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

/**
 * Structured source identity anchor preserved across proposal resolution
 * for late-binding artifact allocation.
 *
 * NOTE: `heading`, `title`, and `stepCount` are snapshot metadata captured
 * from the provider-visible analysis (selection evidence and lookup hints).
 * After resolution against the full authoritative analysis, the canonical
 * builder renders factual metadata (heading, title, step count) from the
 * resolved full-source object (`allocated.section` / `allocated.proc`), not
 * from these prefix snapshot fields.
 */
export type PlanAtomSourceAnchor =
  | {
      kind: "section";
      heading: string;
      startLine: number;
      endLine?: number;
      sectionId: string;
    }
  | {
      kind: "procedure";
      title: string;
      line: number;
      stepCount: number;
    };

export interface GroundedPlanAtom {
  id: string;
  section: GroundedSection;
  text: string;
  sourceAnchor?: PlanAtomSourceAnchor;
}

export interface ResolvedGroundedPlan extends SkillPlan {
  /** Structured step atoms preserving source anchors for late-binding file allocation. */
  stepAtoms?: GroundedPlanAtom[];
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
 * `displayName` must be single-line presentation text (no line breaks permitted).
 * There is deliberately NO `description` field and NO top-level section
 * prose: any old-style free-text payload fails strict parsing with
 * `provider_schema_mismatch` instead of entering the package.
 */
export const ProviderProposalSchema = z
  .object({
    name: z.string().max(200).optional(),
    displayName: z
      .string()
      .max(200)
      .regex(/^[^\r\n\u2028\u2029]*$/)
      .optional(),
    selections: z
      .object({
        whenToUse: z.array(z.string().max(64)).max(12).default([]),
        inputs: z.array(z.string().max(64)).max(12).default([]),
        steps: z.array(z.string().max(64)).max(20).default([]),
        constraints: z.array(z.string().max(64)).max(12).default([]),
        verification: z.array(z.string().max(64)).max(12).default([]),
        pitfalls: z.array(z.string().max(64)).max(12).default([]),
      })
      .strict(),
  })
  .strict();
export type ProviderProposal = z.infer<typeof ProviderProposalSchema>;

const KNOWN_TOP_KEYS = new Set(["name", "displayName", "selections"]);
const KNOWN_SELECTION_KEYS = new Set<string>(GROUNDED_SECTIONS);

/**
 * Sanitize a Zod issue path to ensure provider-controlled key names are NEVER
 * echoed in error paths or diagnostics. Only statically known schema properties
 * and numeric indices are retained; unknown keys become `(unknown)`.
 */
export function sanitizeSchemaPath(path: (string | number)[]): string {
  if (path.length === 0) return "(root)";
  const segments: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment === "number") {
      segments.push(`[${segment}]`);
    } else if (typeof segment === "string" && i === 0 && KNOWN_TOP_KEYS.has(segment)) {
      segments.push(segment);
    } else if (
      typeof segment === "string" &&
      i === 1 &&
      path[0] === "selections" &&
      KNOWN_SELECTION_KEYS.has(segment)
    ) {
      segments.push(`.${segment}`);
    } else {
      segments.push(i === 0 ? "(unknown)" : ".(unknown)");
    }
  }
  return segments.join("").replace(/^\./, "");
}

/**
 * Format schema validation issues without ever echoing raw issue messages,
 * unrecognized key names, or provider-supplied values. This guarantees
 * diagnostics remain secret-safe by construction even if an endpoint reflects
 * the client's Bearer token as an unexpected JSON key or value.
 */
export function formatProviderProposalSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const safePath = sanitizeSchemaPath(issue.path);
      switch (issue.code) {
        case "unrecognized_keys":
          return `${safePath}: unrecognized field(s)`;
        case "invalid_type":
          return `${safePath}: expected ${issue.expected}, received ${issue.received}`;
        case "too_big":
          return `${safePath}: exceeds maximum ${issue.type} of ${issue.maximum}`;
        case "too_small":
          return `${safePath}: does not meet minimum ${issue.type} of ${issue.minimum}`;
        default:
          return `${safePath}: invalid value`;
      }
    })
    .join("; ");
}

/** Build the deterministic catalog from an already-derived trusted plan. */
export function catalogFromPlan(plan: SkillPlan | ResolvedGroundedPlan): GroundedCatalog {
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
      const existingAtom = section === "steps" && (plan as ResolvedGroundedPlan).stepAtoms?.[index];
      const atom: GroundedPlanAtom = existingAtom
        ? { ...existingAtom, id, section }
        : { id, section, text };
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
): ResolvedGroundedPlan {
  const parsed = ProviderProposalSchema.safeParse(proposalUnknown);
  if (!parsed.success) {
    const issues = formatProviderProposalSchemaIssues(parsed.error);
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
  const stepAtoms: GroundedPlanAtom[] = [];
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
      if (section === "steps") {
        stepAtoms.push(atom);
      }
    }
  }
  return {
    ...(proposal.name !== undefined ? { name: proposal.name } : {}),
    ...(proposal.displayName !== undefined ? { displayName: proposal.displayName } : {}),
    whenToUse: resolved.whenToUse,
    inputs: resolved.inputs,
    steps: resolved.steps,
    stepAtoms,
    constraints: resolved.constraints,
    verification: resolved.verification,
    pitfalls: resolved.pitfalls,
  };
}
