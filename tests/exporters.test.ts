import { describe, expect, it, beforeAll, afterAll } from "vitest";
import JSZip from "jszip";
import request from "supertest";
import { parse as parseYaml } from "yaml";
import { ExportTarget, type CanonicalSkill } from "../src/core/types.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis, manifestFor } from "../src/core/build.js";
import { exportPackage, buildZip, ExportError, EXPORT_TARGET_INFO } from "../src/core/export/exporters.js";
import { validatePackage } from "../src/core/validate.js";
import { getSample } from "../src/core/samples.js";
import { safePackagePath } from "../src/core/util.js";
import { createApp } from "../src/server/app.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

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

function skill() {
  const normalized = normalizeSource({ type: "text", name: "doc", content: getSample("meridian-payments-api").content });
  const analysis = analyzeSource(normalized);
  return buildCanonicalSkill(normalized, analysis, derivePlanFromAnalysis(analysis), "mock");
}

async function readZip(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  return entries;
}

describe("safePackagePath", () => {
  it("rejects traversal, absolute, and malformed paths", () => {
    expect(safePackagePath("../evil.txt")).toBeNull();
    expect(safePackagePath("a/../../evil.txt")).toBeNull();
    expect(safePackagePath("/absolute/path")).toBeNull();
    expect(safePackagePath("C:\\evil")).toBeNull();
    expect(safePackagePath("")).toBeNull();
    expect(safePackagePath("a/\u0000b")).toBeNull();
  });

  it("normalizes duplicate slashes and dots", () => {
    expect(safePackagePath("references//x.md")).toBe("references/x.md");
    expect(safePackagePath("./a/./b.md")).toBe("a/b.md");
    expect(safePackagePath("SKILL.md")).toBe("SKILL.md");
  });
});

