/**
 * Express application: REST API + static UI.
 *
 * Generation streams NDJSON pipeline events (one JSON object per line) so the
 * UI shows real per-stage progress. Export re-runs deterministic validation
 * and refuses packages with errors — the download button is never a fake.
 */
import express, { type Express, type Request, type Response } from "express";
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
  saveSkill,
  getSkill as loadSkill,
  listSkills,
  updateValidation,
  updateFileContent,
  EditError,
  toResponse,
} from "./store.js";
import type { ExportTarget, SourceType } from "../core/types.js";
import { PROVIDER_IDS } from "../core/providers/index.js";

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
  recursive: z.boolean().optional(),
  name: z.string().max(200).optional(),
  requestedName: z.string().max(80).optional(),
  provider: z.enum(PROVIDER_IDS).optional(),
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
  baseUrl?: string;
  model?: string;
}

export function createApp(config: AppConfig): Express {
  const app = express();
  app.disable("x-powered-by");
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

  app.post("/api/generate", async (req: Request, res: Response) => {
    const parsed = GenerateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body.",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    const body = parsed.data;

    let content: string;
    let name: string;
    let sourceNotes: string[] = [];
    /** Canonical SourceInput type for this request (notes ride along). */
    let inputType: SourceType = "text";
    /** Adapter notes (truncation, redirects, skipped files) — persisted with the skill. */
    let adapterNotes: string[] = [];
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
        const status = err instanceof UrlSourceError && err.code === "url_invalid" ? 400 : 502;
        res.status(status).json({
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof UrlSourceError ? err.code : "url_fetch_failed",
        });
        return;
      }
    } else if (body.sourceType === "github") {
      if (!body.repo) {
        res.status(400).json({ error: "sourceType 'github' requires `repo` (a github.com repository or tree URL)." });
        return;
      }
      try {
        const fetched = await fetchGithubSource(body.repo);
        content = fetched.input.content;
        name = body.name?.trim() || fetched.input.name;
        sourceNotes = fetched.notes;
        adapterNotes = fetched.notes;
      } catch (err) {
        const code = err instanceof GithubSourceError ? err.code : "github_fetch_failed";
        const status = err instanceof GithubSourceError ? (GITHUB_ERROR_STATUS[code] ?? 502) : 502;
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
    const pipelineSourceType = PIPELINE_SOURCE_TYPE[body.sourceType];
    void (async () => {
      try {
        for await (const event of runPipeline(
          { type: pipelineSourceType, name, content, notes: adapterNotes },
          {
            provider: body.provider ?? (config.provider as (typeof PROVIDER_IDS)[number]) ?? "mock",
            apiKey: config.hasApiKey ? process.env.SKILLFORGE_API_KEY : undefined,
            baseUrl: config.baseUrl,
            model: config.model,
            requestedName: body.requestedName,
          },
        )) {
          if (event.type === "result") {
            await saveSkill({
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
              source: { name, type: pipelineSourceType, text: content, notes: adapterNotes },
              validation: event.validation,
              createdAt: new Date().toISOString(),
            });
          }
          res.write(JSON.stringify(event) + "\n");
        }
      } catch (err) {
        res.write(
          JSON.stringify({
            type: "error",
            code: "pipeline_stream_failed",
            message: err instanceof Error ? err.message : String(err),
          }) + "\n",
        );
      } finally {
        res.end(`{"type":"done","ms":${Date.now() - started}}\n`);
      }
    })();
  });

  app.get("/api/skills", async (_req, res) => {
    res.json({ skills: await listSkills() });
  });

  app.get("/api/skills/:id", async (req, res) => {
    const stored = await loadSkill(req.params.id!);
    if (!stored) {
      res.status(404).json({ error: `No skill with id "${req.params.id}".` });
      return;
    }
    res.json(toResponse(stored));
  });

  // Provenance click-through: exact lines from the *normalized* source that a
  // provenance record refers to. The stored raw source is re-normalized with
  // the same deterministic function the pipeline used, so line numbers match
  // the record exactly.
  app.get("/api/skills/:id/provenance/excerpt", async (req, res) => {
    const stored = await loadSkill(req.params.id!);
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
      normalized = normalizeSource({ type: stored.source.type, name: stored.source.name, content: stored.source.text });
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
  });

  // Re-run deterministic validation on demand.
  app.post("/api/skills/:id/validate", async (req, res) => {
    const stored = await loadSkill(req.params.id!);
    if (!stored) {
      res.status(404).json({ error: `No skill with id "${req.params.id}".` });
      return;
    }
    const report = validatePackage({
      skill: stored.skill,
      sourceText: stored.source.text,
      target: typeof req.body?.target === "string" ? (req.body.target as ExportTarget) : undefined,
    });
    await updateValidation(stored.id, report);
    res.json({ validation: report });
  });

  // Edit one generated text file before export. The stored skill is updated
  // atomically, the file is marked user-edited (its provenance records are
  // dropped), manifest hashes are resynchronized, and deterministic validation
  // re-runs against the edited content before the new state is served.
  app.post("/api/skills/:id/update-file", async (req, res) => {
    const parsed = UpdateFileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid edit request.",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    try {
      const stored = await updateFileContent(req.params.id!, parsed.data.path, parsed.data.content, (skill, sourceText) =>
        validatePackage({ skill, sourceText, target: undefined }),
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
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: "edit_failed" });
    }
  });

  // Export: re-validates, refuses packages with errors, streams a real ZIP.
  app.post("/api/skills/:id/export", async (req, res) => {
    const stored = await loadSkill(req.params.id!);
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

    // Validation gate: never export a package that fails deterministic checks.
    const report = validatePackage({ skill: stored.skill, sourceText: stored.source.text, target });
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
  });

  return app;
}
