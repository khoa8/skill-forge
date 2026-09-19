/**
 * Provider verification harness (core logic).
 *
 * Bridges the gap between "adapter unit-tested with injected fetch" and
 * "provider behavior verified against a live OpenAI-compatible endpoint".
 * Runs one small, bounded generation end to end:
 *
 *   normalize → analyze → provider.generate (selections) →
 *   shared grounded resolution → canonical build → deterministic validation
 *
 * and reports success/failure with actionable diagnostics. Never logs or
 * returns credentials. The CLI wrapper lives in scripts/verify-provider.ts.
 */
import { normalizeSource, IngestError } from "./ingest.js";
import { analyzeSource } from "./analyze.js";
import { resolveProvider, ProviderError, type ProviderId } from "./providers/index.js";
import { buildCanonicalSkill } from "./build.js";
import { prepareProviderCatalog, resolveProviderProposal } from "./plan-catalog.js";
import { validatePackage } from "./validate.js";
import { getSample } from "./samples.js";

export type { ProviderId } from "./providers/index.js";

export interface VerifyOptions {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  requestedName?: string;
  /** Source material for the bounded generation. Defaults to a trimmed
   * bundled sample so the call stays small and cheap. */
  sampleText?: string;
  /** Injectable fetch for deterministic tests. */
  fetchImpl?: typeof fetch;
}

export interface VerifyResult {
  ok: boolean;
  provider: string;
  model: string;
  baseUrl?: string;
  /** Human-readable, credential-free step log. */
  steps: { step: string; ok: boolean; detail: string }[];
  /** Concise actionable failure reason (ok === false). */
  error?: string;
  files?: number;
  validationPassed?: boolean;
  validationErrors?: number;
  validationWarnings?: number;
}

/** Hard cap for the verification source so a live call stays small. */
const MAX_VERIFY_CHARS = 6_000;

export function boundedSampleText(): string {
  const sample = getSample("meridian-payments-api");
  const text = sample.content.length > MAX_VERIFY_CHARS ? sample.content.slice(0, MAX_VERIFY_CHARS) : sample.content;
  return text;
}

export async function verifyProvider(opts: VerifyOptions): Promise<VerifyResult> {
  const steps: VerifyResult["steps"] = [];
  const record = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail });

  const provider = opts.provider;
  const result: VerifyResult = {
    ok: false,
    provider,
    model: opts.model?.trim() || (provider === "mock" ? "deterministic (built-in)" : "provider default"),
    baseUrl: opts.baseUrl?.trim() || undefined,
    steps,
  };

  // 1. Source (bounded, offline).
  let normalized;
  try {
    normalized = normalizeSource({
      type: "sample",
      name: "verify-provider-sample",
      content: opts.sampleText ?? boundedSampleText(),
    });
    record("source", true, `${normalized.lineCount} lines (bounded to ${MAX_VERIFY_CHARS} chars)`);
  } catch (err) {
    record("source", false, err instanceof Error ? err.message : String(err));
    return { ...result, error: `Source preparation failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 2. Analysis (deterministic).
  let analysis;
  try {
    analysis = analyzeSource(normalized);
    record("analyze", true, `${analysis.sections.length} sections, ${analysis.commands.length} commands, ${analysis.procedures.length} procedures`);
  } catch (err) {
    record("analyze", false, err instanceof Error ? err.message : String(err));
    return { ...result, error: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 3. Provider generation (the only step that can reach the network).
  // Grounded selection contract (F-01): provider proposal → shared grounded
  // resolution → canonical build. Old free-text proposals fail here and are
  // never reported as verified.
  let plan;
  try {
    const providerInstance = resolveProvider(
      { provider, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model },
      opts.fetchImpl,
    );
    const prep = prepareProviderCatalog(normalized, analysis, {
      offline: providerInstance.offline,
      requestedName: opts.requestedName,
    });
    const proposal = await providerInstance.generate({
      source: prep.providerSource,
      analysis: prep.providerAnalysis,
      catalog: prep.catalog,
      requestedName: opts.requestedName,
    });
    plan = resolveProviderProposal(proposal, prep.catalog);
    record("generate", true, `provider "${providerInstance.id}" returned a grounded selection (${plan.steps.length} steps, ${plan.whenToUse.length} when-to-use entries)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    record("generate", false, detail);
    const hint =
      err instanceof ProviderError && err.code === "provider_key_missing"
        ? " Set SKILLFORGE_API_KEY (and optionally SKILLFORGE_PROVIDER / SKILLFORGE_BASE_URL / SKILLFORGE_MODEL), or run the offline harness with SKILLFORGE_PROVIDER=mock."
        : err instanceof ProviderError && err.code === "provider_http_error"
          ? " Check the API key, base URL, and model name; the provider's response body is in the error detail."
          : err instanceof IngestError
            ? " Check the source material."
            : "";
    return { ...result, error: `Generation failed: ${detail}.${hint}` };
  }

  // 4. Grounded-resolution re-check (defense in depth; the adapter validates
  // the proposal shape and the shared resolver enforces catalog membership).
  // `plan` above is already the resolved grounded plan.
  record("plan-schema", true, "provider selection resolved against the deterministic grounded catalog");

  // 5. Canonical build.
  const skill = buildCanonicalSkill(normalized, analysis, plan, provider);
  skill.meta.generatedAt = new Date().toISOString();
  record("build", true, `${skill.files.length} files, id "${skill.id}"`);

  // 6. Deterministic validation.
  const validation = validatePackage({ skill, sourceText: normalized.text, target: undefined });
  record(
    "validate",
    validation.executed && validation.passed,
    validation.passed
      ? `${validation.checks.length} checks passed${validation.warningCount > 0 ? ` with ${validation.warningCount} warning(s)` : ""}`
      : `${validation.errorCount} error(s), ${validation.warningCount} warning(s): ` +
        validation.checks
          .filter((c) => c.status === "fail")
          .map((c) => c.title)
          .join("; "),
  );

  return {
    ...result,
    ok: validation.executed && validation.passed,
    files: skill.files.length,
    validationPassed: validation.passed,
    validationErrors: validation.errorCount,
    validationWarnings: validation.warningCount,
    error: validation.passed ? undefined : "Validation failed for the generated package.",
  };
}
