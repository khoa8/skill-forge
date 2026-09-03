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
import { exportPackage, buildZip, EXPORT_TARGET_INFO, ExportError } from "../core/export/exporters.js";
import { listSamples, getSample } from "../core/samples.js";
import { fetchUrlSource, UrlSourceError } from "../core/sources/url.js";
import { collectFiles, combineFiles, FileSourceError } from "../core/sources/files.js";
import {
  saveSkill,
  getSkill as loadSkill,
  listSkills,
  updateValidation,
  toResponse,
} from "./store.js";
import type { ExportTarget } from "../core/types.js";
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
  sourceType: z.enum(["text", "sample", "url", "file"]),
  /** For `text`: the pasted content. Required when sourceType is "text". */
  content: z.string().min(1).max(2_000_000).optional(),
  /** For `sample`: bundled sample id. */
  sampleId: z.string().optional(),
  /** For `url`: the page to fetch. */
  url: z.string().max(2048).optional(),
  /** For `file`: workspace-relative file or directory path. */
  path: z.string().max(1024).optional(),
  recursive: z.boolean().optional(),
  name: z.string().max(200).optional(),
  requestedName: z.string().max(80).optional(),
  provider: z.enum(PROVIDER_IDS).optional(),
});

const ExportBody = z.object({ target: z.enum(["claude-code", "generic"]) });

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
    if (body.sourceType === "sample") {
      if (!body.sampleId) {
        res.status(400).json({ error: "sourceType 'sample' requires `sampleId`." });
        return;
      }
      try {
        const sample = getSample(body.sampleId);
        content = sample.content;
        name = sample.meta.title;
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
      } catch (err) {
        const status = err instanceof UrlSourceError && err.code === "url_invalid" ? 400 : 502;
        res.status(status).json({
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof UrlSourceError ? err.code : "url_fetch_failed",
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
        sourceNotes = [
          `Read ${collected.files.length} file(s) from the allowed root.`,
          ...(collected.skipped.length > 0 ? [`Skipped: ${collected.skipped.slice(0, 5).join("; ")}${collected.skipped.length > 5 ? "; …" : ""}`] : []),
        ];
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
    void (async () => {
      try {
        for await (const event of runPipeline(
          { type: body.sourceType === "sample" ? "sample" : body.sourceType === "file" ? "file" : "text", name, content },
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
              source: { name, type: body.sourceType === "sample" ? "sample" : body.sourceType === "file" ? "file" : "text", text: content },
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
