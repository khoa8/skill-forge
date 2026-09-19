/**
 * F-EXTRA-02 regression coverage — the resolved-plan contract.
 *
 * `ARCHITECTURE.md` names `PlanSchema` (`src/core/plan.ts`) as the owner of the
 * resolved grounded plan shape. After the selection-only redesign the resolved
 * plan stopped being checked anywhere: deterministic producers composed
 * unbounded strings and `resolveProviderProposal` copied trusted atom text
 * straight through. These tests pin both halves of the fix:
 *
 *   1. every normal deterministic producer stays representable in the schema;
 *   2. the shared resolved-plan boundary fails closed if one does not.
 *
 * They also pin the semantic rule that makes this safe: an oversized
 * source-derived *command* is never truncated into a different command.
 */
import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis } from "../src/core/build.js";
import { deriveCodebasePlan } from "../src/core/codebase/plan.js";
import { PLAN_LIMITS, PlanSchema, resolvedPlanContractIssue } from "../src/core/plan.js";
import {
  GROUNDED_SECTIONS,
  catalogFromPlan,
  prepareProviderCatalog,
  resolveProviderProposal,
  type GroundedCatalog,
} from "../src/core/plan-catalog.js";
import { MockProvider } from "../src/core/providers/mock.js";
import { ProviderError } from "../src/core/providers/types.js";
import { verifyProvider } from "../src/core/verify.js";
import { validatePackage } from "../src/core/validate.js";
import type { RepositoryAnalysis } from "../src/core/types.js";
import { sampleRepositoryAnalysis } from "./codebase-model.test.js";

const MAX = {
  whenToUse: PLAN_LIMITS.whenToUse.maxItemChars,
  inputs: PLAN_LIMITS.inputs.maxItemChars,
  steps: PLAN_LIMITS.steps.maxItemChars,
  constraints: PLAN_LIMITS.constraints.maxItemChars,
  verification: PLAN_LIMITS.verification.maxItemChars,
  pitfalls: PLAN_LIMITS.pitfalls.maxItemChars,
} as const;

