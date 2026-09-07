/**
 * P2 source adapter — bounded GitHub repository documentation ingestion.
 *
 * Reads documentation-like text files from a GitHub repository through the
 * GitHub REST API and raw content endpoints. Design constraints (AGENTS.md
 * §12 web safety, GOAL.md):
 * - github.com repository/tree URLs only; requests go to api.github.com and
 *   raw.githubusercontent.com (or its CDN) and nowhere else;
 * - no cloning, no git binary, no execution or installation of repository
 *   code — files are read as inert text and never written to disk;
 * - submodules are never followed; linked repositories are never traversed;
 * - hard bounds: file count, per-file bytes, total bytes, path depth, a
 *   per-request timeout, and an overall ingestion deadline;
 * - public repositories only: a token (SKILLFORGE_GITHUB_TOKEN) exists solely
 *   to raise the api.github.com rate limit for public repositories — it is
 *   never presented as enabling private-repo access, and is never sent to
 *   raw content hosts;
 * - limits truncate honestly: skipped files are reported in notes, never
 *   silently dropped.
 *
 * The fetcher is injectable for deterministic tests.
 */
import type { SourceInput } from "../types.js";
import { TEXT_EXTENSIONS, type CollectedFile } from "./files.js";

export const MAX_GITHUB_FILES = 40;
export const MAX_GITHUB_FILE_BYTES = 800_000; // per file
export const MAX_GITHUB_TOTAL_BYTES = 1_400_000; // combined (under ingest's 1.5 MB cap)
export const MAX_GITHUB_DEPTH = 6; // path segment depth
export const GITHUB_TIMEOUT_MS = 15_000;

const API_HOST = "api.github.com";
const RAW_HOSTS = new Set(["raw.githubusercontent.com", "objects.githubusercontent.com"]);
/** Directories that never hold primary documentation. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "out", "coverage", ".git"]);

export class GithubSourceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "GithubSourceError";
  }
}

// ---------------------------------------------------------------------------
// URL parsing / normalization
// ---------------------------------------------------------------------------

export interface GithubRepoRef {
  owner: string;
  repo: string;
  /** Branch/tag/sha; omitted → resolved from the repository's default branch. */
  ref?: string;
  /** Subpath scope inside the repository; "" = whole repository. */
  path: string;
}

/** Parse and normalize a github.com repository or tree URL. */
export function parseGithubRepoUrl(raw: string): GithubRepoRef {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new GithubSourceError(`"${raw}" is not a valid URL.`, "github_invalid_url");
  }
  if (url.protocol !== "https:") {
    throw new GithubSourceError(
      `Only https://github.com URLs are supported (got "${url.protocol}//${url.host}").`,
      "github_unsupported_host",
    );
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new GithubSourceError(
      `"${url.host}" is not supported. SkillForge ingests documentation from github.com repository URLs.`,
      "github_unsupported_host",
    );
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new GithubSourceError(
      `"${raw}" is not a repository URL. Expected https://github.com/<owner>/<repo> or .../tree/<ref>/<path>.`,
      "github_invalid_url",
    );
  }
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) {
    throw new GithubSourceError(`"${owner}" is not a valid GitHub owner name.`, "github_invalid_url");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new GithubSourceError(`"${repo}" is not a valid GitHub repository name.`, "github_invalid_url");
  }

  if (segments.length === 2) {
    return { owner, repo, path: "" };
  }
  if (segments[2] !== "tree") {
    throw new GithubSourceError(
      `Only repository URLs (…/<owner>/<repo>) and tree URLs (…/<owner>/<repo>/tree/<ref>/<path>) are supported — not "/${segments[2]}" pages.`,
      "github_invalid_url",
    );
  }
  if (segments.length < 4) {
    throw new GithubSourceError(
      `Tree URL "${raw}" is missing a branch or tag after /tree/. Example: https://github.com/owner/repo/tree/main/docs`,
      "github_invalid_url",
    );
  }
  // Refs may themselves contain slashes (e.g. release/v1); disambiguating them
  // from path segments is ambiguous, so the first segment is taken as the ref.
  const ref = segments[3]!;
  const path = segments.slice(4).join("/");
  if (!isSafeRepoPath(path)) {
    throw new GithubSourceError(
      `Path scope "${path}" contains unsafe segments ("..", empty, or backslashes are not allowed).`,
      "github_invalid_url",
    );
  }
  return { owner, repo, ref, path };
}

/** Refuse tree paths that could escape the repository namespace. */
function isSafeRepoPath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  return path.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface FetchGithubOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  /** Optional GitHub API token; sent only to api.github.com. */
  token?: string;
}

export interface GithubSourceResult {
  input: SourceInput;
  repo: { owner: string; repo: string; ref: string; defaultBranchUsed: boolean };
  files: CollectedFile[];
  notes: string[];
}

