import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import JSZip from "jszip";
import { createApp } from "../src/server/app.js";
import { normalizeStoredSource } from "../src/server/store.js";
import { MAX_PDF_BYTES } from "../src/core/sources/pdf.js";
import { PDF_GUIDE, pdfFixture } from "./helpers/pdf-fixture.js";

describe("PDF API integration", () => {
  let sandbox: string;
  let root: string;
  let app: ReturnType<typeof createApp>;
  const config = { provider: "mock", hasApiKey: false };
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "skillforge-api-pdf-"));
    root = join(sandbox, "docs");
    await mkdir(root);
    vi.stubEnv("SKILLFORGE_DOCS_ROOT", root);
    app = createApp(config, { storeRoot: join(sandbox, "store") });
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(sandbox, { recursive: true, force: true }); });

  it("requires a local PDF path and keeps mode GitHub-only", async () => {
    for (const body of [{ sourceType: "pdf" }, { sourceType: "pdf", path: " " }, { sourceType: "pdf", content: PDF_GUIDE.join("\n") }]) {
      const res = await request(app).post("/api/generate").send(body).expect(400);
      expect(res.body.code).toBe("pdf_bad_path");
    }
    const res = await request(app).post("/api/generate").send({ sourceType: "pdf", path: "guide.pdf", mode: "docs" }).expect(400);
    expect(res.body.error).toContain("only supported for sourceType 'github'");
  });

  it("streams, persists notes and literal source, then revalidates/edits/exports after PDF removal and restart", async () => {
    await writeFile(join(root, "guide.pdf"), pdfFixture([PDF_GUIDE, []]));
    const response = await request(app).post("/api/generate").send({ sourceType: "pdf", path: "guide.pdf" }).expect(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    const events = response.text.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1).type).toBe("done");
    const result = events.find((e) => e.type === "result");
    expect(result.validation).toMatchObject({ executed: true, passed: true });
    expect(events.filter((e) => e.type === "stage" && e.status === "done")).toHaveLength(4);
    const id = result.skill.id;
    const before = await request(app).get(`/api/skills/${id}`).expect(200);
    expect(before.body.source.type).toBe("pdf");
    expect(before.body.source.text).toContain('<div class="example">');
    expect(before.body.source.text).not.toContain("%PDF-");
    expect(before.body.source.notes).toEqual(events.filter((e) => e.type === "source-note").map((e) => e.note));
    expect(before.body.source.notes.join(" ")).toContain("no extractable text: 2");
    const manifest = JSON.parse(result.skill.files.find((f: { path: string }) => f.path === "manifest.json").content);
    expect(manifest.source.notes).toEqual(before.body.source.notes);
    const normalized = normalizeStoredSource(before.body.source);
    expect(manifest.source.sha256).toBe(normalized.sha256);
    await rm(join(root, "guide.pdf"));
    app = createApp(config, { storeRoot: join(sandbox, "store") });
    const loaded = await request(app).get(`/api/skills/${id}`).expect(200);
    expect(loaded.body.source).toEqual(before.body.source);
    for (const provenance of result.skill.provenance) {
      const [start, end] = provenance.sourceLines;
      const excerpt = await request(app).get(`/api/skills/${id}/provenance/excerpt?start=${start}&end=${end}`).expect(200);
      expect(excerpt.body.text).toBe(normalized.text.split("\n").slice(start - 1, end).join("\n"));
    }
    const validation = await request(app).post(`/api/skills/${id}/validate`).send({}).expect(200);
    expect(validation.body.validation).toMatchObject({ executed: true, passed: true });
    const skillFile = result.skill.files.find((f: { path: string }) => f.path === "SKILL.md");
    const edit = await request(app).post(`/api/skills/${id}/update-file`).send({ path: "SKILL.md", content: skillFile.content + "\nReview the source before use.\n" }).expect(200);
    expect(edit.body.validation).toMatchObject({ executed: true, passed: true });
    const exported = await request(app).post(`/api/skills/${id}/export`).send({ target: "generic" })
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
    const zip = await JSZip.loadAsync(exported.body);
    expect(await zip.file(`${id}/SKILL.md`)!.async("string")).toContain("Review the source before use.");
    expect(zip.file(`${id}/manifest.json`)).not.toBeNull();
    expect(zip.file(`${id}/AGENTS.md`)).not.toBeNull();
  });

  it("maps safe boundary and content errors deliberately before streaming", async () => {
    await writeFile(join(sandbox, "outside.pdf"), pdfFixture());
    await writeFile(join(root, "blank.pdf"), pdfFixture([[]]));
    await writeFile(join(root, "invalid.pdf"), "not a PDF");
    const file = await open(join(root, "huge.pdf"), "w");
    await file.truncate(MAX_PDF_BYTES + 1);
    await file.close();
    for (const [path, status, code] of [
      [join(sandbox, "outside.pdf"), 403, "pdf_outside_root"], ["missing.pdf", 404, "pdf_not_found"],
      ["huge.pdf", 413, "pdf_too_large"], ["blank.pdf", 422, "pdf_no_text"], ["invalid.pdf", 422, "pdf_invalid"],
      ["bad\0.pdf", 400, "pdf_bad_path"],
    ] as const) {
      const res = await request(app).post("/api/generate").send({ sourceType: "pdf", path }).expect(status);
      expect(res.body.code).toBe(code);
      expect(res.body.error).not.toContain(sandbox);
      expect(res.headers["content-type"]).toContain("application/json");
    }
  });
});
