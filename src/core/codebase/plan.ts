/**
 * Codebase-mode plan derivation (deterministic, offline).
 *
 * Turns a structured RepositoryAnalysis into a SkillPlan oriented at coding
 * agents working in the repository. Every step/constraint/verification entry
 * cites the inspected evidence that supports it (a manifest, CI workflow, or
 * instruction file) — nothing is inferred from ecosystem general knowledge.
 * The mock provider uses this when the pipeline input is a `github-codebase`
 * source; remote providers receive the same RepositoryAnalysis as context.
 *
 * Bounding discipline (the resolved-plan contract):
 *
 * Repository facts are schema-bounded but individually long (paths, refs,
 * scopes, label lists). Every item is therefore composed from an explicit
 * fixed template plus dynamic slots, and each slot renders RAW metadata
 * through the bounded rendering helpers in `util.ts`:
 *
 *   raw metadata → budget at the ingredient boundary → render → fixed template
 *
 * Fixed template text is emitted verbatim and consumes the section budget
 * first, so mandatory semantics — above all scope honesty — can never be
 * displaced by metadata length, and no rendered code span is ever sliced.
 * `fitPlanSection` remains only as documented defense in depth; a normal
 * schema-valid repository must never depend on it.
 */
import type { RepositoryAnalysis } from "../types.js";
import type { SkillPlan } from "../plan.js";
import { PLAN_LIMITS, fitPlanSection } from "../plan.js";
import { boundLabel, composeBoundedItem, slugify, type BoundedItemSlot } from "../util.js";
import { dedupe } from "../build.js";