interface GithubTreeEntry {
  path?: string;
  type?: string;
  size?: number;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function apiFetch(
  fetchImpl: typeof fetch,
  url: string,
  opts: Required<Pick<FetchGithubOptions, "timeoutMs">> & { token?: string },
): Promise<Response> {
  let res: Response;
  const headers: Record<string, string> = {
    "user-agent": "SkillForge/0.1 (documentation-to-skill; +https://github.com/skillforge)",
    accept: "application/vnd.github+json",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  try {
    res = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new GithubSourceError(
      `Request to ${url} failed: ${cause}. GitHub may be unreachable or the request timed out.`,
      "github_fetch_failed",
    );
  }
  throwForApiStatus(res, url);
  return res;
}

function throwForApiStatus(res: Response, url: string): void {
  if (res.ok) return;
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 403 || res.status === 429) {
    if (remaining === "0" || res.status === 429) {
      const reset = res.headers.get("x-ratelimit-reset");
      const when = reset ? new Date(Number.parseInt(reset, 10) * 1000).toISOString() : "later";
      throw new GithubSourceError(
        `GitHub API rate limit reached while calling ${url}. Unauthenticated requests are limited to 60/hour; set SKILLFORGE_GITHUB_TOKEN to raise it. Limit resets at ${when}.`,
        "github_rate_limited",
      );
    }
  }
  if (res.status === 404) {
    throw new GithubSourceError(
      url.includes("/git/trees/")
        ? "The branch, tag, or commit was not found in this repository."
        : "Repository not found. SkillForge reads public repositories only — private repositories are not supported (they appear as not found without credentials, and are deliberately not fetched).",
      url.includes("/git/trees/") ? "github_ref_not_found" : "github_not_found",
    );
  }
  throw new GithubSourceError(
    `GitHub API responded ${res.status} ${res.statusText} for ${url}.`,
    "github_fetch_failed",
  );
}

/** Read one documentation file from raw.githubusercontent.com (CDN redirect allowed). */
async function fetchRawFile(
  fetchImpl: typeof fetch,
  rawUrl: string,
  maxFileBytes: number,
  timeoutMs: number,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(rawUrl, {
      headers: { "user-agent": "SkillForge/0.1 (documentation-to-skill; +https://github.com/skillforge)" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // reported as a skipped-file note by the caller
  }
  if (!res.ok) return null;
  // A redirect must land on GitHub's raw content hosts, never elsewhere.
  // (Manually constructed test responses have an empty final URL; the runtime
  // fetch always populates it.)
  if (res.url !== "" && !RAW_HOSTS.has(new URL(res.url).hostname.toLowerCase())) return null;
  const declared = res.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > maxFileBytes) return null;
  const body = await res.text();
  if (Buffer.byteLength(body, "utf8") > maxFileBytes) return null;
  return body;
}

/**
 * Documentation-first priority: root README, then docs-like directories,
 * then other root files, then everything else. Ties break by path so the
 * selection is fully deterministic.
 */
export function docPriority(path: string): number {
  const segments = path.split("/");
  const base = segments[segments.length - 1]!.toLowerCase();
  if (segments.length === 1 && base.startsWith("readme.")) return 0;
  const top = segments[0]!.toLowerCase();
  if (top === "docs" || top === "doc" || top === "documentation") return 1;
  if (segments.length === 1) return 2;
  return 3;
}

/** Fetch a bounded documentation tree from a GitHub repository. */
export async function fetchGithubSource(
  rawUrl: string,
  opts: FetchGithubOptions = {},
): Promise<GithubSourceResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const maxFiles = opts.maxFiles ?? MAX_GITHUB_FILES;
  const maxFileBytes = opts.maxFileBytes ?? MAX_GITHUB_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_GITHUB_TOTAL_BYTES;
  const maxDepth = opts.maxDepth ?? MAX_GITHUB_DEPTH;
  const token = opts.token ?? (process.env.SKILLFORGE_GITHUB_TOKEN?.trim() || undefined);

  const ref0 = parseGithubRepoUrl(rawUrl);
  const apiBase = `https://${API_HOST}/repos/${ref0.owner}/${ref0.repo}`;
  const notes: string[] = [];

  // Resolve the default branch when the URL omits a ref.
  let ref = ref0.ref;
  let defaultBranchUsed = false;
  if (ref === undefined) {
    const res = await apiFetch(fetchImpl, `${apiBase}`, { timeoutMs, token });
    const meta = (await res.json()) as { default_branch?: string };
    if (typeof meta.default_branch !== "string" || meta.default_branch.length === 0) {
      throw new GithubSourceError(
        `GitHub did not report a default branch for ${ref0.owner}/${ref0.repo}.`,
        "github_fetch_failed",
      );
    }
    ref = meta.default_branch;
    defaultBranchUsed = true;
  }
  const repoRef: { owner: string; repo: string; ref: string; defaultBranchUsed: boolean } = {
    owner: ref0.owner,
    repo: ref0.repo,
    ref,
    defaultBranchUsed,
  };

  // One bounded recursive tree request.
  const treeRes = await apiFetch(fetchImpl, `${apiBase}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
    timeoutMs,
    token,
  });
  const treePayload = (await treeRes.json()) as { tree?: GithubTreeEntry[]; truncated?: boolean };
  const entries = Array.isArray(treePayload.tree) ? treePayload.tree : [];
  if (treePayload.truncated === true) {
    notes.push("GitHub truncated the repository tree listing (very large repository); some files may not have been considered.");
  }

  // Filter + order candidates deterministically.
  const candidates = entries
    .filter((e): e is GithubTreeEntry & { path: string } => typeof e.path === "string")
    .filter((e) => {
      if (e.type !== "blob") {
        if (e.type === "commit") notes.push(`Skipped submodule "${e.path}" — submodules are never followed.`);
        return false;
      }
      return true;
    })
    .filter((e) => isSafeRepoPath(e.path))
    .filter((e) => ref0.path === "" || e.path === ref0.path || e.path.startsWith(`${ref0.path}/`))
    .filter((e) => e.path.split("/").length <= maxDepth)
    .filter((e) => !e.path.split("/").slice(0, -1).some((seg) => SKIP_DIRS.has(seg.toLowerCase())))
    .filter((e) => TEXT_EXTENSIONS.has(extensionOf(e.path)))
    .sort((a, b) => docPriority(a.path) - docPriority(b.path) || a.path.localeCompare(b.path));

  if (candidates.length === 0) {
    const scope = ref0.path ? ` under "${ref0.path}"` : "";
    throw new GithubSourceError(
      `No supported documentation files (${[...TEXT_EXTENSIONS].slice(0, 5).join(", ")}…) found in ${ref0.owner}/${ref0.repo}@${ref}${scope}. Repository source code is not ingested by default.`,
      "github_no_docs",
    );
  }

  // Fetch file contents within the declared bounds.
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  for (const entry of candidates) {
    if (files.length >= maxFiles) {
      notes.push(`Stopped at the file limit (${maxFiles} files); ${candidates.length - files.length} candidate(s) were not fetched.`);
      break;
    }
    if (typeof entry.size === "number" && entry.size > maxFileBytes) {
      notes.push(`Skipped "${entry.path}": too large (${(entry.size / 1000).toFixed(0)} KB, limit ${(maxFileBytes / 1000).toFixed(0)} KB).`);
      continue;
    }
    if (typeof entry.size === "number" && totalBytes + entry.size > maxTotalBytes) {
      notes.push(`Stopped at the total size limit (${(maxTotalBytes / 1_000_000).toFixed(1)} MB); remaining candidate(s) were not fetched.`);
      break;
    }
    const rawPath = entry.path.split("/").map(encodeURIComponent).join("/");
    const rawUrl2 = `https://raw.githubusercontent.com/${ref0.owner}/${encodeURIComponent(ref0.repo)}/${encodeURIComponent(ref)}/${rawPath}`;
    const content = await fetchRawFile(fetchImpl, rawUrl2, maxFileBytes, timeoutMs);
    if (content === null) {
      notes.push(`Skipped "${entry.path}": could not be fetched (missing, too large, or unreachable).`);
      continue;
    }
    totalBytes += Buffer.byteLength(content, "utf8");
    files.push({ path: entry.path, content });
  }
  if (files.length === 0) {
    throw new GithubSourceError(
      `Documentation files were listed in ${ref0.owner}/${ref0.repo}@${ref} but none could be fetched.`,
      "github_no_docs",
    );
  }
  if (ref0.path === "") {
    notes.push(`Read ${files.length} documentation file(s) from ${ref0.owner}/${ref0.repo}@${ref}.`);
  } else {
    notes.push(`Read ${files.length} documentation file(s) from ${ref0.owner}/${ref0.repo}@${ref} under "${ref0.path}".`);
  }

  return {
    input: combineGithubFiles(files, `${ref0.owner}/${ref0.repo}`),
    repo: repoRef,
    files,
    notes,
  };
}

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

/** Join fetched files with synthetic `# path` headers (same convention as the
 * local-file adapter) so per-file structure and provenance stay inspectable. */
function combineGithubFiles(files: CollectedFile[], repoLabel: string): SourceInput {
  if (files.length === 1) {
    return { type: "github", name: repoLabel, content: files[0]!.content };
  }
  const content = files.map((f) => `# ${f.path}\n\n${f.content.trimEnd()}\n`).join("\n\n");
  return {
    type: "github",
    name: `${repoLabel} docs (${files.length} files)`.slice(0, 200),
    content,
  };
}
