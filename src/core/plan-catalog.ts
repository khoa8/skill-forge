/**
 * Deterministic grounded plan catalog + shared provider-proposal resolver.
 *
 * Trust boundary (F-01 remediation):
 *
 * - Deterministic trusted code authors all factual/instructional prose
 *   (via `derivePlanFromAnalysis` / `deriveCodebasePlan`). Each string becomes
 *   a catalog atom with a deterministic ID.
 * - Remote providers may only SELECT and ORDER known atom IDs. They never
 *   author grounded section prose.
 * - Shared runtime code (`resolveProviderProposal`) validates the proposal
 *   shape, resolves every ID against the catalog, rejects unknown/malformed
 *   IDs deterministically, and produces the resolved `SkillPlan`.
 * - The canonical builder synthesizes files from the resolved plan. Provider
 *   description prose is never trusted (the builder derives descriptions
 *   deterministically).
 *
 * IDs are deterministic for one generation input (`<section>-<index>`) and
 * are internal generation data only: they are never persisted and never added
 * to the canonical format.
 */
import { z } from "zod";
import { ProviderError } from "./providers/types.js";
import type { SkillPlan } from "./plan.js";

export const GROUNDED_SECTIONS = [
  "whenToUse",
  "inputs",
  "steps",
  "constraints",
  "verification",
  "pitfalls",
] as const;
export type GroundedSection = (typeof GROUNDED_SECTIONS)[number];

export interface GroundedPlanAtom {
  id: string;
  section: GroundedSection;
  text: string;
}

export interface GroundedCatalog {
  atoms: GroundedPlanAtom[];
  byId: Map<string, GroundedPlanAtom>;
  bySection: Record<GroundedSection, GroundedPlanAtom[]>;
}

/**
 * Provider output contract: selection + ordering over known atom IDs.
 *
 * `name`/`displayName` remain presentation hints (normalized downstream).
 * There is deliberately NO `description` field and NO top-level section
 * prose: any old-style free-text payload fails strict parsing with
 * `provider_schema_mismatch` instead of entering the package.
 */
export const ProviderProposalSchema = z
  .object({
    name: z.string().max(200).optional(),
    displayName: z.string().max(200).optional(),
    selections: z.object({
      whenToUse: z.array(z.string().max(64)).max(12).default([]),
      inputs: z.array(z.string().max(64)).max(12).default([]),
      steps: z.array(z.string().max(64)).max(20).default([]),
      constraints: z.array(z.string().max(64)).max(12).default([]),
      verification: z.array(z.string().max(64)).max(12).default([]),
      pitfalls: z.array(z.string().max(64)).max(12).default([]),
    }),
  })
  .strict();
export type ProviderProposal = z.infer<typeof ProviderProposalSchema>;

/** Build the deterministic catalog from an already-derived trusted plan. */
export function catalogFromPlan(plan: SkillPlan): GroundedCatalog {
  const atoms: GroundedPlanAtom[] = [];
  const byId = new Map<string, GroundedPlanAtom>();
  const bySection = {
    whenToUse: [],
    inputs: [],
    steps: [],
    constraints: [],
    verification: [],
    pitfalls: [],
  } as Record<GroundedSection, GroundedPlanAtom[]>;
  for (const section of GROUNDED_SECTIONS) {
    const items = plan[section] ?? [];
    items.forEach((text, index) => {
      const id = `${section}-${index}`;
      const atom: GroundedPlanAtom = { id, section, text };
      atoms.push(atom);
      byId.set(id, atom);
      bySection[section].push(atom);
    });
  }
  return { atoms, byId, bySection };
}

/** Compact catalog rendering for provider prompts (IDs + text, no prose). */
export function formatCatalogForPrompt(catalog: GroundedCatalog): string {
  const lines: string[] = [];
  for (const section of GROUNDED_SECTIONS) {
    for (const atom of catalog.bySection[section]) {
      lines.push(`- [${atom.id}] (${atom.section}) ${atom.text}`);
    }
  }
  return lines.join("\n");
}

const ATOM_ID_RE = /^(whenToUse|inputs|steps|constraints|verification|pitfalls)-(\d+)$/;

/**
 * Shared runtime resolution (provider-independent).
 *
 * 1. Validates the proposal shape (`provider_schema_mismatch` on failure).
 * 2. Resolves every ID against the catalog.
 * 3. Rejects malformed/unknown IDs with `provider_unknown_atom`.
 * 4. Returns the resolved grounded `SkillPlan` (no provider prose copied).
 *
 * Empty selections are preserved as empty: the builder applies its existing
 * deterministic fallback/gap behavior. Ordering is honored; duplicate IDs
 * are deduped (first occurrence wins).
 */
export function resolveProviderProposal(
  proposalUnknown: unknown,
  catalog: GroundedCatalog,
): SkillPlan {
  const parsed = ProviderProposalSchema.safeParse(proposalUnknown);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ProviderError(
      `Provider proposal did not match the grounded selection schema: ${issues}. Providers must return selections over known grounded atom IDs, not free-text instructions.`,
      "provider_schema_mismatch",
    );
  }
  const proposal = parsed.data;
  const resolved: Record<GroundedSection, string[]> = {
    whenToUse: [],
    inputs: [],
    steps: [],
    constraints: [],
    verification: [],
    pitfalls: [],
  };
  for (const section of GROUNDED_SECTIONS) {
    const seen = new Set<string>();
    for (const rawId of proposal.selections[section]) {
      const id = rawId.trim();
      const m = id.match(ATOM_ID_RE);
      if (!m || m[1] !== section) {
        throw new ProviderError(
          `Unknown grounded atom ID "${rawId}" in selections.${section}: expected "<section>-<index>" for section "${section}" (e.g. "${section}-0"). Provider selections must reference only catalog atom IDs.`,
          "provider_unknown_atom",
          { section, id: rawId },
        );
      }
      const atom = catalog.byId.get(id);
      if (!atom || atom.section !== section) {
        const max = catalog.bySection[section].length;
        throw new ProviderError(
          `Unknown grounded atom ID "${rawId}" in selections.${section}: no such atom in the deterministic catalog (section "${section}" has ${max} atom(s), valid IDs ${section}-0..${section}-${Math.max(0, max - 1)}). Provider selections must reference only catalog atom IDs.`,
          "provider_unknown_atom",
          { section, id: rawId },
        );
      }
      if (seen.has(id)) continue;
      seen.add(id);
      resolved[section].push(atom.text);
    }
  }
  return {
    ...(proposal.name !== undefined ? { name: proposal.name } : {}),
    ...(proposal.displayName !== undefined ? { displayName: proposal.displayName } : {}),
    whenToUse: resolved.whenToUse,
    inputs: resolved.inputs,
    steps: resolved.steps,
    constraints: resolved.constraints,
    verification: resolved.verification,
    pitfalls: resolved.pitfalls,
  };
}
