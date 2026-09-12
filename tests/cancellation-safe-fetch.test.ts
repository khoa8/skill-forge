import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import { safeFetch } from "../src/core/sources/safe-fetch.js";
import { fetchUrlSource } from "../src/core/sources/url.js";
import { fetchGithubSource } from "../src/core/sources/github.js";
import { fetchGithubCodebaseSource } from "../src/core/sources/github-codebase.js";
import { collectFiles } from "../src/core/sources/files.js";
import { createApp } from "../src/server/app.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

const mockHangingFetch = (async (_input: any, init?: any) => {
  if (init?.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });
}) as unknown as typeof fetch;

describe("T-01: safeFetch requestFnOverride test seam", () => {
  it("passes pinned address lookup hook into custom agent without real network access", async () => {
    let capturedOptions: http.RequestOptions | null = null;
    let capturedUrl: string | URL | null = null;

    const mockRequestFn: typeof http.request = ((
      url: string | URL,
      options: http.RequestOptions,
      callback?: (res: http.IncomingMessage) => void,
    ) => {
      capturedUrl = url;
      capturedOptions = options;

      const req = new EventEmitter() as any;
      req.end = vi.fn();
      req.destroy = vi.fn();

      if (callback) {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.statusMessage = "OK";
        res.rawHeaders = ["content-type", "text/plain"];
        res.destroy = vi.fn();
        process.nextTick(() => {
          callback(res);
          res.emit("data", Buffer.from("mock content"));
          res.emit("end");
        });
      }

      return req;
    }) as any;

    const mockLookup = (async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as any;

    const res = await safeFetch(
      "http://docs.example.test/doc",
      { requestFnOverride: mockRequestFn },
      mockLookup,
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(capturedUrl).toBe("http://docs.example.test/doc");
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.agent).toBeDefined();

    // Verify the agent lookup hook resolves to the pinned IP address
    const agentLookup = (capturedOptions!.agent as any).options.lookup;
    expect(typeof agentLookup).toBe("function");

    const lookupResult = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      agentLookup("docs.example.test", {}, (err: any, address: string, family: number) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });

    expect(lookupResult).toEqual({ address: "93.184.216.34", family: 4 });
  });
});

describe("F-05: Caller abort vs deadline timeout differentiation", () => {
  it("fetchUrlSource throws url_aborted on caller abort and url_deadline_exceeded on timeout", async () => {
    // 1. Caller abort
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await expect(
      fetchUrlSource("https://example.com/docs", {
        signal: abortCtrl.signal,
        timeoutMs: 10000,
        fetchImpl: mockHangingFetch,
      }),
    ).rejects.toMatchObject({ code: "url_aborted" });

    // 2. Deadline exceeded (no caller abort)
    await expect(
      fetchUrlSource("https://example.com/docs", {
        timeoutMs: 50,
        fetchImpl: mockHangingFetch,
      }),
    ).rejects.toMatchObject({ code: "url_deadline_exceeded" });
  });

  it("fetchGithubSource throws github_aborted on caller abort and github_deadline_exceeded on timeout", async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await expect(
      fetchGithubSource("https://github.com/owner/repo", {
        signal: abortCtrl.signal,
        overallTimeoutMs: 10000,
        fetchImpl: mockHangingFetch,
      }),
    ).rejects.toMatchObject({ code: "github_aborted" });

    await expect(
      fetchGithubSource("https://github.com/owner/repo", {
        overallTimeoutMs: 50,
        fetchImpl: mockHangingFetch,
      }),
    ).rejects.toMatchObject({ code: "github_deadline_exceeded" });
  });

  it("fetchGithubCodebaseSource throws codebase_aborted on caller abort and codebase_deadline_exceeded on timeout", async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await expect(
      fetchGithubCodebaseSource("https://github.com/owner/repo", {
        signal: abortCtrl.signal,
        overallTimeoutMs: 10000,
        fetchImpl: mockHangingFetch,
      }),
    ).rejects.toMatchObject({ code: "codebase_aborted" });

    await expect(
      fetchGithubCodebaseSource("https://github.com/owner/repo", {
        overallTimeoutMs: 50,
        fetchImpl: mockHangingFetch,
      }),
    ).rejects.toMatchObject({ code: "codebase_deadline_exceeded" });
  });

  it("collectFiles throws file_aborted on caller abort", async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await expect(
      collectFiles("docs", { signal: abortCtrl.signal }),
    ).rejects.toMatchObject({ code: "file_aborted" });
  });
});

describe("F-05: Server disconnect handling during source acquisition", () => {
  let app: ReturnType<typeof createApp>;
  let cleanupStore: () => Promise<void>;

  beforeAll(async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    cleanupStore = cleanup;
    app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
  });

  afterAll(async () => {
    await cleanupStore?.();
  });

  it("aborts source acquisition promptly when client disconnects and avoids unhandled response errors", async () => {
    let sourceSignalAborted = false;

    // Use a custom fetch that inspects signal
    vi.stubGlobal("fetch", async (_url: any, init?: any) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        signal.addEventListener("abort", () => {
          sourceSignalAborted = true;
        });
      }
      return new Promise<Response>(() => {}); // hangs until aborted
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      const clientReq = http.request({
        port,
        path: "/api/generate",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      clientReq.on("error", () => {});

      clientReq.write(
        JSON.stringify({
          sourceType: "github",
          repo: "https://github.com/owner/repo",
        }),
      );
      clientReq.end();

      // Wait a moment for server to receive request and start source acquisition
      await new Promise((r) => setTimeout(r, 50));

      // Destroy the client connection prematurely
      clientReq.destroy();

      // Wait for server to handle disconnect
      await new Promise((r) => setTimeout(r, 100));

      expect(sourceSignalAborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
