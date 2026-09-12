/**
 * Local file and directory source adapter — bounded ingestion.
 *
 * Server-side paths only, restricted to an allowlist root (project workspace
 * or an explicitly configured docs directory). Safety rules:
 * - paths must resolve inside the allowed root (no traversal via symlink or ..);
 * - extension allowlist for text formats; size-bounded per file and in total;
 * - directory ingestion is non-recursive by default, recursive only with an
 *   explicit flag, bounded depth and file count;
 * - no code execution — files are read as text only.
 */
import { readFile, readdir, stat, realpath } from "node:fs/promises";
import { join, relative, extname, basename, isAbsolute, sep } from "node:path";
import type { SourceInput } from "../types.js";

export const MAX_FILE_BYTES = 800_000; // per file
export const MAX_TOTAL_BYTES = 1_400_000; // combined (under ingest's 1.5 MB cap)
export const MAX_FILES = 40;
export const MAX_DEPTH = 6;

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

/** Read a file (with extension + size checks) or walk a bounded directory. */
export async function collectFiles(
  userPath: string,
  opts: { recursive?: boolean; signal?: AbortSignal } = {},
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
    const content = await readFile(absolute, "utf8");
    if (opts.signal?.aborted) {
      throw new FileSourceError("The request was aborted by the client.", "file_aborted");
    }
    return { files: [{ path: relative(root, absolute).split(sep).join("/"), content }], skipped };
  }

  const files: CollectedFile[] = [];
  let totalBytes = 0;
  await walk(realRoot, absolute, 0, opts.recursive ?? false, files, skipped, new Set());
  if (opts.signal?.aborted) {
    throw new FileSourceError("The request was aborted by the client.", "file_aborted");
  }
  if (files.length === 0) {
    throw new FileSourceError(
      `No supported documentation files (${[...TEXT_EXTENSIONS].slice(0, 5).join(", ")}…) found under "${userPath}".`,
      "file_none_found",
    );
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
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
    if (depth > MAX_DEPTH) {
      skipped.push(`${dir}: max depth ${MAX_DEPTH} exceeded`);
      return;
    }
    if (seen.has(dir)) return; // symlink cycle guard
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push(`${dir}: unreadable`);
      return;
    }
    for (const entry of entries) {
      if (opts.signal?.aborted) {
        throw new FileSourceError("The request was aborted by the client.", "file_aborted");
      }
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
      if (info.size > MAX_FILE_BYTES) {
        skipped.push(`${rel}: too large (${(info.size / 1000).toFixed(0)} KB)`);
        continue;
      }
      if (totalBytes + info.size > MAX_TOTAL_BYTES) {
        skipped.push(`${rel}: total size limit reached`);
        return;
      }
      const content = await readFile(full, "utf8").catch(() => {
        skipped.push(`${rel}: unreadable`);
        return null;
      });
      if (content === null) continue;
      totalBytes += info.size;
      out.push({ path: rel, content });
    }
  }
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
