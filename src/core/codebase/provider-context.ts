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

/** One-line clamp for free-text repository-derived strings. */
function clamp(text: string, cap: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= cap ? oneLine : `${oneLine.slice(0, cap - 1)}…`;
}

function claims(list: RepositoryAnalysis["languages"], b: RepositoryContextBudget): Array<{ name: string; evidence: string[] }> {
  return list.slice(0, b.arrayCap).map((c) => ({
    name: clamp(c.name, b.stringCap),
    evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
  }));
}

/**
 * The compact provider context. Field order is the required priority:
 * identity/scope → boundedness/selection → uncertainty → commands →
 * conventions → entrypoints/important files → stack/manifests/testing.
 * Every array is capped by count, so JSON.parse on the output always
 * succeeds.
 */
export function repositoryContextForProvider(repo: RepositoryAnalysis): Record<string, unknown> {
  const b = REPOSITORY_CONTEXT_BUDGET;
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
      inspectedFiles: repo.inspectedFiles.slice(0, b.arrayCap),
      inspectedFilesOmitted: Math.max(0, repo.inspectedFiles.length - b.arrayCap),
    },
    uncertainty: repo.uncertainty.slice(0, b.arrayCap).map((u) => clamp(u, b.stringCap)),
    commands: repo.commands.slice(0, b.arrayCap).map((c) => ({
      purpose: c.purpose,
      command: clamp(c.command, b.stringCap),
      evidence: clamp(c.evidence, b.stringCap),
    })),
    conventions: repo.conventions.slice(0, b.arrayCap).map((c) => ({
      statement: clamp(c.statement, b.stringCap),
      evidence: c.evidence.slice(0, b.evidenceCap).map((e) => clamp(e, b.stringCap)),
    })),
    entrypoints: repo.entrypoints.slice(0, b.arrayCap).map((e) => ({
      path: clamp(e.path, b.stringCap),
      reason: clamp(e.reason, b.stringCap),
    })),
    importantFiles: repo.importantFiles.slice(0, b.arrayCap).map((f) => ({
      path: clamp(f.path, b.stringCap),
      reason: clamp(f.reason, b.stringCap),
    })),
    stack: {
      languages: claims(repo.languages, b),
      ecosystems: repo.ecosystems.slice(0, b.arrayCap),
      frameworks: claims(repo.frameworks, b),
      manifests: repo.manifests.slice(0, b.arrayCap).map((m) => ({
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

/** Deterministic serialized form for embedding in a provider prompt. */
export function repositoryContextJson(repo: RepositoryAnalysis): string {
  return JSON.stringify(repositoryContextForProvider(repo));
}
