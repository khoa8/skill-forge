/**
 * Regression tests for F-02 and F-03:
 * - Claude export semantic YAML handling & manifest hash synchronization (F-02)
 * - Final post-transformation export validation gate (F-02)
 * - User edit provenance removal, manifest userEdited flag, generator claim qualification (F-03)
 * - Repeated-edit idempotency (F-03)
 * - Unzipped ZIP byte and manifest verification (F-02, F-03)
 */
import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";
import { getSample } from "../src/core/samples.js";
import { buildCanonicalSkill } from "../src/core/build.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { derivePlanFromAnalysis } from "../src/core/build.js";
import * as exporterModule from "../src/core/export/exporters.js";
import { exportPackage, buildZip } from "../src/core/export/exporters.js";
import { validatePackage } from "../src/core/validate.js";
import { sha256 } from "../src/core/util.js";
import type { CanonicalSkill } from "../src/core/types.js";

const binaryParser = (res: unknown, cb: (err: Error | null, body?: unknown) => void) => {
  const chunks: Buffer[] = [];
  (res as { on: (ev: string, fn: (c: Buffer) => void) => void }).on("data", (c) => chunks.push(c));
  (res as { on: (ev: string, fn: () => void) => void }).on("end", () => cb(null, Buffer.concat(chunks)));
};

function buildTestSkill(name = "meridian-payments-api"): CanonicalSkill {
  const sample = getSample("meridian-payments-api");
  const normalized = normalizeSource({ type: "sample", name: sample.meta.title, content: sample.content });
  const analysis = analyzeSource(normalized);
  const plan = derivePlanFromAnalysis(analysis);
  plan.name = name;
  return buildCanonicalSkill(normalized, analysis, plan, "mock");
}