export function deriveCodebasePlan(repo: RepositoryAnalysis, requestedName?: string): SkillPlan {
  const { repository, languages, ecosystems, commands, structure, entrypoints, testing, selection } = repo;
  const identity = `${repository.owner}/${repository.name}`;
  const scope = repository.scope;
  const stackLabel =
    languages.slice(0, 3).map((l) => l.name).join("/") ||
    ecosystems.slice(0, 3).join("/") ||
    "unrecognized stack";

  const whenToUseLimit = PLAN_LIMITS.whenToUse.maxItemChars;
  const inputsLimit = PLAN_LIMITS.inputs.maxItemChars;
  const stepsLimit = PLAN_LIMITS.steps.maxItemChars;
  const verificationLimit = PLAN_LIMITS.verification.maxItemChars;
  const pitfallsLimit = PLAN_LIMITS.pitfalls.maxItemChars;
  const descriptionLimit = PLAN_LIMITS.description.maxItemChars;

  // --- whenToUse
  // Scope honesty: a scoped request describes its subtree explicitly and
  // must never read as whole-repository guidance. The limitation is a fixed
  // template clause (never a shortened label), so length pressure cannot
  // remove it.
  const whenToUse: string[] = [
    scope
      ? composeBoundedItem(
          ["Working as a coding agent in the ", " subtree of ", " (ref ", ") — ", " project."],
          [
            { kind: "span", raw: scope },
            { kind: "plain", raw: identity },
            { kind: "span", raw: repository.ref },
            { kind: "plain", raw: stackLabel },
          ],
          whenToUseLimit,
        )
      : composeBoundedItem(
          ["Working as a coding agent in the ", " repository (ref ", ") — ", " project."],
          [
            { kind: "plain", raw: identity },
            { kind: "span", raw: repository.ref },
            { kind: "plain", raw: stackLabel },
          ],
          whenToUseLimit,
        ),
  ];
  if (scope) {
    // Mandatory scope limitation, in its own item with its own budget: no
    // other metadata can consume the space this statement needs.
    whenToUse.push(
      composeBoundedItem(
        ["This skill covers the ", " subtree only — it must not be treated as whole-repository guidance."],
        [{ kind: "span", raw: scope }],
        whenToUseLimit,
      ),
    );
  }
  whenToUse.push(
    `Applies when modifying, debugging, reviewing, or testing ${scope ? "this subtree" : "this codebase"}; guidance below comes from a bounded, prioritized inspection of ${selection.selectedCount} of ${selection.candidateCount} eligible files (repository tree lists ${selection.treeBlobCount} files${selection.treeTruncated ? ", tree listing truncated" : ""}).`,
  );
  if (entrypoints.length > 0) {
    whenToUse.push(
      composeBoundedItem(
        ["Main entrypoints: ", "."],
        [{ kind: "spans", raw: entrypoints.slice(0, 3).map((e) => e.path) }],
        whenToUseLimit,
      ),
    );
  }

  // --- inputs
  const inputs: string[] = [];
  const fetchedManifests = repo.manifests.filter((m) => m.fetched);
  if (fetchedManifests.length > 0) {
    inputs.push(
      composeBoundedItem(
        ["A checkout of ", " at ref ", " with its manifests: ", "."],
        [
          { kind: "plain", raw: identity },
          { kind: "span", raw: repository.ref },
          { kind: "spans", raw: fetchedManifests.slice(0, 6).map((m) => m.path) },
        ],
        inputsLimit,
      ),
    );
  }
  if (structure.packages.length > 0) {
    inputs.push(
      composeBoundedItem(
        ["Monorepo packages: ", "."],
        [{ kind: "spans", raw: structure.packages.slice(0, 6) }],
        inputsLimit,
      ),
    );
  }

  // --- steps (orientation: read instructions, inspect manifests, layout, test mirrors)
  const instructionPaths = repo.importantFiles
    .filter((f) => /instruction file|primary repository documentation/.test(f.reason))
    .map((f) => f.path);
  const steps: string[] = [];
  if (instructionPaths.length > 0) {
    steps.push(
      composeBoundedItem(
        ["Before making changes, read the repository instructions: ", "."],
        [{ kind: "spans", raw: instructionPaths.slice(0, 4) }],
        stepsLimit,
      ),
    );
  }
  const hasCi =
    commands.some((c) => c.kind === "ci-run") ||
    repo.importantFiles.some((f) => f.path.startsWith(".github/workflows/") || /CI/i.test(f.reason));

  if (commands.length > 0) {
    const candidateManifests = fetchedManifests.length > 0 ? fetchedManifests : repo.manifests;
    const manifestPaths = candidateManifests.slice(0, 3).map((m) => m.path);
    const manifestSlot: BoundedItemSlot = { kind: "spans", raw: manifestPaths };
    if (manifestPaths.length > 0 && hasCi) {
      steps.push(
        composeBoundedItem(
          ["Inspect ", ", CI workflows, and repository configuration before choosing project-specific commands."],
          [manifestSlot],
          stepsLimit,
        ),
      );
    } else if (manifestPaths.length > 0) {
      steps.push(
        composeBoundedItem(
          ["Inspect ", " and repository configuration before choosing project-specific commands."],
          [manifestSlot],
          stepsLimit,
        ),
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
    const parts: Array<{ prefix: string; paths: readonly string[] }> = [];
    if (structure.sourceRoots.length > 0) {
      parts.push({ prefix: "implementation code under ", paths: structure.sourceRoots.slice(0, 4) });
    }
    if (structure.testRoots.length > 0) {
      parts.push({ prefix: "tests under ", paths: structure.testRoots.slice(0, 4) });
    }
    const template = ["The repository is organized with "];
    const slots: BoundedItemSlot[] = [];
    for (const [i, part] of parts.entries()) {
      if (i > 0) template[template.length - 1] += " and ";
      template[template.length - 1] += part.prefix;
      slots.push({ kind: "spans", raw: part.paths });
      template.push("");
    }
    template[template.length - 1] += ".";
    steps.push(composeBoundedItem(template, slots, stepsLimit));
  }
  if (testing.relevantFiles.length > 0) {
    steps.push(
      composeBoundedItem(
        [
          "Existing tests to mirror when adding coverage: ",
          testing.relevantFiles.length > 3 ? " (and siblings)." : ".",
        ],
        [{ kind: "spans", raw: testing.relevantFiles.slice(0, 3) }],
        stepsLimit,
      ),
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

  if (hasTests || hasCi) {
    const testItems = [...testing.frameworks, ...testing.relevantFiles.slice(0, 2)];
    if (hasTests && hasCi) {
      verification.push(
        composeBoundedItem(
          ["Verify changes against the repository test suites (", ") and CI workflows before submitting."],
          [{ kind: "spans", raw: testItems }],
          verificationLimit,
        ),
      );
    } else if (hasTests) {
      verification.push(
        composeBoundedItem(
          ["Verify changes against the repository test suites (", ") before submitting."],
          [{ kind: "spans", raw: testItems }],
          verificationLimit,
        ),
      );
    } else {
      verification.push(
        `Verify changes against the repository CI workflows before submitting.`,
      );
    }
  }

  // --- pitfalls: honest uncertainty + scope limits
  const pitfalls: string[] = [];
  for (const u of repo.uncertainty.slice(0, 4)) {
    const suffix = u.endsWith(".") ? "" : ".";
    pitfalls.push(composeBoundedItem(["", suffix], [{ kind: "plain", raw: u }], pitfallsLimit));
  }
  if (scope) {
    pitfalls.push(
      composeBoundedItem(
        ["This skill was generated from the ", " subtree only; repository areas outside that scope were not analyzed and may differ."],
        [{ kind: "span", raw: scope }],
        pitfallsLimit,
      ),
    );
  }

  const name = slugify(requestedName?.trim() || `${repository.owner}-${repository.name}`, 48);
  // The description carries the scope limitation as fixed text for the same
  // reason the whenToUse item does: a long scope/stack label must not be able
  // to displace it.
  const description = scope
    ? composeBoundedItem(
        [
          "Coding-agent guidance for the ",
          " subtree of ",
          ": ",
          ` project, derived from a bounded inspection of ${selection.selectedCount} file(s); not whole-repository guidance.`,
        ],
        [
          { kind: "span", raw: scope },
          { kind: "plain", raw: identity },
          { kind: "plain", raw: stackLabel },
        ],
        descriptionLimit,
      )
    : composeBoundedItem(
        [
          "Coding-agent guidance for ",
          ": ",
          ` project, derived from a bounded inspection of ${selection.selectedCount} file(s).`,
        ],
        [
          { kind: "plain", raw: identity },
          { kind: "plain", raw: stackLabel },
        ],
        descriptionLimit,
      );

  return {
    name,
    displayName: boundLabel(`${identity} — coding agent guide`, 120),
    description,
    // Defense in depth only: every item above is composed from an explicit
    // template with ingredient-bounded labels, so this must never shorten one.
    whenToUse: fitPlanSection(dedupe(whenToUse), whenToUseLimit).slice(0, PLAN_LIMITS.whenToUse.maxItems),
    inputs: fitPlanSection(dedupe(inputs), inputsLimit).slice(0, PLAN_LIMITS.inputs.maxItems),
    steps: fitPlanSection(dedupe(steps), stepsLimit).slice(0, PLAN_LIMITS.steps.maxItems),
    constraints: fitPlanSection(dedupe(constraints), PLAN_LIMITS.constraints.maxItemChars).slice(0, PLAN_LIMITS.constraints.maxItems),
    verification: fitPlanSection(dedupe(verification), verificationLimit).slice(0, PLAN_LIMITS.verification.maxItems),
    pitfalls: fitPlanSection(dedupe(pitfalls), pitfallsLimit).slice(0, PLAN_LIMITS.pitfalls.maxItems),
  };
}
