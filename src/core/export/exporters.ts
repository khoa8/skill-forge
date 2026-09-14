/**
 * Stage 5/6 — Exporters (vendor adapters) and ZIP packaging.
 *
 * Exporters translate the canonical skill package into a specific agent
 * ecosystem's layout. They are the ONLY place vendor differences live; the
 * generation pipeline never branches per vendor. Each exporter documents what
 * it verified the output against, and unsupported targets are refused.
 */
import JSZip from "jszip";
import { parse as parseYaml } from "yaml";
import type { CanonicalSkill, ExportTarget, SkillFile } from "../types.js";
import { joinPackagePath, safePackagePath, sha256, slugify } from "../util.js";

export interface ExporterInfo {
  target: ExportTarget;
  label: string;
  description: string;
  /** What the output format was checked against — honesty requirement. */
  formatBasis: string;
}

export interface ExportedPackage {
  target: ExportTarget;
  skillName: string;
  files: SkillFile[];
  /** Deterministic notes surfaced in the UI (what the exporter changed). */
  notes: string[];
}

export class ExportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

/** Regenerate manifest.json so it lists exporter-added files too. */
function rebuildManifest(
  baseManifest: string | undefined,
  files: SkillFile[],
  extraNotes: string[],
): SkillFile | null {
  if (!baseManifest) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(baseManifest) as Record<string, unknown>;
  } catch {
    return null;
  }
  const entries = files
    .filter((f) => f.path !== "manifest.json")
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({
      path: f.path,
      bytes: Buffer.byteLength(f.content, "utf8"),
      sha256: sha256(f.content),
      ...(f.userEdited ? { userEdited: true } : {}),
    }));
  const updated = {
    ...manifest,
    exportNotes: extraNotes,
    files: entries,
  };
  return {
    path: "manifest.json",
    content: JSON.stringify(updated, null, 2) + "\n",
    purpose: "Machine-readable package manifest: source identity, gap list, file inventory with hashes.",
  };
}

function withFiles(base: CanonicalSkill, added: SkillFile[], notes: string[]): SkillFile[] {
  const baseManifest = base.files.find((f) => f.path === "manifest.json")?.content;
  const files = base.files.filter((f) => f.path !== "manifest.json").concat(added);
  const manifest = rebuildManifest(baseManifest, files, notes);
  if (manifest) files.push(manifest);
  return files;
}

// ---------------------------------------------------------------------------
// claude-code exporter — Anthropic Agent Skills layout (skill folder with
// SKILL.md carrying `name`/`description` YAML front matter, plus supporting
// files). Format basis: the Agent Skills documented format (name ≤64 chars,
// lowercase-hyphen slug; description ≤1024 chars).
// ---------------------------------------------------------------------------

function exportClaudeCode(skill: CanonicalSkill): ExportedPackage {
  const notes: string[] = [];
  const skillMd = skill.files.find((f) => f.path === "SKILL.md");
  if (!skillMd) throw new ExportError("Cannot export without SKILL.md.", "export_missing_skill_md");

  // Enforce claude-code front matter constraints (name/description live in SKILL.md).
  const fm = skillMd.content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) {
    throw new ExportError("SKILL.md is missing YAML front matter; cannot export to claude-code.", "export_bad_frontmatter");
  }

  let parsed: Record<string, unknown>;
  try {
    const v = parseYaml(fm[1]!);
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new ExportError("SKILL.md front matter is not a valid YAML object; cannot export to claude-code.", "export_bad_frontmatter");
    }
    parsed = v as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ExportError) throw err;
    throw new ExportError(`SKILL.md has invalid YAML front matter: ${err instanceof Error ? err.message : String(err)}`, "export_bad_frontmatter");
  }

  const nameOk = typeof parsed.name === "string" && parsed.name === skill.meta.name;
  const description = typeof parsed.description === "string" && parsed.description.trim().length > 0
    ? parsed.description : skill.meta.description;
  if (description.length > 1024) {
    throw new ExportError("Description exceeds the claude-code 1024-character limit.", "export_description_too_long");
  }
  let files = skill.files;
  if (!nameOk) {
    notes.push("Front matter `name` did not match the package id; exporter rewrote it.");
    files = skill.files.map((f) => {
      if (f.path !== "SKILL.md") return f;
      const content = f.content.replace(
        /^---\n[\s\S]*?\n---/,
        `---\nname: ${skill.meta.name}\ndescription: ${JSON.stringify(description)}\n---`,
      );
      return { ...f, content };
    });
    const baseManifest = skill.files.find((f) => f.path === "manifest.json")?.content;
    const resyncedManifest = rebuildManifest(baseManifest, files, notes);
    if (resyncedManifest) {
      files = files.filter((f) => f.path !== "manifest.json").concat(resyncedManifest);
    }
  }
  if (skill.meta.name.length > 64) {
    throw new ExportError(
      `Skill name "${skill.meta.name}" exceeds the claude-code 64-character limit.`,
      "export_name_too_long",
    );
  }
  return {
    target: "claude-code",
    skillName: skill.meta.name,
    files,
    notes,
  };
}