describe("F-02: Claude export semantic YAML & final manifest integrity", () => {
  it("F02-A: preserves semantically equivalent quoted YAML through claude export", async () => {
    const skill = buildTestSkill("meridian-payments-api");
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!;

    // Edit front matter with quoted name and customized description
    const editedSkillMd = skillMd.content.replace(
      /^---\nname:\s*meridian-payments-api\ndescription:\s*([^\n]+)\n---/,
      '---\nname: "meridian-payments-api"\ndescription: "Custom edited description"\n---',
    );
    skillMd.content = editedSkillMd;

    const exported = exportPackage(skill, "claude-code");
    const zipResult = await buildZip(exported);

    const zip = await JSZip.loadAsync(zipResult.buffer);
    const unzippedSkillMd = await zip.file("meridian-payments-api/SKILL.md")?.async("string");

    expect(unzippedSkillMd).toBeDefined();
    // The quoted spelling must be preserved byte-for-byte
    expect(unzippedSkillMd).toContain('name: "meridian-payments-api"');
    expect(unzippedSkillMd).toContain('description: "Custom edited description"');
  });

  it("F02-B: unzipped ZIP manifest hashes and bytes match transformed file contents", async () => {
    const skill = buildTestSkill("meridian-payments-api");

    // Test both targets
    for (const target of ["claude-code", "generic"] as const) {
      const exported = exportPackage(skill, target);
      const zipResult = await buildZip(exported);

      const zip = await JSZip.loadAsync(zipResult.buffer);
      const manifestRaw = await zip.file(`${skill.meta.name}/manifest.json`)?.async("string");
      expect(manifestRaw).toBeDefined();

      const manifest = JSON.parse(manifestRaw!);
      expect(Array.isArray(manifest.files)).toBe(true);

      for (const entry of manifest.files) {
        const zipFile = zip.file(`${skill.meta.name}/${entry.path}`);
        expect(zipFile).toBeDefined();
        const content = await zipFile!.async("nodebuffer");
        expect(content.length).toBe(entry.bytes);
        expect(sha256(content.toString("utf8"))).toBe(entry.sha256);
      }
    }
  });

  it("F02-C: server export endpoint validates post-transformation package and refuses invalidity (HTTP 422)", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });

      // Generate skill
      await request(app)
        .post("/api/generate")
        .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "export-val" })
        .expect(200);

      const store = (await import("../src/server/store.js")).createStore(storeRoot);
      const stored = (await store.getSkill("export-val"))!;
      const source = normalizeSource({ type: stored.source.type, name: stored.source.name, content: stored.source.text });
      expect(validatePackage({ skill: stored.skill, sourceText: source.text, target: "generic" }).passed).toBe(true);
      const actualExport = exporterModule.exportPackage;
      const transform = vi.spyOn(exporterModule, "exportPackage").mockImplementation((skill, target) => {
        const exported = actualExport(skill, target);
        // Only the final representation is broken. The stored canonical input
        // remains valid, proving this request reaches the second gate.
        exported.files = exported.files.map((f) => f.path === "AGENTS.md" ? { ...f, content: f.content + "\nChanged after manifest creation.\n" } : f);
        return exported;
      });
      const zip = vi.spyOn(exporterModule, "buildZip");
      try {
        const res = await request(app).post("/api/skills/export-val/export")
          .send({ target: "generic" }).expect(422);
        expect(transform).toHaveBeenCalledOnce();
        expect(zip).not.toHaveBeenCalled();
        expect(res.body.error).toContain("in the exported package");
        expect(res.body.validation.passed).toBe(false);
        expect(res.body.validation.checks.some((c: { id: string; status: string }) => c.id === "manifest-consistency" && c.status === "fail")).toBe(true);
        expect(res.headers["content-type"]).toContain("application/json");
        expect(res.headers["x-skillforge-validation"]).toBeUndefined();
      } finally { vi.restoreAllMocks(); }
    } finally {
      await cleanup();
    }
  });

  it("F02-D: generic export preserves AGENTS.md wrapper and keeps manifest consistent", async () => {
    const skill = buildTestSkill("meridian-payments-api");
    const exported = exportPackage(skill, "generic");
    const zipResult = await buildZip(exported);

    const zip = await JSZip.loadAsync(zipResult.buffer);
    const agentsMd = await zip.file("meridian-payments-api/AGENTS.md")?.async("string");
    expect(agentsMd).toBeDefined();
    expect(agentsMd).toContain("# AGENTS.md — Meridian Payments API");

    const manifestRaw = await zip.file("meridian-payments-api/manifest.json")?.async("string");
    const manifest = JSON.parse(manifestRaw!);
    const agentsEntry = manifest.files.find((f: { path: string }) => f.path === "AGENTS.md");
    expect(agentsEntry).toBeDefined();
    expect(agentsEntry.bytes).toBe(Buffer.byteLength(agentsMd!, "utf8"));
    expect(agentsEntry.sha256).toBe(sha256(agentsMd!));
  });
});

