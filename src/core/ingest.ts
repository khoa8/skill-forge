/**
 * Stage 1 — Ingestion & normalization.
 *
 * Takes raw user input (pasted text/markdown, a bundled sample, or an uploaded
 * file) and produces a NormalizedSource with stable line numbering that every
 * later stage and provenance record refers to.
 *
 * Treated as untrusted input: size-bounded, entities decoded, HTML stripped.
 */
import { NormalizedSource, type SourceInput } from "./types.js";
import { sha256 } from "./util.js";

/** Hard upper bound for accepted source text (~1.5 MB). Keeps parsing bounded. */
export const MAX_SOURCE_BYTES = 1_500_000;
/** Sources shorter than this cannot produce a meaningful skill. */
export const MIN_SOURCE_CHARS = 40;

export class IngestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Strip simple HTML so pasted web copy doesn't leak tags into the skill. */
function stripHtml(text: string): { text: string; hadHtml: boolean } {
  const hadHtml = /<\/?[a-zA-Z][^>]*>/.test(text);
  if (!hadHtml) return { text, hadHtml };
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return { text: stripped, hadHtml };
}

export function normalizeSource(input: SourceInput): NormalizedSource {
  const byteLength = Buffer.byteLength(input.content, "utf8");
  if (byteLength > MAX_SOURCE_BYTES) {
    throw new IngestError(
      `Source is ${byteLength} bytes; the limit is ${MAX_SOURCE_BYTES}. Split the material and generate from the most relevant part.`,
      "source_too_large",
    );
  }
  if (input.content.trim().length < MIN_SOURCE_CHARS) {
    throw new IngestError(
      `Source has only ${input.content.trim().length} usable characters; at least ${MIN_SOURCE_CHARS} are needed to build a meaningful skill.`,
      "source_too_short",
    );
  }

  // Codebase mode ingests source code whose characters ARE the evidence:
  // markup, tags, and entities must survive untouched (inert text means
  // "do not execute", not "rewrite before analysis"). Only line endings are
  // normalized so provenance line numbers stay stable across platforms.
  const isCodebase = input.type === "github-codebase";

  const notes: string[] = [];
  let text = input.content.replace(/\r\n?/g, "\n");
  if (isCodebase) {
    // Preserve every interior character; only the very end is trimmed so the
    // trailing-newline convention (and lineCount) matches the docs path.
    text = text.replace(/\s+$/g, "") + "\n";
  } else {
    const html = stripHtml(text);
    text = html.text;
    if (html.hadHtml) notes.push("HTML markup was detected and stripped from the source.");
    text = decodeBasicEntities(text);
    // Drop trailing whitespace per line, collapse >2 blank lines to keep line
    // numbers stable while making headings detection reliable.
    text = text
      .split("\n")
      .map((l) => (l.trim().length === 0 ? "" : l.replace(/[ \t]+$/g, "")))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    text = text.replace(/\s+$/g, "") + "\n";
  }

  const lines = text.split("\n");
  if (lines.length === 0 || text.trim().length === 0) {
    throw new IngestError("Source is empty after normalization.", "source_empty");
  }
  // Drop the phantom trailing element so lineCount matches real 1-based lines.
  const contentLines = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const finalText = contentLines.join("\n");

  return {
    text: finalText,
    lineCount: contentLines.length,
    sha256: sha256(finalText),
    originalName: input.name,
    sourceType: input.type,
    // Adapter notes (truncation, redirects, skipped files) come first so the
    // normalization warnings read in ingestion order. Nothing is dropped.
    notes: [...(input.notes ?? []), ...notes],
    // Codebase mode carries the structured repository analysis through the
    // pipeline unchanged; every other source type has it absent.
    repository: input.repository,
  };
}

/** Return the requested line range (1-based, inclusive) from normalized text. */
export function sourceSlice(normalized: NormalizedSource, start: number, end: number): string {
  const lines = normalized.text.split("\n");
  const lo = Math.max(1, start);
  const hi = Math.min(lines.length, end);
  return lines.slice(lo - 1, hi).join("\n");
}