// Codex uses the canonical directory layout. Check the official skill-creator
// contract without rewriting user content or inventing optional openai.yaml.
function exportOpenaiCodex(skill: CanonicalSkill): ExportedPackage {
  const invalid = (message: string): never => {
    throw new ExportError(`Cannot export to openai-codex: ${message}`, "export_codex_metadata_invalid");
  };
  const skillMd = skill.files.find((f) => f.path === "SKILL.md");
  const fm = skillMd?.content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fm) return invalid("SKILL.md requires YAML front matter with name and description.");
  let value: unknown;
  try {
    value = parseYaml(fm[1]!);
  } catch {
    return invalid("SKILL.md front matter must be valid YAML with unique keys.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("SKILL.md front matter must be a YAML mapping.");
  }
  const metadata = value as Record<string, unknown>;
  const allowed = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
  if (Object.keys(metadata).some((key) => !allowed.has(key))) {
    return invalid("Supported front matter keys are name, description, license, allowed-tools, metadata.");
  }
  const { name, description } = metadata;
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return invalid("name must be a lowercase letters/digits slug of 1–64 characters, with single internal hyphens.");
  }
  if (name !== skill.meta.name) return invalid("Front matter name must match the canonical package name.");
  if (typeof description !== "string" || !description.trim() || [...description.trim()].length > 1024 || /[<>]/.test(description)) {
    return invalid("description must be non-empty, at most 1024 characters, and contain no angle brackets.");
  }
  // No file transformation: preserve manifest hashes, edits, provenance and order.
  return { target: "openai-codex", skillName: skill.meta.name, files: skill.files, notes: [] };
}

// ---------------------------------------------------------------------------
// generic exporter — ecosystem-neutral package following the AGENTS.md
// convention: an AGENTS.md wrapper that tells any agent how to use the skill,
// next to the canonical SKILL.md and supporting files.
// ---------------------------------------------------------------------------

function exportGeneric(skill: CanonicalSkill): ExportedPackage {
  const agentsMd = ([
    `# AGENTS.md — ${skill.meta.displayName}`,
    "",
    "> Generated by SkillForge. This file orients agents; `SKILL.md` is the authoritative skill definition.",
    "",
    "## How to use this skill",
    "",
    "Read `SKILL.md` and follow the workflow documented there. `SKILL.md` contains the authoritative purpose, inputs, workflow steps, constraints, and verification procedures for this skill.",
    "",
    "## Where to look",
    "",
    "- `SKILL.md` — authoritative instructions: when to use, inputs, workflow, constraints, verification, pitfalls.",
    skill.files.some((f) => f.path.startsWith("references/"))
      ? "- `references/` — reference material; consult each file and manifest.json for provenance and userEdited status."
      : null,
    skill.files.some((f) => f.path.startsWith("workflows/"))
      ? "- `workflows/` — workflow material; consult each file and manifest.json for provenance and userEdited status."
      : null,
    skill.files.some((f) => f.path.startsWith("examples/"))
      ? "- `examples/` — example material; consult each file and manifest.json for provenance and userEdited status."
      : null,
    "- `manifest.json` — source identity, gap list, file inventory with hashes.",
    "",
  ] as (string | null)[]).filter((l) => l !== null).join("\n");

  const agentsFile: SkillFile = {
    path: "AGENTS.md",
    content: agentsMd,
    purpose: "Agent-orientation wrapper for ecosystems that read AGENTS.md.",
  };

  return {
    target: "generic",
    skillName: skill.meta.name,
    files: withFiles(skill, [agentsFile], ["Added AGENTS.md wrapper for generic agent ecosystems."]),
    notes: ["Added AGENTS.md wrapper for generic agent ecosystems."],
  };
}

