/**
 * GitHub response-body cleanup (F-02) — early rejection paths must release
 * unread bodies instead of leaving connections dangling.
 *
 * Cleanup is cancellation (never buffering), failure-tolerant (a body that
 * errors on cancel must not replace the typed domain error/result), and
 * preserves every public error code / skip classification.
 */
import { describe, expect, it } from "vitest";
import {
  apiFetch,
  cancelResponseBody,
  fetchRawFile,
  GithubSourceError,
} from "../src/core/sources/github.js";

const SHA = "a".repeat(40);
const RAW_URL = `https://raw.githubusercontent.com/acme/widgets/${SHA}/README.md`;

/** A real ReadableStream whose cancellation is observable. */
function trackedStream(state: { cancelled: boolean; failCancel?: boolean }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("# Guide\n\nBody content."));
      controller.close();
    },
    cancel() {
      state.cancelled = true;
      if (state.failCancel) throw new Error("cancel boom");
    },
  });
}

function trackedResponse(
  state: { cancelled: boolean; failCancel?: boolean },
  init: { status?: number; url?: string; contentLength?: string } = {},
): Response {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
  if (init.contentLength !== undefined) headers["content-length"] = init.contentLength;
  const res = new Response(trackedStream(state), { status: init.status ?? 200, headers });
  Object.defineProperty(res, "url", { value: init.url ?? RAW_URL });
  return res;
}

function stubFetch(res: Response) {
  return (async () => res) as unknown as typeof fetch;
}

const LIVE = AbortSignal.timeout(30_000);

describe("fetchRawFile early exits release the body", () => {
  it("cancels the body on a non-2xx raw response, still classified unreachable", async () => {
    const state = { cancelled: false };
    const out = await fetchRawFile(stubFetch(trackedResponse(state, { status: 404 })), RAW_URL, 800_000, 15_000, LIVE);
    expect(out).toEqual({ kind: "unreachable" });
    expect(state.cancelled).toBe(true);
  });

  it("cancels the body on an unexpected final redirect host, still unreachable", async () => {
    const state = { cancelled: false };
    const out = await fetchRawFile(
      stubFetch(trackedResponse(state, { url: "https://evil.example.net/README.md" })),
      RAW_URL,
      800_000,
      15_000,
      LIVE,
    );
    expect(out).toEqual({ kind: "unreachable" });
    expect(state.cancelled).toBe(true);
  });

  it("cancels the body when declared content-length already exceeds the cap, still too_large", async () => {
    const state = { cancelled: false };
    const out = await fetchRawFile(
      stubFetch(trackedResponse(state, { contentLength: String(900_000) })),
      RAW_URL,
      800_000,
      15_000,
      LIVE,
    );
    expect(out).toEqual({ kind: "too_large" });
    expect(state.cancelled).toBe(true);
  });

  it("keeps the public outcome when body cancellation itself throws", async () => {
    const state = { cancelled: false, failCancel: true };
    const out = await fetchRawFile(stubFetch(trackedResponse(state, { status: 500 })), RAW_URL, 800_000, 15_000, LIVE);
    expect(out).toEqual({ kind: "unreachable" });
    expect(state.cancelled).toBe(true);
  });

  it("successful reads still stream the full body unchanged", async () => {
    const state = { cancelled: false };
    const out = await fetchRawFile(stubFetch(trackedResponse(state)), RAW_URL, 800_000, 15_000, LIVE);
    expect(out).toEqual({ kind: "ok", content: "# Guide\n\nBody content." });
  });
});

describe("apiFetch error paths release the body", () => {
  async function apiError(url: string, status: number, headers: Record<string, string> = {}) {
    const state = { cancelled: false };
    const res = new Response(trackedStream(state), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
    try {
      await apiFetch(stubFetch(res), url, {
        timeoutMs: 15_000,
        signal: LIVE,
      });
      expect.fail("expected a GithubSourceError");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubSourceError);
      return { err: err as GithubSourceError, cancelled: state.cancelled };
    }
    throw new Error("unreachable");
  }

  it("cancels the body on repository not-found, keeping the typed code", async () => {
    const { err, cancelled } = await apiError("https://api.github.com/repos/acme/ghost", 404);
    expect(err.code).toBe("github_not_found");
    expect(cancelled).toBe(true);
  });

  it("cancels the body on ref-not-found from the tree endpoint, keeping the code", async () => {
    const { err, cancelled } = await apiError(`https://api.github.com/repos/acme/widgets/git/trees/nope?recursive=1`, 404);
    expect(err.code).toBe("github_ref_not_found");
    expect(cancelled).toBe(true);
  });

  it("cancels the body on ref-not-found from the commit-resolution endpoint", async () => {
    const { err, cancelled } = await apiError("https://api.github.com/repos/acme/widgets/commits/nope", 404);
    expect(err.code).toBe("github_ref_not_found");
    expect(cancelled).toBe(true);
  });

  it("cancels the body on rate limiting, keeping the typed code", async () => {
    const { err, cancelled } = await apiError("https://api.github.com/repos/acme/widgets", 429);
    expect(err.code).toBe("github_rate_limited");
    expect(cancelled).toBe(true);
  });

  it("a failing cancel never masks the typed error", async () => {
    const state = { cancelled: false, failCancel: true };
    const res = new Response(trackedStream(state), { status: 404, headers: { "content-type": "application/json" } });
    await expect(
      apiFetch(stubFetch(res), "https://api.github.com/repos/acme/ghost", { timeoutMs: 15_000, signal: LIVE }),
    ).rejects.toMatchObject({ code: "github_not_found" });
    expect(state.cancelled).toBe(true);
  });

  it("cancelResponseBody tolerates a null body", async () => {
    const res = new Response(null, { status: 404 });
    await expect(cancelResponseBody(res)).resolves.toBeUndefined();
  });
});
