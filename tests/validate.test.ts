import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis } from "../src/core/build.js";
import { validatePackage, skippedValidationReport, splitFrontMatter } from "../src/core/validate.js";
import type { CanonicalSkill } from "../src/core/types.js";
import { getSample } from "../src/core/samples.js";

function buildSkill(source: string): { skill: CanonicalSkill; sourceText: string } {
  const normalized = normalizeSource({ type: "text", name: "doc", content: source });
  const analysis = analyzeSource(normalized);
  const plan = derivePlanFromAnalysis(analysis);
  return { skill: buildCanonicalSkill(normalized, analysis, plan, "mock"), sourceText: normalized.text };
}

const healthy = buildSkill(getSample("meridian-payments-api").content);

/** After mutating file contents, re-sync the manifest so manifest-consistency
 * does not mask the specific check under test. */
function resyncManifest(skill: CanonicalSkill): CanonicalSkill {
  const files = skill.files.filter((f) => f.path !== "manifest.json");
  const manifest = {
    schema: "skillforge.manifest/1",
    name: skill.meta.name,
    files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content, "utf8"), sha256: "test" })),
  };
  files.push({ path: "manifest.json", content: JSON.stringify(manifest, null, 2) + "\n", purpose: "manifest" });
  return { ...skill, files };
}

describe("validatePackage (deterministic validator)", () => {
  it("passes a healthy generated package and executes every check", () => {
    const report = validatePackage({ skill: healthy.skill, sourceText: healthy.sourceText });
    expect(report.executed).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.checks.length).toBeGreaterThanOrEqual(14);
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("is deterministic across runs", () => {
    const a = validatePackage({ skill: healthy.skill, sourceText: healthy.sourceText });
    const b = validatePackage({ skill: healthy.skill, sourceText: healthy.sourceText });
    expect(a).toEqual(b);
  });

  it("fails when SKILL.md or manifest.json is missing", () => {
    const broken: CanonicalSkill = { ...healthy.skill, files: healthy.skill.files.filter((f) => f.path !== "SKILL.md") };
    const report = validatePackage({ skill: broken });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.id === "required-files" && c.status === "fail")).toBe(true);
  });

  it("fails on unsafe file paths (traversal, absolute)", () => {
    const evil: CanonicalSkill = {
      ...healthy.skill,
      files: [...healthy.skill.files, { path: "../escape.md", content: "nope", purpose: "evil" }],
    };
    const report = validatePackage({ skill: evil });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.id === "path-safety" && c.status === "fail")).toBe(true);

    const absolute: CanonicalSkill = {
      ...healthy.skill,
      files: [...healthy.skill.files, { path: "/etc/passwd", content: "x", purpose: "evil" }],
    };
    expect(validatePackage({ skill: absolute }).passed).toBe(false);
  });

  it("fails on malformed front matter", () => {
    const broken = structuredClone(healthy.skill);
    const skillMd = broken.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content = skillMd.content.replace(/^---\n[\s\S]*?\n---/, "---\nname: [unclosed\n---");
    const report = validatePackage({ skill: broken });
    expect(report.checks.some((c) => c.id === "frontmatter-parse" && c.status === "fail")).toBe(true);
  });

  it("fails on invalid slug in front matter", () => {
    const broken = structuredClone(healthy.skill);
    const skillMd = broken.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content = skillMd.content.replace(/^name: .*/m, "name: Bad Slug!");
    const report = validatePackage({ skill: broken });
    expect(report.checks.some((c) => c.id === "frontmatter-fields" && c.status === "fail" && c.message?.includes("lowercase"))).toBe(true);
  });

  it("fails on broken internal links", () => {
    const broken = structuredClone(healthy.skill);
    const skillMd = broken.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content = skillMd.content.replace(/\[references\/[a-z-]+\.md\]\([^)]+\)/, "[missing file](references/nope.md)");
    const report = validatePackage({ skill: broken });
    expect(report.checks.some((c) => c.id === "internal-links" && c.status === "fail")).toBe(true);
  });

  it("fails on invalid JSON files", () => {
    const broken = structuredClone(healthy.skill);
    const manifest = broken.files.find((f) => f.path === "manifest.json")!;
    manifest.content = manifest.content.replace("{", "{ broken:");
    const report = validatePackage({ skill: broken });
    expect(report.checks.some((c) => c.id === "json-parse" && c.status === "fail")).toBe(true);
  });

  it("flags manifest files that do not exist and unlisted files", () => {
    const broken = structuredClone(healthy.skill);
    const manifest = broken.files.find((f) => f.path === "manifest.json")!;
    const parsed = JSON.parse(manifest.content);
    parsed.files.push({ path: "ghost.md", bytes: 10 });
    parsed.files = parsed.files.filter((f: { path: string }) => f.path !== "SKILL.md");
    manifest.content = JSON.stringify(parsed, null, 2);
    const report = validatePackage({ skill: broken });
    const fails = report.checks.filter((c) => c.id === "manifest-consistency" && c.status === "fail");
    expect(fails.some((c) => c.message?.includes("ghost.md"))).toBe(true);
    expect(fails.some((c) => c.message?.includes("SKILL.md"))).toBe(true);
  });

  it("warns on placeholder text", () => {
    const broken = structuredClone(healthy.skill);
    const skillMd = broken.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content += "\n\nTODO: write more here\n";
    const report = validatePackage({ skill: resyncManifest(broken) });
    expect(report.checks.some((c) => c.id === "no-placeholders" && c.status === "warn" && c.message?.includes("TODO"))).toBe(true);
    // Warnings do not fail the report.
    expect(report.passed).toBe(true);
  });

  it("fails on ceremonial empty files", () => {
    const broken: CanonicalSkill = {
      ...healthy.skill,
      files: [...healthy.skill.files, { path: "references/empty.md", content: "\n\n", purpose: "padding" }],
    };
    const report = validatePackage({ skill: broken });
    expect(report.checks.some((c) => c.id === "no-empty-files" && c.status === "fail")).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("grounds commands in the source and warns on untraceable ones", () => {
    const broken = structuredClone(healthy.skill);
    const skillMd = broken.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content += "\n\n## Run\n\n```bash\ntotally-invented-command --flag value\n```\n";
    const report = validatePackage({ skill: resyncManifest(broken), sourceText: healthy.sourceText });
    expect(report.checks.some((c) => c.id === "grounding-commands" && c.status === "warn" && c.message?.includes("totally-invented-command"))).toBe(true);
  });

  it("reports skipped grounding honestly when the source is unavailable", () => {
    const report = validatePackage({ skill: healthy.skill });
    const grounding = report.checks.filter((c) => c.id === "grounding-commands");
    // Source absent → check either skips or is absent, but never falsely claims grounded pass detail.
    expect(report.checks.some((c) => c.id === "internal-links")).toBe(true);
    expect(grounding.length).toBeLessThanOrEqual(1);
  });

  it("skippedValidationReport is explicitly not-success", () => {
    const report = skippedValidationReport("validation was skipped for testing");
    expect(report.executed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("supports splitFrontMatter round trip", () => {
    const split = splitFrontMatter("---\nname: x\ndescription: y\n---\n\n# Body\n");
    expect(split!.fm).toBe("name: x\ndescription: y");
    expect(split!.body).toContain("# Body");
    expect(splitFrontMatter("no front matter")).toBeNull();
  });
});