// ---------------------------------------------------------------------------
// Registry + ZIP
// ---------------------------------------------------------------------------

export const EXPORTERS: Record<ExportTarget, (skill: CanonicalSkill) => ExportedPackage> = {
  "claude-code": exportClaudeCode,
  generic: exportGeneric,
  "openai-codex": exportOpenaiCodex,
};

export const EXPORT_TARGET_INFO: ExporterInfo[] = [
  {
    target: "openai-codex",
    label: "OpenAI Codex",
    description: "Skill folder with SKILL.md and all canonical supporting files. Optional OpenAI UI metadata is omitted.",
    formatBasis: "OpenAI Build skills documentation and openai/skills skill-creator validator: required name/description YAML front matter. Package structure checked by exporter tests; Codex runtime behavior is not verified.",
  },
  {
    target: "claude-code",
    label: "Claude Code",
    description: "Skill folder with SKILL.md (name/description front matter) plus supporting files. Drop into .claude/skills/.",
    formatBasis: "Anthropic Agent Skills format: SKILL.md with `name` (≤64 chars, lowercase-hyphen) and `description` (≤1024 chars) YAML front matter. Structure verified by this repository's exporter tests.",
  },
  {
    target: "generic",
    label: "Generic (AGENTS.md)",
    description: "Ecosystem-neutral package: AGENTS.md orientation wrapper plus canonical SKILL.md and files.",
    formatBasis: "The AGENTS.md convention (agents.md): a root markdown instruction file any agent can read. Structure verified by this repository's exporter tests.",
  },
];

export function exportPackage(skill: CanonicalSkill, target: ExportTarget): ExportedPackage {
  const exporter = EXPORTERS[target];
  if (!exporter) {
    throw new ExportError(
      `Unsupported export target "${String(target)}". Supported targets: ${Object.keys(EXPORTERS).join(", ")}.`,
      "export_target_unsupported",
    );
  }
  return exporter(skill);
}

export interface ZipResult {
  buffer: Buffer;
  entries: string[];
  fileName: string;
}

/**
 * Build a real ZIP from an exported package. Every entry path is sanitized
 * through safePackagePath (zip-slip/traversal/absolute path protection), and
 * the package name itself is slugified.
 */
interface ZipInstance {
  file(path: string, content: string): unknown;
  generateAsync(options: Record<string, unknown>): Promise<Buffer>;
}

export async function buildZip(exported: ExportedPackage): Promise<ZipResult> {
  const zip = new JSZip() as unknown as ZipInstance;
  const root = slugify(exported.skillName, 48);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const file of exported.files) {
    const safe = safePackagePath(file.path);
    if (safe === null) {
      throw new ExportError(
        `Refusing to write unsafe path into ZIP: "${file.path}".`,
        "export_unsafe_path",
      );
    }
    const entry = joinPackagePath(root, safe);
    if (seen.has(entry)) {
      throw new ExportError(`Duplicate ZIP entry "${entry}".`, "export_duplicate_entry");
    }
    seen.add(entry);
    zip.file(entry, file.content);
    entries.push(entry);
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return {
    buffer,
    entries,
    fileName: `${root}-${exported.target}.zip`,
  };
}
