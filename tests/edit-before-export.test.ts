import { describe, expect, it } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { createApp } from "../src/server/app.js";
import { sha256 } from "../src/core/util.js";

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
  const app = createApp({ provider: "mock", hasApiKey: false });
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
    expect(entry!.sha256).toBe(sha256(repaired));
    const editedEntry = manifest.files.find((f: { path: string }) => f.path === editPath);
    expect(editedEntry!.sha256).toBe(sha256("## Test cards (user-reviewed)\n\nUse 4242-4242-4242-4242 in the sandbox only.\n"));
  });
});
