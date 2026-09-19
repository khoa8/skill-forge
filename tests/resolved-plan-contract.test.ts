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
import { runPipeline } from "../src/core/pipeline.js";
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

/**
 * Minimal CommonMark inline-code well-formedness check for one plan item.
 *
 * A code span opens with a backtick run and closes with the next run of the
 * same length. An opening run with no matching closing run means the producer
 * emitted an unterminated span — exactly what post-composition slicing used to
 * produce. (Deliberately not a Markdown parser: the producer controls its own
 * templates, so matching runs is enough to state the invariant.)
 */
function hasUnterminatedCodeSpan(text: string): boolean {
  const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length);
  let i = 0;
  while (i < runs.length) {
    const opener = runs[i]!;
    let j = i + 1;
    while (j < runs.length && runs[j] !== opener) j++;
    if (j >= runs.length) return true;
    i = j + 1;
  }
  return false;
}

/** Every item must be inside its section limit and structurally intact. */
function expectStructurallyIntact(plan: object, label: string): void {
  const sections = plan as Record<string, string[] | undefined>;
  for (const section of GROUNDED_SECTIONS) {
    for (const [i, item] of (sections[section] ?? []).entries()) {
      const where = `${label} ${section}[${i}]`;
      expect(item.length, `${where} exceeds PLAN_LIMITS`).toBeLessThanOrEqual(MAX[section]);
      expect(hasUnterminatedCodeSpan(item), `${where} has an unterminated code span: ${JSON.stringify(item)}`).toBe(false);
      // The post-composition backstop must never fire: an item ending in the
      // elision marker means ingredient budgeting did not hold.
      expect(item.endsWith("…"), `${where} was rescued by the post-composition backstop`).toBe(false);
      expect(item, `${where} must stay single-line`).not.toMatch(/[\r\n]/);
    }
  }
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

/** Schema-valid RepositoryAnalysis at (or near) every schema maximum. */
function maxBoundRepository(): RepositoryAnalysis {
  const long = (n: number, ch: string) => ch.repeat(n);
  return {
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
    const repo = maxBoundRepository();
    expect(repo.repository.scope).toHaveLength(300);

    const plan = deriveCodebasePlan(repo);
    expectSchemaValid(plan, "codebase plan at schema limits");
    const longest = longestBySection(plan);
    for (const section of GROUNDED_SECTIONS) {
      expect(longest[section], `${section} longest item`).toBeLessThanOrEqual(MAX[section]);
    }
    // Bounded presentation must not have fabricated runnable commands.
    expect(plan.verification.join("\n")).not.toContain("npm ");
    // …and length alone is not the contract: every item must still be
    // structurally intact and the mandatory scope limitation must survive.
    expectStructurallyIntact(plan, "max-bound codebase plan");
    expect(plan.whenToUse.join(" ")).toContain("subtree only");
    expect(plan.whenToUse.join(" ")).toContain("must not be treated as whole-repository guidance");
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

// ---------------------------------------------------------------------------
// F-EXTRA-02-R1 — codebase plan composition must budget ingredients BEFORE
// syntax rendering, so schema bounds never cut away mandatory meaning or break
// generated Markdown. Schema validity alone is not the contract.
// ---------------------------------------------------------------------------

/** Realistic deep monorepo scope: the path is ordinary, but long enough that
 * the pre-fix identity sentence lost its mandatory qualifier to the slice. */
const DEEP_SCOPE = "packages/mobile-app/src/features/payments/components/forms/checkout";

function scopedRepository(scope: string | undefined): RepositoryAnalysis {
  return {
    ...sampleRepositoryAnalysis(),
    repository: {
      url: "https://github.com/acme/widgets",
      owner: "acme",
      name: "widgets",
      ref: "main",
      commitSha: "a".repeat(40),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

function codebaseSourceInput(repository: RepositoryAnalysis) {
  return {
    type: "github-codebase" as const,
    name: `${repository.repository.owner}/${repository.repository.name}`,
    content: "# acme/widgets\n\nRepository content long enough to satisfy the minimum source length check.\n",
    repository,
  };
}

function codebaseSource(repository: RepositoryAnalysis) {
  return normalizeSource(codebaseSourceInput(repository));
}

describe("F-EXTRA-02-R1 — codebase plan scope honesty and Markdown integrity", () => {
  it("R1-A: a realistic deep scope keeps the mandatory subtree-only limitation in the plan", () => {
    const repo = scopedRepository(DEEP_SCOPE);
    const plan = deriveCodebasePlan(repo);
    expectSchemaValid(plan, "deep-scope plan");
    expectStructurallyIntact(plan, "deep-scope plan");

    // The limitation is its own item, so no other label can displace it.
    const limitation = plan.whenToUse.filter((item) => /subtree only/i.test(item));
    expect(limitation).toHaveLength(1);
    expect(limitation[0]).toContain("must not be treated as whole-repository guidance");
    expect(limitation[0]).toContain(`\`${DEEP_SCOPE}\``);
    expect(limitation[0]!.length).toBeLessThanOrEqual(MAX.whenToUse);

    // The identity sentence stays a complete sentence with intact delimiters.
    const identity = plan.whenToUse.find((item) => item.startsWith("Working as a coding agent"))!;
    expect(identity).toContain(`\`${DEEP_SCOPE}\``);
    expect(identity.endsWith("project.")).toBe(true);
    expect(hasUnterminatedCodeSpan(identity)).toBe(false);
  });

  it("R1-B: a schema-valid max-bound scope keeps both limitations and intact structure", () => {
    const plan = deriveCodebasePlan(maxBoundRepository());
    expectSchemaValid(plan, "max-bound scoped plan");
    expectStructurallyIntact(plan, "max-bound scoped plan");

    const limitation = plan.whenToUse.filter((item) => /subtree only/i.test(item));
    expect(limitation).toHaveLength(1);
    expect(limitation[0]).toContain("must not be treated as whole-repository guidance");
    expect(limitation[0]!.endsWith("guidance.")).toBe(true);
    expect(hasUnterminatedCodeSpan(limitation[0]!)).toBe(false);

    // Identity sentence: shortened labels are still closed code spans and the
    // fixed template punctuation survives.
    const identity = plan.whenToUse.find((item) => item.startsWith("Working as a coding agent"))!;
    expect(identity).toContain("subtree of");
    expect(identity.endsWith("project.")).toBe(true);
    expect(hasUnterminatedCodeSpan(identity)).toBe(false);
  });

  it("R1-C: the final package carries the bounded scoped guidance through the real pipeline", async () => {
    const repo = scopedRepository(DEEP_SCOPE);
    const events: unknown[] = [];
    for await (const event of runPipeline(codebaseSourceInput(repo), { provider: "mock" })) events.push(event);
    const error = events.find((e): e is { type: "error"; code: string; message: string } =>
      (e as { type?: string }).type === "error",
    );
    expect(error, `pipeline error: ${error?.code} ${error?.message}`).toBeUndefined();
    const result = events.find((e): e is { type: "result"; skill: any; validation: any } =>
      (e as { type?: string }).type === "result",
    )!;

    // Resolved plan still satisfies the authoritative contract.
    expectSchemaValid(result.skill.plan, "resolved codebase plan");
    expect(result.validation.passed).toBe(true);
    expect(result.validation.errorCount).toBe(0);

    const skillMd = result.skill.files.find((f: { path: string }) => f.path === "SKILL.md")!.content;
    const whenToUseBlock = skillMd.split("## When to use this skill")[1]!.split("## Inputs required")[0]!;
    expect(whenToUseBlock).toContain(`\`${DEEP_SCOPE}\``);
    expect(whenToUseBlock).toContain("subtree only");
    expect(whenToUseBlock).toContain("must not be treated as whole-repository guidance");
    // No malformed inline-code fragment reached the package.
    for (const line of whenToUseBlock.split("\n")) {
      expect(hasUnterminatedCodeSpan(line), `unterminated code span in ${JSON.stringify(line)}`).toBe(false);
    }
  });

  it("R1-D: multi-label items degrade deterministically without slicing rendered spans", () => {
    const repo = maxBoundRepository();
    const plan = deriveCodebasePlan(repo);
    expectSchemaValid(plan, "multi-label plan");
    expectStructurallyIntact(plan, "multi-label plan");

    // Representative list-heavy items keep their fixed template semantics.
    const inputs = plan.inputs.join("\n");
    expect(inputs).toContain("A checkout of");
    expect(inputs).toContain("with its manifests:");
    expect(inputs.endsWith(".")).toBe(true);
    expect(inputs).toContain("Monorepo packages:");

    const organized = plan.steps.find((item) => item.startsWith("The repository is organized with"))!;
    expect(organized).toContain("implementation code under");
    expect(organized).toContain("tests under");
    expect(organized.endsWith(".")).toBe(true);

    const mirror = plan.steps.find((item) => item.startsWith("Existing tests to mirror"))!;
    expect(mirror.endsWith(".")).toBe(true);

    const verify = plan.verification[0]!;
    expect(verify).toContain("Verify changes against the repository test suites (");
    expect(verify).toContain(") before submitting.");
    expect(hasUnterminatedCodeSpan(verify)).toBe(false);

    // Labels are shortened with an explicit elision rather than dropped mid-run.
    for (const item of [...plan.inputs, ...plan.steps, ...plan.verification]) {
      for (const run of item.match(/`[^`]*`/g) ?? []) {
        expect(run.length).toBeGreaterThan(1);
      }
    }
  });

  it("R1-E: an unscoped repository keeps whole-repository wording and gains no subtree claim", () => {
    const plan = deriveCodebasePlan(scopedRepository(undefined));
    expectSchemaValid(plan, "unscoped plan");
    expectStructurallyIntact(plan, "unscoped plan");
    expect(plan.whenToUse.join(" ")).not.toContain("subtree");
    expect(plan.whenToUse.join(" ")).not.toContain("whole-repository");
    expect(plan.description).not.toContain("subtree");
    expect(plan.description).not.toContain("whole-repository");
    expect(plan.description!.endsWith("file(s).")).toBe(true);
    expect(plan.whenToUse[0]).toContain("acme/widgets");
  });

  it("R1-F: the description that reaches the package keeps its evidence attribution at schema maxima", () => {
    const repo = maxBoundRepository();
    const plan = deriveCodebasePlan(repo);
    // The plan-level description keeps the mandatory scope suffix.
    expect(plan.description!.endsWith("not whole-repository guidance.")).toBe(true);
    expect(plan.description).toContain("derived from a bounded inspection of 2 file(s)");

    // …and so does the canonical description the builder derives (it is the
    // one rendered into SKILL.md front matter and manifest.json).
    const source = codebaseSource(repo);
    const skill = buildCanonicalSkill(source, analyzeSource(source), plan, "mock");
    expect(skill.meta.description).toContain("derived from a bounded inspection of 2 file(s).");
    expect(skill.meta.description.length).toBeLessThanOrEqual(1024);
    expect(hasUnterminatedCodeSpan(skill.meta.description)).toBe(false);
  });

  it("R1-G: a delimiter-hostile scope still yields bounded, balanced, honest items", () => {
    // `formatCodeSpan` sizes its delimiter to the longest backtick run, so its
    // overhead is not constant. These are the cases where a naive
    // "raw length <= budget" calculation would emit an oversized or
    // unterminated span.
    const hostileScopes = [
      "`".repeat(300),
      `${"`".repeat(200)}rest`,
      `\`${"a".repeat(298)}`,
      `${"a".repeat(298)}\``,
      "docs\n## Injected\nMARKER",
      "a\rb\rc",
    ];
    for (const scope of hostileScopes) {
      const plan = deriveCodebasePlan(scopedRepository(scope));
      expectSchemaValid(plan, `hostile scope ${JSON.stringify(scope.slice(0, 12))}`);
      expectStructurallyIntact(plan, `hostile scope ${JSON.stringify(scope.slice(0, 12))}`);
      // The mandatory limitation survives regardless of the label shape.
      const limitation = plan.whenToUse.find((item) => /subtree only/i.test(item));
      expect(limitation, `limitation missing for ${JSON.stringify(scope.slice(0, 12))}`).toBeDefined();
      expect(limitation).toContain("must not be treated as whole-repository guidance");
      expect(plan.whenToUse.join(" ")).not.toMatch(/^##\s+Injected/m);
    }
  });

  it("R1-H: codebase planning is deterministic for the long-boundary fixture", () => {
    const repo = maxBoundRepository();
    expect(JSON.stringify(deriveCodebasePlan(repo))).toBe(JSON.stringify(deriveCodebasePlan(repo)));
    const scoped = scopedRepository(DEEP_SCOPE);
    expect(JSON.stringify(deriveCodebasePlan(scoped))).toBe(JSON.stringify(deriveCodebasePlan(scoped)));
  });

  it("R1-I: the post-composition backstop never fires for schema-valid repositories", () => {
    // `fitPlanSection` remains documented defense in depth. If ingredient
    // budgeting ever regresses, items start ending in the elision marker and
    // this fails instead of the resolver failing closed on a valid input.
    for (const repo of [maxBoundRepository(), scopedRepository(DEEP_SCOPE), scopedRepository(undefined)]) {
      const plan = deriveCodebasePlan(repo);
      const sections = plan as unknown as Record<string, string[]>;
      for (const section of GROUNDED_SECTIONS) {
        for (const item of sections[section]!) {
          expect(item.endsWith("…"), `${section} item rescued by the backstop: ${JSON.stringify(item)}`).toBe(false);
        }
      }
    }
  });
});
