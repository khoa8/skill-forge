import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis, manifestFor } from "../src/core/build.js";
import { sha256 } from "../src/core/util.js";
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
function resyncManifest(skill: CanonicalSkill, sourceSha256 = sha256(healthy.sourceText)): CanonicalSkill {
  const files = skill.files.filter((f) => f.path !== "manifest.json");
  // Use the real manifest builder so the synthetic manifest carries the same
  // identity fields (name, displayName, description, version, generator) the
  // canonical-metadata-consistency check compares against.
  const manifest = manifestFor(files, skill.meta, {
    name: "fixture-source",
    sha256: sourceSha256,
    lineCount: 1,
    notes: [],
  });
  files.push({ path: "manifest.json", content: manifest, purpose: "manifest" });
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

  it("eval-integrity warns on incomplete or malformed eval items", () => {
    const broken = structuredClone(healthy.skill);
    const evals = broken.files.find((f) => f.path === "evals/evals.json");
    expect(evals).toBeDefined();
    if (!evals) throw new Error("Required evals fixture missing");
    evals.content = JSON.stringify({
      schema: "skillforge.evals/1",
      items: [
        { id: "eval-1", kind: "grounding", prompt: "Valid prompt with enough length?", expect: "Valid expectation." },
        { id: "eval-1", kind: "bogus-kind", prompt: "", expect: "x" },
        { kind: "grounding", prompt: "Missing id here?", expect: "Expectation present." },
      ],
    }, null, 2);
    const report = validatePackage({ skill: resyncManifest(broken) });
    const warns = report.checks.filter((c) => c.id === "eval-integrity" && c.status === "warn");
    expect(warns.some((c) => c.message?.includes("Duplicate eval id"))).toBe(true);
    expect(warns.some((c) => c.message?.includes("bogus-kind"))).toBe(true);
    expect(warns.some((c) => c.message?.includes("missing an id"))).toBe(true);
  });

  it("provenance-integrity fails on invalid line ranges and warns on missing records", () => {
    const broken = structuredClone(healthy.skill);
    broken.provenance = broken.provenance.map((p) =>
      p.filePath === "SKILL.md" ? { ...p, sourceLines: [5, 2] as [number, number] } : p,
    );
    const report = validatePackage({ skill: broken });
    expect(report.checks.some((c) => c.id === "provenance-integrity" && c.status === "fail")).toBe(true);

    const missing = structuredClone(healthy.skill);
    missing.provenance = missing.provenance.slice(0, 1);
    const report2 = validatePackage({ skill: missing });
    expect(report2.checks.some((c) => c.id === "provenance-integrity" && c.status === "warn" && c.message?.includes("no provenance record"))).toBe(true);
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

  it("fails manifest-consistency when a file is mutated to the same byte length (stale hash)", () => {
    const broken = structuredClone(healthy.skill);
    const targetFile = broken.files.find((f) => f.path === "references/authentication.md")!;
    // Exact same byte length mutation: "bearer" (6) -> "header" (6)
    const original = "bearer";
    const replacement = "header";
    expect(targetFile.content).toContain(original);
    targetFile.content = targetFile.content.replace(original, replacement);
    // bytes stay identical, but sha256 has drifted
    const report = validatePackage({ skill: broken, sourceText: healthy.sourceText });
    expect(report.passed).toBe(false);
    const failCheck = report.checks.find((c) => c.id === "manifest-consistency" && c.status === "fail");
    expect(failCheck).toBeDefined();
    expect(failCheck!.message).toContain("records sha256");
    expect(failCheck!.message).toContain("but the file hash is");
  });

  it("fails manifest-consistency when file content changes with stale bytes and sha256", () => {
    const broken = structuredClone(healthy.skill);
    const targetFile = broken.files.find((f) => f.path === "references/authentication.md")!;
    targetFile.content += "\nExtra line changing byte length.\n";
    const report = validatePackage({ skill: broken, sourceText: healthy.sourceText });
    expect(report.passed).toBe(false);
    const fails = report.checks.filter((c) => c.id === "manifest-consistency" && c.status === "fail");
    expect(fails.some((c) => c.message?.includes("records") && c.message?.includes("bytes"))).toBe(true);
    expect(fails.some((c) => c.message?.includes("records sha256"))).toBe(true);
  });

  it("fails manifest-consistency on missing or malformed file entry sha256", () => {
    const broken = structuredClone(healthy.skill);
    const manifestFile = broken.files.find((f) => f.path === "manifest.json")!;
    const parsed = JSON.parse(manifestFile.content);
    parsed.files[0].sha256 = "not-a-valid-sha";
    manifestFile.content = JSON.stringify(parsed, null, 2);
    const report = validatePackage({ skill: broken, sourceText: healthy.sourceText });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.id === "manifest-consistency" && c.status === "fail" && c.message?.includes("invalid sha256"))).toBe(true);

    // Missing sha256
    delete parsed.files[0].sha256;
    manifestFile.content = JSON.stringify(parsed, null, 2);
    const reportMissing = validatePackage({ skill: broken, sourceText: healthy.sourceText });
    expect(reportMissing.passed).toBe(false);
    expect(reportMissing.checks.some((c) => c.id === "manifest-consistency" && c.status === "fail" && c.message?.includes("invalid sha256"))).toBe(true);
  });

  it("fails manifest-consistency on missing, non-integer, or negative file entry bytes", () => {
    const broken = structuredClone(healthy.skill);
    const manifestFile = broken.files.find((f) => f.path === "manifest.json")!;
    const parsed = JSON.parse(manifestFile.content);
    parsed.files[0].bytes = -1;
    manifestFile.content = JSON.stringify(parsed, null, 2);
    expect(validatePackage({ skill: broken }).checks.some((c) => c.id === "manifest-consistency" && c.status === "fail" && c.message?.includes("invalid bytes"))).toBe(true);

    parsed.files[0].bytes = 12.5;
    manifestFile.content = JSON.stringify(parsed, null, 2);
    expect(validatePackage({ skill: broken }).checks.some((c) => c.id === "manifest-consistency" && c.status === "fail" && c.message?.includes("invalid bytes"))).toBe(true);

    delete parsed.files[0].bytes;
    manifestFile.content = JSON.stringify(parsed, null, 2);
    expect(validatePackage({ skill: broken }).checks.some((c) => c.id === "manifest-consistency" && c.status === "fail" && c.message?.includes("invalid bytes"))).toBe(true);
  });

  it("fails manifest-consistency when manifest.source.sha256 does not match provided source text", () => {
    const broken = structuredClone(healthy.skill);
    const manifestFile = broken.files.find((f) => f.path === "manifest.json")!;
    const parsed = JSON.parse(manifestFile.content);
    parsed.source.sha256 = "0".repeat(64);
    manifestFile.content = JSON.stringify(parsed, null, 2);
    const report = validatePackage({ skill: broken, sourceText: healthy.sourceText });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.id === "manifest-consistency" && c.status === "fail" && c.message?.includes("source.sha256") && c.message?.includes("does not match"))).toBe(true);
  });

  it("warns honestly when source text is unavailable for source hash verification", () => {
    const report = validatePackage({ skill: healthy.skill });
    expect(report.passed).toBe(true);
    const warnCheck = report.checks.find((c) => c.id === "manifest-consistency" && c.status === "warn");
    expect(warnCheck).toBeDefined();
    expect(warnCheck!.message).toContain("Source text unavailable; manifest.source.sha256 could not be verified");
  });
});