describe("F-03: Edit provenance removal, manifest userEdited, and honest qualification", () => {
  it("F03-A: body-only reference edit drops provenance, marks manifest userEdited, and qualifies verbatim claims", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = (await import("../src/server/store.js")).createStore(storeRoot);
      const skill = buildTestSkill("ref-edit-test");
      await store.saveSkill({
        id: "ref-edit-test",
        skill,
        analysis: { title: "Test", sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 1, lineCount: 50 },
        source: { name: getSample("meridian-payments-api").meta.title, type: "text", text: "# Test Source\n\nContent for testing purposes." },
        validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
        createdAt: new Date().toISOString(),
      });

      const refFile = skill.files.find((f) => f.path.startsWith("references/"))!;
      const originalContent = refFile.content;

      // Edit only a sentence in the body, keeping generator header and footer intact in submitted text
      const editedContent = originalContent.replace("bearer token", "custom bearer token");
      expect(editedContent).not.toBe(originalContent);

      const defaultValidator = (s: CanonicalSkill, src: string, st: any) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      const updated = await store.updateFileContent(
        "ref-edit-test",
        refFile.path,
        editedContent,
        defaultValidator,
      );

      const updatedRef = updated.skill.files.find((f) => f.path === refFile.path)!;
      expect(updatedRef.userEdited).toBe(true);

      // Structured provenance removed
      expect(updated.skill.provenance.some((p) => p.filePath === refFile.path)).toBe(false);

      // Purpose updated truthfully
      expect(updatedRef.purpose).toMatch(/^User-edited file; originally:/);

      // Generator claims qualified
      expect(updatedRef.content).not.toContain("Verbatim except for this header");
      expect(updatedRef.content).toContain("Originally generated from source");
      expect(updatedRef.content).toContain("edited after generation");
      expect(updatedRef.content).toContain("not guaranteed verbatim");

      // Substantive user edit preserved
      expect(updatedRef.content).toContain("custom bearer token");

      // Manifest marks file userEdited: true
      const manifestFile = updated.skill.files.find((f) => f.path === "manifest.json")!;
      const manifest = JSON.parse(manifestFile.content);
      const entry = manifest.files.find((f: any) => f.path === refFile.path);
      expect(entry.userEdited).toBe(true);

      // Validation passes with userEdited: true
      expect(updated.validation.passed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("F03-B: ZIP inspection confirms exported edited package does not claim verbatim and has manifest userEdited", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });

      await request(app)
        .post("/api/generate")
        .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "zip-edit-test" })
        .expect(200);

      // Edit a reference file
      await request(app)
        .post("/api/skills/zip-edit-test/update-file")
        .send({
          path: "references/authentication.md",
          content: "# Authentication\n\n> Excerpt from source \"Meridian Payments API\" (lines 5–20). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.\n\nUser modified auth instructions.\n\n_Source: Meridian Payments API, lines 5–20._\n",
        })
        .expect(200);

      // Download ZIP
      const exportRes = await request(app)
        .post("/api/skills/zip-edit-test/export")
        .parse(binaryParser)
        .send({ target: "claude-code" })
        .expect(200);

      const zip = await JSZip.loadAsync(exportRes.body);
      const unzippedRef = await zip.file("zip-edit-test/references/authentication.md")?.async("string");
      expect(unzippedRef).toBeDefined();
      expect(unzippedRef).not.toContain("Verbatim except for this header");
      expect(unzippedRef).toContain("Originally generated from source");
      expect(unzippedRef).toContain("User modified auth instructions.");

      const unzippedManifest = await zip.file("zip-edit-test/manifest.json")?.async("string");
      const manifest = JSON.parse(unzippedManifest!);
      const refEntry = manifest.files.find((f: any) => f.path === "references/authentication.md");
      expect(refEntry.userEdited).toBe(true);
      expect(refEntry.bytes).toBe(Buffer.byteLength(unzippedRef!, "utf8"));
      expect(refEntry.sha256).toBe(sha256(unzippedRef!));
    } finally {
      await cleanup();
    }
  });

  it("F03-C: SKILL.md edit qualifies grounding banner", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });

      await request(app)
        .post("/api/generate")
        .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "skill-edit-test" })
        .expect(200);

      const store = (await import("../src/server/store.js")).createStore(storeRoot);
      const stored = await store.getSkill("skill-edit-test");
      const originalSkillMd = stored!.skill.files.find((f) => f.path === "SKILL.md")!.content;

      // Make a body edit while retaining original grounding banner
      const editedSkillMd = originalSkillMd.replace("## Verification", "## Verification\n\nUser custom verification step.");

      const editRes = await request(app)
        .post("/api/skills/skill-edit-test/update-file")
        .send({ path: "SKILL.md", content: editedSkillMd })
        .expect(200);

      const newSkillMd = editRes.body.skill.files.find((f: any) => f.path === "SKILL.md").content;
      expect(newSkillMd).not.toContain("Every factual claim below is grounded in that source; explicit gaps are marked.");
      expect(newSkillMd).toContain("edited after generation");
      expect(newSkillMd).toContain("no longer guaranteed to be fully source-derived");
      expect(newSkillMd).toContain("User custom verification step.");
    } finally {
      await cleanup();
    }
  });

  it("F03-D: workflow edit qualifies header and strips per-step source line markers", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = (await import("../src/server/store.js")).createStore(storeRoot);
      const skill = buildTestSkill("wf-edit-test");
      const wf = skill.files.find((f) => f.path.startsWith("workflows/"));
      expect(wf).toBeDefined();
      if (!wf) throw new Error("Required wf fixture missing");

      await store.saveSkill({
        id: "wf-edit-test",
        skill,
        analysis: { title: "Test", sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 1, lineCount: 50 },
        source: { name: getSample("meridian-payments-api").meta.title, type: "text", text: "# Test Source\n\nContent for testing purposes exceeding forty characters." },
        validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
        createdAt: new Date().toISOString(),
      });

      const defaultValidator = (s: CanonicalSkill, src: string, st: any) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      const updated = await store.updateFileContent(
        "wf-edit-test",
        wf.path,
        wf.content + "\nAdditional user instruction.",
        defaultValidator,
      );

      const updatedWf = updated.skill.files.find((f) => f.path === wf.path)!;
      expect(updatedWf.content).not.toContain("Steps are verbatim from the source");
      expect(updatedWf.content).toContain("edited after generation");
      expect(updatedWf.content).not.toMatch(/\(source line \d+\)/);
    } finally {
      await cleanup();
    }
  });

  it("F03-E: example edit qualifies comment banner", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = (await import("../src/server/store.js")).createStore(storeRoot);
      const skill = buildTestSkill("ex-edit-test");
      const ex = skill.files.find((f) => f.path.startsWith("examples/"));
      expect(ex).toBeDefined();
      if (!ex) throw new Error("Required ex fixture missing");

      await store.saveSkill({
        id: "ex-edit-test",
        skill,
        analysis: { title: "Test", sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 1, lineCount: 50 },
        source: { name: getSample("meridian-payments-api").meta.title, type: "text", text: "# Test Source\n\nContent for testing purposes exceeding forty characters." },
        validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
        createdAt: new Date().toISOString(),
      });

      const defaultValidator = (s: CanonicalSkill, src: string, st: any) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      const updated = await store.updateFileContent(
        "ex-edit-test",
        ex.path,
        ex.content + "\n// user added line",
        defaultValidator,
      );

      const updatedEx = updated.skill.files.find((f) => f.path === ex.path)!;
      expect(updatedEx.content).not.toContain("Verbatim code block");
      expect(updatedEx.content).toContain("edited after generation");
    } finally {
      await cleanup();
    }
  });

  it("F03-F: untouched files keep exact provenance and are not marked userEdited", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = (await import("../src/server/store.js")).createStore(storeRoot);
      const skill = buildTestSkill("untouched-test");
      await store.saveSkill({
        id: "untouched-test",
        skill,
        analysis: { title: "Test", sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 1, lineCount: 50 },
        source: { name: getSample("meridian-payments-api").meta.title, type: "text", text: "# Test Source\n\nContent for testing purposes exceeding forty characters." },
        validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
        createdAt: new Date().toISOString(),
      });

      // Edit only one file
      const defaultValidator = (s: CanonicalSkill, src: string, st: any) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      const updated = await store.updateFileContent(
        "untouched-test",
        "references/authentication.md",
        "# Modified",
        defaultValidator,
      );

      const manifestFile = updated.skill.files.find((f) => f.path === "manifest.json")!;
      const manifest = JSON.parse(manifestFile.content);

      // references/test-cards.md was untouched
      const untouchedEntry = manifest.files.find((f: any) => f.path === "references/test-cards.md");
      if (untouchedEntry) {
        expect(untouchedEntry.userEdited).toBeUndefined();
      }

      // Untouched file still has provenance
      expect(updated.skill.provenance.some((p) => p.filePath === "references/test-cards.md")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("Repeated edit idempotency: multiple edits do not duplicate banners or stack purpose prefixes", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = (await import("../src/server/store.js")).createStore(storeRoot);
      const skill = buildTestSkill("idempotency-test");
      await store.saveSkill({
        id: "idempotency-test",
        skill,
        analysis: { title: "Test", sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 1, lineCount: 50 },
        source: { name: getSample("meridian-payments-api").meta.title, type: "text", text: "# Test Source\n\nContent for testing purposes exceeding forty characters." },
        validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
        createdAt: new Date().toISOString(),
      });

      const defaultValidator = (s: CanonicalSkill, src: string, st: any) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // First edit
      const edit1 = await store.updateFileContent(
        "idempotency-test",
        "SKILL.md",
        skill.files.find((f) => f.path === "SKILL.md")!.content + "\nEdit 1",
        defaultValidator,
      );
      const file1 = edit1.skill.files.find((f) => f.path === "SKILL.md")!;
      expect(file1.purpose).toBe("User-edited file; originally: Primary skill instructions: when to use, inputs, workflow, constraints, verification, pitfalls.");

      // Second edit
      const edit2 = await store.updateFileContent(
        "idempotency-test",
        "SKILL.md",
        file1.content + "\nEdit 2",
        defaultValidator,
      );
      const file2 = edit2.skill.files.find((f) => f.path === "SKILL.md")!;
      // Purpose must not duplicate prefix
      expect(file2.purpose).toBe("User-edited file; originally: Primary skill instructions: when to use, inputs, workflow, constraints, verification, pitfalls.");

      // Banner count in SKILL.md must be exactly 1
      const bannerMatches = file2.content.match(/no longer guaranteed to be fully source-derived/g);
      expect(bannerMatches?.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("Manifest userEdited validation: non-boolean value fails deterministic validation", async () => {
    const skill = buildTestSkill("user-edited-type-test");
    const manifestFile = skill.files.find((f) => f.path === "manifest.json")!;
    const manifest = JSON.parse(manifestFile.content);

    // Set invalid non-boolean userEdited value
    manifest.files[0].userEdited = "yes";
    manifestFile.content = JSON.stringify(manifest, null, 2);

    const report = validatePackage({ skill });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.message?.includes('expected boolean, got "yes"'))).toBe(true);
  });
});


