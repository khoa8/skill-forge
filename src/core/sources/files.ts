/**
 * Local file and directory source adapter — bounded ingestion.
 *
 * Server-side paths only, restricted to an allowlist root (project workspace
 * or an explicitly configured docs directory). Safety rules:
 * - paths must resolve inside the allowed root (no traversal via symlink or ..);
 * - extension allowlist for text formats; size-bounded per file and in total;
 * - directory ingestion is non-recursive by default, recursive only with an
 *   explicit flag, bounded depth and file count;
 * - file contents are read through O_NOFOLLOW handle opens with fstat type
 *   checks and capped actual-byte reads, so a file swapped for a symlink (or
 *   grown) between the metadata check and the read cannot leak outside-root
 *   bytes or exceed the byte budgets via stale stat sizes;
 * - no code execution — files are read as text only.
 *
 * Residual limitation (documented, not claimed away): O_NOFOLLOW binds only
 * the final path component. A parent directory swapped for a symlink and held
 * in place across both the containment re-check and the handle open could
 * still redirect a read. The re-checks below close persistent swaps; a
 * transient toggle confined to the check-to-open window is not fully
 * closable with portable Node APIs (it would need openat-style
 * directory-relative resolution).
 */
import { open, opendir, stat, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, extname, basename, isAbsolute, sep } from "node:path";
import type { Dirent } from "node:fs";
import type { SourceInput } from "../types.js";

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

/** Chunk size for capped handle reads. */
const READ_CHUNK_BYTES = 64 * 1024;

function abortError(): FileSourceError {
  return new FileSourceError("The request was aborted by the client.", "file_aborted");
}

/** True when `realPath` lies outside the resolved allowlist root. */
function isOutsideRoot(realRoot: string, realPath: string): boolean {
  const rel = relative(realRoot, realPath);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel);
}

/**
 * Open a path for reading without following a swapped final symlink,
 * mirroring the PDF adapter. ELOOP callers map to containment refusal;
 * every other open failure propagates to the caller.
 */
async function openForRead(path: string, signal?: AbortSignal): Promise<FileHandle> {
  if (signal?.aborted) throw abortError();
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw err;
  }
}

/**
 * Read at most `cap + 1` bytes from an open handle so growth between the
 * metadata check and the read is observed, not trusted. Returns the decoded
 * text, the exact bytes accepted, and whether the cap was exceeded.
 */
