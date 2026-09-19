/**
 * Local file and directory source adapter — bounded ingestion.
 *
 * Server-side paths only, restricted to an allowlist root (project workspace
 * or an explicitly configured docs directory). Safety rules:
 * - paths must resolve inside the allowed root (no traversal via symlink or ..);
 * - extension allowlist for text formats; size-bounded per file and in total;
 * - accepted content is read through a bounded file handle (O_NOFOLLOW open,
 *   handle-level regular-file verification, actual-byte caps), never through
 *   an unbounded pathname read trusting stale pre-read size metadata;
 * - directory ingestion is non-recursive by default, recursive only with an
 *   explicit flag, bounded depth and file count;
 * - no code execution — files are read as text only.
 *
 * Threat model: ordinary pathname/symlink containment for trusted self-hosted
 * use. Reads resist final-component file-to-symlink replacement and
 * concurrently growing files. Atomic containment against a malicious local
 * process concurrently replacing parent directories is not claimed.
 */
import { open, opendir, stat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, relative, extname, basename, isAbsolute, sep } from "node:path";
import type { Dirent } from "node:fs";
import type { SourceInput } from "../types.js";
import { formatMetadataLabel } from "../util.js";

export const MAX_FILE_BYTES = 800_000; // per file
export const MAX_TOTAL_BYTES = 1_400_000; // combined (under ingest's 1.5 MB cap)
export const MAX_FILES = 40;
export const MAX_DEPTH = 6;
export const MAX_VISITED_ENTRIES = 10_000;

/** Documentation-like text extensions shared by the file and GitHub adapters. */
export const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml", ".toml",
]);

export class FileSourceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FileSourceError";
  }
}

/**
 * The single root SkillForge may read documentation from. Defaults to the
 * project workspace; override with SKILLFORGE_DOCS_ROOT for other locations.
 * Outside tests, this bounds all filesystem reads.
 */
export function allowedRoot(): string {
  return process.env.SKILLFORGE_DOCS_ROOT?.trim() || process.cwd();
}

/** Resolve a user-supplied path against the root and verify containment. */
export async function resolveInsideRoot(root: string, userPath: string): Promise<string> {
  if (userPath.includes("\u0000")) {
    throw new FileSourceError("Path contains a null byte.", "file_bad_path");
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = root;
  }
  // Absolute paths are resolved as-is (then containment-checked); relative
  // paths join under the root. join() would otherwise silently re-root an
  // absolute segment inside the root, masking the escape attempt.
  const candidate = isAbsolute(userPath) ? userPath : join(root, ".", userPath);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new FileSourceError(`"${userPath}" does not exist within the allowed root.`, "file_not_found");
  }
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) {
    throw new FileSourceError(
      `"${userPath}" resolves outside the allowed root. Set SKILLFORGE_DOCS_ROOT to widen access deliberately.`,
      "file_outside_root",
    );
  }
  return real;
}

export interface CollectedFile {
  path: string; // relative to root, POSIX separators
  content: string;
}

/** Chunk size for bounded handle reads. At most MAX_FILE_BYTES + 1 bytes are
 * ever read, so an over-limit file is detected with one sentinel byte and
 * without unbounded growth. */
const READ_CHUNK_BYTES = 64 * 1024;

function abortError(): FileSourceError {
  return new FileSourceError("The request was aborted by the client.", "file_aborted");
}

/**
 * Read a text file through its opened handle, bounding actual bytes.
 *
 * The file must already have passed ordinary containment and extension
 * checks. The open uses O_NOFOLLOW (same defensive pattern as the PDF
 * adapter), so a final component swapped to a symlink after earlier pathname
 * checks is refused instead of followed. The opened object is verified as a
 * regular file through the handle, and at most MAX_FILE_BYTES + 1 actual
 * bytes are read: the pre-read stat size is never authoritative, so a file
 * that grew after stat cannot bypass the byte budget. Cancellation is checked
 * on every chunk and the handle is always closed.
 */