describe("Generic edited-file provenance", () => {
  it("exports edited references without restoring verbatim claims and retains edit flags and hashes", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
      await request(app).post("/api/generate").send({ sourceType: "sample", sampleId: "meridian-payments-api" }).expect(200);
      const edited = await request(app).post("/api/skills/meridian-payments-api/update-file").send({
        path: "references/test-cards.md", content: "# Reviewed test cards\n\nUse only the sandbox cards reviewed by the author.",
      }).expect(200);
      expect(edited.body.validation.checks.find((c: { id: string }) => c.id === "provenance-integrity").status).toBe("pass");
      const res = await request(app).post("/api/skills/meridian-payments-api/export").send({ target: "generic" }).buffer(true).parse(binaryParser).expect(200);
      const zip = await JSZip.loadAsync(res.body);
      const agents = await zip.file("meridian-payments-api/AGENTS.md")!.async("string");
      expect(agents).not.toMatch(/verbatim|source-derived/);
      expect(agents).toContain("userEdited status");
      const manifest = JSON.parse(await zip.file("meridian-payments-api/manifest.json")!.async("string"));
      const entry = manifest.files.find((f: { path: string }) => f.path === "references/test-cards.md");
      const content = await zip.file(`meridian-payments-api/${entry.path}`)!.async("string");
      expect(entry.userEdited).toBe(true);
      expect(entry.bytes).toBe(Buffer.byteLength(content));
      expect(entry.sha256).toBe(sha256(content));
    } finally { await cleanup(); }
  });

  it("accepts intentional provenance absence but rejects retained source claims on edited files", () => {
    const skill = buildTestSkill();
    const file = skill.files.find((f) => f.path.startsWith("references/"))!;
    file.userEdited = true;
    const check = () => validatePackage({ skill }).checks.filter((c) => c.id === "provenance-integrity");
    expect(check().some((c) => c.status === "fail")).toBe(true);
    skill.provenance = skill.provenance.filter((p) => p.filePath !== file.path);
    expect(check()).toEqual([expect.objectContaining({ status: "pass" })]);
    file.userEdited = false;
    expect(check().some((c) => c.status === "warn")).toBe(true);
  });
});