describe("canonical instruction sections", () => {
  const headings = ["When to use this skill", "Inputs required", "Workflow", "Constraints", "Verification", "Common pitfalls", "References"];
  function withBody(body: string) {
    const skill = structuredClone(healthy.skill);
    const file = skill.files.find((f) => f.path === "SKILL.md")!;
    file.content = `---\n${splitFrontMatter(file.content)!.fm}\n---\n${body}`;
    return resyncManifest(skill);
  }
  it("accepts generated instructions and explicit source gaps", () => {
    expect(validatePackage({ skill: healthy.skill }).passed).toBe(true);
    const skill = withBody(headings.map((h) => `## ${h}\n\nSource gap: the supplied material does not specify this information.\n`).join("\n"));
    expect(validatePackage({ skill }).passed).toBe(true);
  });
  it.each(["", "<!-- nothing -->", "```md\n" + headings.map((h) => `## ${h}\npretend instructions`).join("\n") + "\n```"])("rejects bodies without real sections: %s", (body) => {
    const report = validatePackage({ skill: withBody(body) });
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "skill-instructions", status: "fail" }));
  });
  it.each(headings)("rejects a missing or empty %s section", (heading) => {
    const body = splitFrontMatter(healthy.skill.files.find((f) => f.path === "SKILL.md")!.content)!.body;
    expect(validatePackage({ skill: withBody(body.replace(`## ${heading}`, `## Different section`)) }).passed).toBe(false);
    expect(validatePackage({ skill: withBody(headings.map((h) => `## ${h}\n${h === heading ? "<!-- empty -->\n> ---" : "Explicit source gap: not supplied."}\n`).join("\n")) }).passed).toBe(false);
  });
});
