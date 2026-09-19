/**
 * Regression tests for the provider response-body caps and cancellation
 * (src/core/providers/openai-compatible.ts).
 *
 * A timeout bounds elapsed time, not memory: provider response bodies (both
 * success payloads and non-2xx diagnostics) are streamed under a hard byte cap
 * and torn down mid-read when exceeded. Caller cancellation aborts in-flight
 * requests. Injected fetch only — no real provider calls, and API keys must
 * never appear in thrown errors.
 */
import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { OpenAICompatibleProvider } from "../src/core/providers/openai-compatible.js";
import { ProviderError } from "../src/core/providers/index.js";
import { getSample } from "../src/core/samples.js";
import type { GenerateInput } from "../src/core/providers/types.js";

function makeInput(signal?: AbortSignal): GenerateInput {
  const source = normalizeSource({ type: "text", name: "doc", content: getSample("scaffoldcraft-cli").content });
  return { source, analysis: analyzeSource(source), signal };
}

function chatPayload(plan: Record<string, unknown>): string {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] });
}

const VALID_PROPOSAL = {
  name: "my-tool",
  selections: {
    whenToUse: [],
    inputs: [],
    steps: [],
    constraints: [],
    verification: [],
    pitfalls: [],
  },
};

/** A body of `content` delivered in fixed-size chunks (no content-length by
 * default). Zero-padding is never added: the bytes are exactly `content`. */
function dripBody(content: string, chunkSize = 65_536, withContentLength = false): Response {
  const bytes = new TextEncoder().encode(content);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(sent, sent + chunkSize));
      sent += chunkSize;
    },
  });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withContentLength) headers["content-length"] = String(64); // lie
  return new Response(stream, { status: 200, headers });
}

/** Never-ending body: enqueues chunks of junk forever. */
function endlessBody(chunkSize = 65_536): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

const base = { id: "glm", apiKey: "sk-super-secret-key-value", baseUrl: "https://example.invalid/v1", model: "test-model" };

describe("OpenAICompatibleProvider response-body caps", () => {
  it("parses a valid selection delivered as a chunked stream under the cap", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => dripBody(chatPayload(VALID_PROPOSAL), 16),
    });
    const proposal = await provider.generate(makeInput());
    expect(proposal.name).toBe("my-tool");
    expect(proposal.selections.steps).toEqual([]);
  });

  it("refuses an oversized success body with no content-length (streamed cap)", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(65_536));
      },
    });
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({
      code: "provider_response_too_large",
    });
    // The cap trips after ~153 chunks (~10 MB seen) and the read is torn down
    // immediately — the exact pull count varies by one with stream read-ahead,
    // so assert an early-teardown bound, not an exact count.
    expect(pulls).toBeLessThanOrEqual(200);
  });

  it("refuses a body whose streamed size exceeds the cap despite a lying small content-length", async () => {
    // Real JSON that keeps going far beyond the cap: an enormous filler string
    // inside an otherwise valid chat-completions shape.
    const filler = "x".repeat(11_000_000);
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => dripBody(chatPayload({ ...VALID_PROPOSAL, selections: { ...VALID_PROPOSAL.selections, whenToUse: [filler] } }), 65_536, true),
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({
      code: "provider_response_too_large",
    });
  });

  it("bounds an oversized non-2xx diagnostic body and keeps the remediation hint", async () => {
    let sawOverflow = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sawOverflow && pulls_() > 4) sawOverflow = true;
        controller.enqueue(new Uint8Array(65_536));
        function pulls_() {
          return 5;
        }
      },
    });
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => new Response(stream, { status: 401, headers: { "content-type": "application/json" } }),
    });
    const err = await provider.generate(makeInput()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("provider_http_error");
    expect((err as ProviderError).message).toContain("HTTP 401");
    expect((err as ProviderError).message).toContain("Check the API key");
    expect(JSON.stringify(err)).toContain("diagnostic size cap");
  });

  it("aborts a stalled response body at the provider timeout", async () => {
    // Headers arrive; the body stream never ends. The provider timeout (short
    // here) must end the read, not hang forever.
    const provider = new OpenAICompatibleProvider({
      ...base,
      timeoutMs: 150,
      fetchImpl: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const t0 = Date.now();
    await expect(provider.generate(makeInput())).rejects.toMatchObject({
      code: "provider_request_failed",
    });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("maps a malformed bounded JSON body to provider_bad_json", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => new Response("this is not json at all", { status: 200 }),
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({
      code: "provider_bad_json",
    });
  });

  it("never leaks the API key through thrown errors", async () => {
    // Oversized success body, oversized error body, malformed JSON, HTTP 401 —
    // none may echo the key.
    const impls = [
      async () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(65_536)) }), { status: 200 }),
      async () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(65_536)) }), { status: 500 }),
      async () => new Response("garbage {{", { status: 200 }),
      async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    ];
    for (const fetchImpl of impls) {
      const provider = new OpenAICompatibleProvider({ ...base, fetchImpl });
      const err = (await provider.generate(makeInput()).catch((e) => e)) as ProviderError;
      expect(JSON.stringify(err)).not.toContain(base.apiKey);
    }
  });

  it("redacts the configured API key echoed in a non-2xx response body", async () => {
    const key = "sk-super-secret-test-key";
    const provider = new OpenAICompatibleProvider({
      id: "glm",
      apiKey: key,
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
      fetchImpl: async () => new Response(`authentication rejected for ${key}; re-check credentials`, { status: 401 }),
    });
    const err = (await provider.generate(makeInput()).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    // The key must be absent from every error surface, while useful context survives.
    expect(err.message).not.toContain(key);
    expect(String(err.detail)).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
    expect(String(err.detail)).toContain("[REDACTED]");
    expect(String(err.detail)).toContain("re-check credentials");
  });

  it("redacts the configured API key embedded in transport error messages", async () => {
    const key = "sk-super-secret-test-key";
    const provider = new OpenAICompatibleProvider({
      id: "glm",
      apiKey: key,
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
      fetchImpl: (async () => {
        throw new Error(`request failed using Bearer ${key}`);
      }) as unknown as typeof fetch,
    });
    const err = (await provider.generate(makeInput()).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("provider_request_failed");
    expect(err.message).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
    expect(err.message).toContain("[REDACTED]");
  });

  it("redactSecret handles empty and missing inputs safely", async () => {
    const { redactSecret } = await import("../src/core/util.js");
    expect(redactSecret("", "key")).toBe("");
    expect(redactSecret("text", "")).toBe("text");
    expect(redactSecret("text", undefined)).toBe("text");
    expect(redactSecret(undefined, "key")).toBe("");
    expect(redactSecret("a key a", "key")).toBe("a [REDACTED] a");
  });

  it("aborts an in-flight request when the caller's signal fires (not at the 60 s timeout)", async () => {
    let fetchSignal: AbortSignal | undefined | null;
    const provider = new OpenAICompatibleProvider({
      ...base,
      timeoutMs: 60_000,
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = provider.generate(makeInput(controller.signal));
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    await expect(pending).rejects.toMatchObject({ code: "provider_request_failed" });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(fetchSignal?.aborted).toBe(true);
  });
});
