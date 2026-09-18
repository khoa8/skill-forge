/**
 * Shared canonical-skill builder.
 *
 * Turns a validated SkillPlan plus the source analysis into the canonical
 * package: SKILL.md, grounded reference/workflow/example files, deterministic
 * evals, and a manifest with provenance. Both the mock provider and LLM
 * providers converge here, so file synthesis and gap handling exist in
 * exactly one place.
 *
 * Grounding rules enforced here:
 * - reference/workflow/example bodies are verbatim source excerpts with
 *   line-range provenance;
 * - when the source cannot answer a standard section, the section renders an
 *   explicit gap note instead of invented content;
 * - nothing outside the source is asserted as fact.
 */
import type {
  CanonicalSkill,
  CodeBlock,
  NormalizedSource,
  Provenance,
  RepositoryAnalysis,
  SkillFile,
  SkillMeta,
  SourceAnalysis,
} from "./types.js";
import type { SkillPlan } from "./plan.js";
import { slugify, sha256 } from "./util.js";
import { allocateReferences, allocateWorkflows, deriveEvalItems } from "./evals.js";
export { neutralizeRelativeLinks } from "./evals.js";

export const GAP_NOTE =
  "> Not specified in the source material. SkillForge marked this gap instead of inventing content — verify against the primary documentation before relying on it.";

const EXT_BY_LANG: Record<string, string> = {
  javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx",
  python: "py", py: "py", bash: "sh", sh: "sh", shell: "sh", zsh: "sh",
  json: "json", yaml: "yaml", yml: "yml", toml: "toml", html: "html",
  css: "css", sql: "sql", go: "go", rust: "rs", rs: "rs", ruby: "rb",
  java: "java", kotlin: "kt", c: "c", cpp: "cpp", csharp: "cs", diff: "diff",
  dockerfile: "Dockerfile", markdown: "md", md: "md", text: "txt", curl: "sh",
};

function extFor(lang: string): string {
  return EXT_BY_LANG[lang.toLowerCase()] ?? "txt";
}

