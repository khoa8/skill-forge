/**
 * Codebase-mode plan derivation (deterministic, offline).
 *
 * Turns a structured RepositoryAnalysis into a SkillPlan oriented at coding
 * agents working in the repository. Every step/constraint/verification entry
 * cites the inspected evidence that supports it (a manifest, CI workflow, or
 * instruction file) — nothing is inferred from ecosystem general knowledge.
 * The mock provider uses this when the pipeline input is a github-codebase
 * source; remote providers receive the same RepositoryAnalysis as context.
 */
import type { RepositoryAnalysis } from "../types.js";
import type { SkillPlan } from "../plan.js";
import { PLAN_LIMITS, fitPlanSection } from "../plan.js";
import { slugify, formatCodeSpan } from "../util.js";
import { dedupe } from "../build.js";

export function deriveCodebasePlan(repo: RepositoryAnalysis, requestedName?: string): SkillPlan {
  const { repository, languages, ecosystems, commands, structure, entrypoints, testing, selection } = repo;
  const stackLabel =
    languages.slice(0, 3).map((l) => l.name).join("/") ||
    ecosystems.slice(0, 3).join("/") ||
    "unrecognized stack";

  // --- whenToUse
  // Scope honesty: a scoped request describes its subtree explicitly and
  // must never read as whole-repository guidance.
  const scopeLabel = repository.scope
    ? ` This skill covers the ${formatCodeSpan(repository.scope)} subtree only — it must not be treated as whole-repository guidance.`
    : "";
  const whenToUse: string[] = [
    repository.scope
      ? `Working as a coding agent in the ${formatCodeSpan(repository.scope)} subtree of ${repository.owner}/${repository.name} (ref ${formatCodeSpan(repository.ref)}) — ${stackLabel} project.${scopeLabel}`
      : `Working as a coding agent in the ${repository.owner}/${repository.name} repository (ref ${formatCodeSpan(repository.ref)}) — ${stackLabel} project.`,
    `Applies when modifying, debugging, reviewing, or testing ${repository.scope ? `this subtree` : "this codebase"}; guidance below comes from a bounded, prioritized inspection of ${selection.selectedCount} of ${selection.candidateCount} eligible files (repository tree lists ${selection.treeBlobCount} files${selection.treeTruncated ? ", tree listing truncated" : ""}).`,
  ];
  if (entrypoints.length > 0) {
    whenToUse.push(`Main entrypoints: ${entrypoints.slice(0, 3).map((e) => formatCodeSpan(e.path)).join(", ")}.`);
  }

  // --- inputs
  const inputs: string[] = [];
  const fetchedManifests = repo.manifests.filter((m) => m.fetched);
  if (fetchedManifests.length > 0) {
    inputs.push(
      `A checkout of ${repository.owner}/${repository.name} at ref ${formatCodeSpan(repository.ref)} with its manifests: ${fetchedManifests.slice(0, 6).map((m) => formatCodeSpan(m.path)).join(", ")}.`,
    );
  }
  if (structure.packages.length > 0) {
    inputs.push(`Monorepo packages: ${structure.packages.slice(0, 6).map((p) => formatCodeSpan(p)).join(", ")}.`);
  }

  // --- steps (orientation: read instructions, inspect manifests, layout, test mirrors)
  const instructionPaths = repo.importantFiles
    .filter((f) => /instruction file|primary repository documentation/.test(f.reason))
    .map((f) => f.path);
  const steps: string[] = [];
  if (instructionPaths.length > 0) {
    steps.push(
      `Before making changes, read the repository instructions: ${instructionPaths.slice(0, 4).map((p) => formatCodeSpan(p)).join(", ")}.`,
    );
  }
  const hasCi =
    commands.some((c) => c.kind === "ci-run") ||
    repo.importantFiles.some((f) => f.path.startsWith(".github/workflows/") || /CI/i.test(f.reason));

  if (commands.length > 0) {
    const candidateManifests = fetchedManifests.length > 0 ? fetchedManifests : repo.manifests;
    const manifestPaths = candidateManifests
      .slice(0, 3)
      .map((m) => formatCodeSpan(m.path))
      .join(", ");

    if (manifestPaths.length > 0 && hasCi) {
      steps.push(
        `Inspect ${manifestPaths}, CI workflows, and repository configuration before choosing project-specific commands.`,
      );
    } else if (manifestPaths.length > 0) {
      steps.push(
        `Inspect ${manifestPaths} and repository configuration before choosing project-specific commands.`,
      );
    } else if (hasCi) {
      steps.push(
        `Inspect CI workflows and repository configuration before choosing project-specific commands.`,
      );
    } else {
      steps.push(
        `Inspect repository configuration before choosing project-specific commands.`,
      );
    }
  }
  if (structure.sourceRoots.length > 0 || structure.testRoots.length > 0) {
    const where = [
      structure.sourceRoots.length > 0 ? `implementation code under ${structure.sourceRoots.slice(0, 4).map((r) => formatCodeSpan(r)).join(", ")}` : null,
      structure.testRoots.length > 0 ? `tests under ${structure.testRoots.slice(0, 4).map((r) => formatCodeSpan(r)).join(", ")}` : null,
    ].filter((x): x is string => x !== null);
    steps.push(`The repository is organized with ${where.join(" and ")}.`);
  }
  if (testing.relevantFiles.length > 0) {
    steps.push(
      `Existing tests to mirror when adding coverage: ${testing.relevantFiles.slice(0, 3).map((p) => formatCodeSpan(p)).join(", ")}${testing.relevantFiles.length > 3 ? " (and siblings)" : ""}.`,
    );
  }
  if (repo.uncertainty.length > 0) {
    steps.push(`SkillForge inspected only a bounded selection of files; consult the repository directly for areas it could not inspect (see pitfalls).`);
  }

  // --- constraints (honest gap: no policy promotion)
  const constraints: string[] = [];

  // --- verification (orient toward testing evidence without runnable command promotion)
  const verification: string[] = [];
  const hasTests = testing.frameworks.length > 0 || testing.relevantFiles.length > 0;

  if (hasTests && hasCi) {
    const testItems = [
      ...testing.frameworks,
      ...testing.relevantFiles.slice(0, 2).map((p) => formatCodeSpan(p)),
    ];
    verification.push(
      `Verify changes against the repository test suites (${testItems.join(", ")}) and CI workflows before submitting.`,
    );
  } else if (hasTests) {
    const testItems = [
      ...testing.frameworks,
      ...testing.relevantFiles.slice(0, 2).map((p) => formatCodeSpan(p)),
    ];
    verification.push(
      `Verify changes against the repository test suites (${testItems.join(", ")}) before submitting.`,
    );
  } else if (hasCi) {
    verification.push(
      `Verify changes against the repository CI workflows before submitting.`,
    );
  }

  // --- pitfalls: honest uncertainty + scope limits
  const pitfalls: string[] = [];
  for (const u of repo.uncertainty.slice(0, 4)) {
    pitfalls.push(u.endsWith(".") ? u : `${u}.`);
  }
  if (repository.scope) {
    pitfalls.push(`This skill was generated from the ${formatCodeSpan(repository.scope)} subtree only; repository areas outside that scope were not analyzed and may differ.`);
  }

  const name = slugify(requestedName?.trim() || `${repository.owner}-${repository.name}`, 48);
  const description = `Coding-agent guidance for ${repository.scope ? `the ${formatCodeSpan(repository.scope)} subtree of ` : ""}${repository.owner}/${repository.name}: ${stackLabel} project, derived from a bounded inspection of ${selection.selectedCount} file(s)${repository.scope ? "; not whole-repository guidance" : ""}.`.slice(0, 1024);

  return {
    name,
    displayName: `${repository.owner}/${repository.name} — coding agent guide`.slice(0, 120),
    description,
    // Every item is trusted prose composed from schema-bounded repository
    // facts; `fitPlanSection` guarantees the resolved plan stays representable
    // in PlanSchema even when a schema-valid fact sits at its own limit (long
    // refs, paths, framework lists). No command body is ever included here, so
    // shortening cannot turn one command into another.
    whenToUse: fitPlanSection(dedupe(whenToUse), PLAN_LIMITS.whenToUse.maxItemChars).slice(0, PLAN_LIMITS.whenToUse.maxItems),
    inputs: fitPlanSection(dedupe(inputs), PLAN_LIMITS.inputs.maxItemChars).slice(0, PLAN_LIMITS.inputs.maxItems),
    steps: fitPlanSection(dedupe(steps), PLAN_LIMITS.steps.maxItemChars).slice(0, PLAN_LIMITS.steps.maxItems),
    constraints: fitPlanSection(dedupe(constraints), PLAN_LIMITS.constraints.maxItemChars).slice(0, PLAN_LIMITS.constraints.maxItems),
    verification: fitPlanSection(dedupe(verification), PLAN_LIMITS.verification.maxItemChars).slice(0, PLAN_LIMITS.verification.maxItems),
    pitfalls: fitPlanSection(dedupe(pitfalls), PLAN_LIMITS.pitfalls.maxItemChars).slice(0, PLAN_LIMITS.pitfalls.maxItems),
  };
}
