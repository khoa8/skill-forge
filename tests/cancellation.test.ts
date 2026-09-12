/**
 * Regression tests for end-to-end disconnect cancellation:
 *
 *   HTTP disconnect → AbortController → runPipeline(signal) →
 *   provider.generate(signal) → remote provider fetch abort
 *
 * Proves the mocked remote provider's fetch receives the abort, the pipeline
 * surfaces cancellation instead of a result, nothing is persisted, and the
 * server stays healthy. Normal non-aborted generation must be unchanged.
 *
 * All persistence in this file goes to unique temporary store roots
 * (tests/helpers/store-isolation.ts) — never the production .data/skills.
 */
import { describe, it, expect } from "vitest";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";
import request from "supertest";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir } from "node:fs/promises";
import { runPipeline } from "../src/core/pipeline.js";
import { createApp } from "../src/server/app.js";
import { getSample } from "../src/core/samples.js";

const SAMPLE_TEXT = getSample("meridian-payments-api").content;

describe("runPipeline signal (pipeline level)", () => {
  it("aborts a slow remote provider fetch and yields an error, never a result", async () => {
    const controller = new AbortController();
    const fetchCalls: { aborted: boolean }[] = [];
    const slowRemoteFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const rec = { aborted: false };
      fetchCalls.push(rec);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          rec.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    // Use the real OpenAICompatibleProvider through the pipeline with a slow
    // fetch; abort the caller signal while the request is in flight.
    const events: { type: string; code?: string }[] = [];
    const pending = (async () => {
      for await (const event of runPipeline(
        { type: "sample", name: "s", content: SAMPLE_TEXT },
        { provider: "glm", apiKey: "k", baseUrl: "https://example.invalid/v1", model: "m", signal: controller.signal },
        // Inject fetch via globalThis — runPipeline resolves providers without
        // a fetch parameter, so patch and restore.
      )) events.push(event as { type: string; code?: string });
    })();

    // Patch global fetch before the provider issues its request.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = slowRemoteFetch;
    try {
      setTimeout(() => controller.abort(), 50);
      await pending;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.aborted).toBe(true);
    expect(events.some((e) => e.type === "result")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("works unchanged when no signal is supplied (CLI/demo path)", async () => {
    const events: { type: string }[] = [];
    for await (const event of runPipeline(
      { type: "sample", name: "s", content: SAMPLE_TEXT },
      { provider: "mock" },
    )) events.push(event);
    expect(events.some((e) => e.type === "result")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("HTTP disconnect cancels the in-flight provider request end to end", () => {
  it("aborts the provider fetch, persists nothing, and keeps the server healthy", async () => {
    const fetchCalls: { aborted: boolean }[] = [];
    // Resolved when the provider fetch is verifiably in flight, so the test
    // disconnects at a deterministic point (after generate started).
    let signalFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => (signalFetchStarted = resolve));
    const slowRemoteFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      signalFetchStarted();
      const rec = { aborted: false };
      fetchCalls.push(rec);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          rec.aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    // The generate route reads the key from the environment (never logs it);
    // set a test key so the provider resolves and actually issues its fetch.
    const originalKey = process.env.SKILLFORGE_API_KEY;
    const app = createApp({ provider: "glm", hasApiKey: true, apiKey: "sk-test-cancellation-key", baseUrl: "https://example.invalid/v1", model: "m" }, { storeRoot });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = slowRemoteFetch;
    try {
      const payload = JSON.stringify({ sourceType: "sample", sampleId: "meridian-payments-api" });
      const clientRequest = new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/generate",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
          },
          (res: IncomingMessage) => {
            res.once("data", () => {
              // Disconnect once the provider request is verifiably in flight.
              fetchStarted.then(() => {
                req.destroy();
                resolve();
              });
            });
          },
        );
        req.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
          else reject(err);
        });
        req.end(payload);
      });
      await clientRequest;

      // The provider fetch must have received the abort quickly — well below
      // any provider timeout — instead of running to completion.
      await new Promise((r) => setTimeout(r, 300));
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]!.aborted).toBe(true);

      // The isolated store must have gained no entry from the aborted run.
      let ids: string[] = [];
      try {
        ids = await readdir(storeRoot);
      } catch {
        ids = [];
      }
      expect(ids.filter((id) => !/^\./.test(id))).toHaveLength(0);

      const health = await request(app).get("/api/health").expect(200);
      expect(health.body.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.SKILLFORGE_API_KEY;
      else process.env.SKILLFORGE_API_KEY = originalKey;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Cleanup is scoped to THIS test's temporary store root.
      await cleanup();
    }
  });

  it("non-aborted generation still persists exactly one result (unchanged behavior)", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const marker = `cancel-unmodified-${Date.now()}`;
    try {
      // requestedName gives the generated skill a unique id to assert on.
      const payload = JSON.stringify({
        sourceType: "sample",
        sampleId: "meridian-payments-api",
        requestedName: marker,
      });
      const raw = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/generate",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
          },
          (res: IncomingMessage) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString()));
            res.on("end", () => resolve(body));
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
      const events = raw.trim().split("\n").map((l) => JSON.parse(l) as { type: string; skill?: { id: string } });
      expect(events.some((e) => e.type === "result")).toBe(true);
      const skillId = events.find((e) => e.type === "result")!.skill!.id;
      expect(skillId).toBe(marker);

      const ids = await readdir(storeRoot);
      expect(ids.filter((id) => id === marker)).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanup();
    }
  });
});

it("disconnect during persistence aborts before rename and keeps the server healthy", async () => {
  const { createStore } = await import("../src/server/store.js");
  const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
  let reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  let observed!: () => void;
  const aborted = new Promise<void>(resolve => { observed = resolve; });
  let finished!: () => void;
  const settled = new Promise<void>(resolve => { finished = resolve; });
  let signal: AbortSignal | undefined;
  let failure: unknown;
  const store = createStore(storeRoot, {
    beforeRename: async () => { reached(); await aborted; },
  });
  const app = createApp({ provider: "mock", hasApiKey: false }, {
    storeRoot,
    saveSkill: async (entry, options) => {
      signal = options?.signal;
      signal?.addEventListener("abort", observed, { once: true });
      try { await store.saveSkill(entry, options); }
      catch (err) { failure = err; throw err; }
      finally { finished(); }
    },
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let raw = "";
  const req = httpRequest({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, method: "POST", path: "/api/generate", headers: { "content-type": "application/json" } }, res => {
    res.on("data", chunk => { raw += chunk.toString(); });
  });
  req.on("error", () => {});
  try {
    req.end(JSON.stringify({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "paused-save" }));
    await paused;
    req.destroy();
    await aborted;
    await settled;
    expect(signal?.aborted).toBe(true);
    expect(failure).toMatchObject({ code: "store_aborted" });
    expect(await createStore(storeRoot).getSkill("paused-save")).toBeUndefined();
    expect(await readdir(`${storeRoot}/paused-save`)).toEqual([]);
    expect(raw).not.toContain('"type":"result"');
    await request(app).get("/api/health").expect(200);
  } finally {
    req.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
  }
});
