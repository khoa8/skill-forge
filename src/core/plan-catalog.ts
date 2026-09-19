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
import type { NormalizedSource, SourceAnalysis } from "./types.js";
import { derivePlanFromAnalysis } from "./build.js";
import { deriveCodebasePlan } from "./codebase/plan.js";
import { analyzeSource } from "./analyze.js";
import { sha256 } from "./util.js";

/** Maximum normalized source characters transmitted to or analyzed for remote ordinary providers. */
export const MAX_PROVIDER_SOURCE_CHARS = 60_000;

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

/**
 * Return the provider-visible view of a normalized source.
 *
 * For ordinary sources (non-codebase), remote providers are bounded to the
 * first 60,000 characters of normalized text. Source content beyond this
 * boundary must not be sent to the remote provider as raw text, nor may it
 * feed the grounded catalog exposed to the model.
 */
export function providerVisibleSource(
  source: NormalizedSource,
  maxChars = MAX_PROVIDER_SOURCE_CHARS,
): NormalizedSource {
  if (source.repository || source.text.length <= maxChars) {
    return source;
  }
  const boundedText = source.text.slice(0, maxChars);
  return {
    ...source,
    text: boundedText,
    lineCount: boundedText.split("\n").length,
    sha256: sha256(boundedText),
  };
}

export interface PreparedCatalogContext {
  catalog: GroundedCatalog;
  /** Provider-visible source view (bounded for ordinary remote providers; full for offline or codebase). */
  providerSource: NormalizedSource;
  /** Analysis matching providerSource. */
  providerAnalysis: SourceAnalysis;
}

/**
 * Shared preparation of the provider-visible catalog and source context.
 *
 * Ensures remote providers and the downstream resolver agree on the exact
 * same effective catalog:
 * - Codebase mode: safe structural orientation plan from structured repository facts.
 * - Offline providers (mock): full deterministic catalog without truncation.
 * - Ordinary remote providers: catalog derived strictly from the provider-visible
 *   source prefix (<=60k chars).
 */
export function prepareProviderCatalog(
  source: NormalizedSource,
  analysis: SourceAnalysis,
  options: {
    offline: boolean;
    requestedName?: string;
  },
): PreparedCatalogContext {
  if (source.repository) {
    const plan = deriveCodebasePlan(source.repository, options.requestedName);
    const catalog = catalogFromPlan(plan);
    return {
      catalog,
      providerSource: source,
      providerAnalysis: analysis,
    };
  }

  if (options.offline) {
    const plan = derivePlanFromAnalysis(analysis);
    const catalog = catalogFromPlan(plan);
    return {
      catalog,
      providerSource: source,
      providerAnalysis: analysis,
    };
  }

  const providerSource = providerVisibleSource(source);
  const providerAnalysis = providerSource === source ? analysis : analyzeSource(providerSource);
  const plan = derivePlanFromAnalysis(providerAnalysis);
  const catalog = catalogFromPlan(plan);
  return {
    catalog,
    providerSource,
    providerAnalysis,
  };
}

const ATOM_ID_RE = /^(whenToUse|inputs|steps|constraints|verification|pitfalls)-(\d+)$/;

/**
 * Shared runtime resolution (provider-independent).
 *
 * 1. Validates the proposal shape (`provider_schema_mismatch` on failure).
 * 2. Resolves every ID against the catalog.
 * 3. Rejects malformed/unknown IDs with `provider_unknown_atom`. Diagnostics
 *    never echo raw provider-controlled values (secret-safe by construction).
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
    const sectionSelections = proposal.selections[section];
    for (let i = 0; i < sectionSelections.length; i++) {
      const rawId = sectionSelections[i]!;
      const id = rawId.trim();
      const m = id.match(ATOM_ID_RE);
      if (!m || m[1] !== section) {
        throw new ProviderError(
          `Unknown grounded atom reference at selections.${section}[${i}]: expected "<section>-<index>" format for section "${section}" (e.g. "${section}-0"). Provider selections must reference only catalog atom IDs.`,
          "provider_unknown_atom",
          { section, index: i },
        );
      }
      const atom = catalog.byId.get(id);
      if (!atom || atom.section !== section) {
        const max = catalog.bySection[section].length;
        const validRange =
          max > 0
            ? `section "${section}" has ${max} atom(s), valid IDs "${section}-0" through "${section}-${max - 1}"`
            : `section "${section}" has 0 atoms in the current deterministic catalog`;
        throw new ProviderError(
          `Unknown grounded atom reference at selections.${section}[${i}]: no matching atom in the deterministic catalog (${validRange}). Provider selections must reference only catalog atom IDs.`,
          "provider_unknown_atom",
          { section, index: i },
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
