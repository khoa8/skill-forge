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
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  CanonicalSkill,
  Severity,
  SourceType,
  ValidationCheck,
  ValidationReport,
} from "./types.js";
import { ExportTarget } from "./types.js";
import { safePackagePath, sha256, slugify } from "./util.js";

export const VALIDATOR_VERSION = "1.0.0";

export interface ValidateContext {
  skill: CanonicalSkill;
  /** Original normalized source text; enables grounding checks when present. */
  sourceText?: string;
  /** Validate against a specific export target's constraints. */
  target?: ExportTarget;
  /** The canonical source type the package was generated from. When
   * "github-codebase", repository provenance in manifest.json is REQUIRED —
   * edits must not silently strip it (P1-4). */
  sourceType?: SourceType;
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

const frontMatterFields = check("frontmatter-fields", "Front matter has valid name and description", ({ skill }) => {
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
    // Canonical SkillForge v1 policy (unchanged for every export target):
    // Claude Code local skills may omit `name`, but SkillForge does not emit
    // that broader subset.
    if (name.length > 64) {
      outcomes.push(fail(`Front matter \`name\` exceeds 64 characters (${name.length}).`, "SKILL.md"));
    }
  }

  const description = parsed.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    outcomes.push(fail("Front matter `description` is missing; agents use it to decide when to load the skill.", "SKILL.md"));
  } else if (description.length > 1024) {
    // Canonical guidance only: a recommendation, never a target-specific hard
    // error. Local Claude Code truncates long listing text; it does not
    // reject it, so no target upgrades this warning to a failure.
    outcomes.push(
      warn(`Front matter \`description\` is ${description.length} characters; the recommended limit is 1024.`, "SKILL.md"),
    );
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

const requiredSkillSections = check("skill-instructions", "SKILL.md contains canonical instructions", ({ skill }) => {
  const file = skill.files.find((f) => f.path === "SKILL.md");
  const split = file && splitFrontMatter(file.content);
  if (!split) return pass(); // frontmatter-parse owns malformed front matter
  try {
    const fm = parseYaml(split.fm);
    if (!fm || typeof fm !== "object" || Array.isArray(fm)) return pass();
  } catch { return pass(); }
  const required = ["When to use this skill", "Inputs required", "Workflow", "Constraints",
    "Verification", "Common pitfalls", "References"];
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  let fence: { marker: string; length: number } | undefined;
  for (const line of split.body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length &&
          line.slice(delimiter[0].length).trim() === "") fence = undefined;
      else if (current) sections.get(current)!.push(line);
      continue;
    }
    if (delimiter) { fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length }; continue; }
    const heading = line.match(HEADING_RE);
    if (heading && heading[1]!.length <= 2) {
      current = heading[1]!.length === 2 ? heading[2]!.toLowerCase() : undefined;
      if (current && !sections.has(current)) sections.set(current, []);
    } else if (current && !heading) sections.get(current)!.push(line);
  }
  const missing = required.filter((heading) => !sections.has(heading.toLowerCase()));
  if (missing.length) return fail(`SKILL.md is missing required instruction sections: ${missing.join(", ")}.`, "SKILL.md");
  const empty = required.filter((heading) => !/[\p{L}\p{N}]/u.test(sections.get(heading.toLowerCase())!.join("\n")));
  return empty.length
    ? fail(`SKILL.md has empty instruction sections: ${empty.join(", ")}. Add instructions or an explicit source gap.`, "SKILL.md")
    : pass();
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
    const dir = posix.dirname(file.path);
    for (const m of body.matchAll(MD_LINK_RE)) {
      const href = m[1]!;
      if (href.startsWith("#")) continue;
      if (/^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:")) continue;
      const clean = href.split("#")[0]!.trim();
      if (clean.length === 0) continue;

      const target = clean.startsWith("/") ? clean.slice(1) : posix.join(dir, clean);
      const normalized = posix.normalize(target);
      const safe = safePackagePath(normalized);
      if (safe === null || normalized === ".." || normalized.startsWith("../")) {
        outcomes.push(
          fail(
            `Broken internal reference in ${file.path}: "${href}" escapes the skill package root.`,
            file.path,
          ),
        );
        continue;
      }
      if (!paths.has(safe)) {
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

const manifestConsistency = check("manifest-consistency", "Manifest matches package contents", ({ skill, sourceText }) => {
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
    source?: { sha256?: unknown; name?: unknown };
    files?: unknown;
    gaps?: unknown;
  };
  const outcomes: CheckOutcome[] = [];
  if (m.schema !== "skillforge.manifest/1") {
    outcomes.push(warn(`manifest.json has unrecognized schema "${String(m.schema)}".`, "manifest.json"));
  }

  // --- Source hash validation
  const sourceInfo = m.source;
  if (!sourceInfo || typeof sourceInfo !== "object" || Array.isArray(sourceInfo)) {
    outcomes.push(fail("manifest.json is missing the required `source` object.", "manifest.json"));
  } else {
    const srcSha = sourceInfo.sha256;
    if (typeof srcSha !== "string" || !/^[a-f0-9]{64}$/.test(srcSha)) {
      outcomes.push(
        fail(
          `manifest.json source.sha256 (${JSON.stringify(srcSha ?? null)}) is missing or not a 64-character lowercase hex string.`,
          "manifest.json",
        ),
      );
    } else if (sourceText !== undefined) {
      const expectedSourceHash = sha256(sourceText);
      if (srcSha !== expectedSourceHash) {
        outcomes.push(
          fail(
            `manifest.json source.sha256 "${srcSha}" does not match the SHA-256 of the normalized source text ("${expectedSourceHash}").`,
            "manifest.json",
          ),
        );
      }
    } else {
      outcomes.push(
        warn(
          "Source text unavailable; manifest.source.sha256 could not be verified against source text. This check was skipped, not passed.",
          "manifest.json",
        ),
      );
    }
  }

  // --- Files array validation
  if (!Array.isArray(m.files)) {
    outcomes.push(fail("manifest.json `files` is missing or not an array.", "manifest.json"));
    return outcomes;
  }

  const listed = new Map<string, { bytes: number; sha256: string; userEdited?: boolean }>();
  for (const f of m.files as { path?: unknown; bytes?: unknown; sha256?: unknown }[]) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      outcomes.push(fail("manifest.json `files` contains a non-object entry.", "manifest.json"));
      continue;
    }
    const path = f.path;
    if (typeof path !== "string" || path.trim().length === 0) {
      outcomes.push(fail("manifest.json file entry is missing a valid `path`.", "manifest.json"));
      continue;
    }
    if (path === "manifest.json") {
      outcomes.push(fail("manifest.json cannot list itself in `files`.", "manifest.json"));
      continue;
    }
    const safe = safePackagePath(path);
    if (safe === null || safe !== path) {
      outcomes.push(fail(`manifest.json lists unsafe or non-normalized file path "${path}".`, "manifest.json"));
    }
    if (listed.has(path)) {
      outcomes.push(fail(`manifest.json lists "${path}" more than once.`, "manifest.json"));
      continue;
    }

    let validEntry = true;
    if (typeof f.bytes !== "number" || !Number.isInteger(f.bytes) || f.bytes < 0) {
      outcomes.push(
        fail(
          `manifest.json records invalid bytes for "${path}" (expected non-negative integer, got ${JSON.stringify(f.bytes ?? null)}).`,
          "manifest.json",
        ),
      );
      validEntry = false;
    }

    if (typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) {
      outcomes.push(
        fail(
          `manifest.json records invalid sha256 for "${path}" (expected 64-character lowercase hex, got ${JSON.stringify(f.sha256 ?? null)}).`,
          "manifest.json",
        ),
      );
      validEntry = false;
    }

    const userEditedRaw = (f as { userEdited?: unknown }).userEdited;
    let userEdited: boolean | undefined = undefined;
    if (userEditedRaw !== undefined) {
      if (typeof userEditedRaw !== "boolean") {
        outcomes.push(
          fail(
            `manifest.json records invalid userEdited for "${path}" (expected boolean, got ${JSON.stringify(userEditedRaw)}).`,
            "manifest.json",
          ),
        );
        validEntry = false;
      } else {
        userEdited = userEditedRaw;
      }
    }

    if (validEntry) {
      listed.set(path, { bytes: f.bytes as number, sha256: f.sha256 as string, userEdited });
    }
  }

  const actual = new Set(skill.files.map((f) => f.path));
  for (const [path, info] of listed) {
    if (!actual.has(path)) {
      outcomes.push(fail(`manifest.json lists "${path}" but the file does not exist.`, "manifest.json"));
      continue;
    }
    const file = skill.files.find((f) => f.path === path)!;
    const actualBytes = Buffer.byteLength(file.content, "utf8");
    if (info.bytes !== actualBytes) {
      outcomes.push(fail(`manifest.json records ${info.bytes} bytes for "${path}" but the file is ${actualBytes}.`, "manifest.json"));
    }
    const actualHash = sha256(file.content);
    if (info.sha256 !== actualHash) {
      outcomes.push(fail(`manifest.json records sha256 "${info.sha256}" for "${path}" but the file hash is "${actualHash}".`, "manifest.json"));
    }
    const manifestEdited = info.userEdited === true;
    const fileEdited = file.userEdited === true;
    if (manifestEdited !== fileEdited) {
      outcomes.push(
        fail(
          `manifest.json userEdited state (${manifestEdited}) disagrees with package file userEdited state (${fileEdited}) for "${path}".`,
          "manifest.json",
        ),
      );
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
    if (file.userEdited && byFile.has(file.path)) {
      outcomes.push(
        fail(`User-edited file "${file.path}" must not retain source provenance records.`, file.path),
      );
      continue;
    }
    if (file.userEdited === true) continue; // Intentional absence, not unknown origin.
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
  const supported = ExportTarget.options;
  if (!supported.includes(target)) {
    return fail(`Unsupported export target "${String(target)}". Supported: ${supported.join(", ")}.`);
  }
  return pass();
});

// Canonical metadata consistency: SKILL.md front matter and manifest.json
// must agree with skill.meta — the canonical package identity. Users may edit
// instructional body text, but a front-matter `name` that contradicts
// skill.meta.name would silently re-brand the package (skill id, export
// folder, manifest) — that inconsistency must fail validation, not export.
const canonicalMetadataConsistency = check(
  "canonical-metadata-consistency",
  "Canonical metadata is internally consistent",
  ({ skill }) => {
    const outcomes: CheckOutcome[] = [];
    const skillMd = skill.files.find((f) => f.path === "SKILL.md");
    const manifestFile = skill.files.find((f) => f.path === "manifest.json");

    // --- SKILL.md front matter vs skill.meta
    if (skillMd) {
      const split = splitFrontMatter(skillMd.content);
      let fmName: unknown;
      if (split) {
        try {
          const parsed = parseYaml(split.fm);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            fmName = (parsed as Record<string, unknown>).name;
          }
        } catch {
          // covered by frontmatter-parse; no duplicate finding here
        }
      }
      if (typeof fmName === "string" && fmName !== skill.meta.name) {
        outcomes.push(
          fail(
            `SKILL.md front matter \`name: ${fmName}\` contradicts the canonical skill name "${skill.meta.name}". Body text is editable; canonical identity is not. Restore name: ${skill.meta.name} (or regenerate the skill).`,
            "SKILL.md",
          ),
        );
      }
    }

    // --- manifest.json identity fields vs skill.meta
    if (manifestFile) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(manifestFile.content);
      } catch {
        // covered by json-parse / manifest-consistency; no duplicate finding
        manifest = null;
      }
      if (manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)) {
        const m = manifest as Record<string, unknown>;
        const expect: [string, unknown][] = [
          ["name", skill.meta.name],
          ["displayName", skill.meta.displayName],
          ["description", skill.meta.description],
          ["version", skill.meta.version],
          ["generator", skill.meta.generator],
        ];
        for (const [field, canonical] of expect) {
          if (m[field] !== canonical) {
            outcomes.push(
              fail(
                `manifest.json \`${field}\` (${JSON.stringify(m[field] ?? null)}) does not match the canonical metadata (${JSON.stringify(canonical ?? null)}).`,
                "manifest.json",
              ),
            );
          }
        }
      }
    }

