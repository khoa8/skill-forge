import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { MockProvider } from "../src/core/providers/mock.js";
import { OpenAICompatibleProvider, extractJsonObject } from "../src/core/providers/openai-compatible.js";
import { ProviderError, resolveProvider } from "../src/core/providers/index.js";
import { getSample } from "../src/core/samples.js";
import type { GenerateInput } from "../src/core/providers/types.js";

function makeInput(): GenerateInput {
  const source = normalizeSource({ type: "text", name: "doc", content: getSample("fastforge-cli").content });
  return { source, analysis: analyzeSource(source) };
}

function okResponse(json: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof json === "string" ? json : JSON.stringify(json) } }] }), { status: 200 });
}

describe("MockProvider (bundled demo path)", () => {
  it("is offline and deterministic", async () => {
    const provider = new MockProvider();
    expect(provider.offline).toBe(true);
    const a = await provider.generate(makeInput());
    const b = await provider.generate(makeInput());
    expect(a).toEqual(b);
    expect(a.name).toBe("fastforge-cli");
    expect(a.steps.length).toBeGreaterThan(0);
  });
});

describe("provider resolution", () => {
  it("resolves mock without a key", () => {
    expect(resolveProvider({ provider: "mock" }).offline).toBe(true);
  });

  it("refuses remote providers without a key with an actionable error", () => {
    try {
      resolveProvider({ provider: "glm" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("provider_key_missing");
      expect((err as ProviderError).message).toContain("SKILLFORGE_API_KEY");
      expect((err as ProviderError).message).toContain("mock");
    }
  });
});

describe("OpenAICompatibleProvider (validated model output)", () => {
  const base = { id: "glm", apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "test-model" };

  it("parses a valid plan from a chat-completions response", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () =>
        okResponse({
          name: "my-tool",
          whenToUse: ["When using My Tool"],
          inputs: [],
          steps: ["Install My Tool"],
          constraints: [],
          verification: [],
          pitfalls: [],
        }),
    });
    const plan = await provider.generate(makeInput());
    expect(plan.name).toBe("my-tool");
    expect(plan.steps).toEqual(["Install My Tool"]);
  });

  it("fails with provider_schema_mismatch on structurally invalid output", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => okResponse({ whenToUse: "should have been an array", steps: 42 }),
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({ code: "provider_schema_mismatch" });
  });

  it("fails with provider_no_json when the model chats without JSON", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => okResponse("Sorry, I cannot help with that."),
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({ code: "provider_no_json" });
  });

  it("surfaces HTTP errors with remediation hints", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => new Response("denied", { status: 401, statusText: "Unauthorized" }),
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({ code: "provider_http_error" });
  });

  it("surfaces network failures as provider_request_failed", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({ code: "provider_request_failed" });
  });

  it("fails cleanly when the response has no chat message", async () => {
    const provider = new OpenAICompatibleProvider({
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await expect(provider.generate(makeInput())).rejects.toMatchObject({ code: "provider_unexpected_shape" });
  });
});

describe("extractJsonObject", () => {
  it("extracts balanced JSON from chatty text", () => {
    const parsed = extractJsonObject('Here you go:\n{"a": {"b": 1}, "c": "x{y}z"}\nThanks!');
    expect(parsed).toEqual({ a: { b: 1 }, c: "x{y}z" });
  });

  it("handles braces inside strings", () => {
    expect(extractJsonObject('{"s": "}{"}')).toEqual({ s: "}{" });
  });

  it("returns null for unparseable content", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject('{"broken": ')).toBeNull();
  });
});