describe("exporters", () => {
  it("expose exactly the documented targets with format basis", () => {
    expect(EXPORT_TARGET_INFO.map((t) => t.target).sort()).toEqual(["claude-code", "generic", "openai-codex"]);
    for (const info of EXPORT_TARGET_INFO) {
      expect(info.formatBasis.length).toBeGreaterThan(30);
    }
  });

  it("claude-code export keeps canonical files under the skill folder", () => {
    const exported = exportPackage(skill(), "claude-code");
    const paths = exported.files.map((f) => f.path);
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("manifest.json");
    expect(exported.notes).toHaveLength(0);
  });

  it("claude-code front matter satisfies the documented constraints", () => {
    const exported = exportPackage(skill(), "claude-code");
    const skillMd = exported.files.find((f) => f.path === "SKILL.md")!;
    const fm = skillMd.content.match(/^---\n([\s\S]*?)\n---/)!;
    expect(fm[1]).toMatch(/^name: [a-z0-9][a-z0-9-]*$/m);
    expect(fm[1]).toMatch(/^description: ".+"$/m);
    const name = skillMd.content.match(/^name: (.+)$/m)?.[1] ?? "";
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it("generic export adds an AGENTS.md wrapper and updates the manifest", () => {
    const s = skill();
    const exported = exportPackage(s, "generic");
    const agents = exported.files.find((f) => f.path === "AGENTS.md");
    expect(agents).toBeDefined();
    expect(agents!.content).toContain("## How to use this skill");
    expect(agents!.content).toContain("`SKILL.md` is the authoritative skill definition");
    expect(agents!.content).not.toContain("## Purpose");
    expect(agents!.content).not.toContain("## Constraints");
    const manifest = JSON.parse(exported.files.find((f) => f.path === "manifest.json")!.content);
    const listed = manifest.files.map((f: { path: string }) => f.path);
    expect(listed).toContain("AGENTS.md");
    expect(manifest.exportNotes.length).toBeGreaterThan(0);
    // Exported package must still pass deterministic validation.
    const report = validatePackage({ skill: { ...s, files: exported.files } });
    expect(report.passed).toBe(true);
  });

  it("rejects unsupported targets instead of silently exporting", () => {
    expect(() => exportPackage(skill(), "bogus" as never)).toThrow(ExportError);
    try {
      exportPackage(skill(), "bogus" as never);
    } catch (err) {
      expect((err as ExportError).code).toBe("export_target_unsupported");
      expect((err as ExportError).message).toContain("Supported targets");
    }
  });
});

describe("buildZip", () => {
  it("produces a real, readable ZIP with the skill folder root", async () => {
    const zip = await buildZip(exportPackage(skill(), "claude-code"));
    expect(zip.fileName).toMatch(/^meridian-payments-api-claude-code\.zip$/);
    expect(zip.buffer.subarray(0, 2).toString()).toBe("PK"); // ZIP magic bytes

    const names = (await readZip(zip.buffer)).map((f) => f.name);
    expect(names).toHaveLength(zip.entries.length);
    expect(names).toContain("meridian-payments-api/SKILL.md");
  });

  it("ZIP contents match canonical file contents byte for byte", async () => {
    const exported = exportPackage(skill(), "generic");
    const zip = await buildZip(exported);
    const entries = await readZip(zip.buffer);
    const entry = entries.find((f) => f.name === "meridian-payments-api/AGENTS.md");
    expect(entry).toBeDefined();
    expect(await entry!.async("string")).toBe(exported.files.find((f) => f.path === "AGENTS.md")!.content);
  });

  it.each(ExportTarget.options)("%s refuses unsafe ZIP paths", async (target) => {
    const evil = skill();
    evil.files = [...evil.files, { path: "../../evil.txt", content: "gotcha", purpose: "evil" }];
    await expect(buildZip(exportPackage(evil, target))).rejects.toThrow(ExportError);
  });

  it.each(ExportTarget.options)("%s refuses duplicate ZIP entries", async (target) => {
    const evil = skill();
    evil.files = [...evil.files, { ...evil.files[0]! }];
    await expect(buildZip(exportPackage(evil, target))).rejects.toThrow(/Duplicate ZIP entry/);
  });
});


describe("OpenAI Codex", () => {
  it("preserves every file, manifest and edited content through a real ZIP", async () => {
    const canonical = skill();
    const exported = exportPackage(canonical, ExportTarget.parse("openai-codex"));
    expect(exported).toEqual(exportPackage(canonical, "openai-codex"));
    expect(exported.files).toEqual(canonical.files);
    expect(exported.notes).toEqual([]);
    expect(validatePackage({ skill: { ...canonical, files: exported.files }, target: "openai-codex" }).passed).toBe(true);
    const archive = await buildZip(exported);
    expect(archive.fileName).toBe("meridian-payments-api-openai-codex.zip");
    const entries = await readZip(archive.buffer);
    expect(entries.map((f) => f.name).sort()).toEqual(canonical.files.map((f) => `meridian-payments-api/${f.path}`).sort());
    for (const file of canonical.files) {
      expect(await entries.find((e) => e.name === `meridian-payments-api/${file.path}`)!.async("string")).toBe(file.content);
    }
    const md = exported.files.find((f) => f.path === "SKILL.md")!;
    expect(parseYaml(md.content.match(/^---\n([\s\S]*?)\n---/)![1]!)).toMatchObject({ name: canonical.meta.name, description: canonical.meta.description });
  });

  it("retains valid custom YAML and userEdited flags without normalizing", () => {
    const canonical = skill();
    const md = canonical.files.find((f) => f.path === "SKILL.md")!;
    md.content = md.content.replace(/^name: .*$/m, `name: "${canonical.meta.name}"`).replace(/^description: .*$/m, 'description: "User-authored description"\nmetadata:\n  short-description: "Custom display text"');
    md.userEdited = true;
    const before = structuredClone(canonical);
    expect(exportPackage(canonical, "openai-codex").files).toEqual(before.files);
    expect(canonical).toEqual(before);
  });

  it.each([
    "no front matter",
    "---\nname: [\n---\nBody",
    "---\n- array\n---\nBody",
    "---\nnull\n---\nBody",
    "---\nname: doc\nname: doc\ndescription: text\n---\nBody",
    ...["Upper", "bad--name", "bad-", "-bad", "a".repeat(65), "other-id"].map((name) => `---\nname: ${name}\ndescription: text\n---\nBody`),
    ...[null, 42, "", " ", "<tag>", "a".repeat(1025)].map((description) => `---\nname: meridian-payments-api\ndescription: ${JSON.stringify(description)}\n---\nBody`),
    "---\nname: meridian-payments-api\ndescription: text\ninvented: true\n---\nBody",
  ])("fails closed for incompatible front matter %#", (content) => {
    const canonical = skill();
    canonical.files.find((f) => f.path === "SKILL.md")!.content = content;
    expect(() => exportPackage(canonical, "openai-codex")).toThrow(expect.objectContaining({ code: "export_codex_metadata_invalid" }));
  });
});

describe("Claude Code contract (Anthropic Agent Skills format)", () => {
  /** Skill whose canonical name and front matter carry the given values. */
  function claudeSkill(metaName: string, fmName: string, fmDescription: unknown): CanonicalSkill {
    const canonical = skill();
    canonical.meta.name = metaName;
    canonical.id = metaName;
    const md = canonical.files.find((f) => f.path === "SKILL.md")!;
    const body = md.content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)![1]!;
    md.content = `---\nname: ${fmName}\ndescription: ${JSON.stringify(fmDescription)}\n---\n${body}`;
    const files = canonical.files.filter((f) => f.path !== "manifest.json");
    const manifest = manifestFor(files, canonical.meta, {
      name: "fixture-source",
      sha256: "0".repeat(64),
      lineCount: 1,
      notes: [],
    });
    files.push({ path: "manifest.json", content: manifest, purpose: "manifest" });
    return { ...canonical, files };
  }

  function exportErrorFor(metaName: string, fmName: string, fmDescription: unknown): ExportError | null {
    try {
      exportPackage(claudeSkill(metaName, fmName, fmDescription), "claude-code");
      return null;
    } catch (err) {
      return err as ExportError;
    }
  }

  function targetFailsWith(metaName: string, fmName: string, fmDescription: unknown, snippet: string): void {
    const report = validatePackage({ skill: claudeSkill(metaName, fmName, fmDescription), target: "claude-code" });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.id === "frontmatter-fields" && c.status === "fail" && c.message?.includes(snippet))).toBe(true);
  }

  /** Insert extra raw YAML lines into SKILL.md front matter and resync the manifest. */
  function withFrontMatterExtra(built: CanonicalSkill, extraYaml: string): CanonicalSkill {
    const next = structuredClone(built);
    const md = next.files.find((f) => f.path === "SKILL.md")!;
    md.content = md.content.replace(/^---\n([\s\S]*?)\n---/, (_m: string, fm: string) => `---\n${fm}\n${extraYaml}\n---`);
    const files = next.files.filter((f) => f.path !== "manifest.json");
    files.push({
      path: "manifest.json",
      content: manifestFor(files, next.meta, { name: "fixture-source", sha256: "0".repeat(64), lineCount: 1, notes: [] }),
      purpose: "manifest",
    });
    return { ...next, files };
  }

  function compatErrorFor(extraYaml: string): ExportError | null {
    try {
      exportPackage(withFrontMatterExtra(claudeSkill("meridian-payments-api", "meridian-payments-api", "Does things. Use when testing."), extraYaml), "claude-code");
      return null;
    } catch (err) {
      return err as ExportError;
    }
  }

  function compatTargetFailsWith(extraYaml: string, snippet: string): void {
    const built = withFrontMatterExtra(claudeSkill("meridian-payments-api", "meridian-payments-api", "Does things. Use when testing."), extraYaml);
    const report = validatePackage({ skill: built, target: "claude-code" });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.id === "frontmatter-fields" && c.status === "fail" && c.message?.includes(snippet))).toBe(true);
  }

  it.each([
    ["claude-helper", "reserved word prefix"],
    ["my-claude-skill", "reserved word infix"],
    ["my-anthropic-skill", "reserved word anthropic"],
    ["ANTHROPIC-x", "reserved word case-insensitive"],
  ])("rejects reserved word in name: %s (%s)", (name: string) => {
    expect(exportErrorFor(name, name, "Does things. Use when testing.")?.code).toBe("export_claude_metadata_invalid");
    targetFailsWith(name, name, "Does things. Use when testing.", "reserved");
  });

  it.each([
    ["bad--name", "consecutive hyphens", "single internal hyphens"],
    ["bad-", "trailing hyphen", "single internal hyphens"],
    ["-bad", "leading hyphen", "single internal hyphens"],
    ["Bad-Name", "uppercase", "single internal hyphens"],
    ["has space", "space", "single internal hyphens"],
    ["bad<name>", "angle bracket", "single internal hyphens"],
    ["a".repeat(65), "over 64 chars", "64 characters"],
  ])("rejects malformed name %s (%s)", (name: string, _label: string, snippet: string) => {
    expect(exportErrorFor(name, name, "Does things. Use when testing.")?.code).toBe("export_claude_metadata_invalid");
    targetFailsWith(name, name, "Does things. Use when testing.", snippet);
  });

  it("rejects malformed names with the specific shape message, not only length", () => {
    const report = validatePackage({ skill: claudeSkill("bad--name", "bad--name", "Does things. Use when testing."), target: "claude-code" });
    expect(report.checks.some((c) => c.id === "frontmatter-fields" && c.status === "fail" && c.message?.includes("single internal hyphens"))).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["Use <xml> tags here", "angle brackets"],
    ["a > b", "lone greater-than"],
    ["a".repeat(1025), "over 1024 chars"],
    [42, "non-string"],
  ])("rejects invalid description %j (%s)", (description: unknown, _label: string) => {
    expect(exportErrorFor("meridian-payments-api", "meridian-payments-api", description)?.code).toBe("export_claude_metadata_invalid");
    targetFailsWith("meridian-payments-api", "meridian-payments-api", description, "description");
  });

  it.each([
    ["my-skill", "Does things. Use when testing."],
    ["a", "Tiny but valid description for triggering."],
    ["x".repeat(64), "Name at the length limit with a valid description."],
    ["meridian-payments-api", "x".repeat(1024)],
  ])("accepts valid name %s", (name, description) => {
    const built = claudeSkill(name, name, description);
    const exported = exportPackage(built, "claude-code");
    expect(validatePackage({ skill: { ...built, files: exported.files }, target: "claude-code" }).passed).toBe(true);
  });

  it("exporter and target-aware validation agree on every probed case", () => {
    const cases: [string, unknown][] = [
      ["claude-helper", "Does things. Use when testing."],
      ["my-anthropic-skill", "Does things. Use when testing."],
      ["bad--name", "Does things. Use when testing."],
      ["bad-", "Does things. Use when testing."],
      ["meridian-payments-api", "Use <xml> here"],
      ["meridian-payments-api", ""],
      ["meridian-payments-api", "a".repeat(1025)],
      ["meridian-payments-api", "Does things. Use when testing."],
      ["a-b-c-2", "x".repeat(1024)],
    ];
    for (const [name, description] of cases) {
      const built = claudeSkill(name, name, description);
      let exportFailed = false;
      let exportedFiles = built.files;
      try {
        exportedFiles = exportPackage(built, "claude-code").files;
      } catch (err) {
        expect((err as ExportError).code).toBe("export_claude_metadata_invalid");
        exportFailed = true;
      }
      const report = validatePackage({ skill: { ...built, files: exportedFiles }, target: "claude-code" });
      expect(report.passed).toBe(!exportFailed);
    }
  });

  it.each([
    ["compatibility: Requires git and docker", "short string", true],
    [`compatibility: ${"y".repeat(500)}`, "exact 500 chars", true],
    [`compatibility: ${"y".repeat(501)}`, "501 chars", false],
    ["compatibility: 42", "non-string number", false],
    ['compatibility: ["a", "b"]', "non-string list", false],
    ["compatibility:\n  scope: tools", "non-string mapping", false],
    ['compatibility: ""', "empty string (absent-like)", true],
  ])("compatibility %s (%s)", (extraYaml: string, _label: string, valid: boolean) => {
    if (valid) {
      const built = withFrontMatterExtra(claudeSkill("meridian-payments-api", "meridian-payments-api", "Does things. Use when testing."), extraYaml);
      const exported = exportPackage(built, "claude-code");
      expect(validatePackage({ skill: { ...built, files: exported.files }, target: "claude-code" }).passed).toBe(true);
    } else {
      expect(compatErrorFor(extraYaml)?.code).toBe("export_claude_metadata_invalid");
      compatTargetFailsWith(extraYaml, "compatibility");
    }
  });

  it("compatibility type errors name the offending YAML type", () => {
    compatTargetFailsWith("compatibility: 42", "got number");
    compatTargetFailsWith('compatibility: ["a"]', "got list");
    compatTargetFailsWith("compatibility:\n  scope: tools", "got dict");
    compatTargetFailsWith(`compatibility: ${"y".repeat(501)}`, "500");
  });

  it("compatibility survives the name-repair transform and still validates", () => {
    const canonical = skill();
    canonical.meta.name = "compat-repair";
    canonical.id = "compat-repair";
    const repaired = withFrontMatterExtra(canonical, "compatibility: Requires git");
    // Manifest identity was rebuilt for the renamed meta by the helper, so
    // only the front-matter name drift remains for the exporter to repair.
    const exported = exportPackage(repaired, "claude-code");
    const out = exported.files.find((f) => f.path === "SKILL.md")!.content;
    expect(parseYaml(out.match(/^---\n([\s\S]*?)\n---/)![1]!)).toMatchObject({
      name: "compat-repair",
      compatibility: "Requires git",
    });
    expect(validatePackage({ skill: { ...repaired, files: exported.files }, target: "claude-code" }).passed).toBe(true);
  });

  it("name-repair does not mask an invalid compatibility value", () => {
    const canonical = skill();
    canonical.meta.name = "compat-repair";
    canonical.id = "compat-repair";
    const repaired = withFrontMatterExtra(canonical, `compatibility: ${"y".repeat(501)}`);
    expect(() => exportPackage(repaired, "claude-code")).toThrow(
      expect.objectContaining({ code: "export_claude_metadata_invalid" }),
    );
  });

  it("compatibility rules do not leak into generic validation or export", () => {
    const built = withFrontMatterExtra(
      claudeSkill("meridian-payments-api", "meridian-payments-api", "Does things. Use when testing."),
      `compatibility: ${"y".repeat(501)}`,
    );
    // Generic has no compatibility rule: over-limit values still validate and export.
    expect(validatePackage({ skill: built }).passed).toBe(true);
    expect(validatePackage({ skill: built, target: "generic" }).passed).toBe(true);
    expect(exportPackage(built, "generic").files.some((f) => f.path === "SKILL.md")).toBe(true);
  });

  it("does not leak claude-only rules into generic or codex validation", () => {
    const built = claudeSkill("claude-helper", "claude-helper", "Does things. Use when testing.");
    expect(validatePackage({ skill: built }).passed).toBe(true);
    expect(validatePackage({ skill: built, target: "generic" }).passed).toBe(true);
    // Codex has no reserved-word rule: the same name exports cleanly there.
    expect(exportPackage(built, "openai-codex").skillName).toBe("claude-helper");
  });

  it("repair preserves optional front-matter keys and still validates", () => {
    const canonical = skill();
    canonical.meta.name = "renamed-skill";
    canonical.id = "renamed-skill";
    const md = canonical.files.find((f) => f.path === "SKILL.md")!;
    md.content = md.content.replace(
      /^---\n([\s\S]*?)\n---/,
      (_, fm: string) => `---\n${fm}\nlicense: MIT\ncompatibility: test environment\nallowed-tools: Read\nmetadata:\n  owner: team\n---`,
    );
    // Re-sync identity + hashes around both mutations so only the intended
    // name drift remains for the exporter to repair.
    const files = canonical.files.filter((f) => f.path !== "manifest.json");
    files.push({
      path: "manifest.json",
      content: manifestFor(files, canonical.meta, { name: "fixture-source", sha256: "0".repeat(64), lineCount: 1, notes: [] }),
      purpose: "manifest",
    });
    const repaired: CanonicalSkill = { ...canonical, files };
    const exported = exportPackage(repaired, "claude-code");
    const out = exported.files.find((f) => f.path === "SKILL.md")!.content;
    const frontmatter = parseYaml(out.match(/^---\n([\s\S]*?)\n---/)![1]!);
    expect(frontmatter).toMatchObject({
      name: "renamed-skill",
      license: "MIT",
      compatibility: "test environment",
      "allowed-tools": "Read",
    });
    expect(frontmatter.metadata).toMatchObject({ owner: "team" });
    expect(validatePackage({ skill: { ...repaired, files: exported.files }, target: "claude-code" }).passed).toBe(true);
  });

  it("rejects an emptied description instead of silently backfilling it", () => {
    const canonical = skill();
    const md = canonical.files.find((f) => f.path === "SKILL.md")!;
    md.content = md.content.replace(/^description: .*$/m, 'description: ""');
    expect(() => exportPackage(canonical, "claude-code")).toThrow(
      expect.objectContaining({ code: "export_claude_metadata_invalid" }),
    );
  });

  it("claude export is blocked over HTTP as 422 with an actionable report", async () => {
    // End-to-end gate: generic validation still passes for the edit, but the
    // claude-code target refuses it before any ZIP bytes are produced. Uses
    // the same generate → edit → export shape as the Codex gating test.
    const generated = await request(app).post("/api/generate")
      .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "claude-gating" }).expect(200);
    const result = generated.text.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "result");
    const md = result.skill.files.find((file: { path: string; content: string }) => file.path === "SKILL.md");
    const incompatible = md.content.replace(/^description: .*$/m, 'description: "Use <payment> workflows"');
    const edited = await request(app).post("/api/skills/claude-gating/update-file")
      .send({ path: "SKILL.md", content: incompatible }).expect(200);
    expect(edited.body.validation.passed).toBe(true);
    const blocked = await request(app).post("/api/skills/claude-gating/export")
      .send({ target: "claude-code" }).expect(422);
    expect(blocked.body.error).toContain("blocked");
    expect(blocked.body.validation.checks.some(
      (c: { id: string; status: string }) => c.id === "frontmatter-fields" && c.status === "fail",
    )).toBe(true);
  });

  it("claude export blocks over-limit compatibility over HTTP as 422", async () => {
    const generated = await request(app).post("/api/generate")
      .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "claude-compat" }).expect(200);
    const result = generated.text.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "result");
    const md = result.skill.files.find((file: { path: string; content: string }) => file.path === "SKILL.md");
    const incompatible = md.content.replace(/^---\n([\s\S]*?)\n---/, (_m: string, fm: string) => `---\n${fm}\ncompatibility: ${"y".repeat(501)}\n---`);
    const edited = await request(app).post("/api/skills/claude-compat/update-file")
      .send({ path: "SKILL.md", content: incompatible }).expect(200);
    // Generic validation has no compatibility rule, so the edit persists.
    expect(edited.body.validation.passed).toBe(true);
    const blocked = await request(app).post("/api/skills/claude-compat/export")
      .send({ target: "claude-code" }).expect(422);
    expect(blocked.body.error).toContain("blocked");
    expect(blocked.body.validation.checks.some(
      (c: { id: string; status: string; message?: string }) =>
        c.id === "frontmatter-fields" && c.status === "fail" && (c.message ?? "").includes("compatibility"),
    )).toBe(true);
  });
});
