import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createStore } from "../src/server/store.js";
import * as pipelineModule from "../src/core/pipeline.js";
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
  it.each(["docs", "codebase"])("aborts %s acquisition without starting the pipeline or persisting", async (mode) => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
    let started!: () => void;
    let aborted!: () => void;
    const acquisitionStarted = new Promise<void>((resolve) => { started = resolve; });
    const acquisitionAborted = new Promise<void>((resolve) => { aborted = resolve; });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        const stop = () => { aborted(); reject(new DOMException("Disconnected", "AbortError")); };
        if (init?.signal?.aborted) stop();
        else init?.signal?.addEventListener("abort", stop, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pipeline = vi.spyOn(pipelineModule, "runPipeline");
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const client = http.request({ host: "127.0.0.1", port, path: "/api/generate", method: "POST", headers: { "content-type": "application/json" } });
      client.on("error", () => {});
      client.end(JSON.stringify({ sourceType: "github", repo: "https://github.com/owner/repo", mode }));
      await acquisitionStarted;
      client.destroy();
      await acquisitionAborted;
      // A subsequent request gives the aborted acquisition rejection a chance
      // to finish unwinding, without arbitrary timing sleeps.
      await request(server).get("/api/health").expect(200).expect((res) => expect(res.body.ok).toBe(true));
      expect(pipeline).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(await createStore(storeRoot).listSkills()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanup();
    }
  });
});
