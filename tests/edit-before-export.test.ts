import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from "vitest";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";
import request from "supertest";
import JSZip from "jszip";
import { createApp } from "../src/server/app.js";
import { sha256 } from "../src/core/util.js";
import { createStore } from "../src/server/store.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis } from "../src/core/build.js";
import { validatePackage } from "../src/core/validate.js";
import type { RepositoryAnalysis } from "../src/core/types.js";
import { sampleRepositoryAnalysis } from "./codebase-model.test.js";

/** Edit-before-export: edits persist, are validation-aware, keep the manifest
 * honest, and never allow exporting an unvalidated or failing package. */

function eventsOf(text: string) {
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function findManifestEntry(manifestJson: string, path: string) {
  const manifest = JSON.parse(manifestJson) as {
    files: { path: string; bytes: number; sha256: string }[];
  };
  return manifest.files.find((f) => f.path === path);
}

describe("edit generated files before export", () => {
  let app: ReturnType<typeof createApp>;
let cleanupStore: () => Promise<void>;
beforeAll(async () => {
  const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
  cleanupStore = cleanup;
  app = createApp({ provider: "mock", hasApiKey: false, }, { storeRoot });
});
afterAll(async () => {
  await cleanupStore?.();
});
  // A dedicated id so parallel test files that regenerate the bundled sample
  // cannot clobber this suite's stored skill mid-edit.
  const id = "edit-safe-demo";
  const editPath = "references/test-cards.md";
  let originalSkillMd = "";

  it("generates the base skill first", async () => {
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: id })
      .expect(200);
    const result = eventsOf(res.text).find((e) => e.type === "result");
    expect(result.validation.passed).toBe(true);
    const get = await request(app).get(`/api/skills/${id}`).expect(200);
    originalSkillMd = get.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md").content;
    expect(originalSkillMd.length).toBeGreaterThan(0);
  });

  it("applies a valid edit: persists, resyncs manifest, drops provenance, revalidates", async () => {
    const edited = "## Test cards (user-reviewed)\n\nUse 4242-4242-4242-4242 in the sandbox only.\n";
    const res = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: editPath, content: edited })
      .expect(200);
    const skill = res.body.skill;
    const file = skill.files.find((f: { path: string }) => f.path === editPath);
    expect(file.content).toBe(edited);
    expect(file.userEdited).toBe(true);
    // Provenance for the edited file is dropped — the content is no longer
    // claimed as source-derived.
    expect(skill.provenance.find((p: { filePath: string }) => p.filePath === editPath)).toBeUndefined();
    // Manifest hashes were resynchronized to the new content.
    const manifestFile = skill.files.find((f: { path: string }) => f.path === "manifest.json");
    const entry = findManifestEntry(manifestFile.content, editPath);
    expect(entry).toBeDefined();
    expect(entry!.bytes).toBe(Buffer.byteLength(edited, "utf8"));
    expect(entry!.sha256).toBe(sha256(edited));
    // Validation reflects the edited content and still passes.
    expect(res.body.validation.executed).toBe(true);
    expect(res.body.validation.passed).toBe(true);
    // The honest traceability warning for the user-edited file is present.
    const provCheck = res.body.validation.checks.find((c: { id: string }) => c.id === "provenance-integrity");
    expect(provCheck.status).toBe("warn");
    expect(JSON.stringify(provCheck.message ?? provCheck)).toContain(editPath);
    // Persisted across store round-trips.
    const get = await request(app).get(`/api/skills/${id}`).expect(200);
    expect(get.body.skill.files.find((f: { path: string }) => f.path === editPath).content).toBe(edited);
    expect(get.body.validation.passed).toBe(true);
  });

  it("rejects invalid skill ids and file paths", async () => {
    await request(app)
      .post("/api/skills/does-not-exist/update-file")
      .send({ path: editPath, content: "x" })
      .expect(404);
    await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "references/no-such-file.md", content: "x" })
      .expect(404);
    await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "../escape.md", content: "x" })
      .expect(404);
    await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "manifest.json", content: "{}" })
      .expect(400);
    await request(app).post(`/api/skills/${id}/update-file`).send({ path: editPath }).expect(400);
  });

  it("rejects oversized edits with 413", async () => {
    const big = "x".repeat(1_000_001);
    const res = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: editPath, content: big })
      .expect(413);
    expect(res.body.code).toBe("edit_too_large");
  });

  it("blocks export when an edit breaks validation, then allows it after repair", async () => {
    // Break SKILL.md: no YAML front matter → deterministic errors.
    const broken = "Just some prose without the required front matter.\n";
    const brokenRes = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "SKILL.md", content: broken })
      .expect(200);
    expect(brokenRes.body.validation.passed).toBe(false);
    expect(brokenRes.body.validation.errorCount).toBeGreaterThan(0);

    // Stale/pass-less state must never export: the gate re-validates server-side.
    const blocked = await request(app)
      .post(`/api/skills/${id}/export`)
      .send({ target: "generic" })
      .expect(422);
    expect(blocked.body.error).toContain("Export blocked");

    // Repair with the original content plus a small user addition.
    const repaired = originalSkillMd.replace(
      "## When to use",
      "## When to use (reviewed by the skill author)\n\n- Re-reviewed before export.\n\n## When to use",
    );
    const repairRes = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "SKILL.md", content: repaired })
      .expect(200);
    expect(repairRes.body.validation.passed).toBe(true);

    // Export succeeds after a valid edit; the ZIP carries the edited content.
    const exportRes = await request(app)
      .post(`/api/skills/${id}/export`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .send({ target: "generic" })
      .expect(200);
    const zip = await JSZip.loadAsync(exportRes.body);
    const skillMd = await zip.files["edit-safe-demo/SKILL.md"]!.async("string");
    expect(skillMd).toContain("reviewed by the skill author");
    // Manifest inside the ZIP matches the edited file (hash resync survived packaging).
    const manifest = JSON.parse(await zip.files["edit-safe-demo/manifest.json"]!.async("string"));
    const entry = manifest.files.find((f: { path: string }) => f.path === "SKILL.md");
    const repairedSkillMd = repairRes.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md").content;
    expect(entry!.sha256).toBe(sha256(repairedSkillMd));
    const editedEntry = manifest.files.find((f: { path: string }) => f.path === editPath);
    expect(editedEntry!.sha256).toBe(sha256("## Test cards (user-reviewed)\n\nUse 4242-4242-4242-4242 in the sandbox only.\n"));
  });
});

