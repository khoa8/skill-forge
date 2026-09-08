/**
 * SkillForge canonical types.
 *
 * The canonical skill model is the single internal representation that every
 * generator, validator, and exporter operates on. Vendor-specific output
 * formats are produced by exporters/adapters — never by separate pipelines.
 */
import { z } from "zod";

/** Severity used by deterministic validation checks. */
export const Severity = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof Severity>;

/** Where a piece of generated content came from in the source material. */
export const Provenance = z.object({
  /** File path (relative) of the generated file this provenance belongs to. */
  filePath: z.string(),
  /** Human-readable description of the extraction rule that produced this. */
  extraction: z.string(),
  /** 1-based inclusive line range in the *normalized* source text. */
  sourceLines: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  /** Heading the excerpt sits under in the source, if any. */
  sourceHeading: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** A single generated file inside the canonical skill package. */
export const SkillFile = z.object({
  /** Package-relative POSIX path. Must be safe (see validators/pathSafety). */
  path: z.string(),
  content: z.string(),
  /** Why this file exists — every generated file must have a purpose. */
  purpose: z.string(),
  /** Set when the user edited this file's content after generation. Its
   * provenance records are then dropped: the content is no longer purely
   * source-derived, and claiming line-range grounding would be false. */
  userEdited: z.boolean().optional(),
});
export type SkillFile = z.infer<typeof SkillFile>;

/** Metadata block stored in the manifest. */
export const SkillMeta = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  version: z.string().default("0.1.0"),
  /** Which pipeline produced the skill: "mock" (deterministic demo) or a provider id. */
  generator: z.string(),
  generatedAt: z.string(),
  /** Non-empty when the source could not answer a standard section. */
  gaps: z.array(z.string()).default([]),
});
export type SkillMeta = z.infer<typeof SkillMeta>;

/**
 * The canonical skill package: a normalized description plus the concrete
 * files that make up the skill. Exporters translate this structure into
 * ecosystem-specific layouts (e.g. Claude Code skill folders).
 */
export const CanonicalSkill = z.object({
  schemaVersion: z.literal("1"),
  id: z.string(),
  meta: SkillMeta,
  /** Structured summary used by exporters and preview UI. */
  plan: z.object({
    whenToUse: z.array(z.string()),
    inputs: z.array(z.string()),
    steps: z.array(z.string()),
    constraints: z.array(z.string()),
    verification: z.array(z.string()),
    pitfalls: z.array(z.string()),
  }),
  files: z.array(SkillFile),
  provenance: z.array(Provenance),
});
export type CanonicalSkill = z.infer<typeof CanonicalSkill>;

// ---------------------------------------------------------------------------
// GitHub codebase mode — structured repository analysis
// ---------------------------------------------------------------------------

/**
 * A claim about the repository (language, framework, tool) paired with the
 * inspected evidence that supports it. Codebase-mode claims are never
 * asserted without evidence, so the skill stays grounded in what SkillForge
 * actually inspected.
 */
export const RepositoryClaim = z.object({
  name: z.string().min(1).max(120),
  /** Where the claim comes from (e.g. "412 .ts files in tree", "package.json dependency typescript"). */
  evidence: z.array(z.string().min(1).max(300)).min(1).max(8),
});
export type RepositoryClaim = z.infer<typeof RepositoryClaim>;

export const RepositoryCommandPurpose = z.enum([
  "install", "dev", "build", "test", "lint", "typecheck", "format", "other",
]);
export type RepositoryCommandPurpose = z.infer<typeof RepositoryCommandPurpose>;

/** A command evidenced by a manifest/CI/build file — documentation, never an
 * instruction SkillForge itself executed. */
export const RepositoryCommand = z.object({
  purpose: RepositoryCommandPurpose,
  command: z.string().min(1).max(300),
  /** Where the command is defined (e.g. "package.json scripts.test", ".github/workflows/ci.yml:42"). */
  evidence: z.string().min(1).max(300),
});
export type RepositoryCommand = z.infer<typeof RepositoryCommand>;

export const RepositoryManifest = z.object({
  path: z.string().min(1).max(300),
  /** Manifest family (e.g. "package.json", "pyproject.toml", "lockfile"). */
  kind: z.string().min(1).max(80),
  /** Lockfiles inform ecosystem detection from tree metadata but are never fetched. */
  fetched: z.boolean(),
});
export type RepositoryManifest = z.infer<typeof RepositoryManifest>;

