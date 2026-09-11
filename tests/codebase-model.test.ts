/**
 * Codebase source mode — canonical model foundation.
 *
 * The github-codebase source type carries a structured RepositoryAnalysis
 * through ingestion, the pipeline, and persistence. These tests pin the
 * schema contract and the passthrough behavior the later pipeline stages
 * rely on.
 */
import { describe, expect, it } from "vitest";
import {
  RepositoryAnalysis,
  SourceInput,
  type CanonicalSkill,
  type RepositoryAnalysis as RepositoryAnalysisType,
} from "../src/core/types.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, manifestFor } from "../src/core/build.js";
import { PlanSchema } from "../src/core/plan.js";
import { validatePackage } from "../src/core/validate.js";
import { createStore } from "../src/server/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sampleRepositoryAnalysis(): RepositoryAnalysisType {
  return {
    repository: { url: "https://github.com/acme/widgets", owner: "acme", name: "widgets", ref: "main" },
    mode: "codebase",
    languages: [{ name: "TypeScript", evidence: ["3 .ts files in tree", "package.json dependency typescript"] }],
    ecosystems: ["node"],
    frameworks: [{ name: "express", evidence: ["package.json dependency express"] }],
    manifests: [
      { path: "package.json", kind: "package.json", fetched: true },
      { path: "package-lock.json", kind: "lockfile", fetched: false },
    ],
    commands: [{ kind: "package-script", purpose: "test", name: "test", command: "npm test", evidence: "package.json scripts.test" }],
    structure: { sourceRoots: ["src/"], testRoots: ["tests/"], exampleRoots: [], packages: [] },
    entrypoints: [{ path: "src/index.ts", reason: "package.json main field" }],
    importantFiles: [{ path: "AGENTS.md", reason: "repository instruction file" }],
    conventions: [{ statement: "Run tests before pushing.", evidence: ["AGENTS.md:12"] }],
    publicInterfaces: [{ name: "createWidget", path: "src/core/widget.ts" }],
    testing: { frameworks: ["vitest"], relevantFiles: ["tests/widget.test.ts"] },
    inspectedFiles: ["package.json", "src/index.ts"],
    selection: { candidateCount: 20, selectedCount: 2, treeBlobCount: 30, treeTruncated: false },
    uncertainty: ["Only a bounded selection of repository files was inspected."],
  };
}

describe("RepositoryAnalysis schema", () => {
  it("accepts a complete, well-formed analysis", () => {
    const parsed = RepositoryAnalysis.safeParse(sampleRepositoryAnalysis());
    expect(parsed.success).toBe(true);
  });

  it("rejects an analysis whose mode is not codebase", () => {
    const bad = { ...sampleRepositoryAnalysis(), mode: "docs" };
    expect(RepositoryAnalysis.safeParse(bad).success).toBe(false);
  });

  it("rejects commands with an unknown purpose", () => {
    const bad = sampleRepositoryAnalysis();
    bad.commands = [{ kind: "package-script", purpose: "deploy-to-prod", name: "deploy", command: "npm publish", evidence: "package.json" } as never];
    expect(RepositoryAnalysis.safeParse(bad).success).toBe(false);
  });

  it("rejects conventions without evidence", () => {
    const bad = sampleRepositoryAnalysis();
    bad.conventions = [{ statement: "Never edit generated files.", evidence: [] }];
    expect(RepositoryAnalysis.safeParse(bad).success).toBe(false);
  });
});

describe("github-codebase source input", () => {
  it("accepts the new source type with a repository analysis", () => {
    const input: SourceInput = {
      type: "github-codebase",
      name: "acme/widgets",
      content: "# package.json\n\n{\"name\": \"widgets\"}",
      repository: sampleRepositoryAnalysis(),
    };
    expect(SourceInput.safeParse(input).success).toBe(true);
  });

  it("normalizes the source and passes the repository analysis through unchanged", () => {
    const input: SourceInput = {
      type: "github-codebase",
      name: "acme/widgets",
      content: `# package.json\n\n${JSON.stringify({ name: "widgets", scripts: { test: "vitest run" } }, null, 2)}\n`,
      repository: sampleRepositoryAnalysis(),
    };
    const normalized = normalizeSource(input);
    expect(normalized.repository).toEqual(sampleRepositoryAnalysis());
    expect(normalized.lineCount).toBeGreaterThan(1);
  });

  it("keeps documentation-mode sources unchanged (repository absent)", () => {
    const normalized = normalizeSource({ type: "github", name: "docs", content: "# Docs\n\nOrdinary documentation content flows exactly as before." });
    expect(normalized.repository).toBeUndefined();
  });
});

