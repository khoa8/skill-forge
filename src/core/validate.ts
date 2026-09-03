/**
 * Stage 4 — Deterministic validation.
 *
 * A pure registry of checks over the canonical package (optionally with the
 * original source text for grounding checks and an export target for
 * target-specific limits). No model calls: identical input always yields an
 * identical report. LLM review may supplement this elsewhere, but never
 * replaces it.
 *
 * `executed: false` in the report means validation did not run — the UI must
 * never present that state as success.
 */
import { parse as parseYaml } from "yaml";
import type {
  CanonicalSkill,
  ExportTarget,
  Severity,
  ValidationCheck,
  ValidationReport,
} from "./types.js";
import { safePackagePath } from "./util.js";

export const VALIDATOR_VERSION = "1.0.0";

export interface ValidateContext {
  skill: CanonicalSkill;
  /** Original normalized source text; enables grounding checks when present. */
  sourceText?: string;
  /** Validate against a specific export target's constraints. */
  target?: ExportTarget;
}

type OutcomeStatus = "pass" | "fail" | "warn";
export interface CheckOutcome {
  status: OutcomeStatus;
  filePath?: string;
  message?: string;
}
export interface Check {
  id: string;
  title: string;
  run(ctx: ValidateContext): CheckOutcome | CheckOutcome[];
}

const EXTRACTED_FILE_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const PLACEHOLDER_RE =
  /\b(TODO|FIXME|TBD|XXX|LOREM IPSUM)\b|<(?:placeholder|your[_-][a-z-]+|insert[^>]*>|\.\.\.)|your-api-key|API_KEY_HERE|\[\[.*\]\]/i;

function check(id: string, title: string, run: Check["run"]): Check {
  return { id, title, run };
}

function pass(): CheckOutcome {
  return { status: "pass" };
}
function fail(message: string, filePath?: string): CheckOutcome {
  return { status: "fail", message, filePath };
}
function warn(message: string, filePath?: string): CheckOutcome {
  return { status: "warn", message, filePath };
}