/** Fix regression: regenerating manifest.json during an edit must retain the
 * original adapter ingestion notes (truncation/skips survive edits). */
describe("source notes survive edits in the regenerated manifest", () => {
  let app: ReturnType<typeof createApp>;
let cleanupStore: () => Promise<void>;
beforeAll(async () => {
  const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
  cleanupStore = cleanup;
  app = createApp({ provider: "mock", hasApiKey: false, }, { storeRoot });
});
afterAll(async () => {
  await cleanupStore?.();
});
  const id = "notes-survive-edit";
  const small = "# Tiny Docs\n\nSmall but long enough for the minimum source length check to pass.";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGithubFetch() {
    const files = Array.from({ length: 45 }, (_, i) => ({
      path: `docs/page-${String(i).padStart(2, "0")}.md`,
      type: "blob",
      size: 40,
    }));
    const raw: Record<string, string> = {};
    for (let i = 0; i < 45; i++) {
      raw[`docs/page-${String(i).padStart(2, "0")}.md`] = `# Page ${i}\n\nContent for page ${i} of the note-survival fixture.`;
    }
    vi.stubGlobal(
      "fetch",
      (async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/") && !url.includes("/git/trees/")) {
          return new Response(JSON.stringify({ default_branch: "main", private: false, visibility: "public" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/git/trees/")) {
          return new Response(JSON.stringify({ sha: "x", truncated: false, tree: files }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const path = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
        const res = new Response(raw[path] ?? small, { status: 200, headers: { "content-type": "text/plain" } });
        Object.defineProperty(res, "url", { value: url });
        return res;
      }) as unknown as typeof fetch,
    );
  }

  it("keeps the file-limit ingestion note in manifest.json after an edit + export", async () => {
    stubGithubFetch();
    const gen = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/manydocs", requestedName: id })
      .expect(200);
    const result = gen.text.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "result");
    const originalNotes: string[] = result.sourceNotes;
    expect(originalNotes.some((n: string) => n.includes("file limit"))).toBe(true);

    // Edit an allowed generated file.
    const get1 = await request(app).get(`/api/skills/${id}`).expect(200);
    const refFile = get1.body.skill.files.find((f: { path: string }) => f.path.startsWith("references/"));
    const edited = refFile.content + "\nPost-edit review line.\n";
    await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: refFile.path, content: edited })
      .expect(200);

    // The persisted API response still carries the original note.
    const get2 = await request(app).get(`/api/skills/${id}`).expect(200);
    expect(get2.body.source.notes).toEqual(originalNotes);

    // The regenerated manifest inside the exported ZIP retains it too.
    const exportRes = await request(app)
      .post(`/api/skills/${id}/export`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .send({ target: "generic" })
      .expect(200);
    const zip = await JSZip.loadAsync(exportRes.body);
    const manifest = JSON.parse(await zip.files[`${id}/manifest.json`]!.async("string"));
    expect(manifest.source.notes).toEqual(originalNotes);
    expect(manifest.source.notes.some((n: string) => n.includes("file limit"))).toBe(true);
  }, 20000);
});

describe("F-01 regression: generic export does not resurrect stale instructions or description after edit", () => {
  let app: ReturnType<typeof createApp>;
  let cleanupStore: () => Promise<void>;
  beforeAll(async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    cleanupStore = cleanup;
    app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
  });
  afterAll(async () => {
    await cleanupStore?.();
  });

  const id = "f01-stale-instruction-demo";

  it("proves Generic export cannot resurrect stale pre-edit instructions or description", async () => {
    // 1. Generate a valid skill through the server/API
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: id })
      .expect(200);
    const result = eventsOf(res.text).find((e: { type: string }) => e.type === "result");
    expect(result.validation.passed).toBe(true);

    const get = await request(app).get(`/api/skills/${id}`).expect(200);
    const originalSkillMd: string = get.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md").content;
    const originalDesc: string = get.body.skill.meta.description;

    // 2. Capture a distinctive instruction and the original description
    const distinctiveInstruction = 'Follow the documented procedure "Refunding a payment"';
    expect(originalSkillMd).toContain(distinctiveInstruction);
    expect(originalDesc.length).toBeGreaterThan(0);

    // 3. Submit a valid edit to SKILL.md that removes that instruction and changes description
    const newDescription = "A thoroughly updated and custom payment gateway skill definition.";
    const editedSkillMd = originalSkillMd
      .replace(
        /^description: .*/m,
        `description: ${JSON.stringify(newDescription)}`,
      )
      .replace(
        distinctiveInstruction,
        "Custom replacement workflow step for payment processing",
      );

    expect(editedSkillMd).not.toContain(distinctiveInstruction);
    expect(editedSkillMd).toContain(newDescription);
    expect(editedSkillMd).toContain("Custom replacement workflow step for payment processing");

    const editRes = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "SKILL.md", content: editedSkillMd })
      .expect(200);
    expect(editRes.body.validation.passed).toBe(true);

    // 4. Export target generic through the real export endpoint
    const exportRes = await request(app)
      .post(`/api/skills/${id}/export`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .send({ target: "generic" })
      .expect(200);

    // 5. Open the ZIP
    const zip = await JSZip.loadAsync(exportRes.body);

    // 6. Assert:
    // - edited SKILL.md is present exactly as persisted
    const persistedSkillMd = editRes.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md").content;
    const skillMdInZip = await zip.files[`${id}/SKILL.md`]!.async("string");
    expect(skillMdInZip).toBe(persistedSkillMd);

    // - AGENTS.md exists
    const agentsFile = zip.files[`${id}/AGENTS.md`];
    expect(agentsFile).toBeDefined();
    const agentsContent = await agentsFile!.async("string");

    // - AGENTS.md does NOT resurrect the removed/replaced pre-edit instruction
    expect(agentsContent).not.toContain(distinctiveInstruction);
    expect(agentsContent).not.toContain("Refunding a payment");

    // - AGENTS.md does NOT contain stale pre-edit description
    expect(agentsContent).not.toContain(originalDesc);
    expect(agentsContent).not.toContain("## Purpose");
    expect(agentsContent).not.toContain("## Constraints");

    // - the wrapper still provides useful orientation to the canonical files
    expect(agentsContent).toContain("## How to use this skill");
    expect(agentsContent).toContain("## Where to look");
    expect(agentsContent).toContain("`SKILL.md` is the authoritative skill definition");
    expect(agentsContent).toContain("- `SKILL.md`");
    expect(agentsContent).toContain("- `manifest.json`");

    // - exported manifest.json includes correct inventory/hash information for AGENTS.md and edited files
    const manifestJson = JSON.parse(await zip.files[`${id}/manifest.json`]!.async("string"));
    const agentsEntry = manifestJson.files.find((f: { path: string }) => f.path === "AGENTS.md");
    expect(agentsEntry).toBeDefined();
    expect(agentsEntry.bytes).toBe(Buffer.byteLength(agentsContent, "utf8"));
    expect(agentsEntry.sha256).toBe(sha256(agentsContent));

    const skillEntry = manifestJson.files.find((f: { path: string }) => f.path === "SKILL.md");
    expect(skillEntry).toBeDefined();
    expect(skillEntry.bytes).toBe(Buffer.byteLength(persistedSkillMd, "utf8"));
    expect(skillEntry.sha256).toBe(sha256(persistedSkillMd));
  });
});