export const RepositoryStructure = z.object({
  sourceRoots: z.array(z.string().min(1).max(200)).max(16),
  testRoots: z.array(z.string().min(1).max(200)).max(16),
  exampleRoots: z.array(z.string().min(1).max(200)).max(16),
  /** Workspace/package directories (monorepo boundaries). */
  packages: z.array(z.string().min(1).max(200)).max(24),
});
export type RepositoryStructure = z.infer<typeof RepositoryStructure>;

export const RepositoryEntrypoint = z.object({
  path: z.string().min(1).max(300),
  reason: z.string().min(1).max(300),
});
export type RepositoryEntrypoint = z.infer<typeof RepositoryEntrypoint>;

export const RepositoryImportantFile = z.object({
  path: z.string().min(1).max(300),
  reason: z.string().min(1).max(300),
});
export type RepositoryImportantFile = z.infer<typeof RepositoryImportantFile>;

/** A repository convention statement, traceable to inspected instruction or
 * configuration files (never inferred from ecosystem general knowledge). */
export const RepositoryConvention = z.object({
  statement: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(4),
});
export type RepositoryConvention = z.infer<typeof RepositoryConvention>;

export const RepositoryPublicInterface = z.object({
  name: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(300),
  description: z.string().max(300).optional(),
});
export type RepositoryPublicInterface = z.infer<typeof RepositoryPublicInterface>;

export const RepositoryTesting = z.object({
  frameworks: z.array(z.string().min(1).max(80)).max(8),
  relevantFiles: z.array(z.string().min(1).max(300)).max(24),
});
export type RepositoryTesting = z.infer<typeof RepositoryTesting>;

/** How bounded the selection was — the honest-completeness record. */
export const RepositorySelectionStats = z.object({
  /** Eligible candidates after safety/eligibility filtering. */
  candidateCount: z.number().int().min(0),
  /** Files actually selected (and bounded) for deep analysis. */
  selectedCount: z.number().int().min(0),
  /** Blob entries present in the GitHub tree listing. */
  treeBlobCount: z.number().int().min(0),
  /** GitHub reported the recursive tree listing as truncated. */
  treeTruncated: z.boolean(),
});
export type RepositorySelectionStats = z.infer<typeof RepositorySelectionStats>;

/**
 * Structured repository analysis for GitHub codebase mode — the
 * repository-aware representation that feeds skill planning/generation.
 * Every strong claim carries evidence from inspected files or deterministic
 * repository metadata; `inspectedFiles` vs the tree distinguishes "read"
 * from "existed but not inspected".
 */
export const RepositoryAnalysis = z.object({
  repository: z.object({
    url: z.string().min(1).max(300),
    owner: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    ref: z.string().min(1).max(200),
    /** Subpath scope the analysis covers (e.g. "packages/a"); absent = whole
     * repository. All structured facts come from entries inside this scope. */
    scope: z.string().max(300).optional(),
  }),
  mode: z.literal("codebase"),
  languages: z.array(RepositoryClaim).max(12),
  ecosystems: z.array(z.string().min(1).max(80)).max(12),
  frameworks: z.array(RepositoryClaim).max(16),
  manifests: z.array(RepositoryManifest).max(24),
  commands: z.array(RepositoryCommand).max(30),
  structure: RepositoryStructure,
  entrypoints: z.array(RepositoryEntrypoint).max(12),
  importantFiles: z.array(RepositoryImportantFile).max(24),
  conventions: z.array(RepositoryConvention).max(20),
  publicInterfaces: z.array(RepositoryPublicInterface).max(16),
  testing: RepositoryTesting,
  /** Files whose content was fetched and inspected (bounded selection). */
  inspectedFiles: z.array(z.string().min(1).max(300)).max(200),
  selection: RepositorySelectionStats,
  /** What could not be inspected because of ingestion limits. */
  uncertainty: z.array(z.string().min(1).max(300)).max(12),
});
export type RepositoryAnalysis = z.infer<typeof RepositoryAnalysis>;

// ---------------------------------------------------------------------------
// Source / analysis types
// ---------------------------------------------------------------------------

export const SourceType = z.enum(["text", "sample", "file", "github", "github-codebase"]);
export type SourceType = z.infer<typeof SourceType>;

/**
 * Explicit GitHub source mode. "docs" is the existing documentation-first
 * ingestion; "codebase" analyzes the repository as a software project for
 * coding agents. The distinction is deliberate and surfaces in request
 * schemas, ingestion, analysis, UI, provenance, and tests.
 */