/** Split a markdown file into front matter + body (null when no front matter). */
export function splitFrontMatter(content: string): { fm: string; body: string } | null {
  const m = content.match(EXTRACTED_FILE_RE);
  if (!m) return null;
  return { fm: m[1]!, body: m[2] ?? "" };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const requiredFiles = check("required-files", "Required files present", ({ skill }) => {
  const paths = new Set(skill.files.map((f) => f.path));
  const outcomes: CheckOutcome[] = [];
  if (!paths.has("SKILL.md")) {
    outcomes.push(fail("SKILL.md is missing; every skill package requires it."));
  }
  if (!paths.has("manifest.json")) {
    outcomes.push(fail("manifest.json is missing; it documents source identity and file inventory."));
  }
  if (outcomes.length === 0) return pass();
  return outcomes;
});

const pathSafety = check("path-safety", "File paths are safe and unique", ({ skill }) => {
  const seen = new Map<string, number>();
  const outcomes: CheckOutcome[] = [];
  for (const file of skill.files) {
    const safe = safePackagePath(file.path);
    if (safe === null) {
      outcomes.push(fail(`File path "${file.path}" is unsafe (traversal, absolute, or malformed).`, file.path));
      continue;
    }
    if (safe !== file.path) {
      outcomes.push(fail(`File path "${file.path}" is not normalized (expected "${safe}").`, file.path));
    }
    const count = (seen.get(safe) ?? 0) + 1;
    seen.set(safe, count);
    if (count === 2) {
      outcomes.push(fail(`Duplicate file path "${safe}" appears multiple times in the package.`, safe));
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const emptyFiles = check("no-empty-files", "No ceremonial or empty files", ({ skill }) => {
  const outcomes: CheckOutcome[] = [];
  for (const file of skill.files) {
    const meaningful = file.content.replace(/\/\/[^\n]*/g, "").trim();
    if (file.path === "SKILL.md") continue;
    if (meaningful.length < 15) {
      outcomes.push(
        fail(
          `"${file.path}" has no meaningful content (${file.content.trim().length} chars). Empty generated files are not allowed.`,
          file.path,
        ),
      );
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const frontMatterParses = check("frontmatter-parse", "SKILL.md front matter is well-formed YAML", ({ skill }) => {
  const skillMd = skill.files.find((f) => f.path === "SKILL.md");
  if (!skillMd) return pass(); // covered by required-files
  const split = splitFrontMatter(skillMd.content);
  if (!split) {
    return fail('SKILL.md does not start with YAML front matter delimited by "---".', "SKILL.md");
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(split.fm);
  } catch (err) {
    return fail(
      `SKILL.md front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      "SKILL.md",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("SKILL.md front matter must be a YAML mapping with name and description.", "SKILL.md");
  }
  return pass();
});

const frontMatterFields = check("frontmatter-fields", "Front matter has valid name and description", ({ skill, target }) => {
  const skillMd = skill.files.find((f) => f.path === "SKILL.md");
  if (!skillMd) return pass();
  const split = splitFrontMatter(skillMd.content);
  if (!split) return pass(); // covered by frontmatter-parse
  let parsed: Record<string, unknown>;
  try {
    const v = parseYaml(split.fm);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return pass();
    parsed = v as Record<string, unknown>;
  } catch {
    return pass(); // covered by frontmatter-parse
  }

  const outcomes: CheckOutcome[] = [];
  const name = parsed.name;
  if (typeof name !== "string" || name.length === 0) {
    outcomes.push(fail("Front matter `name` is missing.", "SKILL.md"));
  } else {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      outcomes.push(
        fail(`Front matter \`name\` "${name}" must be lowercase letters, digits, and hyphens (no leading/trailing hyphen).`, "SKILL.md"),
      );
    }
    const maxName = target === "claude-code" ? 64 : 64;
    if (name.length > maxName) {
      outcomes.push(fail(`Front matter \`name\` exceeds ${maxName} characters (${name.length}).`, "SKILL.md"));
    }
  }

  const description = parsed.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    outcomes.push(fail("Front matter `description` is missing; agents use it to decide when to load the skill.", "SKILL.md"));
  } else if (description.length > 1024) {
    outcomes.push(
      warn(`Front matter \`description\` is ${description.length} characters; the recommended limit is 1024.`, "SKILL.md"),
    );
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const emptySections = check("no-empty-sections", "No empty markdown sections", ({ skill }) => {
  const outcomes: CheckOutcome[] = [];
  for (const file of skill.files) {
    if (!file.path.endsWith(".md") || file.path.endsWith(".json")) continue;
    const body = splitFrontMatter(file.content)?.body ?? file.content;
    const lines = body.split("\n");
    let currentHeading: { text: string; line: number; hasContent: boolean } | null = null;
    const flush = (outcomes: CheckOutcome[]) => {
      if (currentHeading && !currentHeading.hasContent) {
        outcomes.push(
          warn(
            `Heading "${currentHeading.text}" (${file.path}:${currentHeading.line}) has no content beneath it.`,
            file.path,
          ),
        );
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const h = line.match(HEADING_RE);
      if (h) {
        flush(outcomes);
        currentHeading = { text: h[2]!.trim(), line: i + 1, hasContent: false };
        continue;
      }
      if (currentHeading && line.trim().length > 0) {
        currentHeading.hasContent = true;
      }
    }
    flush(outcomes);
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const brokenLinks = check("internal-links", "Internal file references resolve", ({ skill }) => {
  const paths = new Set(skill.files.map((f) => f.path));
  const outcomes: CheckOutcome[] = [];
  for (const file of skill.files) {
    if (!file.path.endsWith(".md")) continue;
    const body = splitFrontMatter(file.content)?.body ?? file.content;
    for (const m of body.matchAll(MD_LINK_RE)) {
      const href = m[1]!;
      if (href.startsWith("#")) continue;
      if (/^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:")) continue;
      const clean = href.split("#")[0]!.trim();
      if (clean.length === 0) continue;
      if (!paths.has(clean)) {
        outcomes.push(
          fail(
            `Broken internal reference in ${file.path}: "${href}" does not match any file in the package.`,
            file.path,
          ),
        );
      }
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const jsonParses = check("json-parse", "JSON files parse", ({ skill }) => {
  const outcomes: CheckOutcome[] = [];
  for (const file of skill.files) {
    if (!file.path.endsWith(".json")) continue;
    try {
      JSON.parse(file.content);
    } catch (err) {
      outcomes.push(
        fail(`${file.path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, file.path),
      );
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const manifestConsistency = check("manifest-consistency", "Manifest matches package contents", ({ skill }) => {
  const manifestFile = skill.files.find((f) => f.path === "manifest.json");
  if (!manifestFile) return pass();
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestFile.content);
  } catch {
    return pass(); // json-parse already failed; avoid duplicate noise
  }
  const m = manifest as {
    schema?: string;
    source?: { sha256?: string; name?: string };
    files?: { path?: string; bytes?: number; sha256?: string }[];
    gaps?: unknown;
  };
  const outcomes: CheckOutcome[] = [];
  if (m.schema !== "skillforge.manifest/1") {
    outcomes.push(warn(`manifest.json has unrecognized schema "${String(m.schema)}".`, "manifest.json"));
  }
  const listed = new Map<string, { bytes?: number; sha256?: string }>();
  for (const f of m.files ?? []) {
    if (typeof f.path !== "string") continue;
    if (listed.has(f.path)) {
      outcomes.push(fail(`manifest.json lists "${f.path}" more than once.`, "manifest.json"));
    }
    listed.set(f.path, { bytes: f.bytes, sha256: f.sha256 });
  }
  const actual = new Set(skill.files.map((f) => f.path));
  for (const [path, info] of listed) {
    if (!actual.has(path)) {
      outcomes.push(fail(`manifest.json lists "${path}" but the file does not exist.`, "manifest.json"));
      continue;
    }
    const file = skill.files.find((f) => f.path === path)!;
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (typeof info.bytes === "number" && info.bytes !== bytes) {
      outcomes.push(fail(`manifest.json records ${info.bytes} bytes for "${path}" but the file is ${bytes}.`, "manifest.json"));
    }
  }
  for (const path of actual) {
    // manifest.json cannot list itself; only flag other unlisted files.
    if (path !== "manifest.json" && !listed.has(path)) {
      outcomes.push(fail(`File "${path}" exists in the package but is not listed in manifest.json.`, "manifest.json"));
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const placeholders = check("no-placeholders", "No suspicious placeholder text", ({ skill }) => {
  const outcomes: CheckOutcome[] = [];
  for (const file of skill.files) {
    if (file.path === "manifest.json") continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(PLACEHOLDER_RE);
      if (m) {
        outcomes.push(
          warn(
            `Possible placeholder "${m[0]}" at ${file.path}:${i + 1}. Generated packages must not ship unfinished markers.`,
            file.path,
          ),
        );
      }
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const duplicateEvalIds = check("duplicate-ids", "No duplicate identifiers", ({ skill }) => {
  const outcomes: CheckOutcome[] = [];
  const evalsFile = skill.files.find((f) => f.path === "evals/evals.json");
  if (evalsFile) {
    try {
      const parsed = JSON.parse(evalsFile.content) as { items?: { id?: string }[] };
      const seen = new Set<string>();
      for (const item of parsed.items ?? []) {
        const id = item.id;
        if (typeof id !== "string") continue;
        if (seen.has(id)) {
          outcomes.push(warn(`Duplicate eval id "${id}" in evals/evals.json.`, "evals/evals.json"));
        }
        seen.add(id);
      }
    } catch {
      // json-parse covers malformed JSON.
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const skillMdSize = check("skill-md-size", "SKILL.md stays within recommended size", ({ skill }) => {
  const skillMd = skill.files.find((f) => f.path === "SKILL.md");
  if (!skillMd) return pass();
  const words = skillMd.content.split(/\s+/).filter(Boolean).length;
  if (words > 5000) {
    return warn(
      `SKILL.md is ${words} words; the recommended guideline is ≤5000 so agents load it cheaply. Move detail into references/.`,
      "SKILL.md",
    );
  }
  return pass();
});

// Strengthened eval validation: eval ids must exist, be unique AND well-formed;
// every eval must carry a prompt and an expectation.
const evalIntegrity = check("eval-integrity", "Eval entries are complete and well-formed", ({ skill }) => {
  const evalsFile = skill.files.find((f) => f.path === "evals/evals.json");
  if (!evalsFile) return pass();
  let parsed: unknown;
  try {
    parsed = JSON.parse(evalsFile.content);
  } catch {
    return pass(); // json-parse covers malformed JSON.
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return warn("evals/evals.json has no `items` array; evals are not machine-usable.", "evals/evals.json");
  }
  const outcomes: CheckOutcome[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const rec = item as { id?: unknown; prompt?: unknown; expect?: unknown; kind?: unknown };
    const id = typeof rec.id === "string" ? rec.id : `(item ${index + 1})`;
    if (typeof rec.id === "string") {
      if (!/^eval-[a-z0-9-]+$/.test(rec.id)) {
        outcomes.push(warn(`Eval id "${rec.id}" does not follow the "eval-<slug>" convention.`, "evals/evals.json"));
      }
      if (seen.has(rec.id)) {
        outcomes.push(warn(`Duplicate eval id "${rec.id}" in evals/evals.json.`, "evals/evals.json"));
      }
      seen.add(rec.id);
    } else {
      outcomes.push(warn(`Eval item ${index + 1} is missing an id.`, "evals/evals.json"));
    }
    if (typeof rec.prompt !== "string" || rec.prompt.trim().length < 5) {
      outcomes.push(warn(`Eval "${id}" has no usable prompt.`, "evals/evals.json"));
    }
    if (typeof rec.expect !== "string" || rec.expect.trim().length < 5) {
      outcomes.push(warn(`Eval "${id}" has no usable expectation.`, "evals/evals.json"));
    }
    if (rec.kind !== undefined && !["grounding", "procedure"].includes(String(rec.kind))) {
      outcomes.push(warn(`Eval "${id}" has unknown kind "${String(rec.kind)}" (expected grounding or procedure).`, "evals/evals.json"));
    }
  });
  return outcomes.length === 0 ? pass() : outcomes;
});

// Provenance integrity: every file has a provenance record and the recorded
// line ranges are plausible.
const provenanceIntegrity = check("provenance-integrity", "Every file has valid provenance", ({ skill }) => {
  const outcomes: CheckOutcome[] = [];
  const byFile = new Map<string, number>();
  for (const p of skill.provenance) {
    byFile.set(p.filePath, (byFile.get(p.filePath) ?? 0) + 1);
    if (p.sourceLines[0] < 1 || p.sourceLines[1] < p.sourceLines[0]) {
      outcomes.push(
        fail(
          `Provenance for "${p.filePath}" has an invalid source line range ${JSON.stringify(p.sourceLines)}.`,
          p.filePath,
        ),
      );
    }
  }
  for (const file of skill.files) {
    if (!byFile.has(file.path)) {
      outcomes.push(
        warn(`File "${file.path}" has no provenance record; its origin in the source is not traceable.`, file.path),
      );
    }
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const groundingCheck: Check = {
  id: "grounding-commands",
  title: "Shell commands in generated files appear in the source",
  run({ skill, sourceText }) {
    if (sourceText === undefined) {
      return {
        status: "warn",
        message: "Source text unavailable; grounding of commands could not be verified. This check was skipped, not passed.",
      };
    }
    const srcLines = new Set(
      sourceText
        .split("\n")
        .map((l) => l.replace(/^\s*(?:\$\s|>\s)/, "").trim())
        .filter((l) => l.length > 0),
    );
    const srcFragments = new Set<string>();
    for (const line of srcLines) {
      for (const token of line.split(/\s+/)) {
        if (token.length >= 3) srcFragments.add(token.toLowerCase());
      }
    }
    const outcomes: CheckOutcome[] = [];
    for (const file of skill.files) {
      if (!file.path.endsWith(".md") || file.path.startsWith("references/")) continue;
      let inFence = false;
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*(`{3,}|~{3,})/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (!inFence) continue;
        const stripped = line.replace(/^\s*(?:\$\s|>\s)/, "").trim();
        if (stripped.length === 0 || stripped.startsWith("#")) continue;
        if (file.path.startsWith("workflows/") || file.path === "SKILL.md") {
          // Verbatim workflow fences come from the source; only check SKILL.md inline fences here.
        }
        const tokens = stripped.split(/\s+/).filter((t) => t.length >= 3 && /^[a-zA-Z0-9._/@+=-]+$/.test(t));
        const unknown = tokens.filter((t) => !srcFragments.has(t.toLowerCase()) && !/^\$[A-Z_]+$/.test(t));
        // A fence line is considered grounded when at least half its tokens exist in the source.
        if (tokens.length >= 2 && unknown.length > tokens.length / 2) {
          outcomes.push(
            warn(
              `Command at ${file.path}:${i + 1} ("${stripped.slice(0, 80)}") shares few tokens with the source; verify it is not hallucinated.`,
              file.path,
            ),
          );
        }
      }
    }
    return outcomes.length === 0 ? pass() : outcomes;
  },
};

const exportTargetKnown = check("export-target", "Export target is supported", ({ target }) => {
  if (target === undefined) return pass();
  const supported: ExportTarget[] = ["claude-code", "generic"];
  if (!supported.includes(target)) {
    return fail(`Unsupported export target "${String(target)}". Supported: ${supported.join(", ")}.`);
  }
  return pass();
});

export const CHECKS: Check[] = [
  exportTargetKnown,
  requiredFiles,
  pathSafety,
  emptyFiles,
  frontMatterParses,
  frontMatterFields,
  emptySections,
  brokenLinks,
  jsonParses,
  manifestConsistency,
  placeholders,
  duplicateEvalIds,
  evalIntegrity,
  provenanceIntegrity,
  skillMdSize,
  groundingCheck,
];

function severityFor(status: OutcomeStatus, checkId: string): Severity | undefined {
  if (status === "pass") return undefined;
  if (status === "fail") return "error";
  // Warnings in structural checks are more serious than stylistic ones.
  if (checkId === "no-placeholders" || checkId === "grounding-commands" || checkId === "skill-md-size") {
    return "warning";
  }
  return "warning";
}

export function validatePackage(ctx: ValidateContext): ValidationReport {
  const checks: ValidationCheck[] = [];
  for (const c of CHECKS) {
    let outcomes: CheckOutcome[];
    try {
      const result = c.run(ctx);
      outcomes = Array.isArray(result) ? result : [result];
    } catch (err) {
      outcomes = [
        {
          status: "fail",
          message: `Validator check "${c.id}" itself errored: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
    if (outcomes.length === 0) {
      checks.push({ id: c.id, title: c.title, status: "pass" });
      continue;
    }
    const hasFail = outcomes.some((o) => o.status === "fail");
    const hasWarn = outcomes.some((o) => o.status === "warn");
    if (!hasFail && !hasWarn) {
      checks.push({ id: c.id, title: c.title, status: "pass" });
      continue;
    }
    for (const o of outcomes) {
      if (o.status === "pass") continue;
      checks.push({
        id: c.id,
        title: c.title,
        status: o.status === "fail" ? "fail" : "warn",
        severity: severityFor(o.status, c.id),
        filePath: o.filePath,
        message: o.message,
      });
    }
  }

  const executed = true;
  const errorCount = checks.filter((c) => c.status === "fail").length;
  const warningCount = checks.filter((c) => c.status === "warn").length;
  return {
    passed: errorCount === 0,
    executed,
    errorCount,
    warningCount,
    checks,
    validatorVersion: VALIDATOR_VERSION,
  };
}

/** Report used when validation was skipped — explicitly not-success. */
export function skippedValidationReport(reason: string): ValidationReport {
  return {
    passed: false,
    executed: false,
    errorCount: 0,
    warningCount: 0,
    checks: [{ id: "validation", title: "Deterministic validation", status: "skipped", message: reason }],
    validatorVersion: VALIDATOR_VERSION,
  };
}