describe("canonical body and target description export gates", () => {
  it("rejects a bodyless edited skill before ZIP construction", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
      await request(app).post("/api/generate").send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "body-gate" });
      const stored = await request(app).get("/api/skills/body-gate").expect(200);
      const original = stored.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md").content;
      const content = original.match(/^---\n[\s\S]*?\n---/)[0] + "\n";
      const edited = await request(app).post("/api/skills/body-gate/update-file").send({ path: "SKILL.md", content }).expect(200);
      expect(edited.body.validation.passed).toBe(false);
      const zip = vi.spyOn(exporterModule, "buildZip");
      try {
        const res = await request(app).post("/api/skills/body-gate/export").send({ target: "claude-code" }).expect(422);
        expect(res.body.validation.checks).toContainEqual(expect.objectContaining({ id: "skill-instructions", status: "fail" }));
        expect(zip).not.toHaveBeenCalled();
      } finally { zip.mockRestore(); }
    } finally { await cleanup(); }
  });
  it("preserves 1024-character YAML and rejects 1025 only for Claude before ZIP", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
      await request(app).post("/api/generate").send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "description-gate" });
      const stored = await request(app).get("/api/skills/description-gate").expect(200);
      const original = stored.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md").content;
      for (const length of [1024, 1025]) {
        const content = original.replace(/^description:.*$/m, `description: '${"x".repeat(length)}' # preserve formatting`);
        const edited = await request(app).post("/api/skills/description-gate/update-file").send({ path: "SKILL.md", content }).expect(200);
        expect(edited.body.validation.passed).toBe(true);
        if (length === 1025) {
          expect(() => exportPackage(edited.body.skill, "claude-code")).toThrow(/1024/);
          const zip = vi.spyOn(exporterModule, "buildZip");
          try {
            await request(app).post("/api/skills/description-gate/export").send({ target: "claude-code" }).expect(422);
            expect(zip).not.toHaveBeenCalled();
          } finally { zip.mockRestore(); }
        }
        const target = length === 1024 ? "claude-code" : "generic";
        const res = await request(app).post("/api/skills/description-gate/export").send({ target }).parse(binaryParser).expect(200);
        const zip = await JSZip.loadAsync(res.body);
        expect(await zip.file("description-gate/SKILL.md")!.async("string")).toContain(`description: '${"x".repeat(length)}' # preserve formatting`);
      }
    } finally { await cleanup(); }
  });
});

