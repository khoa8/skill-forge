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
  "ecosystems",
  "structureRoots",
  "structurePackages",
  "testingFrameworks",
  "testingFiles",
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
  ecosystems: number;
  structureRoots: number;
  structurePackages: number;
  testingFrameworks: number;
  testingFiles: number;
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
  const n = (field: keyof RepositoryContextBudgetArrays): number =>
    Math.max(0, arrayCaps?.[field] ?? b.arrayCap);
  // Identity strings are clamped too (re-audit P2-2): every repository-derived
  // free-text field participates in the bound.
  const idCap = Math.min(b.stringCap, 120);
  return {
    repository: {
      url: clamp(repo.repository.url, idCap),
      owner: clamp(repo.repository.owner, idCap),
      name: clamp(repo.repository.name, idCap),
      ref: clamp(repo.repository.ref, idCap),
      ...(repo.repository.scope ? { scope: clamp(repo.repository.scope, idCap) } : {}),
    },
    boundedSelection: {
      candidateCount: repo.selection.candidateCount,
      inspectedCount: repo.selection.selectedCount,
      treeBlobCount: repo.selection.treeBlobCount,
      treeTruncated: repo.selection.treeTruncated,
      inspectedFiles: repo.inspectedFiles.slice(0, n("inspectedFiles")).map((p) => clamp(p, b.stringCap)),
      inspectedFilesOmitted: Math.max(0, repo.inspectedFiles.length - n("inspectedFiles")),
    },
    uncertainty: repo.uncertainty.slice(0, b.arrayCap).map((u) => clamp(u, b.stringCap)),
    commands: repo.commands.slice(0, n("commands")).map((c) => ({
      purpose: c.purpose,
      command: clamp(c.command, b.stringCap),
      evidence: clamp(c.evidence, b.stringCap),
    })),
    conventions: repo.conventions.slice(0, n("conventions")).map((c) => ({
      statement: clamp(c.statement, b.stringCap),
      evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
    })),
    entrypoints: repo.entrypoints.slice(0, n("entrypoints")).map((e) => ({
      path: clamp(e.path, b.stringCap),
      reason: clamp(e.reason, b.stringCap),
    })),
    importantFiles: repo.importantFiles.slice(0, n("importantFiles")).map((f) => ({
      path: clamp(f.path, b.stringCap),
      reason: clamp(f.reason, b.stringCap),
    })),
    stack: {
      languages: repo.languages.slice(0, n("languages")).map((c) => ({
        name: clamp(c.name, b.stringCap),
        evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
      })),
      ecosystems: repo.ecosystems.slice(0, n("ecosystems")).map((e) => clamp(e, b.stringCap)),
      frameworks: repo.frameworks.slice(0, n("frameworks")).map((c) => ({
        name: clamp(c.name, b.stringCap),
        evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
      })),
      manifests: repo.manifests.slice(0, n("manifests")).map((m) => ({
        path: clamp(m.path, b.stringCap),
        kind: clamp(m.kind, b.stringCap),
        fetched: m.fetched,
      })),
      structure: {
        sourceRoots: repo.structure.sourceRoots.slice(0, n("structureRoots")).map((r) => clamp(r, b.stringCap)),
        testRoots: repo.structure.testRoots.slice(0, n("structureRoots")).map((r) => clamp(r, b.stringCap)),
        exampleRoots: repo.structure.exampleRoots.slice(0, n("structureRoots")).map((r) => clamp(r, b.stringCap)),
        packages: repo.structure.packages.slice(0, n("structurePackages")).map((p) => clamp(p, b.stringCap)),
      },
      testing: {
        frameworks: repo.testing.frameworks.slice(0, n("testingFrameworks")).map((f) => clamp(f, b.stringCap)),
        relevantFiles: repo.testing.relevantFiles.slice(0, n("testingFiles")).map((p) => clamp(p, b.stringCap)),
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
    ecosystems: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    structureRoots: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    structurePackages: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    testingFrameworks: REPOSITORY_CONTEXT_BUDGET.arrayCap,
    testingFiles: REPOSITORY_CONTEXT_BUDGET.arrayCap,
  };
  let json = JSON.stringify(repositoryContextForProvider(repo, caps));
  if (Buffer.byteLength(json, "utf8") <= MAX_REPOSITORY_CONTEXT_BYTES) return json;

  // Deterministic reduction ladder: floor halving of the lowest-priority
  // arrays first; identity, boundedSelection (counts), and uncertainty are
  // never reduced, so any reduction keeps the boundedness record intact.
  // TERMINATION PROOF: every string in the payload is clamped (≤ stringCap
  // characters), so the floor — all ladder arrays at 0 — leaves only
  // identity (≤ 5 × 120 chars) + uncertainty (≤ 12 × 200 chars) + selection
  // counts, which is provably below MAX_REPOSITORY_CONTEXT_BYTES even for
  // worst-case multibyte content (≈3 bytes/char UTF-8). The loop therefore
  // always terminates under the cap; the iteration bound is pure defense.
  let step = 0;
  const maxSteps = REDUCTION_LADDER.length * 16;
  while (Buffer.byteLength(json, "utf8") > MAX_REPOSITORY_CONTEXT_BYTES && step < maxSteps) {
    const field = REDUCTION_LADDER[step % REDUCTION_LADDER.length]!;
    if (caps[field] > 0) caps[field] = Math.floor(caps[field] / 2);
    step++;
    json = JSON.stringify(repositoryContextForProvider(repo, caps));
  }
  if (Buffer.byteLength(json, "utf8") > MAX_REPOSITORY_CONTEXT_BYTES) {
    // Mathematically unreachable per the termination proof above; fail loudly
    // rather than emit an oversized prompt.
    throw new Error(
      `Provider repository context exceeded ${MAX_REPOSITORY_CONTEXT_BYTES} bytes even after full reduction — this is a bug in the context serializer.`,
    );
  }
  return json;
}