describe("repository provenance in build + manifest + store", () => {
  it("embeds a compact repository block in manifest.json for codebase sources", () => {
    const input: SourceInput = {
      type: "github-codebase",
      name: "acme/widgets",
      content: "# package.json\n\n{\"name\": \"widgets\", \"scripts\": {\"test\": \"vitest run\"}, \"dependencies\": {\"typescript\": \"^5\"}}\n",
      repository: sampleRepositoryAnalysis(),
    };
    const normalized = normalizeSource(input);
    const analysis = analyzeSource(normalized);
    const skill: CanonicalSkill = buildCanonicalSkill(normalized, analysis, PlanSchema.parse({ name: "widgets" }), "mock");
    const manifest = JSON.parse(skill.files.find((f) => f.path === "manifest.json")!.content);
    expect(manifest.source.repository).toEqual({
      url: "https://github.com/acme/widgets",
      owner: "acme",
      name: "widgets",
      ref: "main",
      mode: "codebase",
      inspectedFiles: ["package.json", "src/index.ts"],
      treeBlobCount: 30,
      candidateCount: 20,
      selectedCount: 2,
      treeTruncated: false,
    });
    // Deterministic: same input, same manifest bytes.
    const again = buildCanonicalSkill(normalizeSource(input), analysis, PlanSchema.parse({ name: "widgets" }), "mock");
    expect(again.files.find((f) => f.path === "manifest.json")!.content).toBe(
      skill.files.find((f) => f.path === "manifest.json")!.content,
    );
  });

  it("omits the repository block for documentation-mode sources", () => {
    const normalized = normalizeSource({ type: "text", name: "plain", content: "# Plain\n\nA plain documentation source, long enough to normalize cleanly and without repository data." });
    const analysis = analyzeSource(normalized);
    const skill = buildCanonicalSkill(normalized, analysis, PlanSchema.parse({}), "mock");
    const manifest = JSON.parse(skill.files.find((f) => f.path === "manifest.json")!.content);
    expect(manifest.source.repository).toBeUndefined();
  });

  it("round-trips the repository analysis through the skill store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillforge-store-"));
    try {
      const store = createStore(join(dir, "skills"));
      const input: SourceInput = {
        type: "github-codebase",
        name: "acme/widgets",
        content: `# package.json\n\n${JSON.stringify({ name: "widgets", description: "Widget bundle builder", scripts: { test: "vitest run" } }, null, 2)}\n`,
        repository: sampleRepositoryAnalysis(),
      };
      const normalized = normalizeSource(input);
      const analysis = analyzeSource(normalized);
      const skill = buildCanonicalSkill(normalized, analysis, PlanSchema.parse({ name: "widgets" }), "mock");
      const repository = sampleRepositoryAnalysis();
      await store.saveSkill({
        id: skill.id,
        skill,
        analysis: {
          title: analysis.title,
          sectionCount: analysis.sections.length,
          procedureCount: analysis.procedures.length,
          commandCount: analysis.commands.length,
          codeBlockCount: analysis.codeBlocks.length,
          lineCount: analysis.lineCount,
        },
        source: { name: input.name, type: "github-codebase", text: input.content, notes: [], repository },
        validation: {
          passed: true,
          executed: true,
          errorCount: 0,
          warningCount: 0,
          checks: [],
          validatorVersion: "1.0.0",
        },
        createdAt: new Date(0).toISOString(),
      });
      const loaded = await store.getSkill(skill.id);
      expect(loaded?.source.type).toBe("github-codebase");
      expect(loaded?.source.repository).toEqual(repository);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("manifestFor renders the repository block identically to the builder path", () => {
    const info = {
      name: "acme/widgets",
      sha256: "abc",
      lineCount: 10,
      notes: [],
      repository: {
        url: "https://github.com/acme/widgets",
        owner: "acme",
        name: "widgets",
        ref: "main",
        mode: "codebase" as const,
        inspectedFiles: ["package.json"],
        treeBlobCount: 30,
        candidateCount: 20,
        selectedCount: 1,
        treeTruncated: true,
      },
    };
    const manifest = JSON.parse(manifestFor([{ path: "SKILL.md", content: "x".repeat(40), purpose: "p" }], {
      name: "widgets", displayName: "Widgets", description: "d", version: "0.1.0",
      generator: "mock", generatedAt: new Date(0).toISOString(), gaps: [],
    }, info));
    expect(manifest.source.repository.treeTruncated).toBe(true);
  });
});

describe("repository-provenance validation check", () => {
  it("passes for codebase manifests and docs manifests alike", () => {
    const input: SourceInput = {
      type: "github-codebase",
      name: "acme/widgets",
      content: `# package.json\n\n${JSON.stringify({ name: "widgets", scripts: { test: "vitest run" } }, null, 2)}\n`,
      repository: sampleRepositoryAnalysis(),
    };
    const normalized = normalizeSource(input);
    const analysis = analyzeSource(normalized);
    const skill = buildCanonicalSkill(normalized, analysis, PlanSchema.parse({ name: "widgets" }), "mock");
    expect(validatePackage({ skill, sourceText: normalized.text }).passed).toBe(true);

    const docsNormalized = normalizeSource({ type: "text", name: "plain", content: "# Plain\n\nA plain documentation source, long enough to normalize cleanly and without repository data." });
    const docsSkill = buildCanonicalSkill(docsNormalized, analyzeSource(docsNormalized), PlanSchema.parse({}), "mock");
    expect(validatePackage({ skill: docsSkill, sourceText: docsNormalized.text }).passed).toBe(true);
  });

  it("fails when the repository block is malformed (mode mismatch, missing fields)", () => {
    const normalized = normalizeSource({ type: "text", name: "plain", content: "# Plain\n\nA plain documentation source, long enough to normalize cleanly and without repository data." });
    const skill = buildCanonicalSkill(normalized, analyzeSource(normalized), PlanSchema.parse({}), "mock");
    const manifestFile = skill.files.find((f) => f.path === "manifest.json")!;
    const manifest = JSON.parse(manifestFile.content);
    manifest.source.repository = { mode: "docs", owner: "acme" };
    manifestFile.content = JSON.stringify(manifest, null, 2) + "\n";
    const report = validatePackage({ skill, sourceText: normalized.text });
    expect(report.passed).toBe(false);
    const provenanceFindings = report.checks.filter((c) => c.id === "repository-provenance");
    expect(provenanceFindings.length).toBeGreaterThan(0);
    expect(provenanceFindings.some((c) => c.status === "fail" && c.message?.includes("mode"))).toBe(true);
    expect(provenanceFindings.some((c) => c.status === "fail" && c.message?.includes("url"))).toBe(true);
  });
});
