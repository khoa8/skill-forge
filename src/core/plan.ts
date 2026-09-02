/**
 * The structured skill plan that providers must produce.
 *
 * Both the deterministic mock provider and LLM providers emit this shape;
 * the shared builder in build.ts turns a validated plan + source analysis
 * into the canonical skill package. Keeping providers narrow keeps grounding
 * enforcement and file synthesis in one auditable place.
 */
import { z } from "zod";

export const PlanSchema = z.object({
  /** Suggested package slug (lowercase, hyphenated). Builders may normalize it. */
  name: z.string().optional(),
  displayName: z.string().optional(),
  /** One-paragraph "what this skill is for", grounded in the source. */
  description: z.string().max(1024).optional(),
  whenToUse: z.array(z.string().min(1).max(300)).max(12).default([]),
  inputs: z.array(z.string().min(1).max(300)).max(12).default([]),
  steps: z.array(z.string().min(1).max(500)).max(20).default([]),
  constraints: z.array(z.string().min(1).max(500)).max(12).default([]),
  verification: z.array(z.string().min(1).max(500)).max(12).default([]),
  pitfalls: z.array(z.string().min(1).max(500)).max(12).default([]),
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
