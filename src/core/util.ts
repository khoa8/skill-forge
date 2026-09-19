import { createHash } from "node:crypto";

/** Lowercase ASCII slug suitable for skill ids, file names, and headings anchors. */
export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Refuse package paths that could escape the package directory (zip-slip),
 * be absolute, collide, or contain characters that break downstream tooling.
 * Returns null when the path is unsafe; the caller decides how to report it.
 */
export function safePackagePath(rawPath: string): string | null {
  if (rawPath.length === 0 || rawPath.length > 256) return null;
  if (rawPath.includes("\\")) return null;
  if (rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath)) return null;
  const segments = rawPath.split("/");
  const clean: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue; // duplicate/empty segments normalized
    if (seg === "..") return null; // traversal
    if (/[\u0000-\u001f\u007f]/.test(seg)) return null;
    clean.push(seg);
  }
  if (clean.length === 0) return null;
  const normalized = clean.join("/");
  // Reserved names that would be confusing or dangerous at package root.
  if (clean.length === 1 && (normalized === "." || normalized === "..")) return null;
  return normalized;
}

/** Join two already-validated package paths (used by exporters). */
export function joinPackagePath(...parts: string[]): string {
  const joined = parts.filter((p) => p.length > 0).join("/");
  const safe = safePackagePath(joined);
  if (safe === null) {
    throw new Error(`Unsafe package path produced by exporter: ${joined}`);
  }
  return safe;
}

/** Marker replacing redacted credential occurrences in diagnostics. */
export const REDACTED = "[REDACTED]";

/**
 * Replace every exact occurrence of `secret` in `text` with [REDACTED].
 * No-ops safely on empty/undefined inputs, so callers can apply it
 * unconditionally to any diagnostics text that might embed a credential
 * (remote response bodies, transport error messages). The invariant: the
 * configured API key must never leave the provider adapter in cleartext.
 */
export function redactSecret(text: string | undefined | null, secret: string | undefined | null): string {
  if (!text) return "";
  if (!secret || secret.length === 0) return text;
  return text.split(secret).join(REDACTED);
}

/**
 * Render untrusted metadata as single-line plain presentation text.
 *
 * Source names, imported file paths, and headings used as *labels* are
 * identity, not content: they must never be able to escape the presentation
 * context they are rendered into. Collapsing line/paragraph separators
 * (LF, CR, U+2028, U+2029) and C0/C1 control characters into single spaces
 * makes that structurally impossible in every context SkillForge renders
 * metadata into — Markdown blockquotes/headings, source-code comment
 * headers, and provider prompt lines.
 *
 * The raw value stays authoritative everywhere it is *stored* (manifest
 * JSON, persisted source records): JSON serialization already provides
 * structural escaping, so identity is never rewritten at the ingestion
 * boundary, only rendered safely at each presentation boundary.
 */
export function formatMetadataLabel(rawText: string): string {
  return rawText.replace(/[\r\n\u2028\u2029\x00-\x1f\x7f-\x9f]+/g, " ").trim();
}

/**
 * Format a string safely as a CommonMark inline code span.
 *
 * Prevents untrusted metadata (such as repository file paths, scopes, or package names)
 * from breaking out of code spans into Markdown headings, lists, or instructions.
 * Strips/normalizes line breaks and control characters, and applies CommonMark
 * delimiter sizing (surrounds with N+1 backticks when the text contains backticks).
 */
