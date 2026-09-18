import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parse as parseYaml } from "yaml";
import { ExportTarget } from "../src/core/types.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis } from "../src/core/build.js";
import { exportPackage, buildZip, ExportError, EXPORT_TARGET_INFO } from "../src/core/export/exporters.js";
import { validatePackage } from "../src/core/validate.js";
import { getSample } from "../src/core/samples.js";
import { safePackagePath } from "../src/core/util.js";

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
