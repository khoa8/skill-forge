/**
 * Express application: REST API + static UI.
 *
 * Generation streams NDJSON pipeline events (one JSON object per line) so the
 * UI shows real per-stage progress. Export re-runs deterministic validation
 * and refuses packages with errors — the download button is never a fake.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { runPipeline } from "../core/pipeline.js";
import { validatePackage } from "../core/validate.js";
import { normalizeSource, sourceSlice } from "../core/ingest.js";
import { exportPackage, buildZip, EXPORT_TARGET_INFO, ExportError } from "../core/export/exporters.js";
import { listSamples, getSample } from "../core/samples.js";
import { fetchUrlSource, UrlSourceError } from "../core/sources/url.js";
import { collectFiles, combineFiles, FileSourceError } from "../core/sources/files.js";
import { fetchGithubSource, GithubSourceError } from "../core/sources/github.js";
import {
  createStore,
  getDefaultStore,
  getSkill as loadSkill,
  EditError,
  SkillIdConflictError,
  toResponse,
  normalizeStoredSource,
  SourceRenormalizationError,
} from "./store.js";
import type { ExportTarget, SourceType, RepositoryAnalysis } from "../core/types.js";
import { fetchGithubCodebaseSource, GithubCodebaseError } from "../core/sources/github-codebase.js";
import { PROVIDER_IDS } from "../core/providers/index.js";
import { createHostValidationMiddleware } from "./host-guard.js";

const VERSION = "0.1.0";

/** Locate web/ whether running from src (tsx) or dist (tsc output). */
function findWebDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "web");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "web");
}
const WEB_DIR = findWebDir();

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 does not route rejected promises from async handlers into the
 * error middleware chain — a rejection outside try/catch would become an
 * unhandled rejection. Every async route is wrapped so a failure always
 * reaches the terminal error handler instead.
 */
function asyncRoute(handler: AsyncRouteHandler): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const GenerateBody = z.object({
  sourceType: z.enum(["text", "sample", "url", "file", "github"]),
  /** For `text`: the pasted content. Required when sourceType is "text". */
  content: z.string().min(1).max(2_000_000).optional(),
  /** For `sample`: bundled sample id. */
  sampleId: z.string().optional(),
  /** For `url`: the page to fetch. */
  url: z.string().max(2048).optional(),
  /** For `file`: workspace-relative file or directory path. */
  path: z.string().max(1024).optional(),
  /** For `github`: a github.com repository or tree URL. */
  repo: z.string().max(2048).optional(),
  /** For `github`: what the repository means. "docs" (default) reads
   * documentation-like files; "codebase" analyzes the repository as a
   * software project for coding agents. */
  mode: z.enum(["docs", "codebase"]).optional(),
  recursive: z.boolean().optional(),
  name: z.string().max(200).optional(),
  requestedName: z.string().max(80).optional(),
});

const ExportBody = z.object({ target: z.enum(["claude-code", "generic"]) });

const UpdateFileBody = z.object({
  /** Package-relative path of an existing generated text file. */
  path: z.string().min(1).max(300),
  /** Replacement content. The schema is a transport sanity bound (under the
   * express JSON limit); the authoritative per-file limit lives in the store
   * and is reported as 413 edit_too_large. */
  content: z.string().min(1).max(2_000_000),
});

/** Max lines per provenance excerpt response — keeps replies bounded. */
const MAX_EXCERPT_LINES = 200;

const ExcerptQuery = z.object({
  start: z.coerce.number().int().min(1).max(1_000_000),
  end: z.coerce.number().int().min(1).max(1_000_000),
});

/** HTTP status per typed source-adapter error code. */
const GITHUB_ERROR_STATUS: Record<string, number> = {
  github_invalid_url: 400,
  github_unsupported_host: 400,
  github_not_found: 404,
  github_ref_not_found: 404,
  github_no_docs: 422,
  github_rate_limited: 429,
  github_fetch_failed: 502,
  github_deadline_exceeded: 504,
  github_private_repo: 400,
  // Codebase mode reuses the docs adapter's URL grammar, so URL-level codes
  // arrive in the docs spelling; status mapping is shared.
  codebase_invalid_url: 400,
  codebase_unsupported_host: 400,
  codebase_not_found: 404,
  codebase_ref_not_found: 404,
  codebase_no_candidates: 422,
  codebase_rate_limited: 429,
  codebase_fetch_failed: 502,
  codebase_deadline_exceeded: 504,
  codebase_private_repo: 400,
};

