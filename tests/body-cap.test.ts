/**
 * Regression tests for the bounded response-body readers (src/core/sources/body.ts).
 *
 * The cap must be enforced WHILE the body streams: a server that omits or lies
 * about content-length must not be able to make SkillForge buffer unbounded
 * data, and an oversized connection must be torn down mid-read.
 */
import { describe, expect, it } from "vitest";
import { readBodyCapped, decodeUtf8, BodyTooLargeError } from "../src/core/sources/body.js";
import { fetchUrlSource } from "../src/core/sources/url.js";
import { fetchGithubSource } from "../src/core/sources/github.js";

/** A body of `size` bytes delivered in small chunks (slow drip). */
function dripBody(size: number, chunkSize = 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, size - sent);
      controller.enqueue(new Uint8Array(n));
      sent += n;
    },
  });
}

describe("readBodyCapped", () => {
  it("returns exact bytes for a body under the cap", async () => {
    const res = new Response("hello skillforge", { status: 200 });
    const bytes = await readBodyCapped(res, 1000);
    expect(decodeUtf8(bytes)).toBe("hello skillforge");
  });

  it("refuses mid-stream when the body crosses the cap (no content-length)", async () => {
    // 8 chunks of 600 bytes = 4800 bytes against a 2000-byte cap.
    const res = new Response(dripBody(4800, 600), { status: 200 });
    await expect(readBodyCapped(res, 2000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("accepts a body that lands exactly on the cap", async () => {
    const res = new Response(dripBody(2000, 500), { status: 200 });
    const bytes = await readBodyCapped(res, 2000);
    expect(bytes.byteLength).toBe(2000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const res = new Response(dripBody(100), { status: 200 });
    const controller = new AbortController();
    controller.abort();
    await expect(readBodyCapped(res, 1000, controller.signal)).rejects.toBeDefined();
  });

  it("rejects a stalled body when the signal aborts mid-read", async () => {
    // Stream enqueues nothing and never ends; only the abort can end the read.
    const res = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    const controller = new AbortController();
    const pending = readBodyCapped(res, 1000, controller.signal);
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("URL source: streaming byte cap", () => {
  it("refuses a page whose streamed body exceeds the cap even without content-length", async () => {
    // 1.5 MB dripped in 64 KB chunks, no content-length header: the old
    // buffer-then-check implementation consumed the entire body first. The
    // pull counter proves the read is torn down mid-body (~1 MB) instead.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(65_536));
      },
    });
    const lyingFetch = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    await expect(
      fetchUrlSource("https://example.com/huge", {
        fetchImpl: lyingFetch,
        maxBytes: 1_000_000,
        lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "url_too_large" });
    // 1.5 MB / 64 KB ≈ 23 chunks to full delivery; a mid-read teardown must
    // stop well before that.
    expect(pulls).toBeLessThan(23);
  });

  it("still accepts an honest body delivered in many chunks", async () => {
    const chunkedFetch = (async () =>
      new Response(dripBody(50_000, 1_000), {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    const result = await fetchUrlSource("https://example.com/docs", {
      fetchImpl: chunkedFetch,
      maxBytes: 1_000_000,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.input.content.length).toBeGreaterThan(40);
  });
});

describe("GitHub source: streaming per-file cap", () => {
  function githubFetchWithRawBodies(bodies: Record<string, ReadableStream<Uint8Array>>) {
    const tree = {
      sha: "x",
      truncated: false,
      tree: Object.keys(bodies).map((path) => ({ path, type: "blob", size: 10 })),
    };
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        const body = url.includes("/git/trees/")
          ? tree
          : url.includes("/commits/")
            ? { sha: "a".repeat(40) }
            : { default_branch: "main", private: false, visibility: "public" };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const rawPath = url.replace(/^https:\/\/raw\.githubusercontent\.com\/acme\/widgets\/[^/]+\//, "");
      const body = bodies[rawPath] ?? bodies[decodeURIComponent(rawPath)]!;
      const res = new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }) as unknown as typeof fetch;
  }

  it("skips a raw file whose streamed body exceeds the per-file cap (metadata claimed small)", async () => {
    const fetchImpl = githubFetchWithRawBodies({
      "README.md": dripBody(5_000, 1_000),
      "docs/big.md": dripBody(200_000, 10_000),
    });
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl,
      maxFileBytes: 100_000,
    });
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(result.notes.some((n) => n.includes("docs/big.md") && n.includes("per-file limit"))).toBe(true);
  });

  it("keeps a raw file whose streamed body fits under the cap", async () => {
    const fetchImpl = githubFetchWithRawBodies({ "docs/big.md": dripBody(5_000, 1_000) });
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl,
      maxFileBytes: 100_000,
    });
    expect(result.files.map((f) => f.path)).toEqual(["docs/big.md"]);
  });
});
