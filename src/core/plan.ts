/**
 * The structured skill plan that providers must produce.
 *
 * Both the deterministic mock provider and LLM providers emit this shape;
 * the shared builder in build.ts turns a validated plan + source analysis
 * into the canonical skill package. Keeping providers narrow keeps grounding
 * enforcement and file synthesis in one auditable place.
 *
 * This module is the single owner of the resolved-plan contract: `PlanSchema`
 * declares the shape AND `PLAN_LIMITS` is the one source of truth for the
 * per-section item/length bounds the producers must respect. Deterministic
 * planners (`derivePlanFromAnalysis`, `deriveCodebasePlan`) compose their
 * strings from `fitPlanItem`-bounded ingredients, and the shared resolved-plan
 * boundary (`resolveProviderProposal`) fails closed with
 * `resolvedPlanContractIssue` if a catalog atom is still unrepresentable.
 */
import { z } from "zod";

/**
 * Per-section bounds of the resolved grounded plan.
 *
 * `PlanSchema` is built from these constants, so the schema and the limits
 * producers compose against can never drift apart. Item counts deliberately
 * mirror the builder's own section slices.
 */
export const PLAN_LIMITS = {
  /** The one free-text plan field outside the grounded sections. */
  description: { maxItemChars: 1024 },
  whenToUse: { maxItems: 12, maxItemChars: 300 },
  inputs: { maxItems: 12, maxItemChars: 300 },
  steps: { maxItems: 20, maxItemChars: 500 },
  constraints: { maxItems: 12, maxItemChars: 500 },
  verification: { maxItems: 12, maxItemChars: 500 },
  pitfalls: { maxItems: 12, maxItemChars: 500 },
} as const;

/** The ordered grounded plan sections every provider selects over. */
export const GROUNDED_SECTIONS = [
  "whenToUse",
  "inputs",
  "steps",
  "constraints",
  "verification",
  "pitfalls",
] as const;
export type GroundedSection = (typeof GROUNDED_SECTIONS)[number];

const item = (section: GroundedSection) =>
  z.array(z.string().min(1).max(PLAN_LIMITS[section].maxItemChars)).max(PLAN_LIMITS[section].maxItems).default([]);

export const PlanSchema = z.object({
  /** Suggested package slug (lowercase, hyphenated). Builders may normalize it. */
  name: z.string().optional(),
  displayName: z.string().optional(),
  /** One-paragraph "what this skill is for", grounded in the source. */
  description: z.string().max(PLAN_LIMITS.description.maxItemChars).optional(),
  whenToUse: item("whenToUse"),
  inputs: item("inputs"),
  steps: item("steps"),
  constraints: item("constraints"),
  verification: item("verification"),
  pitfalls: item("pitfalls"),
});
export type SkillPlan = z.infer<typeof PlanSchema>;

/** Human-facing pipeline stage names, in execution order. */
export const PIPELINE_STAGES = [
  "ingest",
  "analyze",
  "generate",
  "validate",
  "export",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// ---------------------------------------------------------------------------
// Producer-side bounding
// ---------------------------------------------------------------------------

/**
 * Shorten trusted prose for a bounded presentation slot, marking the elision
 * with an ellipsis (the same convention `firstSentences` already uses) and
 * flattening whitespace so the result stays single-line.
 */
export function clipPlanText(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return flat.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
}

/**
 * Guarantee a trusted-prose plan item is representable in its section.
 *
 * This is a backstop, not the primary bound: producers compose items from
 * `clipPlanText`-bounded ingredients so structural parts (quotes, guidance
 * clauses, evidence lists) stay intact. It exists so no deterministic
 * producer can emit an item the resolved-plan contract rejects.
 *
 * Never apply this to a source-derived command body: shortening a shell
 * command produces a *different* command. Command-bearing items are handled
 * by explicit non-runnable reference rendering instead.
 */
export function fitPlanItem(text: string, maxChars: number): string {
  return text.length > maxChars ? clipPlanText(text, maxChars) : text;
}

/** Apply `fitPlanItem` across one plan section. */
export function fitPlanSection(items: readonly string[], maxChars: number): string[] {
  return items.map((text) => fitPlanItem(text, maxChars));
}

// ---------------------------------------------------------------------------
// Shared resolved-plan boundary check
// ---------------------------------------------------------------------------

/**
 * Describe why a resolved plan violates `PlanSchema`, or null when it is
 * valid.
 *
 * Diagnostics are bounded and value-free by construction: only statically
 * known section names, indices, and schema limits are ever rendered, so a
 * hostile atom value can never be reflected into an error message, log, or
 * API response.
 */
export function resolvedPlanContractIssue(plan: unknown): string | null {
  const parsed = PlanSchema.safeParse(plan);
  if (parsed.success) return null;
  return parsed.error.issues
    .slice(0, 5)
    .map((issue) => {
      const [head, index] = issue.path;
      const section =
        typeof head === "string" && (GROUNDED_SECTIONS as readonly string[]).includes(head)
          ? head
          : "(unknown)";
      const slot = typeof index === "number" ? `[${index}]` : "";
      switch (issue.code) {
        case "too_big":
          return `${section}${slot}: exceeds maximum ${issue.type} of ${issue.maximum}`;
        case "too_small":
          return `${section}${slot}: does not meet minimum ${issue.type} of ${issue.minimum}`;
        case "invalid_type":
          return `${section}${slot}: expected ${issue.expected}, received ${issue.received}`;
        default:
          return `${section}${slot}: invalid value`;
      }
    })
    .join("; ");
}
