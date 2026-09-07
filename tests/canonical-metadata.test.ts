import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from "vitest";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";
import request from "supertest";
import JSZip from "jszip";
import { createApp } from "../src/server/app.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis, manifestFor } from "../src/core/build.js";
import { validatePackage } from "../src/core/validate.js";
import type { CanonicalSkill } from "../src/core/types.js";
import { getSample } from "../src/core/samples.js";

/** Canonical metadata consistency: users may edit SKILL.md body text, but
 * front matter / manifest values that contradict skill.meta must fail
 * deterministic validation (and therefore block export). */

function buildSkill(source: string): CanonicalSkill {
  const normalized = normalizeSource({ type: "text", name: "doc", content: source });
  const analysis = analyzeSource(normalized);
  const plan = derivePlanFromAnalysis(analysis);
  return buildCanonicalSkill(normalized, analysis, plan, "mock");
}

function resyncManifest(skill: CanonicalSkill): CanonicalSkill {
  const files = skill.files.filter((f) => f.path !== "manifest.json");
  const manifest = manifestFor(files, skill.meta, {
    name: "fixture-source",
    sha256: "test",
    lineCount: 1,
    notes: [],
  });
  files.push({ path: "manifest.json", content: manifest, purpose: "manifest" });
  return { ...skill, files };
}

describe("canonical-metadata-consistency (unit)", () => {
  const skill = buildSkill(getSample("meridian-payments-api").content);

  it("a generated package is consistent by construction", () => {
    const report = validatePackage({ skill });
    expect(report.checks.some((c) => c.id === "canonical-metadata-consistency" && c.status === "pass")).toBe(true);
  });

  it("a different front matter name fails even when syntactically valid", () => {
    const edited = structuredClone(skill);
    const skillMd = edited.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content = skillMd.content.replace(
      /^name: .*/m,
      "name: totally-different-skill",
    );
    const report = validatePackage({ skill: resyncManifest(edited) });
    const check = report.checks.find((c) => c.id === "canonical-metadata-consistency");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("totally-different-skill");
    expect(check?.message).toContain(skill.meta.name);
    expect(report.passed).toBe(false);
  });

  it("an inconsistent manifest identity field fails", () => {
    const edited = structuredClone(skill);
    const manifestFile = edited.files.find((f) => f.path === "manifest.json")!;
    const manifest = JSON.parse(manifestFile.content);
    manifest.displayName = "Some Other Display Name";
    manifestFile.content = JSON.stringify(manifest, null, 2) + "\n";
    const report = validatePackage({ skill: edited });
    const check = report.checks.find((c) => c.id === "canonical-metadata-consistency");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("displayName");
    expect(report.passed).toBe(false);
  });

  it("a body-only edit stays valid", () => {
    const edited = structuredClone(skill);
    const skillMd = edited.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content = skillMd.content.replace(
      "## When to use this skill",
      "## When to use this skill\n\n- Reviewed and extended by the skill author.\n",
    );
    const report = validatePackage({ skill: resyncManifest(edited) });
    const check = report.checks.find((c) => c.id === "canonical-metadata-consistency");
    expect(check?.status).toBe("pass");
  });
});

describe("canonical metadata via the API (edit → validate → export)", () => {
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
  const id = "metadata-consistency-demo";

  it("rejects an identity-changing front matter edit, then accepts the repair", async () => {
    await request(app)
      .post("/api/generate")
      .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: id })
      .expect(200);

    // 1. Body-only edit stays valid.
    const get1 = await request(app).get(`/api/skills/${id}`).expect(200);
    const skillMd1 = get1.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md");
    const bodyEdit = skillMd1.content.replace(
      "## When to use this skill",
      "## When to use this skill\n\n- Body-only edit, identity untouched.\n",
    );
    const r1 = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "SKILL.md", content: bodyEdit })
      .expect(200);
    expect(r1.body.validation.passed).toBe(true);

    // 2. Editing front matter name to a different valid slug fails validation.
    const renamed = bodyEdit.replace(/^name: .*/m, `name: totally-different-skill`);
    const r2 = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "SKILL.md", content: renamed })
      .expect(200); // the edit is stored; validation honestly reports the contradiction
    expect(r2.body.validation.passed).toBe(false);
    expect(r2.body.validation.checks.some((c: { id: string; status: string }) =>
      c.id === "canonical-metadata-consistency" && c.status === "fail")).toBe(true);

    // 3. Export is blocked (422) while metadata is inconsistent.
    await request(app).post(`/api/skills/${id}/export`).send({ target: "generic" }).expect(422);

    // 4. Repairing the front matter restores validation and export.
    const r4 = await request(app)
      .post(`/api/skills/${id}/update-file`)
      .send({ path: "SKILL.md", content: bodyEdit })
      .expect(200);
    expect(r4.body.validation.passed).toBe(true);

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
    // 5. The ZIP carries consistent metadata.
    const zip = await JSZip.loadAsync(exportRes.body);
    const skillMd = await zip.files[`${id}/SKILL.md`]!.async("string");
    const manifest = JSON.parse(await zip.files[`${id}/manifest.json`]!.async("string"));
    expect(skillMd).toContain(`name: ${id}`);
    expect(manifest.name).toBe(id);
  });
});