async function readBoundedTextFile(
  absolute: string,
  opts: { signal?: AbortSignal },
): Promise<{ content: string; bytes: number }> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError();
  let handle: FileHandle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (signal?.aborted) throw abortError();
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new FileSourceError(
        `"${basename(absolute)}" was refused: the file changed into a symlink before it could be read.`,
        "file_outside_root",
      );
    }
    if (code === "ENOENT") {
      throw new FileSourceError(`"${basename(absolute)}" is no longer available.`, "file_not_found");
    }
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new FileSourceError(`"${basename(absolute)}" is not a regular file.`, "file_not_found");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let position = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      // Clamp the final read so overflow detection costs at most one sentinel
      // byte past the cap. size <= MAX_FILE_BYTES holds at this point
      // (overflow throws below), so want >= 1 and the loop always terminates:
      // EOF yields bytesRead 0 while any other read grows size.
      const want = Math.min(READ_CHUNK_BYTES, MAX_FILE_BYTES + 1 - size);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      size += bytesRead;
      if (size > MAX_FILE_BYTES) {
        throw new FileSourceError(
          `"${basename(absolute)}" exceeds the per-file limit of ${(MAX_FILE_BYTES / 1000).toFixed(0)} KB; over-limit bytes were not retained.`,
          "file_too_large",
        );
      }
      chunks.push(buf.subarray(0, bytesRead));
    }
    if (signal?.aborted) throw abortError();
    return { content: Buffer.concat(chunks, size).toString("utf8"), bytes: size };
  } finally {
    await handle.close();
  }
}

