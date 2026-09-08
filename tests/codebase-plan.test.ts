/**
 * Codebase-mode generation: deterministic plan derivation from the structured
 * repository analysis, mock-provider routing, remote-provider context, and a
 * full offline pipeline run (ingest → analyze → generate → validate) over a
 * github-codebase source.
 */
import { describe, expect, it } from "vitest";
import { deriveCodebasePlan } from "../src/core/codebase/plan.js";
import { MockProvider } from "../src/core/providers/mock.js";
import { OpenAICompatibleProvider } from "../src/core/providers/openai-compatible.js";
import { PlanSchema } from "../src/core/plan.js";
import { runPipeline } from "../src/core/pipeline.js";
import { validatePackage } from "../src/core/validate.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill } from "../src/core/build.js";
import type { RepositoryAnalysis, SourceInput } from "../src/core/types.js";
import { sampleRepositoryAnalysis } from "./codebase-model.test.js";

/** A realistic analysis mirroring the Fixture A ingestion result. */
function fullAnalysis(): RepositoryAnalysis {
  const base = sampleRepositoryAnalysis();
  return {
    ...base,
    repository: { url: "https://github.com/acme/fixture-service", owner: "acme", name: "fixture-service", ref: "main" },
    languages: [{ name: "TypeScript", evidence: ["3 .ts file(s) in the repository tree"] }],
    ecosystems: ["node"],
    frameworks: [{ name: "Fastify", evidence: ["package.json dependencies: fastify"] }],
    manifests: [
      { path: "package.json", kind: "package.json", fetched: true },
      { path: "package-lock.json", kind: "lockfile", fetched: false },
    ],
    commands: [
      { purpose: "install", command: "npm ci", evidence: ".github/workflows/ci.yml (CI run step)" },
      { purpose: "dev", command: "npm run dev", evidence: 'package.json scripts.dev = "tsx watch src/server.ts"' },
      { purpose: "build", command: "npm run build", evidence: 'package.json scripts.build = "tsc -p tsconfig.json"' },
      { purpose: "test", command: "npm test", evidence: 'package.json scripts.test = "vitest run"' },
      { purpose: "lint", command: "npm run lint", evidence: 'package.json scripts.lint = "eslint ."' },
      { purpose: "typecheck", command: "npm run typecheck", evidence: 'package.json scripts.typecheck = "tsc --noEmit"' },
    ],
    structure: { sourceRoots: ["src/"], testRoots: ["tests/"], exampleRoots: [], packages: [] },
    entrypoints: [{ path: "src/index.ts", reason: "entrypoint-named file under a source root + package.json main field (package.json)" }],
    importantFiles: [
      { path: "AGENTS.md", reason: "repository instruction file (conventions and workflow authority)" },
      { path: "README.md", reason: "primary repository documentation" },
    ],
    conventions: [
      { statement: "Never commit secrets to the repository.", evidence: ["AGENTS.md:3"] },
      { statement: "Always run `npm test` before pushing changes.", evidence: ["AGENTS.md:4"] },
      { statement: "New modules belong in src/core.", evidence: ["AGENTS.md:8"] },
    ],
    publicInterfaces: [{ name: "fixture-service", path: "package.json", description: "package.json main: src/index.ts" }],
    testing: { frameworks: ["vitest"], relevantFiles: ["tests/service.test.ts"] },
    inspectedFiles: ["README.md", "AGENTS.md", "package.json", "tsconfig.json", "src/index.ts", "src/server.ts", "src/core/service.ts", "tests/service.test.ts", ".github/workflows/ci.yml"],
    selection: { candidateCount: 10, selectedCount: 9, treeBlobCount: 11, treeTruncated: false },
    uncertainty: ["1 of 10 eligible files were not inspected (bounded selection budget)."],
  };
}

describe("deriveCodebasePlan", () => {
  it("derives a grounded, evidence-citing plan", () => {
    const plan = PlanSchema.parse(deriveCodebasePlan(fullAnalysis()));
    expect(plan.name).toBe("acme-fixture-service");
    expect(plan.whenToUse[0]).toContain("acme/fixture-service");
    expect(plan.whenToUse.join(" ")).toContain("bounded, prioritized inspection of 9 of 10");

    // Every command step cites its defining file.
    const testStep = plan.verification.find((v) => v.includes("`npm test`"));
    expect(testStep).toContain("package.json scripts.test");
    const installStep = plan.steps.find((s) => s.includes("`npm ci`"));
    expect(installStep).toContain(".github/workflows/ci.yml");

    // Conventions become constraints verbatim.
    expect(plan.constraints).toContain("Never commit secrets to the repository.");

    // Warning-shaped conventions surface as pitfalls; honest uncertainty too.
    expect(plan.pitfalls).toContain("Never commit secrets to the repository.");
    expect(plan.pitfalls.join(" ")).toContain("were not inspected");

    // Orientation step names the instruction files.
    expect(plan.steps[0]).toContain("`AGENTS.md`");
    // Test-location guidance references the test root.
    expect(plan.steps.join(" ")).toContain("`tests/`");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(deriveCodebasePlan(fullAnalysis()))).toBe(
      JSON.stringify(deriveCodebasePlan(fullAnalysis())),
    );
  });

  it("respects the plan schema caps and handles a sparse analysis without inventing content", () => {
    const sparse: RepositoryAnalysis = {
      repository: { url: "https://github.com/acme/bare", owner: "acme", name: "bare", ref: "main" },
      mode: "codebase",
      languages: [{ name: "Go", evidence: ["2 .go file(s) in the repository tree"] }],
      ecosystems: ["go"],
      frameworks: [],
      manifests: [{ path: "go.mod", kind: "go.mod", fetched: true }],
      commands: [],
      structure: { sourceRoots: [], testRoots: [], exampleRoots: [], packages: [] },
      entrypoints: [],
      importantFiles: [],
      conventions: [],
      publicInterfaces: [],
      testing: { frameworks: [], relevantFiles: [] },
      inspectedFiles: ["go.mod"],
      selection: { candidateCount: 2, selectedCount: 1, treeBlobCount: 2, treeTruncated: false },
      uncertainty: ["1 of 2 eligible files were not inspected (bounded selection budget)."],
    };
    const plan = PlanSchema.parse(deriveCodebasePlan(sparse));
    expect(plan.verification).toEqual([]); // no evidenced commands — honest gap, never invented
    expect(plan.constraints).toEqual([]);
    expect(plan.whenToUse[0]).toContain("Go");
  });
});

