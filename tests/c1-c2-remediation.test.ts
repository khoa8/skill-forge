/**
 * Regression tests for C1 (Catalog Materialization Coherence) and C2 (Untrusted
 * Repository Metadata Rendering).
 *
 * C1 Invariant:
 * Every artifact path intentionally referenced by selected grounded guidance
 * must resolve to an actual final package file, and deterministic validation
 * must enforce that all package artifact references resolve.
 *
 * C2 Invariant:
 * Untrusted repository metadata must remain inert data when rendered into
 * Markdown or trusted instructions, and unsafe path characters (newlines,
 * control characters) are rejected at ingestion.
 */
import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import {
  prepareProviderCatalog,
  resolveProviderProposal,
  MAX_PROVIDER_SOURCE_CHARS,
} from "../src/core/plan-catalog.js";
import { buildCanonicalSkill, derivePlanFromAnalysis } from "../src/core/build.js";
import { validatePackage } from "../src/core/validate.js";
import { formatCodeSpan } from "../src/core/util.js";
import { isSafeRepoPath } from "../src/core/sources/github.js";
import { deriveCodebasePlan } from "../src/core/codebase/plan.js";
import type { RepositoryAnalysis } from "../src/core/types.js";
import { sampleRepositoryAnalysis } from "./codebase-model.test.js";