    return outcomes.length === 0 ? pass() : outcomes;
  },
);

// Claude Code local-skill constraints: additive target validation for
// `target === "claude-code"` only. Canonical validation always runs first and
// remains mandatory — SkillForge intentionally exports a stricter
// canonical-valid subset of what Claude Code loads locally (Claude Code
// permits `name`/`description` to be optional with body fallback; SkillForge
// canonical v1 still requires them). This check adds only real local Claude
// Code requirements: the `compatibility` type/limit and the reserved `synced`
// folder name. Upload/API-only rules (Agent Skills six-field allowlist,
// description hard limits, angle-bracket bans, `claude`/`anthropic` name
// bans) are not local Claude Code requirements and are not enforced here.
const claudeCodeLocalConstraints = check(
  "claude-code-local",
  "Claude Code local-skill constraints",
  ({ skill, target }) => {
    if (target !== "claude-code") return pass();
    const outcomes: CheckOutcome[] = [];
    const skillMd = skill.files.find((f) => f.path === "SKILL.md");
    const split = skillMd && splitFrontMatter(skillMd.content);
    if (split) {
      let parsed: Record<string, unknown> | null = null;
      try {
        const v = parseYaml(split.fm);
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          parsed = v as Record<string, unknown>;
        }
      } catch {
        // Malformed front matter is owned by frontmatter-parse; no duplicate finding here.
      }
      if (parsed && "compatibility" in parsed) {
        // Local Claude Code accepts `compatibility` but does not act on it:
        // absent or a string of at most 500 characters is valid.
        const compatibility = parsed.compatibility;
        if (typeof compatibility !== "string") {
          outcomes.push(
            fail("Front matter `compatibility` must be a string of at most 500 characters for claude-code.", "SKILL.md"),
          );
        } else if (compatibility.length > 500) {
          outcomes.push(
            fail(`Front matter \`compatibility\` is ${compatibility.length} characters; the claude-code limit is 500.`, "SKILL.md"),
          );
        }
      }
    }
    // The exported skill folder derives from canonical identity. Claude Code
    // reserves the local folder name `synced` (any capitalization) for skills
    // downloaded from claude.ai and skips an authored skill using that name.
    if (slugify(skill.meta.name, 48) === "synced") {
      outcomes.push(
        fail(`Skill folder "${skill.meta.name}" is reserved for claude-code: the local folder name "synced" (any capitalization) is used for skills synced from claude.ai.`, "SKILL.md"),
      );
    }
    return outcomes.length === 0 ? pass() : outcomes;
  },
);