async function readCapped(
  handle: FileHandle,
  cap: number,
  signal?: AbortSignal,
): Promise<{ content: string; bytes: number; overflow: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, cap + 1));
  for (;;) {
    if (signal?.aborted) throw abortError();
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, cap + 1 - bytes), null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    if (bytes > cap) {
      overflow = true;
      break;
    }
  }
  return { content: Buffer.concat(chunks).toString("utf8"), bytes, overflow };
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
    // Handle-bound read: O_NOFOLLOW refuses a final component swapped for a
    // symlink after the containment check, fstat re-verifies the type, and
    // the capped read enforces MAX_FILE_BYTES on actual bytes — not on the
    // stale stat size above (which remains only as a fast path).
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await openForRead(absolute, opts.signal);
      } catch (err) {
        if (err instanceof FileSourceError) throw err;
        if ((err as NodeJS.ErrnoException)?.code === "ELOOP") {
          throw new FileSourceError(
            `"${basename(absolute)}" resolves outside the allowed root. Set SKILLFORGE_DOCS_ROOT to widen access deliberately.`,
            "file_outside_root",
          );
        }
        throw err;
      }
      if (opts.signal?.aborted) throw abortError();
      // A parent directory held swapped for an outside symlink across the
      // initial check would still redirect this open; refuse persistent swaps.
      const realAgain = await realpath(absolute).catch(() => null);
      if (realAgain === null || isOutsideRoot(realRoot, realAgain)) {
        throw new FileSourceError(
          `"${basename(absolute)}" resolves outside the allowed root. Set SKILLFORGE_DOCS_ROOT to widen access deliberately.`,
          "file_outside_root",
        );
      }
      if (!(await handle.stat()).isFile()) {
        throw new FileSourceError(`"${basename(absolute)}" is no longer a regular file.`, "file_not_found");
      }
      const read = await readCapped(handle, MAX_FILE_BYTES, opts.signal);
      if (opts.signal?.aborted) {
        throw new FileSourceError("The request was aborted by the client.", "file_aborted");
      }
      if (read.overflow) {
        throw new FileSourceError(
          `"${basename(absolute)}" exceeds the per-file limit of ${(MAX_FILE_BYTES / 1000).toFixed(0)} KB.`,
          "file_too_large",
        );
      }
      const content = read.content;
      return { files: [{ path: relative(root, absolute).split(sep).join("/"), content }], skipped };
    } finally {
      await handle?.close().catch(() => {});
    }
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
    // Re-verify containment at use time: a directory replaced by an outside
    // symlink after the parent enumeration must not be descended into. This
    // closes persistent swaps; see the module header for the residual window.
    const realDir = await realpath(dir).catch(() => null);
    if (realDir === null || isOutsideRoot(rootDir, realDir)) {
      skipped.push(`${relative(rootDir, dir).split(sep).join("/") || dir}: resolves outside the allowed root`);
      return;
    }
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
      // Refuse a file whose parent chain persistently resolves outside the
      // root at use time; the O_NOFOLLOW open below then atomically refuses a
      // swapped final symlink, and the capped read enforces the byte budgets
      // on actual bytes rather than the stale sizes below.
      const realFull = await realpath(full).catch(() => null);
      if (realFull === null) {
        skipped.push(`${rel}: stat failed`);
        continue;
      }
      if (isOutsideRoot(rootDir, realFull)) {
        skipped.push(`${rel}: resolves outside the allowed root`);
        continue;
      }
      let fileHandle: FileHandle | undefined;
      try {
        fileHandle = await openForRead(full, opts.signal);
      } catch (err) {
        if (err instanceof FileSourceError) throw err;
        if ((err as NodeJS.ErrnoException)?.code === "ELOOP") {
          skipped.push(`${rel}: symlink refused`);
          continue;
        }
        skipped.push(`${rel}: unreadable`);
        continue;
      }
      let content: string;
      try {
        if (opts.signal?.aborted) {
          throw new FileSourceError("The request was aborted by the client.", "file_aborted");
        }
        if (!(await fileHandle.stat()).isFile()) {
          skipped.push(`${entry.name}: not a regular file`);
          continue;
        }
        const read = await readCapped(fileHandle, MAX_FILE_BYTES, opts.signal);
        if (read.overflow) {
          skipped.push(`${rel}: too large (over ${(MAX_FILE_BYTES / 1000).toFixed(0)} KB)`);
          continue;
        }
        if (totalBytes + read.bytes > MAX_TOTAL_BYTES) {
          skipped.push(`${rel}: total size limit reached`);
          return;
        }
        content = read.content;
        totalBytes += read.bytes;
      } catch (err) {
        if (err instanceof FileSourceError) throw err;
        skipped.push(`${rel}: unreadable`);
        continue;
      } finally {
        await fileHandle.close().catch(() => {});
      }
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
 * and provenance line numbers remain meaningful within the combined text. */
export function combineFiles(files: CollectedFile[], name?: string): SourceInput {
  if (files.length === 1) {
    return { type: "file", name: name ?? files[0]!.path, content: files[0]!.content };
  }
  const content = files
    .map((f) => `# ${f.path}\n\n${f.content.trimEnd()}\n`)
    .join("\n\n");
  return {
    type: "file",
    name: name ?? `${files.length} files: ${files[0]!.path} (+${files.length - 1} more)`,
    content,
  };
}