/** A deterministic plan that stays inside the schema for every section. */
function expectSchemaValid(plan: unknown, label: string): void {
  const parsed = PlanSchema.safeParse(plan);
  expect(
    parsed.success ? null : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`),
    `${label} must satisfy PlanSchema`,
  ).toBeNull();
  expect(resolvedPlanContractIssue(plan), `${label} contract issue`).toBeNull();
}

/** Longest item in each section, for budget assertions. */
function longestBySection(plan: object): Record<string, number> {
  const sections = plan as Record<string, string[] | undefined>;
  const out: Record<string, number> = {};
  for (const section of GROUNDED_SECTIONS) {
    const items = sections[section] ?? [];
    out[section] = items.reduce((max, item) => Math.max(max, item.length), 0);
  }
  return out;
}

describe("F-EXTRA-02 — deterministic producers stay inside the resolved-plan contract", () => {
  it("P1: an ordinary-source plan is schema-valid, including schema-max headings and a very long command", () => {
    const longTitle = "T".repeat(900);
    const longHeading = "H".repeat(900);
    const longCommand = `curl -X POST https://api.example.test/v1/payments ${'-H "Authorization: Bearer $TOKEN" '.repeat(20)}--data @payload.json`;
    expect(longCommand.length).toBeGreaterThan(MAX.verification);

    const source = normalizeSource({
      type: "text",
      name: "long-inputs",
      content: [
        `# ${longTitle}`,
        "",
        "A description long enough to pass the minimum source length check.",
        "",
        `## Verify ${longHeading}`,
        "",
        "```bash",
        longCommand,
        "```",
        "",
        "## Constraints",
        "",
        "Always validate the payload before sending it to the payments endpoint.",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const plan = derivePlanFromAnalysis(analysis);

    expectSchemaValid(plan, "ordinary-source plan");
    const longest = longestBySection(plan);
    for (const section of GROUNDED_SECTIONS) {
      expect(longest[section], `${section} longest item`).toBeLessThanOrEqual(MAX[section]);
    }
  });

  it("P2: an oversized source-derived command is never truncated into a different runnable command", () => {
    const longCommand = `curl -X POST https://api.example.test/v1/payments ${'-H "Authorization: Bearer $TOKEN" '.repeat(20)}--data @payload.json`;
    const source = normalizeSource({
      type: "text",
      name: "long-command",
      content: [
        "# Payments API",
        "",
        "A description long enough to pass the minimum source length check.",
        "",
        "## Verify the deployment",
        "",
        "```bash",
        longCommand,
        "```",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const plan = derivePlanFromAnalysis(analysis);

    const verification = plan.verification.join("\n");
    // The command itself must be absent (no prefix, no ellipsis-truncated
    // variant) — a shortened shell line is a different command.
    expect(verification).not.toContain(longCommand);
    expect(verification).not.toContain(longCommand.slice(0, 120));
    expect(verification).not.toContain("curl -X POST");
    // Instead it is referenced honestly, by source line, and stays bounded.
    expect(verification).toMatch(/Source line \d+ documents a verification command too long to quote here \(\d+ characters\)/);
    expectSchemaValid(plan, "long-command plan");
    expect(plan.verification.every((v) => v.length <= MAX.verification)).toBe(true);
  });

  it("P3: a command that does fit is still quoted verbatim and stays schema-valid", () => {
    const source = normalizeSource({
      type: "text",
      name: "short-command",
      content: [
        "# Payments API",
        "",
        "A description long enough to pass the minimum source length check.",
        "",
        "## Verify the deployment",
        "",
        "```bash",
        "npm run check",
        "```",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const plan = derivePlanFromAnalysis(analysis);
    expect(plan.verification.join("\n")).toContain("`npm run check` (source line");
    expectSchemaValid(plan, "short-command plan");
  });

  it("P4: a codebase plan stays schema-valid at every RepositoryAnalysis schema limit", () => {
    const long = (n: number, ch: string) => ch.repeat(n);
    const repo: RepositoryAnalysis = {
      ...sampleRepositoryAnalysis(),
      repository: {
        url: `https://github.com/${long(120, "o")}/${long(120, "r")}`.slice(0, 300),
        owner: long(120, "o"),
        name: long(120, "r"),
        ref: long(200, "f"),
        commitSha: "a".repeat(40),
        scope: long(300, "s"),
      },
      languages: [
        { name: long(120, "L"), evidence: [long(300, "e")] },
        { name: long(120, "M"), evidence: [long(300, "e")] },
        { name: long(120, "N"), evidence: [long(300, "e")] },
      ],
      ecosystems: [long(80, "x"), long(80, "y")],
      frameworks: Array.from({ length: 8 }, (_, i) => ({ name: `fw${i}${long(70, "z")}`.slice(0, 120), evidence: [long(300, "e")] })),
      manifests: Array.from({ length: 6 }, (_, i) => ({ path: `${i}-${long(290, "p")}`.slice(0, 300), kind: "package.json", fetched: true })),
      structure: {
        sourceRoots: Array.from({ length: 4 }, (_, i) => `${i}-${long(190, "s")}`.slice(0, 200)),
        testRoots: Array.from({ length: 4 }, (_, i) => `${i}-${long(190, "t")}`.slice(0, 200)),
        exampleRoots: [],
        packages: Array.from({ length: 6 }, (_, i) => `${i}-${long(190, "k")}`.slice(0, 200)),
      },
      entrypoints: Array.from({ length: 3 }, (_, i) => ({ path: `${i}-${long(290, "p")}`.slice(0, 300), reason: "entrypoint" })),
      importantFiles: Array.from({ length: 4 }, (_, i) => ({ path: `${i}-${long(290, "i")}`.slice(0, 300), reason: "instruction file" })),
      testing: {
        frameworks: Array.from({ length: 8 }, (_, i) => `f${i}${long(70, "q")}`.slice(0, 80)),
        relevantFiles: Array.from({ length: 4 }, (_, i) => `${i}-${long(290, "v")}`.slice(0, 300)),
      },
      uncertainty: Array.from({ length: 4 }, (_, i) => `${i}-${long(290, "u")}`.slice(0, 300)),
    };
    expect(repo.repository.scope).toHaveLength(300);

    const plan = deriveCodebasePlan(repo);
    expectSchemaValid(plan, "codebase plan at schema limits");
    const longest = longestBySection(plan);
    for (const section of GROUNDED_SECTIONS) {
      expect(longest[section], `${section} longest item`).toBeLessThanOrEqual(MAX[section]);
    }
    // Bounded presentation must not have fabricated runnable commands.
    expect(plan.verification.join("\n")).not.toContain("npm ");
  });

  it("P5: the mock/offline path is deterministic and schema-valid end to end", async () => {
    const source = normalizeSource({
      type: "text",
      name: "mock-doc",
      content: [
        "# Widget Guide",
        "",
        "Widget builds widget bundles from a manifest and validates them.",
        "",
        "## Setup",
        "",
        "1. Install the tool.",
        "2. Create a manifest.",
        "3. Run the build.",
        "",
        "## Verify",
        "",
        "```bash",
        "widget check manifest.yaml",
        "```",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const prep = prepareProviderCatalog(source, analysis, { offline: true });
    const provider = new MockProvider();

    const first = await provider.generate({
      source: prep.providerSource,
      analysis: prep.providerAnalysis,
      catalog: prep.catalog,
    });
    const second = await provider.generate({
      source: prep.providerSource,
      analysis: prep.providerAnalysis,
      catalog: prep.catalog,
    });
    expect(second).toEqual(first);

    const resolved = resolveProviderProposal(first, prep.catalog);
    expectSchemaValid(resolved, "resolved mock plan");
    const again = resolveProviderProposal(second, prep.catalog);
    expect(again).toEqual(resolved);
  });
});

describe("F-EXTRA-02 — the shared resolved-plan boundary fails closed", () => {
  function catalogWithAtom(text: string): GroundedCatalog {
    // Deliberately malformed *trusted/test* catalog: this is the internal
    // invariant failure mode, not something a provider can author (providers
    // may only select existing IDs).
    return catalogFromPlan({
      whenToUse: [],
      inputs: [],
      steps: [text],
      constraints: [],
      verification: [],
      pitfalls: [],
    });
  }

  it("P6: a valid provider selection resolving catalog atoms yields a schema-valid plan", () => {
    const source = normalizeSource({
      type: "text",
      name: "selection-doc",
      content: [
        "# Widget Guide",
        "",
        "Widget builds widget bundles from a manifest and validates them.",
        "",
        "## Setup",
        "",
        "1. Install the tool.",
        "2. Create a manifest.",
        "3. Run the build.",
        "",
        "## Constraints",
        "",
        "Always pin the widget version before building a bundle.",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const prep = prepareProviderCatalog(source, analysis, { offline: true });
    const proposal = {
      name: "widget-guide",
      displayName: "Widget Guide",
      selections: Object.fromEntries(
        GROUNDED_SECTIONS.map((section) => [section, prep.catalog.bySection[section].map((a) => a.id)]),
      ),
    };
    const resolved = resolveProviderProposal(proposal, prep.catalog);
    expectSchemaValid(resolved, "resolved selection plan");
    for (const section of GROUNDED_SECTIONS) {
      expect(resolved[section]).toEqual(prep.catalog.bySection[section].map((a) => a.text));
    }
  });

  it("P7: an over-limit catalog atom fails at the shared boundary with a value-free diagnostic", () => {
    const secretLikeAtom = `Follow the documented procedure "sk-live-SUPER-SECRET-KEY" ${"x".repeat(600)}`;
    const catalog = catalogWithAtom(secretLikeAtom);

    let caught: unknown;
    try {
      resolveProviderProposal({ selections: { steps: ["steps-0"] } }, catalog);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const error = caught as ProviderError;
    expect(error.code).toBe("provider_plan_contract_violation");
    // Diagnostics name only the section, index, and schema limit.
    expect(error.message).toContain(`steps[0]: exceeds maximum string of ${MAX.steps}`);
    expect(error.message).not.toContain("sk-live-SUPER-SECRET-KEY");
    expect(JSON.stringify(error)).not.toContain("sk-live-SUPER-SECRET-KEY");
    expect(JSON.stringify(error)).not.toContain("xxxxx");
  });

  it("P8: the boundary check never rejects a schema-valid catalog atom", () => {
    const catalog = catalogWithAtom("x".repeat(MAX.steps));
    const resolved = resolveProviderProposal({ selections: { steps: ["steps-0"] } }, catalog);
    expect(resolved.steps).toEqual(["x".repeat(MAX.steps)]);
    expectSchemaValid(resolved, "boundary-length plan");
  });

  it("P9: resolvedPlanContractIssue reports every section honestly and never echoes values", () => {
    const plan = {
      whenToUse: ["y".repeat(MAX.whenToUse + 1)],
      inputs: [],
      steps: ["z".repeat(MAX.steps + 1)],
      constraints: [],
      verification: [],
      pitfalls: [],
    };
    const issue = resolvedPlanContractIssue(plan);
    expect(issue).toContain(`whenToUse[0]: exceeds maximum string of ${MAX.whenToUse}`);
    expect(issue).toContain(`steps[0]: exceeds maximum string of ${MAX.steps}`);
    expect(issue).not.toContain("yyy");
    expect(issue).not.toContain("zzz");
  });

  it("P10: a schema-invalid resolved plan can never reach the builder through the pipeline boundary", () => {
    const catalog = catalogWithAtom("q".repeat(MAX.steps + 1));
    expect(() => resolveProviderProposal({ selections: { steps: ["steps-0"] } }, catalog)).toThrow(ProviderError);
  });
});

describe("F-EXTRA-02 — verification reporting", () => {
  it("P11: verifyProvider's plan-schema step is a real PlanSchema check, not a placeholder", async () => {
    const result = await verifyProvider({ provider: "mock" });
    expect(result.ok).toBe(true);
    const step = result.steps.find((s) => s.step === "plan-schema");
    expect(step).toBeDefined();
    expect(step!.ok).toBe(true);
    expect(step!.detail).toContain("PlanSchema");
    expect(step!.detail).not.toContain("resolved against the deterministic grounded catalog");
    // The check runs before the build step.
    const order = result.steps.map((s) => s.step);
    expect(order.indexOf("plan-schema")).toBeLessThan(order.indexOf("build"));
  });

  it("P12: the generated package from the ordinary-source path validates and is schema-valid", () => {
    const source = normalizeSource({
      type: "text",
      name: "validator-doc",
      content: [
        "# Widget Guide",
        "",
        "Widget builds widget bundles from a manifest and validates them.",
        "",
        "## Setup",
        "",
        "1. Install the tool.",
        "2. Create a manifest.",
        "3. Run the build.",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const plan = derivePlanFromAnalysis(analysis);
    expectSchemaValid(plan, "validator plan");
    const skill = buildCanonicalSkill(source, analysis, plan, "mock");
    const report = validatePackage({ skill, sourceText: source.text, target: undefined });
    expect(report.executed).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.passed).toBe(true);
  });
});
