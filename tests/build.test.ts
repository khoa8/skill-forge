import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis, GAP_NOTE } from "../src/core/build.js";
import { CanonicalSkill } from "../src/core/types.js";
import { getSample } from "../src/core/samples.js";

function build(source: string) {
  const normalized = normalizeSource({ type: "text", name: "doc", content: source });
  const analysis = analyzeSource(normalized);
  const plan = derivePlanFromAnalysis(analysis);
  return { normalized, analysis, plan, skill: buildCanonicalSkill(normalized, analysis, plan, "mock") };
}

describe("buildCanonicalSkill", () => {
  it("produces a schema-valid canonical package with purposeful files", () => {
    const { skill } = build(getSample("meridian-payments-api").content);
    const parsed = CanonicalSkill.safeParse(skill);
    expect(parsed.success).toBe(true);
    expect(skill.files.map((f) => f.path)).toContain("SKILL.md");
    expect(skill.files.map((f) => f.path)).toContain("manifest.json");
    for (const file of skill.files) {
      expect(file.purpose.length).toBeGreaterThan(10);
      expect(file.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("is deterministic: identical input yields byte-identical files", () => {
    const source = getSample("fastforge-cli").content;
    const a = build(source).skill;
    const b = build(source).skill;
    expect(a.files).toEqual(b.files);
    expect(a.plan).toEqual(b.plan);
  });

  it("keeps reference content verbatim from the source", () => {
    const { skill, normalized } = build(getSample("meridian-payments-api").content);
    const ref = skill.files.find((f) => f.path === "references/authentication.md")!;
    const lines = normalized.text.split("\n");
    // Section body must appear verbatim inside the reference excerpt.
    expect(ref.content).toContain(lines.slice(8, 20).join("\n").replace(/^## Authentication\n\n/, ""));
  });

  it("records line-range provenance for generated files", () => {
    const { skill } = build(getSample("meridian-payments-api").content);
    expect(skill.provenance.length).toBeGreaterThanOrEqual(skill.files.length);
    for (const p of skill.provenance) {
      expect(p.sourceLines[0]).toBeLessThanOrEqual(p.sourceLines[1]);
      expect(p.extraction.length).toBeGreaterThan(3);
    }
  });

  it("renders an explicit gap instead of inventing content", () => {
    const source = "# Bare Notes\n\nJust a paragraph with no procedures, warnings, or commands at all. Nothing structured here.\n";
    const { skill } = build(source);
    expect(skill.meta.gaps.length).toBeGreaterThan(0);
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!;
    expect(skillMd.content).toContain(GAP_NOTE.slice(0, 40));
  });

  it("detects env-var inputs only from configuration contexts", () => {
    const source = [
      "# Tool",
      "",
      "Set the environment variable `MY_TOOL_TOKEN` before calls.",
      "",
      "## Usage",
      "",
      "The word SKYSCRAPER appears here in plain prose text.",
      "",
      "```bash",
      "tool run --token",
      "```",
      "",
    ].join("\n");
    const { skill } = build(source);
    const inputs = skill.plan.inputs.join("\n");
    expect(inputs).toContain("MY_TOOL_TOKEN");
    expect(inputs).not.toContain("SKYSCRAPER");
  });

  it("writes valid JSON example files (no comment prefix for json)", () => {
    const source = [
      "## Payload",
      "",
      "The payment object returns these fields.",
      "",
      "```json",
      "{",
      '  "amount": 100,',
      '  "currency": "usd",',
      '  "status": "ok"',
      "}",
      "```",
      "",
    ].join("\n");
    const { skill } = build(source);
    const example = skill.files.find((f) => f.path.startsWith("examples/") && f.path.endsWith(".json"));
    expect(example).toBeDefined();
    expect(() => JSON.parse(example!.content)).not.toThrow();
  });

  it("manifest inventories match actual files with byte counts", () => {
    const { skill } = build(getSample("fastforge-cli").content);
    const manifest = JSON.parse(skill.files.find((f) => f.path === "manifest.json")!.content);
    const actual = skill.files.filter((f) => f.path !== "manifest.json");
    expect(manifest.files).toHaveLength(actual.length);
    for (const entry of manifest.files) {
      const file = actual.find((f) => f.path === entry.path);
      expect(file).toBeDefined();
      expect(entry.bytes).toBe(Buffer.byteLength(file!.content, "utf8"));
    }
  });
});