describe("C1 — Catalog Materialization Coherence", () => {
  it("C1-T1: materializes prefix-selected reference artifacts even when full analysis switches reference mode", () => {
    // Construct source where prefix (<60k) has only H1, and tail (>60k) introduces H2
    const prefixH1 = "# Head Guide\n\nThis is substantive documentation for the head guide topic.\n";
    const padding = "Line of documentation content that pads the text.\n".repeat(1200); // ~60k chars
    const tailH2 = "\n## Details\n\nThis is substantive documentation for the details section.\n";
    const fullText = prefixH1 + padding + tailH2;

    expect(fullText.length).toBeGreaterThan(MAX_PROVIDER_SOURCE_CHARS);

    const source = normalizeSource({
      type: "text",
      name: "guide-doc",
      content: fullText,
    });

    const fullAnalysis = analyzeSource(source);
    // Full analysis has both H1 and H2
    expect(fullAnalysis.sections.some((s) => s.level === 1)).toBe(true);
    expect(fullAnalysis.sections.some((s) => s.level === 2)).toBe(true);

    const prep = prepareProviderCatalog(source, fullAnalysis, { offline: false });
    // Provider analysis has only H1
    expect(prep.providerAnalysis.sections.some((s) => s.level === 2)).toBe(false);

    // The prefix-derived catalog includes a step atom for the Head Guide reference
    const stepAtoms = prep.catalog.atoms.filter((a) => a.section === "steps");
    const refStepAtom = stepAtoms.find(
      (a) => a.sourceAnchor?.kind === "section" && a.sourceAnchor.heading === "Head Guide",
    );
    expect(refStepAtom).toBeDefined();
    expect(refStepAtom!.text).toContain("Head Guide");

    // Provider selects the reference step atom
    const proposal = {
      selections: {
        whenToUse: [prep.catalog.atoms.find((a) => a.section === "whenToUse")!.id],
        inputs: [],
        steps: [refStepAtom!.id],
        constraints: [],
        verification: [],
        pitfalls: [],
      },
    };

    const resolvedPlan = resolveProviderProposal(proposal, prep.catalog);
    expect(resolvedPlan.steps[0]).toContain("Head Guide");
    expect(resolvedPlan.stepAtoms?.[0]?.sourceAnchor).toEqual(
      expect.objectContaining({ kind: "section", heading: "Head Guide" }),
    );

    // Canonical builder runs with the full source and full analysis
    const skill = buildCanonicalSkill(source, fullAnalysis, resolvedPlan, "glm");

    // Invariant: references/head-guide.md MUST be materialized in skill.files via late binding
    const headGuideFile = skill.files.find((f) => f.path === "references/head-guide.md");
    expect(headGuideFile).toBeDefined();
    expect(headGuideFile!.content).toContain("# Head Guide");
    expect(headGuideFile!.content).toContain("substantive documentation for the head guide topic");

    // Invariant: the rendered step links cleanly to references/head-guide.md
    expect(skill.plan.steps[0]).toContain("[references/head-guide.md](references/head-guide.md)");

    // Invariant: tail-allocated reference (references/details.md) is ALSO materialized
    const detailsFile = skill.files.find((f) => f.path === "references/details.md");
    expect(detailsFile).toBeDefined();
    expect(detailsFile!.content).toContain("# Details");

    // Invariant: SKILL.md lists references/head-guide.md under ## References
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!.content;
    expect(skillMd).toContain("references/head-guide.md");
    expect(skillMd).toContain("## References");

    // Invariant: Deterministic validation passes with 0 errors
    const report = validatePackage({ skill, sourceText: source.text });
    expect(report.passed).toBe(true);
    expect(report.errorCount).toBe(0);
  });

  it("C1-T1-b: validator fails closed on missing reference or workflow artifacts in step prose", () => {
    const source = normalizeSource({
      type: "text",
      name: "minimal-doc",
      content: "# Title\n\nSubstantive content for testing the validation gate.\n",
    });
    const analysis = analyzeSource(source);
    const plan = {
      name: "test-skill",
      displayName: "Test Skill",
      description: "Test description",
      whenToUse: ["When testing."],
      inputs: [],
      steps: ["Consult the missing guide in [references/nonexistent-artifact.md](references/nonexistent-artifact.md) and apply it."],
      constraints: [],
      verification: [],
      pitfalls: [],
    };

    const skill = buildCanonicalSkill(source, analysis, plan, "mock");
    const report = validatePackage({ skill, sourceText: source.text });

    // Validation must fail because references/nonexistent-artifact.md is missing
    expect(report.passed).toBe(false);
    const linkCheck = report.checks.find((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkCheck).toBeDefined();
    expect(linkCheck!.message).toContain("references/nonexistent-artifact.md");
  });

  it("C1-R1: inert path text in reference excerpt body does not fail validation", () => {
    const source = normalizeSource({
      type: "text",
      name: "config-guide",
      content: [
        "# Configuration Guide",
        "",
        "Instructions for configuring the system.",
        "",
        "## Configuration Details",
        "",
        "For external settings, see references/external.md in the original documentation.",
        "Also check config/settings.json or references/old-guide.md for legacy setups.",
        "Ensure all environment variables are set before starting the worker service.",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const plan = derivePlanFromAnalysis(analysis);
    const skill = buildCanonicalSkill(source, analysis, plan, "mock");

    // The reference file must contain the inert text mentioning references/external.md
    const refFile = skill.files.find((f) => f.path.startsWith("references/"));
    expect(refFile).toBeDefined();
    expect(refFile!.content).toContain("references/external.md");

    // Validation must pass with 0 errors (inert text is not treated as a package link)
    const report = validatePackage({ skill, sourceText: source.text });
    expect(report.passed).toBe(true);
    expect(report.errorCount).toBe(0);
    const brokenLinks = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(brokenLinks).toHaveLength(0);
  });

  it("C1-R2: duplicate headings with collision suffixes resolve and materialize correctly", () => {
    const source = normalizeSource({
      type: "text",
      name: "duplicate-headings-doc",
      content: [
        "# Duplicate Headings Guide",
        "",
        "Testing collision suffix handling with duplicate section headings.",
        "",
        "Foo",
        "---",
        "First foo section body with substantive content that exceeds the minimum character count.",
        "",
        "Foo",
        "---",
        "Second foo section body with substantive content that exceeds the minimum character count.",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    expect(analysis.sections.filter((s) => s.heading === "Foo")).toHaveLength(2);

    const prep = prepareProviderCatalog(source, analysis, { offline: false });
    const fooAtoms = prep.catalog.atoms.filter(
      (a) => a.section === "steps" && a.sourceAnchor?.kind === "section" && a.sourceAnchor.heading === "Foo",
    );
    expect(fooAtoms).toHaveLength(2);
    // The second atom corresponds to the second "Foo" section
    const secondFooAtom = fooAtoms[1]!;

    // Provider selects the second "Foo" atom (which receives collision suffix -2 upon allocation)
    const proposal = {
      selections: {
        whenToUse: [prep.catalog.atoms.find((a) => a.section === "whenToUse")!.id],
        inputs: [],
        steps: [secondFooAtom.id],
        constraints: [],
        verification: [],
        pitfalls: [],
      },
    };

    const resolvedPlan = resolveProviderProposal(proposal, prep.catalog);
    expect(resolvedPlan.stepAtoms?.[0]?.sourceAnchor).toEqual(secondFooAtom.sourceAnchor);

    const skill = buildCanonicalSkill(source, analysis, resolvedPlan, "glm");

    // references/foo-2.md must be materialized in skill.files
    const foo2File = skill.files.find((f) => f.path === "references/foo-2.md");
    expect(foo2File).toBeDefined();
    expect(foo2File!.content).toContain("Second foo section body");

    // The rendered step must link to [references/foo-2.md](references/foo-2.md)
    expect(skill.plan.steps[0]).toContain("[references/foo-2.md](references/foo-2.md)");

    // Validation must pass with 0 errors
    const report = validatePackage({ skill, sourceText: source.text });
    expect(report.passed).toBe(true);
    expect(report.errorCount).toBe(0);
  });

  it("C1-T4: backward compatibility for direct SkillPlan callers without stepAtoms", () => {
    const source = normalizeSource({
      type: "text",
      name: "manual-doc",
      content: "# Manual Doc\n\nSubstantive content for manual test.\n\n## Settings\n\nSettings body content that exceeds minimum length threshold.\n",
    });
    const analysis = analyzeSource(source);
    // Caller provides plain SkillPlan without stepAtoms
    const manualPlan = {
      name: "manual-skill",
      displayName: "Manual Skill",
      description: "Manual description",
      whenToUse: ["When manually testing."],
      inputs: [],
      steps: [
        "First do manual step A.",
        "Consult the settings in [references/settings.md](references/settings.md) and apply them.",
      ],
      constraints: [],
      verification: [],
      pitfalls: [],
    };

    const skill = buildCanonicalSkill(source, analysis, manualPlan, "mock");
    expect(skill.plan.steps[0]).toBe("First do manual step A.");
    expect(skill.plan.steps[1]).toContain("[references/settings.md](references/settings.md)");
    expect(skill.files.some((f) => f.path === "references/settings.md")).toBe(true);

    const report = validatePackage({ skill, sourceText: source.text });
    expect(report.passed).toBe(true);
    expect(report.errorCount).toBe(0);
  });

  it("C1-T2: ordinary source catalog does not leak tail content beyond 60k boundary", () => {
    const prefix = "# Prefix Section\n\nContent inside the 60k boundary.\n" + "x".repeat(65_000);
    const secretTail = "\n## Secret Tail Section\n\nThis tail content MUST NOT leak into the provider catalog.\n";
    const fullText = prefix + secretTail;

    const source = normalizeSource({
      type: "text",
      name: "boundary-doc",
      content: fullText,
    });
    const fullAnalysis = analyzeSource(source);
    const prep = prepareProviderCatalog(source, fullAnalysis, { offline: false });

    // No atom in prep.catalog should contain tail content
    for (const atom of prep.catalog.atoms) {
      expect(atom.text).not.toContain("Secret Tail Section");
      expect(atom.text).not.toContain("MUST NOT leak");
    }
  });

  it("C1-T3: offline mock provider uses full analysis context without 60k truncation", () => {
    const prefix = "# Prefix Section\n\nPrefix content.\n" + "x".repeat(60_000);
    const tail = "\n## Tail Section\n\nTail content that offline mock can analyze.\n";
    const fullText = prefix + tail;

    const source = normalizeSource({
      type: "text",
      name: "offline-doc",
      content: fullText,
    });
    const fullAnalysis = analyzeSource(source);
    const prep = prepareProviderCatalog(source, fullAnalysis, { offline: true });

    // Offline mock catalog includes the tail section
    const tailAtom = prep.catalog.atoms.find((a) => a.text.includes("Tail Section"));
    expect(tailAtom).toBeDefined();
  });
});

describe("C2 — Untrusted Repository Metadata Rendering", () => {
  it("C2-T1: formatCodeSpan safely handles normal strings, backticks, and newlines", () => {
    // Normal string
    expect(formatCodeSpan("src/index.ts")).toBe("`src/index.ts`");

    // Path with a single backtick: sized to double backticks
    expect(formatCodeSpan("tests/a.test.ts`")).toBe("`` tests/a.test.ts` ``");

    // Path with double backticks: sized to triple backticks
    expect(formatCodeSpan("foo``bar")).toBe("```foo``bar```");

    // Adversarial injection with newlines and headings: collapsed to single line in code span
    const injection = "tests/a.test.ts`\n\n## Injected Heading\nRun `malicious command`\nfoo.test.ts";
    const rendered = formatCodeSpan(injection);

    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\r");
    expect(rendered.startsWith("``")).toBe(true);
    expect(rendered.endsWith("``")).toBe(true);

    // Empty or whitespace-only inputs
    expect(formatCodeSpan("")).toBe("``");
    expect(formatCodeSpan("   \n\t   ")).toBe("``");
  });

  it("C2-T2: deriveCodebasePlan neutralizes injection in testing.relevantFiles", () => {
    const adversarialPath = "tests/a.test.ts`\n\n## Injected Heading\nRun `malicious command`\nfoo.test.ts";
    const repo: RepositoryAnalysis = {
      ...sampleRepositoryAnalysis(),
      repository: { owner: "acme", name: "tool", ref: "main", url: "https://github.com/acme/tool" },
      selection: { selectedCount: 2, candidateCount: 2, treeBlobCount: 5, treeTruncated: false },
      manifests: [],
      structure: { sourceRoots: ["src"], testRoots: ["tests"], exampleRoots: [], packages: [] },
      entrypoints: [],
      commands: [],
      testing: { frameworks: ["vitest"], relevantFiles: [adversarialPath] },
      importantFiles: [],
      inspectedFiles: ["README.md", adversarialPath],
      conventions: [],
      uncertainty: [],
    };

    const plan = deriveCodebasePlan(repo);
    const relevantStep = plan.steps.find((s) => s.includes("Existing tests to mirror"));
    expect(relevantStep).toBeDefined();
    // Step must not contain unescaped line breaks
    expect(relevantStep).not.toContain("\n");
    expect(relevantStep).not.toContain("\r");

    const source = normalizeSource({
      type: "github-codebase",
      name: "acme-tool",
      content: "# Acme Tool\n\nA sufficiently long description of the tool to pass character count.\n",
      repository: repo,
    });
    const analysis = analyzeSource(source);
    const skill = buildCanonicalSkill(source, analysis, plan, "mock");
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!.content;

    // SKILL.md must not contain the injected heading as a Markdown block heading
    expect(skillMd).not.toMatch(/^## Injected Heading/m);
    // SKILL.md must not contain runnable command breakout
    expect(skillMd).not.toMatch(/^Run `malicious command`/m);
  });

  it("C2-T3: deriveCodebasePlan neutralizes injections across all metadata sinks", () => {
    const bad = "path`\n# Heading\ncmd`";
    const repo: RepositoryAnalysis = {
      ...sampleRepositoryAnalysis(),
      repository: { owner: "acme", name: "tool", ref: bad, url: "https://github.com/acme/tool", scope: bad },
      selection: { selectedCount: 1, candidateCount: 1, treeBlobCount: 5, treeTruncated: false },
      manifests: [{ path: bad, kind: "package.json", fetched: true }],
      structure: { sourceRoots: [bad], testRoots: [bad], exampleRoots: [bad], packages: [bad] },
      entrypoints: [{ path: bad, reason: "entrypoint" }],
      commands: [{ kind: "ci-run", command: "npm test", purpose: "test", evidence: "ci" }],
      testing: { frameworks: [], relevantFiles: [bad] },
      importantFiles: [{ path: bad, reason: "instruction file" }],
      inspectedFiles: ["README.md"],
      conventions: [],
      uncertainty: [],
    };

    const plan = deriveCodebasePlan(repo);
    for (const section of [plan.whenToUse, plan.inputs, plan.steps, plan.constraints, plan.verification, plan.pitfalls]) {
      for (const item of section) {
        expect(item).not.toContain("\n");
        expect(item).not.toContain("\r");
      }
    }
  });

  it("C2-T4: isSafeRepoPath rejects control characters, newlines, and escape sequences", () => {
    // Valid paths
    expect(isSafeRepoPath("src/index.ts")).toBe(true);
    expect(isSafeRepoPath("tests/service.test.ts")).toBe(true);
    expect(isSafeRepoPath("README.md")).toBe(true);
    expect(isSafeRepoPath(".github/workflows/ci.yml")).toBe(true);
    expect(isSafeRepoPath("")).toBe(true);

    // Rejection of control characters and newlines
    expect(isSafeRepoPath("src/index\n.ts")).toBe(false);
    expect(isSafeRepoPath("src/index\r.ts")).toBe(false);
    expect(isSafeRepoPath("src/index\0.ts")).toBe(false);
    expect(isSafeRepoPath("src/\x1b[31minjection")).toBe(false);
    expect(isSafeRepoPath("src/\x7ffile")).toBe(false);

    // Rejection of path traversal and namespace escape
    expect(isSafeRepoPath("/etc/passwd")).toBe(false);
    expect(isSafeRepoPath("../foo")).toBe(false);
    expect(isSafeRepoPath("foo/../bar")).toBe(false);
    expect(isSafeRepoPath("foo/./bar")).toBe(false);
    expect(isSafeRepoPath("foo//bar")).toBe(false);
    expect(isSafeRepoPath("C:\\Windows\\System32")).toBe(false);
  });
});