describe("punctuation-safe edited provenance", () => {
  it.each([`Alice's "API", notes`, "Unicode — café / 東京", "comma,name", 'quote"name', "apostrophe'name", "regex.* [$&] `name`", "two\nlines"])("qualifies generated templates and exported manifest for %s", async (name) => {
    const { qualifyEditedFileContent } = await import("../src/core/build.js");
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
      await request(app).post("/api/generate").send({ sourceType: "text", content: getSample("meridian-payments-api").content, name, requestedName: "punctuation" });
      const res = await request(app).get("/api/skills/punctuation").expect(200);
      const files = res.body.skill.files as CanonicalSkill["files"];
      const paths = ["SKILL.md", "evals/README.md", files.find((f) => f.path.startsWith("references/"))!.path,
        files.find((f) => f.path.startsWith("workflows/"))!.path,
        files.find((f) => f.path.startsWith("examples/") && f.content.includes("Verbatim code block"))!.path];
      const userProse = "User prose: verbatim source, grounded claims and (source line 12) are discussed here.";
      for (const path of paths) {
        const file = files.find((f) => f.path === path)!;
        const content = file.content + `\n${userProse}\n`;
        const edited = await request(app).post("/api/skills/punctuation/update-file").send({ path, content }).expect(200);
        const updated = edited.body.skill.files.find((f: { path: string }) => f.path === path);
        expect(updated.userEdited).toBe(true);
        expect(updated.content).toContain("edited after generation");
        expect(updated.content).toContain(userProse);
        expect(updated.content).not.toMatch(/Every factual claim below is grounded|Verbatim except|Verbatim code block|Steps are verbatim|_Source:|_\(source line \d+\)_/);
        expect(qualifyEditedFileContent(path, updated.content, name)).toBe(updated.content);
        expect(qualifyEditedFileContent(path, userProse, name)).toBe(userProse);
      }
      const downloaded = await request(app).post("/api/skills/punctuation/export").send({ target: "claude-code" }).parse(binaryParser).expect(200);
      const zip = await JSZip.loadAsync(downloaded.body);
      const manifest = JSON.parse(await zip.file("punctuation/manifest.json")!.async("string"));
      for (const path of paths) {
        const content = await zip.file(`punctuation/${path}`)!.async("string");
        expect(content).toContain("edited after generation");
        expect(manifest.files).toContainEqual(expect.objectContaining({ path, userEdited: true, bytes: Buffer.byteLength(content), sha256: sha256(content) }));
      }
    } finally { await cleanup(); }
  });
});
