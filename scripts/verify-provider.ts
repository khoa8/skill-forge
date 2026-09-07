/**
 * Provider verification CLI.
 *
 * Verifies that a configured provider can actually produce a valid SkillForge
 * package — one small bounded generation, schema-checked, canonically built,
 * deterministically validated. Exits nonzero on failure.
 *
 * Configuration comes from the environment (see .env.example):
 *   SKILLFORGE_PROVIDER  mock (default) | glm | openai
 *   SKILLFORGE_API_KEY   required for glm/openai; never printed
 *   SKILLFORGE_BASE_URL  optional override
 *   SKILLFORGE_MODEL     optional override
 *
 * No key is needed for the default offline (mock) verification.
 *
 * Usage: npm run verify:provider
 */
import { verifyProvider } from "../src/core/verify.js";
import { PROVIDER_IDS, type ProviderId } from "../src/core/providers/index.js";

function maskKey(configured: boolean): string {
  return configured ? "configured (never printed)" : "not set";
}

async function main(): Promise<number> {
  const rawProvider = process.env.SKILLFORGE_PROVIDER?.trim() || "mock";
  if (!PROVIDER_IDS.includes(rawProvider as ProviderId)) {
    console.error(`Unsupported SKILLFORGE_PROVIDER "${rawProvider}". Supported: ${PROVIDER_IDS.join(", ")}.`);
    return 2;
  }
  const provider = rawProvider as ProviderId;
  const apiKey = process.env.SKILLFORGE_API_KEY?.trim() || undefined;
  const baseUrl = process.env.SKILLFORGE_BASE_URL?.trim() || undefined;
  const model = process.env.SKILLFORGE_MODEL?.trim() || undefined;

  console.log("SkillForge provider verification");
  console.log(`  provider : ${provider}`);
  console.log(`  base url : ${baseUrl ?? "(provider default)"}`);
  console.log(`  model    : ${model ?? "(provider default)"}`);
  console.log(`  api key  : ${maskKey(Boolean(apiKey))}`);
  if (provider !== "mock" && !apiKey) {
    console.error(
      `\nProvider "${provider}" requires SKILLFORGE_API_KEY. Set it (never commit it), or run the offline harness with SKILLFORGE_PROVIDER=mock.`,
    );
    return 2;
  }

  console.log("\nRunning one small bounded generation…\n");
  const result = await verifyProvider({ provider, apiKey, baseUrl, model });

  for (const step of result.steps) {
    console.log(`  ${step.ok ? "✓" : "✗"} ${step.step.padEnd(12)} ${step.detail}`);
  }

  console.log("");
  if (result.ok) {
    console.log(
      `VERIFIED: provider "${result.provider}" produced a package with ${result.files} file(s) passing deterministic validation (${result.validationWarnings ?? 0} warning(s)).`,
    );
    return 0;
  }
  console.error(`NOT VERIFIED: ${result.error ?? "unknown failure"}`);
  console.error("Fix the configuration or provider behavior above and re-run: npm run verify:provider");
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`verify:provider crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