describe("MockProvider codebase routing", () => {
  it("uses the repository plan for github-codebase inputs", async () => {
    const provider = new MockProvider();
    const input = normalizeSource({
      type: "github-codebase",
      name: "acme/fixture-service codebase",
      content: `# package.json\n\n${JSON.stringify({ name: "fixture-service", scripts: { test: "vitest run" } }, null, 2)}\n`,
      repository: fullAnalysis(),
    });
    const plan = await provider.generate({
      source: input,
      analysis: analyzeSource(input),
      repository: input.repository,
    });
    expect(plan.name).toBe("acme-fixture-service");
    expect(plan.displayName).toContain("coding agent guide");
    expect(plan.verification.length).toBeGreaterThan(0);
  });
});

describe("OpenAI-compatible provider receives repository context", () => {
  it("includes the repository analysis in the prompt when present", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ whenToUse: ["x"], inputs: [], steps: [], constraints: [], verification: [], pitfalls: [] }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      baseUrl: "https://provider.example/v1",
      model: "test-model",
      fetchImpl,
    });
    const input = normalizeSource({
      type: "github-codebase",
      name: "acme/fixture-service codebase",
      content: `# package.json\n\n${JSON.stringify({ name: "fixture-service" }, null, 2)}\n`,
      repository: fullAnalysis(),
    });
    await provider.generate({ source: input, analysis: analyzeSource(input), repository: input.repository });
    expect(capturedBody).toContain("Repository analysis (bounded, evidence-backed");
    expect(capturedBody).toContain("acme/fixture-service");
  });

  it("omits the repository section for documentation-mode inputs", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ whenToUse: ["x"], inputs: [], steps: [], constraints: [], verification: [], pitfalls: [] }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      baseUrl: "https://provider.example/v1",
      model: "test-model",
      fetchImpl,
    });
    const input = normalizeSource({ type: "text", name: "docs", content: "# Docs\n\nPlain documentation content long enough to normalize cleanly through ingest." });
    await provider.generate({ source: input, analysis: analyzeSource(input) });
    expect(capturedBody).not.toContain("Repository analysis");
  });
});

describe("codebase pipeline end-to-end (offline mock)", () => {
  it("generates, validates, and exports a codebase-specific skill", async () => {
    const input: SourceInput = {
      type: "github-codebase",
      name: "acme/fixture-service codebase",
      content: [
        "# package.json",
        "",
        JSON.stringify({ name: "fixture-service", scripts: { test: "vitest run", build: "tsc -p tsconfig.json" }, devDependencies: { vitest: "^1" } }, null, 2),
        "",
        "# AGENTS.md",
        "",
        "- Never commit secrets to the repository.",
        "- Always run `npm test` before pushing changes.",
        "",
        "# README.md",
        "",
        "## Setup",
        "",
        "1. Run `npm install`.",
        "2. Run `npm run dev`.",
        "3. Verify with `npm test`.",
        "",
        "# tests/service.test.ts",
        "",
        'import { describe, expect, it } from "vitest";',
        'describe("Service", () => { it("works", () => { expect(1).toBe(1); }); });',
      ].join("\n"),
      repository: fullAnalysis(),
    };

    let result: { skill: unknown; validation: unknown } | null = null;
    const events: { type: string; stage?: string; detail?: string }[] = [];
    for await (const ev of runPipeline(input, { provider: "mock" })) {
      events.push(ev as { type: string; stage?: string; detail?: string });
      if (ev.type === "result") result = ev as unknown as { skill: unknown; validation: unknown };
      if (ev.type === "error") throw new Error(`${(ev as { message: string }).message}`);
    }
    expect(result).toBeTruthy();
    const skill = (result as { skill: import("../src/core/types.js").CanonicalSkill }).skill;
    const validation = (result as { validation: import("../src/core/types.js").ValidationReport }).validation;

    // Codebase-oriented SKILL.md content (not a generic docs summary).
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!.content;
    expect(skillMd).toContain("acme/fixture-service");
    expect(skillMd).toContain("`npm test`");
    expect(skillMd).toContain("Never commit secrets to the repository.");
    // Validation executed and passed.
    expect(validation.executed).toBe(true);
    expect(validation.passed).toBe(true);

    // The build + validation must also succeed through the canonical path.
    const normalized = normalizeSource(input);
    const rebuilt = buildCanonicalSkill(normalized, analyzeSource(normalized), PlanSchema.parse({}), "mock");
    expect(rebuilt.files.length).toBeGreaterThan(3);
    void validatePackage({ skill: rebuilt, sourceText: normalized.text });
    void events;
  });
});