/** Map an API sourceType to the canonical SourceInput type kept in the store. */
const PIPELINE_SOURCE_TYPE: Record<z.infer<typeof GenerateBody>["sourceType"], SourceType> = {
  text: "text",
  sample: "sample",
  url: "text",
  file: "file",
  github: "github",
};

export interface AppConfig {
  provider: string;
  hasApiKey: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  bindHost?: string;
  allowedHosts?: string[];
}

/** Narrow dependency overrides, mainly for tests. `storeRoot` isolates
 * persistence in a temporary directory so tests can never touch the
 * production `.data/skills` store; omit it for normal use. */
export interface AppOverrides {
  storeRoot?: string;
  loadSkill?: typeof loadSkill;
}

/** True when the bind host only exposes the server to the local machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1" || h === "[::1]";
}

export function createApp(config: AppConfig, overrides: AppOverrides = {}): Express {
  const store = overrides.storeRoot ? createStore(overrides.storeRoot) : getDefaultStore();
  const saveSkillImpl = store.saveSkill;
  const loadSkillImpl = overrides.loadSkill ?? store.getSkill;
  const listSkillsImpl = store.listSkills;
  const revalidateSkillImpl = store.revalidateSkill;
  const updateFileContentImpl = store.updateFileContent;
  const app = express();
  app.disable("x-powered-by");
  app.use(createHostValidationMiddleware({ bindHost: config.bindHost, allowedHosts: config.allowedHosts }));
  app.use(express.json({ limit: "3mb" }));
  app.use(express.static(WEB_DIR));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      provider: config.provider,
      providerUsesApiKey: config.hasApiKey,
      offlineDemo: config.provider === "mock",
    });
  });

  app.get("/api/exporters", (_req, res) => {
    res.json({ targets: EXPORT_TARGET_INFO });
  });

  app.get("/api/samples", (_req, res) => {
    res.json({ samples: listSamples() });
  });

  app.get("/api/samples/:id", (req, res) => {
    try {
      const { meta, content } = getSample(req.params.id!);
      res.json({ sample: meta, content });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/generate", asyncRoute(async (req: Request, res: Response) => {
    const parsed = GenerateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body.",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    const body = parsed.data;
    if (body.mode !== undefined && body.sourceType !== "github") {
      res.status(400).json({ error: "`mode` is only supported for sourceType 'github' (docs | codebase)." });
      return;
    }

    let content: string;
    let name: string;
    let sourceNotes: string[] = [];
    /** Canonical SourceInput type for this request (notes ride along). */
    let inputType: SourceType = "text";
    /** Adapter notes (truncation, redirects, skipped files) — persisted with the skill. */
    let adapterNotes: string[] = [];
    /** Structured repository analysis for codebase-mode GitHub sources. */
    let repository: RepositoryAnalysis | undefined = undefined;
    if (body.sourceType === "sample") {
      if (!body.sampleId) {
        res.status(400).json({ error: "sourceType 'sample' requires `sampleId`." });
        return;
      }
      try {
        const sample = getSample(body.sampleId);
        content = sample.content;
        name = sample.meta.title;
        inputType = "sample";
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
    } else if (body.sourceType === "url") {
      if (!body.url) {
        res.status(400).json({ error: "sourceType 'url' requires `url`." });
        return;
      }
      try {
        const fetched = await fetchUrlSource(body.url);
        content = fetched.input.content;
        name = body.name?.trim() || fetched.input.name;
        sourceNotes = fetched.notes;
        adapterNotes = fetched.notes;
      } catch (err) {
        const code = err instanceof UrlSourceError ? err.code : "url_fetch_failed";
        const status = code === "url_invalid" ? 400 : code === "url_deadline_exceeded" ? 504 : 502;
        res.status(status).json({
          error: err instanceof Error ? err.message : String(err),
          code,
        });
        return;
      }
    } else if (body.sourceType === "github") {
      if (!body.repo) {
        res.status(400).json({ error: "sourceType 'github' requires `repo` (a github.com repository or tree URL)." });
        return;
      }
      const mode = body.mode ?? "docs";
      try {
        if (mode === "codebase") {
          const fetched = await fetchGithubCodebaseSource(body.repo);
          content = fetched.input.content;
          name = body.name?.trim() || fetched.input.name;
          sourceNotes = fetched.notes;
          adapterNotes = fetched.notes;
          repository = fetched.input.repository;
        } else {
          const fetched = await fetchGithubSource(body.repo);
          content = fetched.input.content;
          name = body.name?.trim() || fetched.input.name;
          sourceNotes = fetched.notes;
          adapterNotes = fetched.notes;
        }
      } catch (err) {
        const isCodebase = err instanceof GithubCodebaseError;
        const code = isCodebase
          ? err.code
          : err instanceof GithubSourceError
            ? err.code
            : mode === "codebase"
              ? "codebase_fetch_failed"
              : "github_fetch_failed";
        const status = isCodebase
          ? (GITHUB_ERROR_STATUS[code] ?? 502)
          : err instanceof GithubSourceError
            ? (GITHUB_ERROR_STATUS[code] ?? 502)
            : 502;
        res.status(status).json({
          error: err instanceof Error ? err.message : String(err),
          code,
        });
        return;
      }
    } else if (body.sourceType === "file") {
      if (!body.path) {
        res.status(400).json({ error: "sourceType 'file' requires `path` (workspace-relative file or directory)." });
        return;
      }
      try {
        const collected = await collectFiles(body.path, { recursive: body.recursive });
        const combined = combineFiles(collected.files, body.name?.trim());
        content = combined.content;
        name = combined.name;
        inputType = "file";
        sourceNotes = [
          `Read ${collected.files.length} file(s) from the allowed root.`,
          ...(collected.skipped.length > 0 ? [`Skipped: ${collected.skipped.slice(0, 5).join("; ")}${collected.skipped.length > 5 ? "; …" : ""}`] : []),
        ];
        adapterNotes = sourceNotes;
      } catch (err) {
        const status = err instanceof FileSourceError && err.code === "file_outside_root" ? 403 : 400;
        res.status(status).json({
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof FileSourceError ? err.code : "file_source_failed",
        });
        return;
      }
    } else {
      if (!body.content || body.content.trim().length === 0) {
        res.status(400).json({ error: "sourceType 'text' requires non-empty `content`." });
        return;
      }
      content = body.content;
      name = body.name?.trim() || "pasted-source";
    }

    res.setHeader("content-type", "application/x-ndjson");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();

    const started = Date.now();
    const pipelineSourceType: SourceType =
      body.sourceType === "github" && (body.mode ?? "docs") === "codebase"
        ? "github-codebase"
        : PIPELINE_SOURCE_TYPE[body.sourceType];
    // Client disconnects surface as EPIPE/ECONNRESET 'error' events on the
    // response; an unhandled 'error' event would crash the process. Swallow
    // them here — the abort below stops further work instead.
    res.on("error", () => {});
    // End-to-end cancellation: a disconnect aborts the in-flight pipeline work
    // itself (including a remote provider request), not just the writes.
    const cancellation = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
      // Aborting also guarantees no unfinished result is persisted: the
      // pipeline surfaces cancellation instead of yielding a result.
      cancellation.abort();
    });
    void (async () => {
      try {
        for await (const event of runPipeline(
          {
            type: pipelineSourceType,
            name,
            content,
            notes: adapterNotes,
            ...(repository ? { repository } : {}),
          },
          {
            provider: (config.provider as (typeof PROVIDER_IDS)[number]) ?? "mock",
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            requestedName: body.requestedName,
            signal: cancellation.signal,
          },
        )) {
          if (clientGone || res.writableEnded) return;
          if (event.type === "result") {
            await saveSkillImpl({
              id: event.skill.id,
              skill: event.skill,
              analysis: {
                title: event.analysis.title,
                sectionCount: event.analysis.sections.length,
                procedureCount: event.analysis.procedures.length,
                commandCount: event.analysis.commands.length,
                codeBlockCount: event.analysis.codeBlocks.length,
                lineCount: event.analysis.lineCount,
              },
              source: { name, type: pipelineSourceType, text: content, notes: adapterNotes, ...(repository ? { repository } : {}) },
              validation: event.validation,
              createdAt: new Date().toISOString(),
            });
          }
          res.write(JSON.stringify(event) + "\n");
        }
      } catch (err) {
        if (!clientGone) {
          const code =
            err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
              ? (err as { code: string }).code
              : "pipeline_stream_failed";
          res.write(
            JSON.stringify({
              type: "error",
              code,
              message: err instanceof Error ? err.message : String(err),
            }) + "\n",
          );
        }
      } finally {
        if (!clientGone && !res.writableEnded) {
          res.end(`{"type":"done","ms":${Date.now() - started}}\n`);
        }
      }
    })();
  }));

  app.get("/api/skills", asyncRoute(async (_req, res) => {
    res.json({ skills: await listSkillsImpl() });
  }));

  app.get("/api/skills/:id", asyncRoute(async (req, res) => {
    const stored = await loadSkillImpl(req.params.id!);
    if (!stored) {
      res.status(404).json({ error: `No skill with id "${req.params.id}".` });
      return;
    }
    res.json(toResponse(stored));
  }));

  // Provenance click-through: exact lines from the *normalized* source that a
  // provenance record refers to. The stored raw source is re-normalized with
  // the same deterministic function the pipeline used, so line numbers match
  // the record exactly.
  app.get("/api/skills/:id/provenance/excerpt", asyncRoute(async (req, res) => {
    const stored = await loadSkillImpl(req.params.id!);
    if (!stored) {
      res.status(404).json({ error: `No skill with id "${req.params.id}".` });
      return;
    }
    const parsed = ExcerptQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid line range.",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    const { start, end } = parsed.data;
    if (end < start) {
      res.status(400).json({ error: `end (${end}) must be ≥ start (${start}).`, code: "provenance_bad_range" });
      return;
    }
    let normalized;
    try {
      normalized = normalizeStoredSource(stored.source);
    } catch (err) {
      res.status(409).json({
        error: `The stored source could not be re-normalized: ${err instanceof Error ? err.message : String(err)}`,
        code: "source_renormalization_failed",
      });
      return;
    }
    if (start > normalized.lineCount) {
      res.status(422).json({
        error: `Requested start line ${start} is beyond the source (${normalized.lineCount} lines). The provenance record does not match the stored source.`,
        code: "provenance_out_of_range",
        totalLines: normalized.lineCount,
      });
      return;
    }
    const clampedEnd = Math.min(end, normalized.lineCount);
    // Ranges wider than the cap return a clearly-labeled partial excerpt —
    // exact lines, never fabricated, with the truncation surfaced.
    const requestedEnd = clampedEnd;
    const partial = end - start + 1 > MAX_EXCERPT_LINES;
    const effectiveEnd = Math.min(clampedEnd, start + MAX_EXCERPT_LINES - 1);
    res.json({
      source: { name: stored.source.name, type: stored.source.type },
      requested: { start, end },
      returned: { start, end: effectiveEnd },
      partial,
      requestedEnd: partial ? requestedEnd : undefined,
      excerptLimit: partial ? MAX_EXCERPT_LINES : undefined,
      totalLines: normalized.lineCount,
      text: sourceSlice(normalized, start, effectiveEnd),
    });
  }));

  // Re-run deterministic validation on demand.
  app.post("/api/skills/:id/validate", asyncRoute(async (req, res) => {
    const target = typeof req.body?.target === "string" ? (req.body.target as ExportTarget) : undefined;
    try {
      const report = await revalidateSkillImpl(
        req.params.id!,
        (skill, sourceText, sourceType) =>
          validatePackage({ skill, sourceText, target, sourceType }),
      );
      res.json({ validation: report });
    } catch (err) {
      if (err instanceof EditError && err.code === "skill_not_found") {
        res.status(404).json({ error: `No skill with id "${req.params.id}".` });
        return;
      }
      if (err instanceof SourceRenormalizationError) {
        res.status(409).json({
          error: err.message,
          code: "source_renormalization_failed",
        });
        return;
      }
      throw err;
    }
  }));

  // Edit one generated text file before export. The stored skill is updated
  // atomically, the file is marked user-edited (its provenance records are
  // dropped), manifest hashes are resynchronized, and deterministic validation
  // re-runs against the edited content before the new state is served.
  app.post("/api/skills/:id/update-file", asyncRoute(async (req, res) => {
    const parsed = UpdateFileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid edit request.",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    try {
      const stored = await updateFileContentImpl(
        req.params.id!,
        parsed.data.path,
        parsed.data.content,
        (skill, sourceText, sourceType) =>
          validatePackage({ skill, sourceText, target: undefined, sourceType }),
      );
      res.json(toResponse(stored));
    } catch (err) {
      if (err instanceof EditError) {
        const status =
          err.code === "skill_not_found" || err.code === "file_not_found"
            ? 404
            : err.code === "edit_too_large"
              ? 413
              : 400;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof SourceRenormalizationError) {
        res.status(409).json({
          error: err.message,
          code: "source_renormalization_failed",
        });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "edit_failed" });
    }
  }));

  // Export: re-validates, refuses packages with errors, streams a real ZIP.
  app.post("/api/skills/:id/export", asyncRoute(async (req, res) => {
    const stored = await loadSkillImpl(req.params.id!);
    if (!stored) {
      res.status(404).json({ error: `No skill with id "${req.params.id}".` });
      return;
    }
    const parsed = ExportBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid export target.",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        supported: EXPORT_TARGET_INFO.map((t) => t.target),
      });
      return;
    }
    const target = parsed.data.target;

    let normalized;
    try {
      normalized = normalizeStoredSource(stored.source);
    } catch (err) {
      res.status(409).json({
        error: `The stored source could not be re-normalized: ${err instanceof Error ? err.message : String(err)}`,
        code: "source_renormalization_failed",
      });
      return;
    }

    // Validation gate: never export a package that fails deterministic checks.
    const report = validatePackage({
      skill: stored.skill,
      sourceText: normalized.text,
      target,
      sourceType: stored.source.type,
    });
    if (!report.passed) {
      res.status(422).json({
        error: `Export blocked: deterministic validation found ${report.errorCount} error(s). Inspect the validation panel, repair the source or plan, and try again.`,
        validation: report,
      });
      return;
    }

    try {
      const exported = exportPackage(stored.skill, target);
      void buildZip(exported).then((zip) => {
        res.setHeader("content-type", "application/zip");
        res.setHeader("content-disposition", `attachment; filename="${zip.fileName}"`);
        res.setHeader("x-skillforge-validation", JSON.stringify({ passed: report.passed, warnings: report.warningCount }));
        res.setHeader("x-skillforge-entries", String(zip.entries.length));
        res.status(200).send(zip.buffer);
      }).catch((err) => {
        const code = err instanceof ExportError ? err.code : "export_failed";
        res.status(500).json({ error: err instanceof Error ? err.message : String(err), code });
      });
    } catch (err) {
      const code = err instanceof ExportError ? err.code : "export_failed";
      const status = err instanceof ExportError && err.code === "export_target_unsupported" ? 400 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err), code });
    }
  }));

  // Registered after all routes: catches body-parser failures (malformed or
  // oversized JSON) and any error that reaches the end of the middleware
  // chain, so clients get honest JSON instead of an HTML stack trace.
  app.use(terminalErrorHandler);

  return app;
}

/**
 * Terminal error handler. JSON only — never an HTML stack trace. body-parser
 * failures (malformed JSON, oversized bodies) are mapped to honest statuses;
 * anything unexpected becomes a generic 500 that echoes no error internals.
 */
export function terminalErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    // The response is already streaming (e.g. NDJSON generation); the stream
    // owner is responsible for it. Terminate instead of writing a second body.
    res.end();
    return;
  }
  const type =
    typeof err === "object" && err !== null && "type" in err
      ? String((err as { type?: unknown }).type)
      : "";
  if (type === "entity.too.large") {
    res.status(413).json({
      error: `Request body too large. The JSON body limit is 3 MB.`,
      code: "payload_too_large",
    });
    return;
  }
  if (type === "entity.parse.failed" || type === "entity.decode.failed" || type === "encoding.invalid") {
    res.status(400).json({
      error: "Request body is not valid JSON for content-type application/json.",
      code: "invalid_json_body",
    });
    return;
  }
  res.status(500).json({ error: "Internal server error.", code: "internal_error" });
}