/** Read a file (with extension + size checks) or walk a bounded directory. */
export async function collectFiles(
  userPath: string,
  opts: { recursive?: boolean; signal?: AbortSignal; /** May lower, never raise, the traversal budget. */ maxVisitedEntries?: number } = {},
): Promise<{ files: CollectedFile[]; skipped: string[] }> {
  if (opts.signal?.aborted) {
    throw new FileSourceError("The request was aborted by the client.", "file_aborted");
  }
  const root = allowedRoot();
  const realRoot = await realpath(root).catch(() => root);
  const absolute = await resolveInsideRoot(root, userPath);
  if (opts.signal?.aborted) {
    throw new FileSourceError("The request was aborted by the client.", "file_aborted");
  }
  const info = await stat(absolute);
  const skipped: string[] = [];

  if (info.isFile()) {
    if (opts.signal?.aborted) {
      throw new FileSourceError("The request was aborted by the client.", "file_aborted");
    }
    const ext = extname(absolute).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      throw new FileSourceError(
        `"${basename(absolute)}" has extension "${ext || "(none)"}"; supported: ${[...TEXT_EXTENSIONS].join(", ")}.`,
        "file_bad_extension",
      );
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new FileSourceError(
        `"${basename(absolute)}" is ${(info.size / 1000).toFixed(0)} KB; the per-file limit is ${(MAX_FILE_BYTES / 1000).toFixed(0)} KB.`,
        "file_too_large",
      );
    }
    // Fast path only: the authoritative per-file cap is enforced on actual
    // bytes by the bounded handle read below, so stale stat metadata cannot
    // bypass the budget.
    const { content } = await readBoundedTextFile(absolute, { signal: opts.signal });
    if (opts.signal?.aborted) {
      throw new FileSourceError("The request was aborted by the client.", "file_aborted");
    }
    return { files: [{ path: relative(root, absolute).split(sep).join("/"), content }], skipped };
  }

  const budget = opts.maxVisitedEntries ?? MAX_VISITED_ENTRIES;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_VISITED_ENTRIES) {
    throw new FileSourceError(`Traversal budget must be an integer from 1 to ${MAX_VISITED_ENTRIES}.`, "file_bad_budget");
  }
  let visited = 0;
  let traversalStopped = false;
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  await walk(realRoot, absolute, 0, opts.recursive ?? false, files, skipped, new Set());
  if (opts.signal?.aborted) {
    throw new FileSourceError("The request was aborted by the client.", "file_aborted");
  }
  if (files.length === 0) {
    throw new FileSourceError(
      `No supported documentation files (${[...TEXT_EXTENSIONS].slice(0, 5).join(", ")}…) found under "${userPath}".${traversalStopped ? ` ${skipped[skipped.length - 1]}` : ""}`,
      "file_none_found",
    );
  }
  files.sort((a, b) => compareNames(a.path, b.path));
  return { files, skipped };

  async function walk(
    rootDir: string,
    dir: string,
    depth: number,
    recursive: boolean,
    out: CollectedFile[],
    skipped: string[],
    seen: Set<string>,
  ): Promise<void> {
    if (opts.signal?.aborted) {
      throw new FileSourceError("The request was aborted by the client.", "file_aborted");
    }
    if (traversalStopped) return;
    if (depth > MAX_DEPTH) {
      skipped.push(`${dir}: max depth ${MAX_DEPTH} exceeded`);
      return;
    }
    if (seen.has(dir)) return; // symlink cycle guard
    seen.add(dir);
    const entries: Dirent[] = [];
    try {
      // Incremental enumeration bounds memory/work even for huge ignored directories.
      // Do not select from an incomplete listing: its prefix is platform-dependent.
      const directory = await opendir(dir, { bufferSize: 1 });
      for await (const entry of directory) {
        if (opts.signal?.aborted) throw new FileSourceError("The request was aborted by the client.", "file_aborted");
        visited++;
        if (visited >= budget) {
          traversalStopped = true;
          skipped.push(`stopped: traversal entry limit (${budget}) reached; ${relative(rootDir, dir).split(sep).join("/")}/ listing may be incomplete and was omitted`);
          return;
        }
        entries.push(entry);
      }
    } catch (err) {
      if (opts.signal?.aborted || err instanceof FileSourceError) {
        throw new FileSourceError("The request was aborted by the client.", "file_aborted");
      }
      skipped.push(`${dir}: unreadable`);
      return;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));
    for (const entry of entries) {
      if (opts.signal?.aborted) {
        throw new FileSourceError("The request was aborted by the client.", "file_aborted");
      }
      if (traversalStopped) return;
      if (out.length >= MAX_FILES) {
        skipped.push(`stopped: file limit (${MAX_FILES}) reached`);
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) {
          skipped.push(`${relative(rootDir, full).split(sep).join("/")}/: subdirectory (enable recursive)`);
          continue;
        }
        await walk(rootDir, full, depth + 1, recursive, out, skipped, seen);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push(`${entry.name}: not a regular file`);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      const rel = relative(rootDir, full).split(sep).join("/");
      const info = await stat(full).catch(() => null);
      if (!info) {
        skipped.push(`${rel}: stat failed`);
        continue;
      }
      // Pre-read sizes are a fast path only. A stale individually-oversized
      // size skips just that file; the combined total is decided from actual
      // accepted bytes below, so stale metadata can neither bypass either
      // budget nor stop collection before the real total is reached.
      if (info.size > MAX_FILE_BYTES) {
        skipped.push(`${rel}: too large (${(info.size / 1000).toFixed(0)} KB)`);
        continue;
      }
      let content: string;
      let bytes: number;
      try {
        ({ content, bytes } = await readBoundedTextFile(full, { signal: opts.signal }));
      } catch (err) {
        if (err instanceof FileSourceError && err.code === "file_aborted") throw err;
        if (err instanceof FileSourceError && err.code === "file_too_large") {
          skipped.push(`${rel}: too large (exceeds ${(MAX_FILE_BYTES / 1000).toFixed(0)} KB during read; bytes not retained)`);
          continue;
        }
        if (opts.signal?.aborted) throw new FileSourceError("The request was aborted by the client.", "file_aborted");
        // Symlink refusal, vanished files, and unreadable files are skipped
        // honestly without leaking filesystem diagnostics.
        skipped.push(`${rel}: unreadable`);
        continue;
      }
      if (totalBytes + bytes > MAX_TOTAL_BYTES) {
        skipped.push(`${rel}: total size limit reached`);
        return;
      }
      totalBytes += bytes;
      out.push({ path: rel, content });
    }
  }
}

/** UTF-16 code-unit ordering, independent of filesystem order and locale. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Build a SourceInput from collected files. Multi-file sources are joined
 * with synthetic `# path` headers so the analyzer keeps per-file structure
 * and provenance line numbers remain meaningful within the combined text.
 *
 * The header label is untrusted metadata: it goes through the shared
 * single-line rendering boundary first, so a pathname containing line breaks
 * or control characters cannot create additional Markdown blocks (or any
 * other attacker-authored structure) for the analyzer to treat as source.
 * The raw path is preserved everywhere it is *stored* (the source name below,
 * provenance records, persistence). */
export function combineFiles(files: CollectedFile[], name?: string): SourceInput {
  if (files.length === 1) {
    return { type: "file", name: name ?? files[0]!.path, content: files[0]!.content };
  }
  const content = files
    .map((f) => `# ${formatMetadataLabel(f.path)}\n\n${f.content.trimEnd()}\n`)
    .join("\n\n");
  return {
    type: "file",
    name: name ?? `${files.length} files: ${files[0]!.path} (+${files.length - 1} more)`,
    content,
  };
}
