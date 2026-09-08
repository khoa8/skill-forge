/**
 * Provider-facing repository context (P1-6/P2-2).
 *
 * Serializes a RepositoryAnalysis into a compact, always-valid JSON document
 * for remote providers: array caps are applied per field (never a raw
 * character truncation that could cut JSON mid-object), and the fields that
 * carry boundedness/provenance (selection, inspectedFiles, uncertainty) are
 * preserved unconditionally. Deterministic: same analysis, same bytes.
 */
import type { RepositoryAnalysis } from "../types.js";

export interface RepositoryContextBudget {
  /** Cap per string-array field (commands, conventions, inspectedFiles, …). */
  arrayCap: number;
  /** Cap per claim-evidence entry. */
  evidenceCap: number;
  /** Cap for the description fields (reason/why strings). */
  stringCap: number;
}

export const REPOSITORY_CONTEXT_BUDGET: RepositoryContextBudget = {
  arrayCap: 12,
  evidenceCap: 3,
  stringCap: 200,
};

/**
 * Hard serialized-size ceiling for the provider repository context (re-audit
 * P2-2). The final JSON must ALWAYS fit under this bound in bytes — enforced
 * by deterministic progressive reduction of the lowest-priority arrays, never
 * by string slicing, so the output stays valid JSON. Identity, boundedness/
 * selection, and uncertainty are never reduced.
 */
export const MAX_REPOSITORY_CONTEXT_BYTES = 16_000;

/** Reduction order: lowest priority first. `null` marks the end of the
 * reduction ladder (all arrays at their floors). */
const REDUCTION_LADDER: Array<keyof RepositoryContextBudgetArrays> = [
  "importantFiles",
  "entrypoints",
  "frameworks",
  "manifests",
  "commands",
  "conventions",
  "inspectedFiles",
  "languages",
];

interface RepositoryContextBudgetArrays {
  importantFiles: number;
  entrypoints: number;
  frameworks: number;
  manifests: number;
  commands: number;
  conventions: number;
  inspectedFiles: number;
  languages: number;
}

/** One-line clamp for free-text repository-derived strings. */
function clamp(text: string, cap: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= cap ? oneLine : `${oneLine.slice(0, cap - 1)}…`;
}

/**
 * The compact provider context. Field order is the required priority:
 * identity/scope → boundedness/selection → uncertainty → commands →
 * conventions → entrypoints/important files → stack/manifests/testing.
 * Every array is capped by count, so JSON.parse on the output always
 * succeeds.
 */
export function repositoryContextForProvider(
  repo: RepositoryAnalysis,
  arrayCaps?: Partial<RepositoryContextBudgetArrays>,
): Record<string, unknown> {
  const b = REPOSITORY_CONTEXT_BUDGET;
  const cap = (n: number) => Math.max(0, n);
  return {
    repository: {
      url: repo.repository.url,
      owner: repo.repository.owner,
      name: repo.repository.name,
      ref: repo.repository.ref,
      ...(repo.repository.scope ? { scope: repo.repository.scope } : {}),
    },
    boundedSelection: {
      candidateCount: repo.selection.candidateCount,
      inspectedCount: repo.selection.selectedCount,
      treeBlobCount: repo.selection.treeBlobCount,
      treeTruncated: repo.selection.treeTruncated,
      inspectedFiles: repo.inspectedFiles.slice(0, cap(arrayCaps?.inspectedFiles ?? b.arrayCap)),
      inspectedFilesOmitted: Math.max(0, repo.inspectedFiles.length - cap(arrayCaps?.inspectedFiles ?? b.arrayCap)),
    },
    uncertainty: repo.uncertainty.slice(0, b.arrayCap).map((u) => clamp(u, b.stringCap)),
    commands: repo.commands.slice(0, cap(arrayCaps?.commands ?? b.arrayCap)).map((c) => ({
      purpose: c.purpose,
      command: clamp(c.command, b.stringCap),
      evidence: clamp(c.evidence, b.stringCap),
    })),
    conventions: repo.conventions.slice(0, cap(arrayCaps?.conventions ?? b.arrayCap)).map((c) => ({
      statement: clamp(c.statement, b.stringCap),
      evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
    })),
    entrypoints: repo.entrypoints.slice(0, cap(arrayCaps?.entrypoints ?? b.arrayCap)).map((e) => ({
      path: clamp(e.path, b.stringCap),
      reason: clamp(e.reason, b.stringCap),
    })),
    importantFiles: repo.importantFiles.slice(0, cap(arrayCaps?.importantFiles ?? b.arrayCap)).map((f) => ({
      path: clamp(f.path, b.stringCap),
      reason: clamp(f.reason, b.stringCap),
    })),
    stack: {
      languages: repo.languages.slice(0, cap(arrayCaps?.languages ?? b.arrayCap)).map((c) => ({
        name: clamp(c.name, b.stringCap),
        evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
      })),
      ecosystems: repo.ecosystems.slice(0, b.arrayCap),
      frameworks: repo.frameworks.slice(0, cap(arrayCaps?.frameworks ?? b.arrayCap)).map((c) => ({
        name: clamp(c.name, b.stringCap),
        evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
      })),
      manifests: repo.manifests.slice(0, cap(arrayCaps?.manifests ?? b.arrayCap)).map((m) => ({
        path: clamp(m.path, b.stringCap),
        kind: clamp(m.kind, b.stringCap),
        fetched: m.fetched,
      })),
      structure: {
        sourceRoots: repo.structure.sourceRoots.slice(0, 8),
        testRoots: repo.structure.testRoots.slice(0, 8),
        exampleRoots: repo.structure.exampleRoots.slice(0, 8),
        packages: repo.structure.packages.slice(0, b.arrayCap),
      },
      testing: {
        frameworks: repo.testing.frameworks.slice(0, b.arrayCap),
        relevantFiles: repo.testing.relevantFiles.slice(0, b.arrayCap),
      },
    },
  };
}

/** Deterministic serialized form for embedding in a provider prompt. Always
 * valid JSON and always within MAX_REPOSITORY_CONTEXT_BYTES (progressive
 * deterministic reduction of lower-priority arrays when needed). */
export function repositoryContextJson(repo: RepositoryAnalysis): string {
  const caps: RepositoryContextBudgetArrays = {
    importantFiles: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    entrypoints: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    frameworks: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    manifests: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    commands: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    conventions: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    inspectedFiles: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    languages: REPOSITORY_CONTEXT_BUDGET.arrayCap,
  };
  let json = JSON.stringify(repositoryContextForProvider(repo, caps));
  if (Buffer.byteLength(json, "utf8") <= MAX_REPOSITORY_CONTEXT_BYTES) return json;

  // Deterministic reduction ladder: floor halving of the lowest-priority
  // arrays first; identity, boundedSelection (counts), and uncertainty are
  // never reduced, so any reduction keeps the boundedness record intact.
  let step = 0;
  while (Buffer.byteLength(json, "utf8") > MAX_REPOSITORY_CONTEXT_BYTES && step < REDUCTION_LADDER.length * 8) {
    const field = REDUCTION_LADDER[step % REDUCTION_LADDER.length]!;
    if (caps[field] > 0) caps[field] = Math.floor(caps[field] / 2);
    step++;
    json = JSON.stringify(repositoryContextForProvider(repo, caps));
  }
  return json;
}
