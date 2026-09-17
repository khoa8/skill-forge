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
});
