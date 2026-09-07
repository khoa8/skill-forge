/**
 * Regression tests for production-hardening fixes at the HTTP boundary:
 * - the terminal error handler returns honest JSON (no HTML stack traces)
 *   for malformed and oversized JSON bodies;
 * - the loopback classifier used for the non-loopback binding warning.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, isLoopbackHost, terminalErrorHandler } from "../src/server/app.js";
import type { Request, Response, NextFunction } from "express";

const app = createApp({ provider: "mock", hasApiKey: false });

describe("malformed JSON bodies fail safely", () => {
  it("returns JSON 400 (not an HTML stack trace) for invalid JSON", async () => {
    const res = await request(app)
      .post("/api/generate")
      .set("content-type", "application/json")
      .send('{"sourceType": "text", "content": truncated...')
      .expect(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.code).toBe("invalid_json_body");
    expect(res.body.error).not.toMatch(/at\s+\w+\s+\(/); // no stack frames
    expect(res.text).not.toContain("<html");
    expect(res.text).not.toContain("<pre>");
  });

  it("returns JSON 413 for a JSON body over the 3 MB limit", async () => {
    const big = "x".repeat(3 * 1024 * 1024 + 1024);
    const res = await request(app)
      .post("/api/generate")
      .set("content-type", "application/json")
      .send(`{"sourceType":"text","content":"${big}"}`)
      .expect(413);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.code).toBe("payload_too_large");
  });

  it("keeps serving valid JSON after a malformed request", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("terminalErrorHandler", () => {
  function mockRes(): {
    res: Response;
    state: { headers: Map<string, string | number>; body: unknown; status: number | null };
  } {
    const state: { headers: Map<string, string | number>; body: unknown; status: number | null } = {
      headers: new Map(),
      body: null,
      status: null,
    };
    const res = {
      headersSent: false,
      setHeader: (k: string, v: string | number) => state.headers.set(k, v),
      status(code: number) {
        state.status = code;
        return this;
      },
      json(payload: unknown) {
        state.body = payload;
        return this;
      },
      end() {},
    } as unknown as Response;
    return { res, state };
  }
  const next: NextFunction = () => {};

  it("maps body-parser entity.too.large to 413 JSON", () => {
    const { res, state } = mockRes();
    terminalErrorHandler({ type: "entity.too.large", expose: true, status: 413 }, {} as Request, res, next);
    expect(state.status).toBe(413);
    expect((state.body as { code: string }).code).toBe("payload_too_large");
  });

  it("maps entity.parse.failed to 400 JSON", () => {
    const { res, state } = mockRes();
    terminalErrorHandler({ type: "entity.parse.failed" }, {} as Request, res, next);
    expect(state.status).toBe(400);
    expect((state.body as { code: string }).code).toBe("invalid_json_body");
  });

  it("reduces unknown errors to a generic 500 with no internals", () => {
    const { res, state } = mockRes();
    const secret = "SKILLFORGE_API_KEY=super-secret-value";
    terminalErrorHandler(new Error(`boom: ${secret}`), {} as Request, res, next);
    expect(state.status).toBe(500);
    expect(JSON.stringify(state.body)).not.toContain(secret);
    expect((state.body as { code: string }).code).toBe("internal_error");
  });
});

describe("client disconnects mid-stream are safe", () => {
  it("survives an abrupt disconnect during NDJSON generation and keeps serving", async () => {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // Large source ⇒ many NDJSON events; destroy the socket after the first
      // streamed chunk, while the server is still mid-pipeline.
      const bigSource = "Step one: npm install.\n".repeat(4000);
      const payload = JSON.stringify({ sourceType: "text", name: "disconnect-test", content: bigSource });
      const port_ = port;
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: port_,
            method: "POST",
            path: "/api/generate",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
          },
          (res: IncomingMessage) => {
            res.once("data", () => {
              req.destroy(); // abort mid-stream
              resolve();
            });
          },
        );
        req.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
          else reject(err);
        });
        req.end(payload);
      });
      // Give the abandoned pipeline a few ticks to hit the guard.
      await new Promise((r) => setTimeout(r, 200));
      const health = await request(app).get("/api/health").expect(200);
      expect(health.body.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("async route rejections reach the terminal handler (Express 4)", () => {
  // Express 4 does not forward rejected promises from async handlers into the
  // error middleware chain. The asyncRoute wrapper must guarantee that an
  // async dependency failure becomes an honest JSON 500 — not a hang, not a
  // leak of the underlying error.
  it("maps a rejecting async dependency to a generic JSON 500 without internals", async () => {
    const secret = "postgres://skillforge:super-secret-dsn@db.internal:5432/prod";
    const failingApp = createApp({ provider: "mock", hasApiKey: false }, {
      loadSkill: async () => {
        throw new Error(`connection refused: ${secret}`);
      },
    });
    const res = await request(failingApp).get("/api/skills/whatever-id").expect(500);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.code).toBe("internal_error");
    expect(res.body.error).toBe("Internal server error.");
    expect(res.text).not.toContain(secret);
    expect(res.text).not.toContain("<html");
    // supertest completing at all proves the request did not hang.
  });

  it("a rejecting dependency on the excerpt route also lands on the generic 500", async () => {
    const failingApp = createApp({ provider: "mock", hasApiKey: false }, {
      loadSkill: async () => {
        throw new Error("disk exploded");
      },
    });
    const res = await request(failingApp)
      .get("/api/skills/whatever-id/provenance/excerpt?start=1&end=2")
      .expect(500);
    expect(res.body.code).toBe("internal_error");
    expect(res.text).not.toContain("disk exploded");
  });
});

describe("isLoopbackHost (binding-warning classifier)", () => {
  it("treats loopback forms as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("treats every non-loopback bind as exposed", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("skillforge.example.com")).toBe(false);
  });
});