export function formatCodeSpan(rawText: string): string {
  const clean = formatMetadataLabel(rawText);
  if (clean.length === 0) return "``";

  const matches = clean.match(/`+/g);
  let maxBackticks = 0;
  if (matches) {
    for (const m of matches) {
      if (m.length > maxBackticks) maxBackticks = m.length;
    }
  }
  const delimiter = "`".repeat(maxBackticks + 1);
  const padded = clean.startsWith("`") || clean.endsWith("`") ? ` ${clean} ` : clean;
  return `${delimiter}${padded}${delimiter}`;
}

// ---------------------------------------------------------------------------
// Bounded presentation rendering
//
// Length limits belong to semantic *ingredients*, never to a finished
// syntax-bearing string: slicing rendered Markdown can cut a delimiter in half
// or drop a mandatory clause. These helpers shorten RAW metadata first and
// render afterwards, so every generated delimiter is closed by construction.
// ---------------------------------------------------------------------------

/**
 * Shorten RAW metadata to a presentation budget, marking the elision with an
 * ellipsis.
 *
 * Always applied to the raw label *before* it is rendered into any
 * syntax-bearing form. The full value stays authoritative in structured JSON
 * (manifest, persisted record); only its bounded presentation is shortened.
 */
export function boundLabel(rawText: string, maxChars: number): string {
  const flat = formatMetadataLabel(rawText);
  if (flat.length <= maxChars) return flat;
  if (maxChars <= 0) return "";
  if (maxChars === 1) return "…";
  return flat.slice(0, maxChars - 1).trimEnd() + "…";
}

/**
 * Render a RAW label as a CommonMark inline code span that fits `budget`.
 *
 * `formatCodeSpan` sizes its delimiter to the longest backtick run in the
 * label, so its overhead is not a constant. The label is therefore shortened
 * as RAW text and re-rendered until the *rendered* span fits; the closing
 * delimiter is always generated after the shortening decision, so the result
 * is balanced by construction. Returns "" when no span can fit.
 */
export function renderCodeSpanFitting(rawText: string, budget: number): string {
  if (budget <= 0) return "";
  const flat = formatMetadataLabel(rawText);
  const full = formatCodeSpan(flat);
  if (full.length <= budget) return full;

  // Each step removes at least the observed overflow, so the loop terminates;
  // a pathological backtick run bottoms out at a one-character label.
  let labelBudget = Math.max(1, budget - 2);
  let candidate = formatCodeSpan(boundLabel(flat, labelBudget));
  for (let i = 0; i < 8 && candidate.length > budget && labelBudget > 1; i++) {
    labelBudget = Math.max(1, labelBudget - (candidate.length - budget));
    candidate = formatCodeSpan(boundLabel(flat, labelBudget));
  }
  if (candidate.length <= budget) return candidate;
  const minimal = formatCodeSpan("…");
  return minimal.length <= budget ? minimal : "";
}

/** Minimum rendered width for one label in a bounded list, so a list degrades
 * by dropping whole labels instead of emitting unreadable stubs. */
const MIN_LIST_LABEL_CHARS = 6;

/**
 * Render an ordered list of RAW labels as inline code spans inside `budget`.
 *
 * Deterministic degradation: the budget is water-filled across the labels (a
 * short label keeps its full form instead of being averaged down by a long
 * sibling), and when the tail cannot be represented at a readable width it is
 * dropped and reported as `(and N more)` — a rendered span is never sliced.
 * Returns "" when nothing readable fits.
 */
export function renderCodeSpanList(rawLabels: readonly string[], budget: number): string {
  const labels = rawLabels.map((label) => formatMetadataLabel(label)).filter((label) => label.length > 0);
  if (labels.length === 0 || budget <= 0) return "";
  const separator = ", ";
  for (let count = labels.length; count >= 1; count--) {
    const omitted = labels.length - count;
    const more = omitted > 0 ? ` (and ${omitted} more)` : "";
    const available = budget - more.length - separator.length * (count - 1);
    if (available < count * MIN_LIST_LABEL_CHARS) continue;
    const shown = labels.slice(0, count);
    const budgets = allocateByNeed(shown.map((label) => formatCodeSpan(label).length), available);
    const rendered = shown.map((label, i) => renderCodeSpanFitting(label, budgets[i]!));
    if (rendered.some((part) => part.length === 0)) continue;
    const text = rendered.join(separator) + more;
    if (text.length <= budget) return text;
  }
  return "";
}

/**
 * One dynamic slot of a bounded plan item.
 *
 * Slots carry RAW metadata; the renderer decides how to present it inside the
 * share of the item budget it is given.
 */
export type BoundedItemSlot =
  /** A metadata label rendered as an inline code span. */
  | { kind: "span"; raw: string }
  /** A metadata label rendered as bounded plain text (delimiter-free). */
  | { kind: "plain"; raw: string }
  /** An ordered list of metadata labels rendered as inline code spans. */
  | { kind: "spans"; raw: readonly string[] };

/**
 * Compose a bounded plan item from fixed template text and metadata slots.
 *
 * `template.length === slots.length + 1`; the result is
 * `template[0] + slot0 + template[1] + slot1 + … + template[n]`.
 *
 * Fixed template text is emitted verbatim and consumes the budget FIRST, so
 * mandatory semantics (scope honesty, what the item instructs, fixed
 * punctuation) can never be displaced by metadata length. Whatever remains is
 * shared between the slots with unused share rolling forward to later slots,
 * and every slot renders RAW metadata through the bounded rendering helpers —
 * no rendered string is ever sliced.
 */
export function composeBoundedItem(
  template: readonly string[],
  slots: readonly BoundedItemSlot[],
  limit: number,
): string {
  const fixedChars = template.reduce((total, part) => total + part.length, 0);
  const budgets = allocateSlotBudgets(slots, Math.max(0, limit - fixedChars));
  const rendered = slots.map((slot, i) => renderBoundedSlot(slot, budgets[i]!));
  let out = template[0] ?? "";
  for (let i = 0; i < rendered.length; i++) out += rendered[i]! + (template[i + 1] ?? "");
  return out;
}

/** Rendered length a slot would have with an unlimited budget. */
function desiredSlotLength(slot: BoundedItemSlot): number {
  switch (slot.kind) {
    case "span":
      return formatCodeSpan(slot.raw).length;
    case "plain":
      return formatMetadataLabel(slot.raw).length;
    case "spans":
      return slot.raw
        .map((label) => formatMetadataLabel(label))
        .filter((label) => label.length > 0)
        .map((label) => formatCodeSpan(label).length)
        .reduce((total, length, i) => total + length + (i > 0 ? 2 : 0), 0);
  }
}

/**
 * Split `available` characters across `needs` deterministically.
 *
 * Equal-share with redistribution (water filling): every entry first receives
 * an equal share of what is left, and any share it does not need flows back to
 * the entries that still want more. This keeps a short label from being starved
 * just because a sibling is long, and it is fully deterministic — order is
 * fixed by the caller and no locale/random input is involved.
 */
function allocateByNeed(needs: readonly number[], available: number): number[] {
  const budgets = needs.map(() => 0);
  let remaining = available;
  let pending = needs.map((_, i) => i).filter((i) => needs[i]! > 0);
  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    if (share <= 0) break;
    const stillPending: number[] = [];
    for (const i of pending) {
      const give = Math.min(needs[i]! - budgets[i]!, share);
      budgets[i]! += give;
      remaining -= give;
      if (budgets[i]! < needs[i]!) stillPending.push(i);
    }
    // No entry was satisfied this round: every remaining entry already holds
    // its equal share, so another round cannot change anything.
    if (stillPending.length === pending.length) break;
    pending = stillPending;
  }
  // Hand the sub-entry remainder to the highest-priority (first) entry.
  if (pending.length > 0 && remaining > 0) budgets[pending[0]!]! += remaining;
  return budgets;
}

function allocateSlotBudgets(slots: readonly BoundedItemSlot[], available: number): number[] {
  return allocateByNeed(slots.map(desiredSlotLength), available);
}

function renderBoundedSlot(slot: BoundedItemSlot, share: number): string {
  switch (slot.kind) {
    case "span":
      return renderCodeSpanFitting(slot.raw, share);
    case "plain":
      return boundLabel(slot.raw, share);
    case "spans":
      return renderCodeSpanList(slot.raw, share);
  }
}