function firstSentences(text: string, maxSentences: number, maxChars: number): string {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z`*_-])/);
  const picked = sentences.slice(0, maxSentences).join(" ");
  return picked.length > maxChars ? picked.slice(0, maxChars - 1).trimEnd() + "…" : picked;
}

function bulletsOf(text: string, max: number): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      out.push(current.join(" ").replace(/\s+/g, " ").trim());
      current = [];
    }
  };
  for (const line of text.split("\n")) {
    const m = line.match(/^\s{0,3}[-*+]\s+(.+)$/);
    if (m) {
      flush();
      current = [m[1]!.trim()];
      if (out.length >= max) {
        flush();
        break;
      }
    } else if (current.length > 0 && /^\s{2,}\S/.test(line)) {
      // Continuation line of a wrapped bullet.
      current.push(line.trim());
    } else if (current.length > 0) {
      flush();
    }
  }
  flush();
  return out.slice(0, max);
}

/** Comment token for a file extension; null when the format forbids comments. */
const COMMENT_TOKEN: Record<string, string> = {
  js: "//", jsx: "//", ts: "//", tsx: "//", go: "//", rs: "//", java: "//",
  kt: "//", c: "//", cpp: "//", cs: "//", swift: "//",
  sh: "#", py: "#", yaml: "#", yml: "#", toml: "#", rb: "#", r: "#",
};

/** Extract `ENV_VAR` style tokens only from contexts that imply configuration. */
export function detectEnvVarInputs(analysis: SourceAnalysis): { token: string; line: number }[] {
  const found = new Map<string, number>();
  const contextRe =
    /\b(?:environment variable|env var|export |set(?:x)?\s+[A-Z_]|\.env\b|api[_ -]?key|token|secret|credential|config(?:uration)?\b)/i;
  const tokenRe = /\b([A-Z][A-Z0-9_]{2,40})\b/g;

  const scan = (text: string, line: number) => {
    if (!contextRe.test(text)) return;
    for (const m of text.matchAll(tokenRe)) {
      const tok = m[1]!;
      if (
        ["TODO", "NOTE", "WARNING", "IMPORTANT", "THE", "AND", "FOR", "YOU", "YOUR", "GET", "POST", "PUT", "DELETE", "HTTP", "HTTPS", "JSON", "URL", "API", "SDK", "CLI", "CSS", "HTML", "XML", "SQL", "CSV", "UTF"].includes(tok)
      ) {
        continue;
      }
      if (!found.has(tok)) found.set(tok, line);
    }
  };

  for (const block of analysis.codeBlocks) {
    block.code.split("\n").forEach((l, i) => scan(l, block.line + i));
  }
  for (const cmd of analysis.commands) scan(cmd.raw, cmd.line);
  for (const line of analysis.warningLines) scan(line, 0);
  analysis.sections.forEach((s) => {
    s.text.split("\n").forEach((l, i) => scan(l, s.startLine + i));
  });
  return [...found.entries()].slice(0, 12).map(([token, line]) => ({ token, line }));
}

/** Derive the deterministic plan the mock provider uses. */
export function derivePlanFromAnalysis(analysis: SourceAnalysis): SkillPlan {
  const whenToUse: string[] = [
    `Use this skill when the task involves ${analysis.title}.`,
  ];
  if (analysis.intro.length > 0) {
    whenToUse.push(firstSentences(analysis.intro, 1, 240));
  }

  const inputs = detectEnvVarInputs(analysis).map(
    (e) => `\`${e.token}\` — configuration value referenced in the source (line ${e.line}).`,
  );

  const steps: string[] = [];
  for (const { proc, path } of allocateWorkflows(analysis).slice(0, 6)) {
    steps.push(
      `Follow the documented procedure "${proc.title}" (${proc.steps.length} steps) — see ${path}.`,
    );
  }
  const procedureTitles = new Set(analysis.procedures.map((p) => p.title.toLowerCase()));
  for (const { section, path } of allocateReferences(analysis).slice(0, 6)) {
    if (procedureTitles.has(section.heading.toLowerCase())) continue; // already covered by its workflow file
    steps.push(
      `Consult the "${section.heading}" guidance in ${path} and apply it to the task.`,
    );
  }

  const constraints: string[] = [];
  const isPitfallHeading = /\b(troubleshoot\w*|faq|pitfall|gotcha|common (?:issue|problem|error))\b/i;
  for (const w of analysis.warningLines.slice(0, 5)) {
    constraints.push(firstSentences(w, 2, 240));
  }
  for (const heading of analysis.constraintHeadings.slice(0, 6)) {
    if (isPitfallHeading.test(heading)) continue; // pitfall sections are reported under pitfalls
    const section = analysis.sections.find((s) => s.heading === heading);
    if (section) {
      for (const b of bulletsOf(section.text, 2)) {
        constraints.push(firstSentences(b, 2, 240));
      }
    }
  }
  // Imperative constraint sentences from prose ("Always pass an…", "Never…").
  for (const s of constraintSentences(analysis, 6)) {
    constraints.push(firstSentences(s, 1, 240));
  }

  const verification: string[] = [];
  const verifyHeadingRe = /\b(test|verify|check|build|lint|validate|install|run)\b/i;
  const verifyStatementRe = /^\s*(?:\*\*)?(?:verify|confirm|check|make sure|ensure)\b/i;
  for (const cmd of analysis.commands) {
    if (verifyHeadingRe.test(cmd.heading) || verifyHeadingRe.test(cmd.raw)) {
      verification.push(`\`${cmd.raw}\` (source line ${cmd.line}).`);
    }
    if (verification.length >= 5) break;
  }
  // Explicit "verify/confirm/check" statements inside documented procedures
  // are grounded success criteria — surface them as verification steps too.
  for (const proc of analysis.procedures) {
    for (const step of proc.steps) {
      if (verifyStatementRe.test(step.text)) {
        verification.push(firstSentences(step.text, 1, 240));
      }
    }
  }

  const pitfalls: string[] = [];
  for (const section of analysis.sections) {
    if (/\b(troubleshoot\w*|faq|pitfall|gotcha|common (?:issue|problem|error)|error)\b/i.test(section.heading)) {
      for (const b of bulletsOf(section.text, 3)) {
        pitfalls.push(firstSentences(b, 2, 240));
      }
      if (pitfalls.length >= 6) break;
    }
  }

  return {
    whenToUse: dedupe(whenToUse).slice(0, 12),
    inputs: dedupe(inputs).slice(0, 12),
    steps: dedupe(steps).slice(0, 20),
    constraints: dedupe(constraints).slice(0, 12),
    verification: dedupe(verification).slice(0, 12),
    pitfalls: dedupe(pitfalls).slice(0, 12),
  };
}

