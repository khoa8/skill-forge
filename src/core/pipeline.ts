/**
 * Pipeline orchestration: ingest → analyze → generate → validate.
 *
 * Implemented as an async generator so both the HTTP layer (NDJSON streaming
 * to the UI) and the CLI can consume identical progress events. Export is a
 * separate on-demand step, not part of generation.
 *
 * Errors are typed and surfaced per stage — the pipeline never collapses a
 * failure into a generic "generation failed" message.
 */
import type {
  CanonicalSkill,
  SourceAnalysis,
  SourceInput,
  ValidationReport,
} from "./types.js";
import { normalizeSource, IngestError } from "./ingest.js";
import { analyzeSource } from "./analyze.js";
import { buildCanonicalSkill } from "./build.js";
import { validatePackage } from "./validate.js";
import { resolveProvider, ProviderError, type ProviderId } from "./providers/index.js";
import type { PipelineStage } from "./plan.js";

export type PipelineEvent =
  | {
      type: "stage";
      stage: PipelineStage;
      status: "start" | "done" | "error";
      ms?: number;
      detail?: string;
    }
  | { type: "source-note"; note: string }
  | { type: "result"; skill: CanonicalSkill; analysis: SourceAnalysis; validation: ValidationReport; sourceNotes: string[] }
  | { type: "error"; stage?: PipelineStage; code: string; message: string };

export interface PipelineOptions {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  requestedName?: string;
  /** Optional caller cancellation (e.g. HTTP client disconnect). When it
   * fires, an in-flight remote provider request is aborted and no further
   * pipeline work runs. Optional — offline/CLI consumers omit it. */
  signal?: AbortSignal;
}

export interface StageTiming {
  stage: PipelineStage;
  ms: number;
  ok: boolean;
}

export interface PipelineResult {
  skill: CanonicalSkill;
  analysis: SourceAnalysis;
  validation: ValidationReport;
  stageTimings: StageTiming[];
  providerId: string;
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly stage: PipelineStage,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

function wrapError(err: unknown, stage: PipelineStage): PipelineError {
  if (err instanceof PipelineError) return err;
  if (err instanceof IngestError) return new PipelineError(err.message, err.code, stage);
  if (err instanceof ProviderError) return new PipelineError(err.message, err.code, stage, err.detail);
  return new PipelineError(
    err instanceof Error ? err.message : String(err),
    "pipeline_unexpected_error",
    stage,
  );
}

/**
 * Run the pipeline, yielding progress events and ending with a `result` or
 * `error` event. Provider failures and validation both produce typed events;
 * validation issues do NOT abort the pipeline — a package with findings is
 * still inspectable, with `passed: false` reported honestly.
 */
export async function* runPipeline(
  input: SourceInput,
  options: PipelineOptions,
): AsyncGenerator<PipelineEvent, void, unknown> {
  const timings: StageTiming[] = [];

  // --- ingest
  let normalized;
  let t0 = Date.now();
  yield { type: "stage", stage: "ingest", status: "start" };
  try {
    normalized = normalizeSource(input);
    timings.push({ stage: "ingest", ms: Date.now() - t0, ok: true });
    yield {
      type: "stage",
      stage: "ingest",
      status: "done",
      ms: timings[0]!.ms,
      detail: `${normalized.lineCount} lines from "${normalized.originalName}"${normalized.notes.length > 0 ? ` (${normalized.notes.join(" ")})` : ""}`,
    };
    // Surface adapter notes (truncation, skipped files, redirects) as their
    // own events so the UI can render each one instead of a folded detail line.
    for (const note of normalized.notes) {
      yield { type: "source-note", note };
    }
  } catch (err) {
    timings.push({ stage: "ingest", ms: Date.now() - t0, ok: false });
    const e = wrapError(err, "ingest");
    yield { type: "error", stage: "ingest", code: e.code, message: e.message };
    return;
  }

  // --- analyze
  t0 = Date.now();
  yield { type: "stage", stage: "analyze", status: "start" };
  let analysis: SourceAnalysis;
  try {
    analysis = analyzeSource(normalized);
    timings.push({ stage: "analyze", ms: Date.now() - t0, ok: true });
    const repoDetail = normalized.repository
      ? ` · repository: ${normalized.repository.commands.length} evidenced command(s), ${normalized.repository.conventions.length} convention(s), ${normalized.repository.inspectedFiles.length} inspected file(s)`
      : "";
    yield {
      type: "stage",
      stage: "analyze",
      status: "done",
      ms: timings[timings.length - 1]!.ms,
      detail: `${analysis.sections.length} sections, ${analysis.procedures.length} procedures, ${analysis.commands.length} commands, ${analysis.codeBlocks.length} code blocks${repoDetail}`,
    };
  } catch (err) {
    timings.push({ stage: "analyze", ms: Date.now() - t0, ok: false });
    const e = wrapError(err, "analyze");
    yield { type: "error", stage: "analyze", code: e.code, message: e.message };
    return;
  }

  // --- generate
  t0 = Date.now();
  yield {
    type: "stage",
    stage: "generate",
    status: "start",
    detail: normalized.repository
      ? `provider: ${options.provider} · planning coding-agent skill (codebase mode)`
      : `provider: ${options.provider}`,
  };
  let skill: CanonicalSkill;
  try {
    // Cancellation check before starting the stage.
    options.signal?.throwIfAborted();
    const provider = resolveProvider(
      {
        provider: options.provider,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
      },
    );
    const plan = await provider.generate({
      source: normalized,
      analysis,
      repository: normalized.repository,
      requestedName: options.requestedName,
      signal: options.signal,
    });
    skill = buildCanonicalSkill(normalized, analysis, plan, provider.id);
    skill.meta.generatedAt = new Date().toISOString();
    timings.push({ stage: "generate", ms: Date.now() - t0, ok: true });
    yield {
      type: "stage",
      stage: "generate",
      status: "done",
      ms: timings[timings.length - 1]!.ms,
      detail: `${skill.files.length} files, id "${skill.id}"`,
    };
  } catch (err) {
    timings.push({ stage: "generate", ms: Date.now() - t0, ok: false });
    const e = wrapError(err, "generate");
    yield { type: "error", stage: "generate", code: e.code, message: e.message };
    return;
  }

  // --- validate
  t0 = Date.now();
  yield { type: "stage", stage: "validate", status: "start" };
  let validation: ValidationReport;
  try {
    validation = validatePackage({
      skill,
      sourceText: normalized.text,
      target: undefined,
      sourceType: normalized.sourceType,
    });
    timings.push({ stage: "validate", ms: Date.now() - t0, ok: true });
    yield {
      type: "stage",
      stage: "validate",
      status: "done",
      ms: timings[timings.length - 1]!.ms,
      detail: validation.passed
        ? `${validation.checks.length} checks passed${validation.warningCount > 0 ? ` with ${validation.warningCount} warning(s)` : ""}`
        : `${validation.errorCount} error(s), ${validation.warningCount} warning(s)`,
    };
  } catch (err) {
    timings.push({ stage: "validate", ms: Date.now() - t0, ok: false });
    const e = wrapError(err, "validate");
    yield { type: "error", stage: "validate", code: e.code, message: e.message };
    return;
  }

  yield { type: "result", skill, analysis, validation, sourceNotes: normalized.notes };
}