// Repository provenance (codebase mode). Two layers:
// 1. A manifest that DECLARES a source.repository block must be internally
//    consistent (mode, counts, unique inspected files).
// 2. A package generated from a github-codebase source MUST declare the
//    block at all — a codebase package silently losing its repository
//    provenance (e.g. through edit/regeneration) is an error, not a pass.
const repositoryProvenance = check("repository-provenance", "Repository provenance is present and consistent", ({ skill, sourceType }) => {
  const manifestFile = skill.files.find((f) => f.path === "manifest.json");
  if (!manifestFile) return pass();
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestFile.content);
  } catch {
    return pass(); // json-parse already failed; avoid duplicate noise
  }
  const repo = (manifest as { source?: { repository?: unknown } })?.source?.repository;
  if (repo === undefined || repo === null) {
    if (sourceType === "github-codebase") {
      return fail(
        'This skill was generated from a github-codebase source, but manifest.json has no source.repository provenance. Repository provenance must survive edits and regeneration.',
        "manifest.json",
      );
    }
    return pass();
  }
  if (typeof repo !== "object" || Array.isArray(repo)) {
    return fail("manifest.json source.repository is present but malformed.", "manifest.json");
  }
  const r = repo as Record<string, unknown>;
  const outcomes: CheckOutcome[] = [];
  for (const field of ["url", "owner", "name", "ref", "mode"]) {
    if (typeof r[field] !== "string" || (r[field] as string).length === 0) {
      outcomes.push(fail(`manifest.json source.repository.${field} is missing or not a non-empty string.`, "manifest.json"));
    }
  }
  if (typeof r.mode === "string" && r.mode !== "codebase") {
    outcomes.push(fail(`manifest.json source.repository.mode must be "codebase" (got "${r.mode}").`, "manifest.json"));
  }
  if (!Array.isArray(r.inspectedFiles)) {
    outcomes.push(fail("manifest.json source.repository.inspectedFiles must be an array of inspected file paths.", "manifest.json"));
  } else {
    if (r.inspectedFiles.length === 0) {
      outcomes.push(warn("manifest.json source.repository.inspectedFiles is empty; no repository files were recorded as inspected.", "manifest.json"));
    }
    const seen = new Set<string>();
    for (const p of r.inspectedFiles) {
      if (typeof p !== "string") {
        outcomes.push(fail("manifest.json source.repository.inspectedFiles contains a non-string entry.", "manifest.json"));
        break;
      }
      if (seen.has(p)) {
        outcomes.push(fail(`manifest.json source.repository.inspectedFiles contains duplicate entry "${p}".`, "manifest.json"));
        break;
      }
      seen.add(p);
    }
  }
  // Required count fields (re-audit P2-3): for a codebase manifest the
  // boundedness record is mandatory, not optional — a missing field fails,
  // it does not silently skip the consistency rules.
  for (const [field, type] of [
    ["treeBlobCount", "number"],
    ["candidateCount", "number"],
    ["selectedCount", "number"],
  ] as const) {
    const v = r[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      outcomes.push(
        fail(
          `manifest.json source.repository.${field} is required and must be a non-negative integer (got ${JSON.stringify(v ?? null)}).`,
          "manifest.json",
        ),
      );
    }
  }
  if (typeof r.treeTruncated !== "boolean") {
    outcomes.push(fail("manifest.json source.repository.treeTruncated is required and must be a boolean.", "manifest.json"));
  }
  if (!Array.isArray(r.inspectedFiles)) {
    outcomes.push(fail("manifest.json source.repository.inspectedFiles is required and must be an array.", "manifest.json"));
  }

  // Count consistency: selectedCount is the actually-inspected count.
  const numeric = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (numeric(r.selectedCount) && Array.isArray(r.inspectedFiles) && r.selectedCount !== r.inspectedFiles.length) {
    outcomes.push(
      fail(
        `manifest.json source.repository.selectedCount (${r.selectedCount}) does not match inspectedFiles.length (${r.inspectedFiles.length}).`,
        "manifest.json",
      ),
    );
  }
  if (numeric(r.candidateCount) && numeric(r.selectedCount) && r.candidateCount < r.selectedCount) {
    outcomes.push(
      fail(`manifest.json source.repository.candidateCount (${r.candidateCount}) is smaller than selectedCount (${r.selectedCount}).`, "manifest.json"),
    );
  }
  if (numeric(r.treeBlobCount) && numeric(r.candidateCount) && r.treeBlobCount < r.candidateCount) {
    outcomes.push(
      fail(`manifest.json source.repository.treeBlobCount (${r.treeBlobCount}) is smaller than candidateCount (${r.candidateCount}).`, "manifest.json"),
    );
  }
  return outcomes.length === 0 ? pass() : outcomes;
});

export const CHECKS: Check[] = [
  exportTargetKnown,
  requiredFiles,
  pathSafety,
  emptyFiles,
  frontMatterParses,
  frontMatterFields,
  requiredSkillSections,
  canonicalMetadataConsistency,
  claudeCodeLocalConstraints,
  emptySections,
  brokenLinks,
  jsonParses,
  manifestConsistency,
  repositoryProvenance,
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
