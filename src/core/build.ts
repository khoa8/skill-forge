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
import { PLAN_LIMITS, clipPlanText, fitPlanItem, fitPlanSection } from "./plan.js";
import type { ResolvedGroundedPlan, GroundedPlanAtom } from "./plan-catalog.js";
import { slugify, sha256, formatCodeSpan, formatMetadataLabel } from "./util.js";
import { allocateReferences, allocateWorkflows, deriveEvalItems, neutralizeRelativeLinks } from "./evals.js";
export { neutralizeRelativeLinks };

/**
 * Presentation budget for a quoted label (heading/title) inside a plan item.
 * Far longer than any realistic heading, and small enough that every fixed
 * template in `derivePlanFromAnalysis` provably fits its section limit.
 */
const PLAN_LABEL_CHARS = 240;

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
export function derivePlanFromAnalysis(analysis: SourceAnalysis): ResolvedGroundedPlan {
  // Labels (titles/headings) are interpolated into fixed templates, so they
  // are bounded *before* composition: the sentence structure (quotes, guidance
  // clause, evidence list) stays intact and the result provably fits the
  // resolved-plan contract. `fitPlanItem` remains a backstop only.
  const title = clipPlanText(analysis.title, PLAN_LABEL_CHARS);
  const whenToUse: string[] = [
    fitPlanItem(`Use this skill when the task involves ${title}.`, PLAN_LIMITS.whenToUse.maxItemChars),
  ];
  if (analysis.intro.length > 0) {
    whenToUse.push(firstSentences(analysis.intro, 1, 240));
  }

  const inputs = detectEnvVarInputs(analysis).map(
    (e) => `\`${e.token}\` — configuration value referenced in the source (line ${e.line}).`,
  );

  const steps: string[] = [];
  const stepAtoms: GroundedPlanAtom[] = [];
  let stepIndex = 0;

  for (const { proc, path } of allocateWorkflows(analysis).slice(0, 6)) {
    const procTitle = clipPlanText(proc.title, PLAN_LABEL_CHARS);
    steps.push(
      fitPlanItem(
        `Follow the documented procedure "${procTitle}" (${proc.steps.length} steps) — see [${path}](${path}).`,
        PLAN_LIMITS.steps.maxItemChars,
      ),
    );
    stepAtoms.push({
      id: `steps-${stepIndex++}`,
      section: "steps",
      text: fitPlanItem(
        `Follow the documented procedure "${procTitle}" (${proc.steps.length} steps).`,
        PLAN_LIMITS.steps.maxItemChars,
      ),
      sourceAnchor: {
        kind: "procedure",
        title: proc.title,
        line: proc.line,
        stepCount: proc.steps.length,
      },
    });
  }
  const procedureTitles = new Set(analysis.procedures.map((p) => p.title.toLowerCase()));
  for (const { section, path } of allocateReferences(analysis).slice(0, 6)) {
    if (procedureTitles.has(section.heading.toLowerCase())) continue; // already covered by its workflow file
    const heading = clipPlanText(section.heading, PLAN_LABEL_CHARS);
    steps.push(
      fitPlanItem(
        `Consult the "${heading}" guidance in [${path}](${path}) and apply it to the task.`,
        PLAN_LIMITS.steps.maxItemChars,
      ),
    );
    stepAtoms.push({
      id: `steps-${stepIndex++}`,
      section: "steps",
      text: fitPlanItem(
        `Consult the "${heading}" section guidance and apply it to the task.`,
        PLAN_LIMITS.steps.maxItemChars,
      ),
      sourceAnchor: {
        kind: "section",
        heading: section.heading,
        startLine: section.startLine,
        endLine: section.endLine,
        sectionId: section.id,
      },
    });
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
      // Source-derived command bodies are rendered through the code-span
      // boundary (backtick-safe) and are never shortened to fit: a truncated
      // shell line is a *different* command. When one cannot be represented
      // within the section contract it is referenced by source line instead,
      // so nothing runnable and wrong is ever presented as authoritative.
      const quoted = `${formatCodeSpan(cmd.raw)} (source line ${cmd.line}).`;
      if (quoted.length <= PLAN_LIMITS.verification.maxItemChars) {
        verification.push(quoted);
      } else {
        verification.push(
          `Source line ${cmd.line} documents a verification command too long to quote here (${cmd.raw.length} characters); read it from the source material before relying on it.`,
        );
      }
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
    // Backstop only: every item above is already composed from bounded
    // ingredients (and command-bearing items are either representable or
    // replaced by a bounded non-runnable reference), so this cannot shorten a
    // command into a different command.
    whenToUse: fitPlanSection(dedupe(whenToUse), PLAN_LIMITS.whenToUse.maxItemChars).slice(0, PLAN_LIMITS.whenToUse.maxItems),
    inputs: fitPlanSection(dedupe(inputs), PLAN_LIMITS.inputs.maxItemChars).slice(0, PLAN_LIMITS.inputs.maxItems),
    steps: fitPlanSection(dedupe(steps), PLAN_LIMITS.steps.maxItemChars).slice(0, PLAN_LIMITS.steps.maxItems),
    stepAtoms,
    constraints: fitPlanSection(dedupe(constraints), PLAN_LIMITS.constraints.maxItemChars).slice(0, PLAN_LIMITS.constraints.maxItems),
    verification: fitPlanSection(dedupe(verification), PLAN_LIMITS.verification.maxItemChars).slice(0, PLAN_LIMITS.verification.maxItems),
    pitfalls: fitPlanSection(dedupe(pitfalls), PLAN_LIMITS.pitfalls.maxItemChars).slice(0, PLAN_LIMITS.pitfalls.maxItems),
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
 * Build the canonical package. `plan` must be a RESOLVED grounded plan:
 * the normal path is provider proposal → shared grounded resolution
 * (`resolveProviderProposal`) → resolved SkillPlan → this builder.
 * Descriptions are always derived deterministically here and never trusted
 * from provider output; deterministic gap-filling from the analysis augments
 * empty plan sections, and remaining gaps are rendered explicitly.
 */
function sanitizeDisplayName(raw: string | undefined, fallback: string): string {
  // The fallback is untrusted metadata too: an ordinary source with no usable
  // title falls back to the raw source name, and a provider may legitimately
  // omit `displayName`. Render it through the same single-line boundary.
  const safeFallback = formatMetadataLabel(fallback).slice(0, 120) || "Untitled skill";
  const trimmed = raw?.trim();
  if (!trimmed) return safeFallback;
  // Display names are presentation titles only; collapse line breaks to prevent
  // Markdown heading escaping into body blocks.
  const firstLine = trimmed.split(/[\r\n\u2028\u2029]/)[0]?.trim();
  return (firstLine || safeFallback).slice(0, 120);
}

export function buildCanonicalSkill(
  source: NormalizedSource,
  analysis: SourceAnalysis,
  rawPlan: SkillPlan | ResolvedGroundedPlan,
  generatorId: string,
): CanonicalSkill {
  const isCodebase = source.sourceType === "github-codebase";

  // Untrusted source identity, rendered once through the shared metadata
  // boundary and reused at every presentation sink below. The RAW name stays
  // authoritative in the manifest/persisted record (JSON escapes it
  // structurally); only the rendered form is single-line and context-safe.
  const sourceLabel = formatMetadataLabel(source.originalName);

  let name: string;
  let displayName: string;
  let description: string;

  if (isCodebase) {
    const repo = source.repository;
    const ownerName = repo ? `${repo.repository.owner}-${repo.repository.name}` : sourceLabel;
    const repoIdentity = repo ? `${repo.repository.owner}/${repo.repository.name}` : sourceLabel;
    name = slugify(rawPlan.name?.trim() || ownerName, 48);
    displayName = sanitizeDisplayName(rawPlan.displayName, `${repoIdentity} — coding agent guide`);

    // Descriptions are deterministic grounded authority: never trust
    // provider-authored prose (F-01). Codebase descriptions derive from
    // repository identity + bounded inspection counts only.
    const stackLabel = repo
      ? repo.languages.slice(0, 3).map((l) => l.name).join("/") ||
        repo.ecosystems.slice(0, 3).join("/") ||
        "unrecognized stack"
      : "project";
    const scopeLabel = repo?.repository.scope ? `the ${formatCodeSpan(repo.repository.scope)} subtree of ` : "";
    const countLabel = repo ? `bounded inspection of ${repo.selection.selectedCount} file(s)` : "bounded repository inspection";
    description = `Coding-agent guidance for ${scopeLabel}${repoIdentity}: ${stackLabel}, derived from a ${countLabel}.`.slice(0, 1024);
  } else {
    name = slugify(rawPlan.name?.trim() || analysis.title, 48);
    displayName = sanitizeDisplayName(rawPlan.displayName, analysis.title);
    // Descriptions are deterministic grounded authority: never trust
    // provider-authored prose (F-01). Ordinary docs derive from the source
    // intro or a generic deterministic fallback.
    description = (
      firstSentences(analysis.intro, 2, 500) ||
      `Working knowledge for ${analysis.title}, extracted by SkillForge.`
    ).slice(0, 1024);
  }

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
  const allocatedRefs = allocateReferences(analysis);

  for (const { section, canonicalBody, path } of allocatedRefs) {
    usedPaths.add(path);
    const content = [
      `# ${section.heading}`,
      "",
      `> Excerpt from source "${sourceLabel}" (lines ${section.startLine}–${section.endLine}). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.`,
      "",
      canonicalBody,
      "",
      `_Source: ${sourceLabel}, lines ${section.startLine}–${section.endLine}._`,
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
  const allocatedWfs = isCodebase ? [] : allocateWorkflows(analysis);
  if (!isCodebase) {
    for (const { proc, path, canonicalSteps } of allocatedWfs) {
      usedPaths.add(path);
      const endLine = proc.steps[proc.steps.length - 1]!.line;
      const content = [
        `# ${proc.title}`,
        "",
        `> Documented procedure from source "${sourceLabel}" (lines ${proc.line}–${endLine}). Steps are verbatim from the source; relative links are shown as paths.`,
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

  // Late-binding: materialize and link any grounded reference or workflow
  // artifacts referenced by selected step atoms. Artifact-bearing selected
  // atoms carry structured source anchors (F-01 / F-33-01 remediation); the
  // final package filenames and standard Markdown links are rendered here.
  const renderedSteps: string[] = [];
  const rawStepAtoms = (rawPlan as ResolvedGroundedPlan).stepAtoms;
  if (rawStepAtoms && rawStepAtoms.length > 0) {
    for (const atom of rawStepAtoms) {
      const anchor = atom.sourceAnchor;
      if (!anchor) {
        renderedSteps.push(atom.text);
        continue;
      }

      if (anchor.kind === "section") {
        let allocated = allocatedRefs.find(
          (r) => r.section.startLine === anchor.startLine,
        );
        if (!allocated) {
          const section =
            analysis.sections.find((s) => s.startLine === anchor.startLine) ??
            analysis.sections.find((s) => s.heading === anchor.heading && s.id === anchor.sectionId) ??
            analysis.sections.find((s) => s.heading === anchor.heading);
          if (section) {
            const body = section.text.split("\n").slice(1).join("\n").trim();
            if (body.length >= 20) {
              let path = `references/${section.id}.md`;
              let n = 2;
              while (usedPaths.has(path)) path = `references/${section.id}-${n++}.md`;
              usedPaths.add(path);
              const canonicalBody = neutralizeRelativeLinks(body);
              const content = [
                `# ${section.heading}`,
                "",
                `> Excerpt from source "${sourceLabel}" (lines ${section.startLine}–${section.endLine}). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.`,
                "",
                canonicalBody,
                "",
                `_Source: ${sourceLabel}, lines ${section.startLine}–${section.endLine}._`,
                "",
              ].join("\n");
              addFile(
                path,
                content,
                `Verbatim source excerpt for the "${section.heading}" section, so the agent can consult the original guidance.`,
                { extraction: `section "${section.heading}"`, sourceLines: [section.startLine, section.endLine], sourceHeading: section.heading },
              );
              referenceLinks.push({ path, heading: section.heading, range: `${section.startLine}–${section.endLine}` });
              allocated = { section, body, path, canonicalBody };
            }
          }
        }

        if (allocated) {
          // Factual metadata (heading) is rendered from the authoritative
          // resolved full-source section, not from prefix-snapshot anchor
          // hints. The label is bounded for presentation only; the plan item
          // stays inside the resolved-plan contract either way.
          renderedSteps.push(
            fitPlanItem(
              `Consult the "${clipPlanText(allocated.section.heading, PLAN_LABEL_CHARS)}" guidance in [${allocated.path}](${allocated.path}) and apply it to the task.`,
              PLAN_LIMITS.steps.maxItemChars,
            ),
          );
        } else {
          renderedSteps.push(atom.text);
        }
      } else if (anchor.kind === "procedure" && !isCodebase) {
        let allocated = allocatedWfs.find(
          (w) => w.proc.line === anchor.line || w.proc.title === anchor.title,
        );
        if (!allocated) {
          const proc =
            analysis.procedures.find((p) => p.line === anchor.line) ??
            analysis.procedures.find((p) => p.title === anchor.title);
          if (proc) {
            let path = `workflows/${slugify(proc.title)}.md`;
            let n = 2;
            while (usedPaths.has(path)) path = `workflows/${slugify(proc.title)}-${n++}.md`;
            usedPaths.add(path);
            const endLine = proc.steps[proc.steps.length - 1]!.line;
            const canonicalSteps = proc.steps.map((step) => neutralizeRelativeLinks(step.text));
            const content = [
              `# ${proc.title}`,
              "",
              `> Documented procedure from source "${sourceLabel}" (lines ${proc.line}–${endLine}). Steps are verbatim from the source; relative links are shown as paths.`,
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
            allocated = { proc, path, canonicalSteps };
          }
        }

        if (allocated) {
          // Factual metadata (title, step count) is rendered from the
          // authoritative resolved full-source procedure, not from
          // prefix-snapshot anchor hints (C1-LB1). The label is bounded for
          // presentation only.
          renderedSteps.push(
            fitPlanItem(
              `Follow the documented procedure "${clipPlanText(allocated.proc.title, PLAN_LABEL_CHARS)}" (${allocated.proc.steps.length} steps) — see [${allocated.path}](${allocated.path}).`,
              PLAN_LIMITS.steps.maxItemChars,
            ),
          );
        } else {
          renderedSteps.push(atom.text);
        }
      }
    }
  }

  // Fallback for callers that passed steps without stepAtoms (e.g. manual plan or direct tests)
  let stepsToUse: string[];
  if (renderedSteps.length > 0) {
    stepsToUse = renderedSteps;
  } else if (rawPlan.steps.length > 0 || isCodebase) {
    stepsToUse = rawPlan.steps;
    // Backward compatibility: if steps contain Markdown links to unallocated files, materialize them
    const linkRe = /\[(?:[^\]]*)\]\(((?:references|workflows)\/([a-z0-9_.-]+)\.md)\)/g;
    for (const step of stepsToUse) {
      for (const m of step.matchAll(linkRe)) {
        const targetPath = m[1]!;
        const artifactId = m[2]!;
        if (usedPaths.has(targetPath)) continue;
        if (targetPath.startsWith("references/")) {
          const section = analysis.sections.find((s) => s.id === artifactId || slugify(s.heading) === artifactId);
          if (section) {
            const body = section.text.split("\n").slice(1).join("\n").trim();
            if (body.length >= 20) {
              usedPaths.add(targetPath);
              const canonicalBody = neutralizeRelativeLinks(body);
              const content = [
                `# ${section.heading}`,
                "",
                `> Excerpt from source "${sourceLabel}" (lines ${section.startLine}–${section.endLine}). Verbatim except for this header; relative links to the original repository are shown as paths instead of links.`,
                "",
                canonicalBody,
                "",
                `_Source: ${sourceLabel}, lines ${section.startLine}–${section.endLine}._`,
                "",
              ].join("\n");
              addFile(
                targetPath,
                content,
                `Verbatim source excerpt for the "${section.heading}" section, so the agent can consult the original guidance.`,
                { extraction: `section "${section.heading}"`, sourceLines: [section.startLine, section.endLine], sourceHeading: section.heading },
              );
              referenceLinks.push({ path: targetPath, heading: section.heading, range: `${section.startLine}–${section.endLine}` });
            }
          }
        } else if (targetPath.startsWith("workflows/") && !isCodebase) {
          const proc = analysis.procedures.find((p) => slugify(p.title) === artifactId);
          if (proc) {
            usedPaths.add(targetPath);
            const endLine = proc.steps[proc.steps.length - 1]!.line;
            const canonicalSteps = proc.steps.map((step) => neutralizeRelativeLinks(step.text));
            const content = [
              `# ${proc.title}`,
              "",
              `> Documented procedure from source "${sourceLabel}" (lines ${proc.line}–${endLine}). Steps are verbatim from the source; relative links are shown as paths.`,
              "",
              ...proc.steps.map((s, i) => `${i + 1}. ${canonicalSteps[i]} _(source line ${s.line})_`),
              "",
            ].join("\n");
            addFile(
              targetPath,
              content,
              `Documented procedure for "${proc.title}", with verbatim steps from the source.`,
              { extraction: `procedure "${proc.title}"`, sourceLines: [proc.line, endLine], sourceHeading: proc.title },
            );
            workflowLinks.push({ path: targetPath, title: proc.title, stepCount: proc.steps.length });
          }
        }
      }
    }
  } else {
    stepsToUse = derivePlanFromAnalysis(analysis).steps;
  }

  const plan: SkillPlan = {
    name,
    displayName,
    description,
    whenToUse: rawPlan.whenToUse.length > 0 || isCodebase ? rawPlan.whenToUse : derivePlanFromAnalysis(analysis).whenToUse,
    inputs: rawPlan.inputs.length > 0 || isCodebase ? rawPlan.inputs : derivePlanFromAnalysis(analysis).inputs,
    steps: dedupe(stepsToUse).slice(0, 20),
    constraints: rawPlan.constraints,
    verification: rawPlan.verification,
    pitfalls: rawPlan.pitfalls,
  };

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
        ? `${commentToken} Source: ${sourceLabel}, lines ${block.line}–${endLine} (under "${formatMetadataLabel(block.heading)}"). Verbatim code block.\n`
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
    `> Generated by SkillForge (\`${generatorId}\`) from ${formatCodeSpan(source.originalName)}. Every factual claim below is grounded in that source; explicit gaps are marked.`,
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
 *
 * Generation renders the source name through the shared untrusted-metadata
 * boundary (`formatMetadataLabel` / `formatCodeSpan`), so qualification must
 * use the *same* rendering to recognize the banner/header it owns. The raw
 * stored spelling is matched too, so records generated before that boundary
 * existed still lose their false provenance when edited.
 */
export function qualifyEditedFileContent(path: string, content: string, sourceName: string): string {
  const plain = formatMetadataLabel(sourceName);
  const codeSpan = formatCodeSpan(sourceName);
  /** Regex alternation over the rendered and legacy raw spellings. */
  const variants = (...forms: string[]) => {
    const unique = [...new Set(forms.filter((f) => f.length > 0))];
    // `(?!)` never matches, so an empty name can never produce an
    // alternation that matches arbitrary content.
    return unique.length > 0
      ? unique.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
      : "(?!)";
  };
  const name = variants(plain, sourceName);
  const spanName = variants(codeSpan, `\`${sourceName}\``);

  if (path === "SKILL.md") {
    // Only replace unedited generator grounding banner if still present
    const generatorBannerRe = new RegExp("^> Generated by SkillForge(?: \\([^\\n]*\\))? from (?:" + spanName + ")\\. Every factual claim below is grounded in that source; explicit gaps are marked\\.", "m");
    if (generatorBannerRe.test(content)) {
      return content.replace(
        generatorBannerRe,
        () => `> Generated by SkillForge from ${codeSpan} and edited after generation. The current file is no longer guaranteed to be fully source-derived; verify edited statements against the original source.`,
      );
    }
    return content;
  }

  if (path.startsWith("references/")) {
    let result = content;
    const refHeaderRe = new RegExp('^> Excerpt from source "(?:' + name + ')" \\(lines \\d+[-–]\\d+\\)\\. Verbatim except for this header; relative links to the original repository are shown as paths instead of links\\.', "m");
    if (refHeaderRe.test(result)) {
      result = result.replace(
        refHeaderRe,
        () => `> Originally generated from source "${plain}"; edited after generation. Current contents are not guaranteed verbatim and the original line-range provenance no longer applies.`,
      );
    }
    // Match the exact generator footer even when an edit appends text after it.
    const refFooterRe = new RegExp("^_Source: (?:" + name + "), lines \\d+[-–]\\d+\\._(?:\\n|$)", "m");
    result = result.replace(refFooterRe, "\n");
    return result;
  }

  if (path.startsWith("workflows/")) {
    let result = content;
    const wfHeaderRe = new RegExp('^> Documented procedure from source "(?:' + name + ')" \\(lines \\d+[-–]\\d+\\)\\. Steps are verbatim from the source; relative links are shown as paths\\.', "m");
    if (!wfHeaderRe.test(result)) return content;
    result = result.replace(
      wfHeaderRe,
      () => `> Documented procedure from source "${plain}"; edited after generation. Current steps are not guaranteed to be verbatim from the source.`,
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
    const exampleHeaderRe = new RegExp('^(//|#) Source: (?:' + name + '), lines \\d+[-–]\\d+ \\(under "[^\\n]*"\\)\\. Verbatim code block\\.\\n');
    if (exampleHeaderRe.test(content)) {
      return content.replace(
        exampleHeaderRe,
        (_match, token: string) => `${token} Originally generated from source: ${plain}; edited after generation.\n`,
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