/** Imperative constraint sentences ("Always…", "Never…", "Do not…", "must…"). */
const CONSTRAINT_SENTENCE_RE =
  /^\s*(?:Always|Never|Do not|Don't|Must(?:\s+not)?|Avoid|Ensure|Make sure)\b|\b(?:must(?:\s+not)?|must never)\b/i;

function constraintSentences(analysis: SourceAnalysis, max: number): string[] {
  const out: string[] = [];
  const pitfallRe = /\b(troubleshoot\w*|faq|pitfall|gotcha|common (?:issue|problem|error))\b/i;
  for (const section of analysis.sections) {
    if (pitfallRe.test(section.heading)) continue;
    // Drop fenced code blocks so flattened sentences never contain code fences.
    const proseLines: string[] = [];
    let inFence = false;
    for (const line of section.text.split("\n")) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (!inFence && !HEADINGISH.test(line)) proseLines.push(line);
    }
    const flat = proseLines.join(" ");
    for (const sentence of flat.split(/(?<=[.!?])\s+(?=[A-Z`*_-])/)) {
      const s = sentence.replace(/\s+/g, " ").trim();
      if (s.length < 12 || s.length > 300) continue;
      if (s.includes(": ")) {
        // Prose often joins unrelated statements with colons ("Do X: do Y.").
        // Evaluate each clause so constraints stay crisp and grounded.
        for (const clause of s.split(/:\s+/)) {
          const c = clause.trim();
          if (c.length >= 12 && c.length <= 300 && CONSTRAINT_SENTENCE_RE.test(c)) {
            out.push(c);
          }
        }
      } else if (CONSTRAINT_SENTENCE_RE.test(s)) {
        out.push(s);
      }
    }
  }
  return dedupe(out).slice(0, max);
}

const HEADINGISH = /^#{1,6}\s/;

export function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Build the canonical package. `plan` should already be validated against
 * PlanSchema; deterministic gap-filling from the analysis augments empty plan
 * sections, and remaining gaps are rendered explicitly.
 */
export function buildCanonicalSkill(
  source: NormalizedSource,
  analysis: SourceAnalysis,
  rawPlan: SkillPlan,
  generatorId: string,
): CanonicalSkill {
  const isCodebase = source.sourceType === "github-codebase";

  let name: string;
  let displayName: string;
  let description: string;

  if (isCodebase) {
    const repo = source.repository;
    const ownerName = repo ? `${repo.repository.owner}-${repo.repository.name}` : source.originalName;
    const repoIdentity = repo ? `${repo.repository.owner}/${repo.repository.name}` : source.originalName;
    name = slugify(rawPlan.name?.trim() || ownerName, 48);
    displayName = (rawPlan.displayName?.trim() || `${repoIdentity} — coding agent guide`).slice(0, 120);

    if (rawPlan.description?.trim()) {
      description = rawPlan.description.trim().slice(0, 1024);
    } else {
      const stackLabel = repo
        ? repo.languages.slice(0, 3).map((l) => l.name).join("/") ||
          repo.ecosystems.slice(0, 3).join("/") ||
          "unrecognized stack"
        : "project";
      const scopeLabel = repo?.repository.scope ? `the \`${repo.repository.scope}\` subtree of ` : "";
      const countLabel = repo ? `bounded inspection of ${repo.selection.selectedCount} file(s)` : "bounded repository inspection";
      description = `Coding-agent guidance for ${scopeLabel}${repoIdentity}: ${stackLabel}, derived from a ${countLabel}.`.slice(0, 1024);
    }
  } else {
    name = slugify(rawPlan.name?.trim() || analysis.title, 48);
    displayName = (rawPlan.displayName?.trim() || analysis.title).slice(0, 120);
    description = (
      rawPlan.description?.trim() ||
      firstSentences(analysis.intro, 2, 500) ||
      `Working knowledge for ${analysis.title}, extracted by SkillForge.`
    ).slice(0, 1024);
  }

  const plan: SkillPlan = {
    name,
    displayName,
    description,
    whenToUse: rawPlan.whenToUse.length > 0 || isCodebase ? rawPlan.whenToUse : derivePlanFromAnalysis(analysis).whenToUse,
    inputs: rawPlan.inputs.length > 0 || isCodebase ? rawPlan.inputs : derivePlanFromAnalysis(analysis).inputs,
    steps: rawPlan.steps.length > 0 || isCodebase ? rawPlan.steps : derivePlanFromAnalysis(analysis).steps,
    constraints: rawPlan.constraints,
    verification: rawPlan.verification,
    pitfalls: rawPlan.pitfalls,
  };

  const files: SkillFile[] = [];
  const provenance: Provenance[] = [];
  const gaps: string[] = [];
  const addFile = (path: string, content: string, purpose: string, prov: Omit<Provenance, "filePath">) => {
    files.push({ path, content, purpose });
    provenance.push({ filePath: path, ...prov });
  };

  // --- Reference files from top-level sections (verbatim source excerpts).
  const usedPaths = new Set<string>(["SKILL.md"]);
  const referenceLinks: { path: string; heading: string; range: string }[] = [];

  for (const { section, canonicalBody, path } of allocateReferences(analysis)) {
    usedPaths.add(path);
    const content = [
      `# ${section.heading}`,
      "",
      `> Excerpt from source "${source.originalName}" (lines ${section.startLine}–${section.endLine}). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.`,
      "",
      canonicalBody,
      "",
      `_Source: ${source.originalName}, lines ${section.startLine}–${section.endLine}._`,
      "",
    ].join("\n");
    addFile(
      path,
      content,
      `Verbatim source excerpt for the "${section.heading}" section, so the agent can consult the original guidance.`,
      { extraction: `section "${section.heading}"`, sourceLines: [section.startLine, section.endLine], sourceHeading: section.heading },
    );
    referenceLinks.push({ path, heading: section.heading, range: `${section.startLine}–${section.endLine}` });
  }

  // --- Workflow files from detected ordered procedures.
  // In codebase mode, generic README ordered procedures must NOT be promoted
  // into executable workflow files.
  const workflowLinks: { path: string; title: string; stepCount: number }[] = [];
  if (!isCodebase) {
    for (const { proc, path, canonicalSteps } of allocateWorkflows(analysis)) {
      usedPaths.add(path);
      const endLine = proc.steps[proc.steps.length - 1]!.line;
      const content = [
        `# ${proc.title}`,
        "",
        `> Documented procedure from source "${source.originalName}" (lines ${proc.line}–${endLine}). Steps are verbatim from the source; relative links are shown as paths.`,
        "",
        ...proc.steps.map((s, i) => `${i + 1}. ${canonicalSteps[i]} _(source line ${s.line})_`),
        "",
      ].join("\n");
      addFile(
        path,
        content,
        `Executable ${proc.steps.length}-step procedure "${proc.title}" detected in the source.`,
        { extraction: `ordered procedure "${proc.title}"`, sourceLines: [proc.line, endLine], sourceHeading: proc.title },
      );
      workflowLinks.push({ path, title: proc.title, stepCount: proc.steps.length });
    }
  }

  // --- Example files from substantial fenced code blocks.
  for (const block of analysis.codeBlocks.filter((b) => b.code.trim().split("\n").length >= 3).slice(0, 8)) {
    const base = slugify(block.heading.length > 0 ? `${block.heading} ${block.language}` : block.language || "example", 40);
    const ext = extFor(block.language || "text");
    const path = `examples/${base}.${ext}`;
    if (usedPaths.has(path)) continue;
    usedPaths.add(path);
    const endLine = block.line + block.code.split("\n").length + 1;
    const commentToken = COMMENT_TOKEN[ext];
    const header =
      commentToken !== undefined
        ? `${commentToken} Source: ${source.originalName}, lines ${block.line}–${endLine} (under "${block.heading}"). Verbatim code block.\n`
        : "";
    const content = `${header}${block.code}\n`;
    addFile(
      path,
      content,
      `Verbatim ${block.language || "code"} example from the source ("${block.heading}").`,
      { extraction: `code block (${block.language || "unspecified language"})`, sourceLines: [block.line, Math.min(endLine, source.lineCount)], sourceHeading: block.heading },
    );
  }

  // --- Deterministic evals derived from source structure.
  const evals = deriveEvalItems(source, analysis);
  if (evals.length > 0) {
    const evalsPath = "evals/evals.json";
    usedPaths.add(evalsPath);
    addFile(
      evalsPath,
      JSON.stringify({ schema: "skillforge.evals/1", items: evals }, null, 2) + "\n",
      "Deterministic, source-derived eval questions for smoke-testing the skill.",
      { extraction: "derived eval index", sourceLines: [1, source.lineCount] },
    );
    usedPaths.add("evals/README.md");
    addFile(
      "evals/README.md",
      [
        "# Evals",
        "",
        "These checks were derived deterministically from the source structure (sections,",
        "procedures, commands). Each eval carries an optional structured assertion enabling",
        "bounded, offline, deterministic evaluation: topic-retention checks verify a reference",
        "file retains its source excerpt and stays discoverable from SKILL.md; procedure-fidelity",
        "checks compare ordered step text in workflow files against the source. Nothing is ever",
        "executed; evaluation is advisory, does not replace deterministic validation, and lists",
        "pass, concern, or not-executable per check with no aggregate quality score.",
        "Evals without assertions (manual grounding questions) and command checks remain manual.",
        "",
      ].join("\n"),
      "Structured eval questions with executable assertions for advisory deterministic evaluation, plus manual grounding checks.",
      { extraction: "eval explanation", sourceLines: [1, source.lineCount] },
    );
  }

  // --- SKILL.md
  const gap = (section: string) => {
    gaps.push(section);
    return GAP_NOTE;
  };

  const whenToUseMd =
    plan.whenToUse.length > 0
      ? plan.whenToUse.map((w) => `- ${w}`).join("\n")
      : gap("When to use");
  const inputsMd =
    plan.inputs.length > 0
      ? plan.inputs.map((i) => `- ${i}`).join("\n")
      : gap("Inputs required");
  const constraintsMd =
    plan.constraints.length > 0
      ? plan.constraints.map((c) => `- ${c}`).join("\n")
      : gap("Constraints");
  const verificationMd =
    plan.verification.length > 0
      ? plan.verification.map((v) => `- ${v}`).join("\n")
      : gap("Verification");
  const pitfallsMd =
    plan.pitfalls.length > 0
      ? plan.pitfalls.map((p) => `- ${p}`).join("\n")
      : gap("Common pitfalls");

  const workflowMd =
    plan.steps.length > 0
      ? plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : gap("Workflow");

  const referencesMd =
    referenceLinks.length > 0
      ? referenceLinks.map((r) => `- [${r.path}](${r.path}) — "${r.heading}" (source lines ${r.range})`).join("\n")
      : "_No reference files were warranted by the source structure._";

  const skillMd = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${displayName}`,
    "",
    `> Generated by SkillForge (\`${generatorId}\`) from \`${source.originalName}\`. Every factual claim below is grounded in that source; explicit gaps are marked.`,
    "",
    "## When to use this skill",
    "",
    whenToUseMd,
    "",
    "## Inputs required",
    "",
    inputsMd,
    "",
    "## Workflow",
    "",
    workflowMd,
    "",
    "## Constraints",
    "",
    constraintsMd,
    "",
    "## Verification",
    "",
    verificationMd,
    "",
    "## Common pitfalls",
    "",
    pitfallsMd,
    "",
    "## References",
    "",
    referencesMd,
    "",
  ].join("\n");

  files.unshift({
    path: "SKILL.md",
    content: skillMd,
    purpose: "Primary skill instructions: when to use, inputs, workflow, constraints, verification, pitfalls.",
  });
  provenance.unshift({
    filePath: "SKILL.md",
    extraction: "synthesized from plan + analysis",
    sourceLines: [1, source.lineCount],
  });

  // --- manifest.json (deterministic: no timestamps inside package files).
  const meta: SkillMeta = {
    name,
    displayName,
    description,
    version: "0.1.0",
    generator: generatorId,
    generatedAt: new Date(0).toISOString(), // stamped by pipeline; builders stay deterministic
    gaps,
  };
  files.push({
    path: "manifest.json",
    content: manifestFor(files, meta, {
      name: source.originalName,
      sha256: source.sha256,
      lineCount: source.lineCount,
      notes: source.notes,
      ...(source.repository ? { repository: manifestRepositoryBlock(source.repository) } : {}),
    }),
    purpose: "Machine-readable package manifest: source identity, gap list, file inventory with hashes.",
  });
  provenance.push({
    filePath: "manifest.json",
    extraction: "manifest from package inventory",
    sourceLines: [1, source.lineCount],
  });

  return {
    schemaVersion: "1",
    id: name,
    meta,
    plan: {
      whenToUse: plan.whenToUse,
      inputs: plan.inputs,
      steps: plan.steps,
      constraints: plan.constraints,
      verification: plan.verification,
      pitfalls: plan.pitfalls,
    },
    files,
    provenance,
  };
}

/** Source identity block shared by build and post-edit manifest resync. */
export interface ManifestSourceInfo {
  name: string;
  sha256: string;
  lineCount: number;
  notes: string[];
  /** Repository provenance for codebase-mode sources (manifest only — the
   * full structured analysis lives in the persisted record, not the package). */
  repository?: ManifestRepositoryBlock;
}

/** The compact repository provenance block embedded in manifest.json. */
export interface ManifestRepositoryBlock {
  url: string;
  owner: string;
  name: string;
  /** The requested/logical ref, kept for display. */
  ref: string;
  /** The immutable commit SHA actually inspected. Optional for backward
   * compatibility with historical records that predate snapshot pinning. */
  commitSha?: string;
  mode: "codebase";
  /** Subpath scope the analysis covers; absent = whole repository. */
  scope?: string;
  inspectedFiles: string[];
  /** Blob count in the tree vs how many were inspected. */
  treeBlobCount: number;
  candidateCount: number;
  selectedCount: number;
  treeTruncated: boolean;
}

/**
 * Derive the manifest repository block from a persisted RepositoryAnalysis.
 * Shared by the initial build and by post-edit manifest regeneration so the
 * two can never drift (P1-4): edits must keep codebase provenance intact.
 */
export function manifestRepositoryBlock(repository: RepositoryAnalysis): ManifestRepositoryBlock {
  return {
    url: repository.repository.url,
    owner: repository.repository.owner,
    name: repository.repository.name,
    ref: repository.repository.ref,
    ...(repository.repository.commitSha ? { commitSha: repository.repository.commitSha } : {}),
    mode: repository.mode,
    ...(repository.repository.scope ? { scope: repository.repository.scope } : {}),
    inspectedFiles: repository.inspectedFiles,
    treeBlobCount: repository.selection.treeBlobCount,
    candidateCount: repository.selection.candidateCount,
    selectedCount: repository.selection.selectedCount,
    treeTruncated: repository.selection.treeTruncated,
  };
}

/**
 * Render manifest.json content for a file inventory. Deterministic; used both
 * at build time and after user edits so manifest hashes can never drift from
 * the packaged files.
 */
export function manifestFor(
  files: SkillFile[],
  meta: SkillMeta,
  source: ManifestSourceInfo,
): string {
  const manifest = {
    schema: "skillforge.manifest/1",
    name: meta.name,
    displayName: meta.displayName,
    description: meta.description,
    version: meta.version,
    generator: meta.generator,
    source: {
      name: source.name,
      sha256: source.sha256,
      lineCount: source.lineCount,
      notes: source.notes,
      ...(source.repository ? { repository: source.repository } : {}),
    },
    gaps: meta.gaps,
    files: files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({
        path: f.path,
        bytes: Buffer.byteLength(f.content, "utf8"),
        sha256: sha256(f.content),
        ...(f.userEdited ? { userEdited: true } : {}),
      })),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Clean up or qualify known generator-owned provenance claims when a file is edited.
 * Idempotent: safe to apply multiple times without duplicating banners or mangling user text.
 * Strictly avoids rewriting arbitrary user prose; only matches generator-owned templates.
 */
export function qualifyEditedFileContent(path: string, content: string, sourceName: string): string {
  const name = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (path === "SKILL.md") {
    // Only replace unedited generator grounding banner if still present
    const generatorBannerRe = new RegExp("^> Generated by SkillForge(?: \\([^\\n]*\\))? from `" + name + "`\\. Every factual claim below is grounded in that source; explicit gaps are marked\\.", "m");
    if (generatorBannerRe.test(content)) {
      return content.replace(
        generatorBannerRe,
        () => `> Generated by SkillForge from \`${sourceName}\` and edited after generation. The current file is no longer guaranteed to be fully source-derived; verify edited statements against the original source.`,
      );
    }
    return content;
  }

  if (path.startsWith("references/")) {
    let result = content;
    const refHeaderRe = new RegExp('^> Excerpt from source "' + name + '" \\(lines \\d+[-–]\\d+\\)\\. Verbatim except for this header; relative links to the original repository are shown as paths instead of links\\.', "m");
    if (refHeaderRe.test(result)) {
      result = result.replace(
        refHeaderRe,
        () => `> Originally generated from source "${sourceName}"; edited after generation. Current contents are not guaranteed verbatim and the original line-range provenance no longer applies.`,
      );
    }
    // Match the exact generator footer even when an edit appends text after it.
    const refFooterRe = new RegExp("^_Source: " + name + ", lines \\d+[-–]\\d+\\._(?:\\n|$)", "m");
    result = result.replace(refFooterRe, "\n");
    return result;
  }

  if (path.startsWith("workflows/")) {
    let result = content;
    const wfHeaderRe = new RegExp('^> Documented procedure from source "' + name + '" \\(lines \\d+[-–]\\d+\\)\\. Steps are verbatim from the source; relative links are shown as paths\\.', "m");
    if (!wfHeaderRe.test(result)) return content;
    result = result.replace(
      wfHeaderRe,
      () => `> Documented procedure from source "${sourceName}"; edited after generation. Current steps are not guaranteed to be verbatim from the source.`,
    );
    // Remove source line annotations only from generated numbered step lines
    const lines = result.split("\n");
    const cleanedLines = lines.map((line) => {
      if (/^\s*\d+\.\s+/.test(line)) {
        return line.replace(/\s+_\(source line \d+\)_$/, "");
      }
      return line;
    });
    return cleanedLines.join("\n");
  }

  if (path.startsWith("examples/")) {
    const exampleHeaderRe = new RegExp('^(//|#) Source: ' + name + ', lines \\d+[-–]\\d+ \\(under "[^\\n]*"\\)\\. Verbatim code block\\.\\n');
    if (exampleHeaderRe.test(content)) {
      return content.replace(
        exampleHeaderRe,
        (_match, token: string) => `${token} Originally generated from source: ${sourceName}; edited after generation.\n`,
      );
    }
    return content;
  }

  if (path === "evals/README.md") {
    const origEvalNotice = "These checks were derived deterministically from the source structure (sections,\nprocedures, commands). Each eval carries an optional structured assertion enabling\nbounded, offline, deterministic evaluation: topic-retention checks verify a reference\nfile retains its source excerpt and stays discoverable from SKILL.md; procedure-fidelity\nchecks compare ordered step text in workflow files against the source. Nothing is ever\nexecuted; evaluation is advisory, does not replace deterministic validation, and lists\npass, concern, or not-executable per check with no aggregate quality score.\nEvals without assertions (manual grounding questions) and command checks remain manual.";
    if (content.includes(origEvalNotice)) {
      return content.replace(
        origEvalNotice,
        "These checks were originally derived from the source structure; edited after generation.\nThey are grounding checks: run them manually by asking an agent the `prompt`\nand verifying the `expect` condition holds.",
      );
    }
    return content;
  }

  return content;
}
