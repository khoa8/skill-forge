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
 * Format a string safely as a CommonMark inline code span.
 *
 * Prevents untrusted metadata (such as repository file paths, scopes, or package names)
 * from breaking out of code spans into Markdown headings, lists, or instructions.
 * Strips/normalizes line breaks and control characters, and applies CommonMark
 * delimiter sizing (surrounds with N+1 backticks when the text contains backticks).
 */
export function formatCodeSpan(rawText: string): string {
  const clean = rawText.replace(/[\r\n\u2028\u2029\x00-\x1f\x7f-\x9f]+/g, " ").trim();
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
