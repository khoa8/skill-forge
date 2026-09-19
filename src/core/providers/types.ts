/**
 * Provider abstraction. Generation is never coupled to a single vendor:
 * providers turn (normalized source, analysis) into a validated SkillPlan,
 * and the shared builder produces the canonical package.
 */
import type { SourceAnalysis, NormalizedSource, RepositoryAnalysis } from "../types.js";
import type { ProviderProposal, GroundedCatalog } from "../plan-catalog.js";

export interface GenerateInput {
  source: NormalizedSource;
  analysis: SourceAnalysis;
  /** Structured repository analysis — present only for github-codebase
   * sources; providers must ground repository claims in it. */
  repository?: RepositoryAnalysis;
  /** Optional user hint for naming the skill. */
  requestedName?: string;
  /** Deterministic grounded catalog that the provider may select from.
   * When provided, remote providers format this exact catalog and the shared
   * resolver resolves against it. */
  catalog?: GroundedCatalog;
  /** Optional caller cancellation (e.g. HTTP client disconnect). Remote
   * providers abort their in-flight request when it fires; offline providers
   * may ignore it. */
  signal?: AbortSignal;
}

export interface GenerationProvider {
  readonly id: string;
  /** True when the provider works without any external API or key. */
  readonly offline: boolean;
  /**
   * Return a SELECTION over the deterministic grounded catalog (atom IDs),
   * never free-text grounded prose. The shared resolver
   * (`resolveProviderProposal`) validates and resolves the proposal before
   * the canonical builder runs.
   */
  generate(input: GenerateInput): Promise<ProviderProposal>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
