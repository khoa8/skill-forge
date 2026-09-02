/**
 * Stage 2 — Analysis / knowledge & procedure extraction.
 *
 * A deterministic, line-based markdown/text analyzer. It deliberately does its
 * own parsing (instead of a markdown AST library) because every extraction
 * must carry exact source line numbers: provenance is a core product promise.
 *
 * Extracts: sections, fenced code blocks, runnable commands, ordered
 * procedures, warning lines, and constraint-style headings. Nothing here
 * invents content — it only indexes what the source actually says.
 */
import type {
  CodeBlock,
  DetectedCommand,
  NormalizedSource,
  Procedure,
  Section,
  SourceAnalysis,
} from "./types.js";
import { slugify } from "./util.js";

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*[^\n]*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SETEXT_H1_RE = /^(=+)\s*$/;
const SETEXT_H2_RE = /^(-{2,})\s*$/;
const ORDERED_ITEM_RE = /^\s{0,3}(\d+)[.)]\s+(.+)$/;
const PROMPT_RE = /^\s*(?:\$\s|>\s|PS>\s)/;
const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "zsh", "console", "terminal", "powershell", "pwsh", "cmd",
]);
const CONSTRAINING_HEADING_RE =
  /\b(constraint\w*|limitation\w*|caveat\w*|warning\w*|caution\w*|important|note|requirement\w*|prerequisite\w*|gotcha\w*|pitfall\w*|troubleshoot\w*|faq|error\w*|security|best practice|don'?t|do not)\b/i;
const CALLOUT_RE = /^\s{0,3}>\s*\[!(WARNING|CAUTION|NOTE|IMPORTANT|TIP)\]/i;
const INLINE_WARNING_RE =
  /^\s{0,3}(?:\*\*)?(?:warning|caution|important|note)(?:\*\*)?\s*[:!]\s+/i;

interface HeadingInfo {
  level: number;
  text: string;
  line: number;
  id: string;
}

function isFence(line: string): RegExpMatchArray | null {
  return line.match(FENCE_RE);
}

/** Parse headings outside of fenced code blocks (setext-style included). */
export function extractHeadings(lines: string[]): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  let fence: string | null = null;
  const usedIds = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = isFence(line);
    if (f) {
      const marker = f[1]!.charAt(0).repeat(3);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const atx = line.match(HEADING_RE);
    if (atx) {
      const level = atx[1]!.length;
      const text = atx[2]!.trim();
      const base = slugify(text, 64);
      const seen = usedIds.get(base) ?? 0;
      usedIds.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen + 1}`;
      headings.push({ level, text, line: i + 1, id });
      continue;
    }
    // Setext underline: previous non-empty line becomes the heading.
    if (i > 0) {
      const prev = lines[i - 1]!;
      if (prev.trim().length > 0 && !prev.match(HEADING_RE)) {
        if (line.match(SETEXT_H1_RE) && !prev.match(SETEXT_H2_RE)) {
          headings.push({ level: 1, text: prev.trim(), line: i, id: slugify(prev, 64) });
        } else if (line.match(SETEXT_H2_RE)) {
          headings.push({ level: 2, text: prev.trim(), line: i, id: slugify(prev, 64) });
        }
      }
    }
  }
  return headings;
}

export function analyzeSource(normalized: NormalizedSource): SourceAnalysis {
  const lines = normalized.text.split("\n");
  const headings = extractHeadings(lines);

  // --- Sections: each heading opens a section that runs to the next heading
  // of the same or higher level (or the next heading of any level for h2+ nesting).
  const sections: Section[] = [];
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]!;
    const next = headings[h + 1];
    let endLine = next ? next.line - 1 : lines.length;
    // Trim trailing blank lines from the section body.
    while (endLine > cur.line && lines[endLine - 1]!.trim().length === 0) endLine--;
    const text = lines.slice(cur.line - 1, endLine).join("\n");
    sections.push({
      id: cur.id,
      heading: cur.text,
      level: cur.level,
      startLine: cur.line,
      endLine,
      text,
    });
  }

  // --- Fenced code blocks, commands, procedures, warnings (single pass).
  const codeBlocks: CodeBlock[] = [];
  const commands: DetectedCommand[] = [];
  const procedures: Procedure[] = [];
  const warningLines: string[] = [];

  let fence: { marker: string; lang: string; start: number; body: string[] } | null = null;
  let currentHeading = "";
  let currentHeadingLevel = 0;
  let orderedBuffer: { text: string; line: number }[] = [];

  const flushOrdered = () => {
    // Procedures need at least 3 steps to be executable knowledge.
    if (orderedBuffer.length >= 3) {
      procedures.push({
        title: currentHeading.length > 0 ? currentHeading : "Procedure",
        steps: orderedBuffer.map((s) => ({ text: s.text, line: s.line })),
        line: orderedBuffer[0]!.line,
      });
    }
    orderedBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;

    const atx = raw.match(HEADING_RE);
    const fenceMatch = isFence(raw);

    if (fence !== null) {
      const marker = fenceMatch?.[1]!.charAt(0).repeat(3);
      if (marker && marker === fence.marker) {
        // Close fence.
        const code = fence.body.join("\n");
        codeBlocks.push({
          language: fence.lang,
          code,
          heading: currentHeading,
          line: fence.start,
        });
        if (SHELL_LANGS.has(fence.lang)) {
          for (const cl of fence.body) {
            const stripped = cl.replace(PROMPT_RE, "").trim();
            if (stripped.length > 0 && !stripped.startsWith("#")) {
              commands.push({ raw: stripped, heading: currentHeading, line: fence.start });
            }
          }
        }
        fence = null;
      } else {
        fence.body.push(raw);
      }
      continue;
    }

    if (fenceMatch) {
      fence = { marker: fenceMatch[1]!.charAt(0).repeat(3), lang: (fenceMatch[2] ?? "").toLowerCase(), start: lineNo, body: [] };
      continue;
    }

    if (atx) {
      flushOrdered();
      currentHeading = atx[2]!.trim();
      currentHeadingLevel = atx[1]!.length;
      continue;
    }

    // Setext heading underlines flip the current heading context.
    if (i > 0 && raw.match(SETEXT_H1_RE) && lines[i - 1]!.trim().length > 0) {
      flushOrdered();
      currentHeading = lines[i - 1]!.trim();
      currentHeadingLevel = 1;
      continue;
    }
    if (i > 0 && raw.match(SETEXT_H2_RE) && lines[i - 1]!.trim().length > 0) {
      flushOrdered();
      currentHeading = lines[i - 1]!.trim();
      currentHeadingLevel = 2;
      continue;
    }

    const ordered = raw.match(ORDERED_ITEM_RE);
    if (ordered) {
      orderedBuffer.push({ text: ordered[2]!.trim(), line: lineNo });
      continue;
    }
    if (raw.trim().length > 0 && !raw.match(/^\s{0,3}[-*+]\s/)) {
      // Any non-blank, non-bullet line ends an ordered run.
      if (orderedBuffer.length > 0) flushOrdered();
    }

    if (CALLOUT_RE.test(raw) || INLINE_WARNING_RE.test(raw)) {
      // Merge wrapped continuation lines so warnings are not truncated
      // mid-sentence; stop at a blank line or sentence-ending punctuation.
      let text = raw.replace(/^\s{0,3}>\s*/, "").trim();
      let j = i + 1;
      while (j < lines.length && j - i < 4) {
        const next = lines[j]!.trim();
        if (next.length === 0) break;
        if (/[.!?:]$/.test(text)) break;
        if (next.match(HEADING_RE) || next.match(ORDERED_ITEM_RE) || isFence(next)) break;
        text += " " + next.replace(/^\s{0,3}>\s*/, "");
        j++;
      }
      warningLines.push(text);
    }
  }
  flushOrdered();

  // --- Title & intro.
  const h1 = headings.find((h) => h.level === 1);
  let title = h1?.text ?? "";
  let titleLine = h1?.line ?? 0;
  if (title.length === 0) {
    const firstMeaningful = lines.findIndex((l) => l.trim().length > 0);
    if (firstMeaningful >= 0) {
      title = lines[firstMeaningful]!.replace(/^#+\s*/, "").trim().slice(0, 120);
      titleLine = firstMeaningful + 1;
    }
  }

  let intro = "";
  for (let i = titleLine; i < lines.length && intro.length < 600; i++) {
    const line = lines[i]!;
    if (line.match(HEADING_RE)) {
      if (intro.trim().length > 0) break;
      continue;
    }
    if (isFence(line)) break;
    if (line.trim().length === 0) {
      if (intro.trim().length > 80) break;
      continue;
    }
    intro += (intro.length > 0 ? " " : "") + line.trim();
  }
  intro = intro.trim();

  const constraintHeadings = headings
    .filter((h) => h.level <= 3 && CONSTRAINING_HEADING_RE.test(h.text))
    .map((h) => h.text);

  return {
    title: title.length > 0 ? title : normalized.originalName,
    intro,
    sections,
    codeBlocks,
    commands,
    procedures,
    constraintHeadings,
    warningLines,
    lineCount: normalized.lineCount,
  };
}

/**
 * Extract candidate "runnable tokens" from generated markdown: shell commands
 * and flag-like tokens. Used by the grounding validator to compare generated
 * instructions against what the source actually contained.
 */
export function extractCommandTokens(text: string): string[] {
  const tokens = new Set<string>();
  let inFence = false;
  let fenceMarker = "";
  for (const line of text.split("\n")) {
    const f = line.match(FENCE_RE);
    if (f) {
      const marker = f[1]!.charAt(0).repeat(3);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (!inFence) continue;
    const stripped = line.replace(PROMPT_RE, "").trim();
    if (stripped.length === 0 || stripped.startsWith("#")) continue;
    const first = stripped.split(/\s+/)[0]!;
    if (/^[a-zA-Z][a-zA-Z0-9._/@+-]{1,}$/.test(first)) tokens.add(first.toLowerCase());
  }
  return [...tokens];
}
