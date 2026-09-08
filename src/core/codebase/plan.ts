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
import type { RepositoryAnalysis, RepositoryCommand } from "../types.js";
import type { SkillPlan } from "../plan.js";
import { slugify } from "../util.js";
import { dedupe } from "../build.js";

/** Short evidence label: `package.json scripts.test = "vitest run"` →
 * `package.json scripts.test`. */
function evidenceLabel(evidence: string): string {
  const cut = evidence.indexOf(" = ");
  return (cut === -1 ? evidence : evidence.slice(0, cut)).slice(0, 160);
}

function commandsOfPurpose(commands: RepositoryCommand[], purpose: RepositoryCommand["purpose"]): RepositoryCommand[] {
  return commands.filter((c) => c.purpose === purpose);
}

/** Render an evidenced command: the command plus where it is defined. */
function commandStep(cmd: RepositoryCommand): string {
  return `Run \`${cmd.command}\` — defined in ${evidenceLabel(cmd.evidence)}.`;
}

const WARNINGISH = /^(never|do not|don'?t|avoid|always|required|forbidden|prohibited|must)\b/i;

export function deriveCodebasePlan(repo: RepositoryAnalysis, requestedName?: string): SkillPlan {
  const { repository, languages, ecosystems, commands, structure, entrypoints, conventions, testing, selection } = repo;
  const stackLabel =
    languages.slice(0, 3).map((l) => l.name).join("/") ||
    ecosystems.slice(0, 3).join("/") ||
    "unrecognized stack";

  // --- whenToUse
  const whenToUse: string[] = [
    `Working as a coding agent in the ${repository.owner}/${repository.name} repository (ref \`${repository.ref}\`) — ${stackLabel} project.`,
    `Applies when modifying, debugging, reviewing, or testing this codebase; guidance below comes from a bounded, prioritized inspection of ${selection.selectedCount} of ${selection.candidateCount} eligible files (repository tree lists ${selection.treeBlobCount} files${selection.treeTruncated ? ", tree listing truncated" : ""}).`,
  ];
  if (entrypoints.length > 0) {
    whenToUse.push(`Main entrypoints: ${entrypoints.slice(0, 3).map((e) => `\`${e.path}\``).join(", ")}.`);
  }

  // --- inputs
  const inputs: string[] = [];
  const fetchedManifests = repo.manifests.filter((m) => m.fetched);
  if (fetchedManifests.length > 0) {
    inputs.push(
      `A checkout of ${repository.owner}/${repository.name} at ref \`${repository.ref}\` with its manifests: ${fetchedManifests.slice(0, 6).map((m) => `\`${m.path}\``).join(", ")}.`,
    );
  }
  for (const cmd of commandsOfPurpose(commands, "install").slice(0, 2)) {
    inputs.push(`Dependencies are installed with \`${cmd.command}\` (see ${evidenceLabel(cmd.evidence)}).`);
  }
  if (structure.packages.length > 0) {
    inputs.push(`Monorepo packages: ${structure.packages.slice(0, 6).map((p) => `\`${p}\``).join(", ")}.`);
  }

  // --- steps (orientation → setup → development → verification)
  const instructionPaths = repo.importantFiles
    .filter((f) => /instruction file|primary repository documentation/.test(f.reason))
    .map((f) => f.path);
  const steps: string[] = [];
  if (instructionPaths.length > 0) {
    steps.push(
      `Before making changes, read the repository instructions: ${instructionPaths.slice(0, 4).map((p) => `\`${p}\``).join(", ")}.`,
    );
  }
  for (const cmd of commandsOfPurpose(commands, "install").slice(0, 1)) {
    steps.push(commandStep(cmd));
  }
  if (structure.sourceRoots.length > 0 || structure.testRoots.length > 0) {
    const where = [
      structure.sourceRoots.length > 0 ? `implementation code under ${structure.sourceRoots.slice(0, 4).map((r) => `\`${r}\``).join(", ")}` : null,
      structure.testRoots.length > 0 ? `tests under ${structure.testRoots.slice(0, 4).map((r) => `\`${r}\``).join(", ")}` : null,
    ].filter((x): x is string => x !== null);
    steps.push(`The repository is organized with ${where.join(" and ")}.`);
  }
  for (const purpose of ["dev", "build"] as const) {
    for (const cmd of commandsOfPurpose(commands, purpose).slice(0, purpose === "dev" ? 2 : 1)) {
      steps.push(commandStep(cmd));
    }
  }
  if (testing.relevantFiles.length > 0) {
    steps.push(
      `Existing tests to mirror when adding coverage: ${testing.relevantFiles.slice(0, 3).map((p) => `\`${p}\``).join(", ")}${testing.relevantFiles.length > 3 ? " (and siblings)" : ""}.`,
    );
  }
  if (repo.uncertainty.length > 0) {
    steps.push(`SkillForge inspected only a bounded selection of files; consult the repository directly for areas it could not inspect (see pitfalls).`);
  }

  // --- constraints (repository conventions, verbatim statements)
  const constraints = conventions.slice(0, 12).map((c) => c.statement);

  // --- verification (evidenced test/typecheck/lint/build commands)
  const verification: string[] = [];
  for (const purpose of ["test", "typecheck", "lint", "build"] as const) {
    for (const cmd of commandsOfPurpose(commands, purpose).slice(0, purpose === "test" ? 3 : 2)) {
      verification.push(commandStep(cmd));
    }
  }

  // --- pitfalls: warning-shaped conventions + honest uncertainty
  const pitfalls: string[] = [];
  for (const c of conventions) {
    if (WARNINGISH.test(c.statement) && pitfalls.length < 6) pitfalls.push(c.statement);
  }
  for (const u of repo.uncertainty.slice(0, 4)) {
    pitfalls.push(u.endsWith(".") ? u : `${u}.`);
  }

  const name = slugify(requestedName?.trim() || `${repository.owner}-${repository.name}`, 48);
  const description = `Coding-agent guidance for ${repository.owner}/${repository.name}: ${stackLabel} project with ${commands.length} evidenced command(s) and ${conventions.length} convention(s), derived from a bounded inspection of ${selection.selectedCount} file(s).`.slice(0, 1024);

  return {
    name,
    displayName: `${repository.owner}/${repository.name} — coding agent guide`.slice(0, 120),
    description,
    whenToUse: dedupe(whenToUse).slice(0, 12),
    inputs: dedupe(inputs).slice(0, 12),
    steps: dedupe(steps).slice(0, 20),
    constraints: dedupe(constraints).slice(0, 12),
    verification: dedupe(verification).slice(0, 12),
    pitfalls: dedupe(pitfalls).slice(0, 12),
  };
}
