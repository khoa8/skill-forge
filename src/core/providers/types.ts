/**
 * Provider abstraction. Generation is never coupled to a single vendor:
 * providers turn (normalized source, analysis) into a validated SkillPlan,
 * and the shared builder produces the canonical package.
 */
import type { SourceAnalysis, NormalizedSource } from "../types.js";
import type { SkillPlan } from "../plan.js";

export interface GenerateInput {
  source: NormalizedSource;
  analysis: SourceAnalysis;
  /** Optional user hint for naming the skill. */
  requestedName?: string;
  /** Optional caller cancellation (e.g. HTTP client disconnect). Remote
   * providers abort their in-flight request when it fires; offline providers
   * may ignore it. */
  signal?: AbortSignal;
}

export interface GenerationProvider {
  readonly id: string;
  /** True when the provider works without any external API or key. */
  readonly offline: boolean;
  generate(input: GenerateInput): Promise<SkillPlan>;
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
