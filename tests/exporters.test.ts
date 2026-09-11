import { describe, expect, it } from "vitest";
import JSZip from "jszip";
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
    expect(EXPORT_TARGET_INFO.map((t) => t.target).sort()).toEqual(["claude-code", "generic"]);
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

  it("refuses to write unsafe paths into the ZIP (zip-slip)", async () => {
    const evil = skill();
    evil.files = [...evil.files, { path: "../../evil.txt", content: "gotcha", purpose: "evil" }];
    await expect(buildZip(exportPackage(evil, "claude-code"))).rejects.toThrow(ExportError);
  });

  it("refuses duplicate entries", async () => {
    const evil = skill();
    evil.files = [...evil.files, { ...evil.files[0]! }];
    await expect(buildZip(exportPackage(evil, "claude-code"))).rejects.toThrow(/Duplicate ZIP entry/);
  });
});
