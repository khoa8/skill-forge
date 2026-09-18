import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis, manifestFor } from "../src/core/build.js";
import { evaluateSkill } from "../src/core/evaluate.js";

function fixture() {
  const source = normalizeSource({
    type: "text",
    name: "guide",
    content: "# Guide\n\nDocumentation for a deterministic local workflow.\n\n## Setup\n\nRead the configuration before proceeding with this operation.\n\n1. Read the configuration.\n2. Select the documented option.\n3. Verify the result.\n",
  });
  const analysis = analyzeSource(source);
  const skill = buildCanonicalSkill(source, analysis, derivePlanFromAnalysis(analysis), "mock");
  return { skill, source };
}

function syncManifest(ctx: ReturnType<typeof fixture>) {
  ctx.skill.files.find((file) => file.path === "manifest.json")!.content = manifestFor(
    ctx.skill.files.filter((file) => file.path !== "manifest.json"),
    ctx.skill.meta,
    { name: ctx.source.originalName, sha256: ctx.source.sha256, lineCount: ctx.source.lineCount, notes: ctx.source.notes },
  );
}

describe("evaluateSkill", () => {
  it("does not pass an eval whose prompt was changed", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    specification.items[0].prompt = "Does the skill mention anything at all?";
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.checks.find((check) => check.id === specification.items[0].id)?.status).toBe("not-executable");
    expect(report.counts.notExecutable).toBeGreaterThan(0);
  });

  it("reports a deleted expected eval explicitly instead of dropping it (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    const [removed] = specification.items.splice(1, 1);
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    const check = report.checks.find((c) => c.id === removed.id);
    expect(check?.status).toBe("not-executable");
    expect(check?.message).toMatch(/missing/i);
  });

  it("reports explicit outcomes when items is empty but the source implies expectations (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    file.content = JSON.stringify({ schema: "skillforge.evals/1", items: [] });
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.counts.passed).toBe(0);
    expect(report.counts.concern).toBe(0);
    expect(report.counts.notExecutable).toBe(report.checks.length);
  });

  it("surfaces a schema-invalid expected item instead of dropping it (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    specification.items[0].assertions[0].type = "bogus-kind";
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    const check = report.checks.find((c) => c.id === specification.items[0].id);
    expect(check?.status).toBe("not-executable");
    expect(check?.message).toMatch(/malformed|not-executable|parse/i);
  });

  it("surfaces a duplicated expected id instead of evaluating it twice (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    specification.items.push(structuredClone(specification.items[0]));
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    const matches = report.checks.filter((c) => c.id === specification.items[0].id);
    expect(matches.length).toBe(1);
    expect(matches[0]?.status).toBe("not-executable");
    expect(matches[0]?.message).toMatch(/duplicate/i);
  });

  it("fails an over-limit eval inventory honestly instead of truncating it (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    for (let i = 0; i < 64; i++) {
      specification.items.push({
        id: `eval-pad-${i}`,
        kind: "grounding",
        prompt: `Padding manual question ${i}?`,
        expect: "Padding expectation for bound testing.",
      });
    }
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.executed).toBe(false);
    expect(report.counts.passed).toBe(0);
    expect(report.counts.concern).toBe(0);
    expect(report.checks.some((c) => c.status === "not-executable" && /at most 64/i.test(c.message))).toBe(true);
  });

  it("keeps legacy manual-only items as not-executable, never passes (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    for (const item of specification.items) delete item.assertions;
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.executed).toBe(true);
    expect(report.counts.passed).toBe(0);
    expect(report.counts.notExecutable).toBe(report.checks.length);
  });

  it("does not penalize canonical relative-link neutralization in topics or steps (F-02)", () => {
    const source = normalizeSource({
      type: "text",
      name: "guide",
      content: "# Guide\n\nDocumentation for a deterministic local workflow.\n\n## Setup\n\nRead [the configuration guide](docs/config.md) before continuing with this documented operation.\n\n1. Read [the configuration guide](docs/config.md) first.\n2. Select the documented option next.\n3. Verify the operation result afterwards.\n",
    });
    const analysis = analyzeSource(source);
    const skill = buildCanonicalSkill(source, analysis, derivePlanFromAnalysis(analysis), "mock");
    const report = evaluateSkill({ skill, source });
    expect(report.executed).toBe(true);
    expect(report.counts.concern).toBe(0);
    expect(report.checks.filter((c) => c.status === "pass").length).toBeGreaterThan(0);
  });
});
