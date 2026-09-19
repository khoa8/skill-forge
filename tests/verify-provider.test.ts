import { describe, expect, it } from "vitest";
import { verifyProvider, boundedSampleText } from "../src/core/verify.js";
import { getSample } from "../src/core/samples.js";

/** Provider verification harness, tested with injected fetch — no live
 * endpoint and no API key involved. The live glm/openai path is exercised
 * manually via `npm run verify:provider` when credentials are available. */

const SAMPLE = getSample("meridian-payments-api").content;

function planJson() {
  // A minimal selection the provider under test returns; must satisfy the
  // grounded ProviderProposalSchema (empty selections = honest gaps).
  return {
    name: "verify-demo",
    displayName: "Verify Demo",
    selections: {
      whenToUse: [],
      inputs: [],
      steps: [],
      constraints: [],
      verification: [],
      pitfalls: [],
    },
  };
}

function okFetch(): typeof fetch {
  return (async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify(planJson()) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("verifyProvider harness", () => {
  it("bounded sample is trimmed and usable offline", () => {
    const text = boundedSampleText();
    expect(text.length).toBeGreaterThan(200);
    expect(text.length).toBeLessThanOrEqual(6_000);
  });

  it("verifies a live-shaped OpenAI-compatible response end to end", async () => {
    const result = await verifyProvider({
      provider: "glm",
      apiKey: "test-key-not-real",
      baseUrl: "https://provider.example.test/v1",
      model: "test-model",
      sampleText: SAMPLE,
      fetchImpl: okFetch(),
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      "source",
      "analyze",
      "generate",
      "plan-schema",
      "build",
      "validate",
    ]);
    expect(result.validationPassed).toBe(true);
    expect(result.files).toBeGreaterThan(0);
    // Credential-free reporting: the key never appears anywhere.
    expect(JSON.stringify(result)).not.toContain("test-key-not-real");
  });

  it("fails with actionable diagnostics on HTTP 401", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;
    const result = await verifyProvider({
      provider: "openai",
      apiKey: "test-key-not-real",
      baseUrl: "https://provider.example.test/v1",
      sampleText: SAMPLE,
      fetchImpl: failing,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Generation failed");
    expect(result.error).toContain("Check the API key, base URL, and model name");
    const generate = result.steps.find((s) => s.step === "generate");
    expect(generate?.ok).toBe(false);
  });

  it("fails when the provider returns a schema-invalid selection", async () => {
    const invalid = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify({ name: "x", selections: { whenToUse: "not-an-array" } }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await verifyProvider({
      provider: "glm",
      apiKey: "test-key-not-real",
      sampleText: SAMPLE,
      fetchImpl: invalid,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Generation failed|schema validation/);
  });

  it("fails on network errors with a typed message", async () => {
    const offline = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const result = await verifyProvider({
      provider: "glm",
      apiKey: "test-key-not-real",
      sampleText: SAMPLE,
      fetchImpl: offline,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Provider request failed");
  });

  it("runs fully offline with the mock provider and no key", async () => {
    const result = await verifyProvider({ provider: "mock", sampleText: SAMPLE });
    expect(result.ok).toBe(true);
    expect(result.validationPassed).toBe(true);
  });
});