export const GithubSourceMode = z.enum(["docs", "codebase"]);
export type GithubSourceMode = z.infer<typeof GithubSourceMode>;

export const SourceInput = z.object({
  type: SourceType,
  /** Raw text for `text`; sample id for `sample`; file name for `file`. */
  name: z.string().min(1).max(200).default("source"),
  content: z.string().min(1),
  /** Ingestion notes from the source adapter (redirects, truncation, skipped
   * files, …). Merged into NormalizedSource.notes so they reach the manifest,
   * pipeline events, and the persisted record — truncation is never silent. */
  notes: z.array(z.string()).optional(),
  /** Structured repository analysis for `github-codebase` sources. Absent
   * for every other source type. */
  repository: RepositoryAnalysis.optional(),
});
export type SourceInput = z.infer<typeof SourceInput>;

export const NormalizedSource = z.object({
  text: z.string(),
  /** Total number of lines after normalization. */
  lineCount: z.number().int().min(1),
  /** sha256 of the normalized text; recorded in the manifest. */
  sha256: z.string(),
  originalName: z.string(),
  /** Canonical source type carried through for validation context. */
  sourceType: SourceType,
  /** Non-fatal problems found while normalizing (e.g. stripped HTML). */
  notes: z.array(z.string()),
  /** Structured repository analysis (codebase mode); otherwise undefined. */
  repository: RepositoryAnalysis.optional(),
});
export type NormalizedSource = z.infer<typeof NormalizedSource>;

export const CodeBlock = z.object({
  language: z.string(),
  code: z.string(),
  heading: z.string(),
  line: z.number().int().min(1),
});
export type CodeBlock = z.infer<typeof CodeBlock>;

export const DetectedCommand = z.object({
  raw: z.string(),
  heading: z.string(),
  line: z.number().int().min(1),
});
export type DetectedCommand = z.infer<typeof DetectedCommand>;

export const ProcedureStep = z.object({
  text: z.string(),
  line: z.number().int().min(1),
});
export type ProcedureStep = z.infer<typeof ProcedureStep>;

/** An ordered list with >= 3 steps found in the source: an executable workflow. */
export const Procedure = z.object({
  title: z.string(),
  steps: z.array(ProcedureStep).min(2),
  line: z.number().int().min(1),
});
export type Procedure = z.infer<typeof Procedure>;

export const Section = z.object({
  id: z.string(),
  heading: z.string(),
  level: z.number().int().min(1).max(6),
  /** 1-based inclusive line range in the normalized source. */
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  text: z.string(),
});
export type Section = z.infer<typeof Section>;

export const SourceAnalysis = z.object({
  title: z.string(),
  intro: z.string(),
  sections: z.array(Section),
  codeBlocks: z.array(CodeBlock),
  commands: z.array(DetectedCommand),
  procedures: z.array(Procedure),
  /** Section headings that look like constraints / warnings / troubleshooting. */
  constraintHeadings: z.array(z.string()),
  warningLines: z.array(z.string()),
  lineCount: z.number().int().min(1),
});
export type SourceAnalysis = z.infer<typeof SourceAnalysis>;

// ---------------------------------------------------------------------------
// Validation report
// ---------------------------------------------------------------------------

export const ValidationCheck = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pass", "fail", "warn", "skipped"]),
  severity: Severity.optional(),
  /** Which generated file (if any) the finding is about. */
  filePath: z.string().optional(),
  /** Actionable, human-readable explanation of the finding. */
  message: z.string().optional(),
});

export const ValidationReport = z.object({
  /** True only when every executed check passed (warnings allowed). */
  passed: z.boolean(),
  /** False when validation was skipped or aborted — UI must not claim success. */
  executed: z.boolean(),
  errorCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  checks: z.array(ValidationCheck),
  validatorVersion: z.string(),
});
export type ValidationReport = z.infer<typeof ValidationReport>;
export type ValidationCheck = z.infer<typeof ValidationCheck>;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const ExportTarget = z.enum(["claude-code", "generic"]);
export type ExportTarget = z.infer<typeof ExportTarget>;

export const ExportResult = z.object({
  target: ExportTarget,
  fileName: z.string(),
  /** Number of entries in the produced ZIP. */
  fileCount: z.number().int().min(1),
  bytes: z.number().int().min(1),
  /** Paths as written into the ZIP (post-sanitization). */
  entries: z.array(z.string()),
});
export type ExportResult = z.infer<typeof ExportResult>;