describe("F-02 regression: manifest and source hash consistency across reload, validate, and export", () => {
  let app: ReturnType<typeof createApp>;
  let cleanupStore: () => Promise<void>;
  let storeRootPath: string;
  beforeAll(async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    cleanupStore = cleanup;
    storeRootPath = storeRoot;
    app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
  });
  afterAll(async () => {
    await cleanupStore?.();
  });

  it("raw source with CRLF and HTML normalization does not produce false hash failure on reload, /validate, or /export", async () => {
    const id = "crlf-html-source-demo";
    // Source text with CRLF line endings and HTML markup that changes during normalization
    const rawContent = "# Payments API Guide\r\n\r\n<p>This is paragraph text with &amp; entities.</p>\r\n\r\n## Usage\r\n\r\nRun the payment procedure.\r\n";

    const gen = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", content: rawContent, name: "crlf-doc", requestedName: id })
      .expect(200);
    const result = eventsOf(gen.text).find((e: { type: string }) => e.type === "result");
    expect(result.validation.passed).toBe(true);

    // Persisted reload
    const get = await request(app).get(`/api/skills/${id}`).expect(200);
    expect(get.body.validation.passed).toBe(true);

    // Manual revalidation
    const valRes = await request(app).post(`/api/skills/${id}/validate`).expect(200);
    expect(valRes.body.validation.passed).toBe(true);
    expect(valRes.body.validation.errorCount).toBe(0);
    const hashFail = valRes.body.validation.checks.find(
      (c: { id: string; status: string }) => c.id === "manifest-consistency" && c.status === "fail",
    );
    expect(hashFail).toBeUndefined();

    // Export validation
    const exportRes = await request(app)
      .post(`/api/skills/${id}/export`)
      .send({ target: "generic" })
      .expect(200);
    expect(exportRes.headers["content-type"]).toBe("application/zip");
  });

  it("synthetic github-codebase source verifies offline without false hash failure across reload, /validate, and /export", async () => {
    const id = "offline-codebase-demo";
    // Codebase source with HTML-like code tags that must NOT be stripped by normalization
    const codeContent = "// Codebase Source\nexport function renderTemplate() {\n  return '<div><span>Hello</span></div>';\n}\n// Ensure minimum characters requirement is met easily for this fixture.\n";

    const store = createStore(storeRootPath);
    const normalized = normalizeSource({
      type: "github-codebase",
      name: "acme/offline-repo",
      content: codeContent,
      notes: ["Inspected 1 file(s) in codebase mode."],
    });
    // Codebase normalization must preserve the code tags verbatim
    expect(normalized.text).toContain("<div><span>Hello</span></div>");

    const analysis = analyzeSource(normalized);
    const plan = derivePlanFromAnalysis(analysis);
    const repoAnalysis: RepositoryAnalysis = {
      ...sampleRepositoryAnalysis(),
      repository: {
        url: "https://github.com/acme/offline-repo",
        owner: "acme",
        name: "offline-repo",
        ref: "main",
      },
      inspectedFiles: ["package.json", "src/index.ts"],
      selection: {
        treeBlobCount: 30,
        candidateCount: 20,
        selectedCount: 2,
        treeTruncated: false,
      },
    };

    normalized.repository = repoAnalysis;
    const skill = buildCanonicalSkill(normalized, analysis, plan, "mock");
    const validation = validatePackage({
      skill,
      sourceText: normalized.text,
      sourceType: "github-codebase",
    });
    expect(validation.passed).toBe(true);

    await store.saveSkill({
      id,
      skill,
      analysis: {
        title: analysis.title,
        sectionCount: analysis.sections.length,
        procedureCount: analysis.procedures.length,
        commandCount: analysis.commands.length,
        codeBlockCount: analysis.codeBlocks.length,
        lineCount: analysis.lineCount,
      },
      source: {
        name: "acme/offline-repo",
        type: "github-codebase",
        text: codeContent,
        notes: ["Inspected 1 file(s) in codebase mode."],
        repository: repoAnalysis,
      },
      validation,
      createdAt: new Date().toISOString(),
    });

    // Reload from store
    const get = await request(app).get(`/api/skills/${id}`).expect(200);
    expect(get.body.validation.passed).toBe(true);

    // Revalidate
    const valRes = await request(app).post(`/api/skills/${id}/validate`).expect(200);
    expect(valRes.body.validation.passed).toBe(true);

    // Export
    const exportRes = await request(app)
      .post(`/api/skills/${id}/export`)
      .send({ target: "generic" })
      .expect(200);
    expect(exportRes.headers["content-type"]).toBe("application/zip");
  });

  it("fails closed with 409 source_renormalization_failed when persisted source cannot be re-normalized", async () => {
    const id = "malformed-source-fail-closed";
    const goodContent = "# A perfectly valid document with enough text to pass normalization.\n\n## Section\nSome instructional text.";
    const gen = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", content: goodContent, name: "good-doc", requestedName: id })
      .expect(200);
    const result = eventsOf(gen.text).find((e: { type: string }) => e.type === "result");
    expect(result.validation.passed).toBe(true);

    // Corrupt stored source.text directly in the store to empty string (which fails normalizeSource)
    const store = createStore(storeRootPath);
    const stored = await store.getSkill(id);
    expect(stored).toBeDefined();
    stored!.source.text = "too short"; // < 40 chars -> fails normalizeSource with source_too_short

    // Directly rewrite skill.json
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(path.join(storeRootPath, id, "skill.json"), JSON.stringify(stored, null, 2), "utf8");

    // /validate should fail closed with 409 source_renormalization_failed
    const valRes = await request(app).post(`/api/skills/${id}/validate`).expect(409);
    expect(valRes.body.code).toBe("source_renormalization_failed");

    // /export should fail closed with 409 source_renormalization_failed
    const exportRes = await request(app)
      .post(`/api/skills/${id}/export`)
      .send({ target: "generic" })
      .expect(409);
    expect(exportRes.body.code).toBe("source_renormalization_failed");
  });
});
