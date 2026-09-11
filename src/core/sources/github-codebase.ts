/**
 * GitHub codebase source adapter — bounded repository reconnaissance.
 *
 * Turns a public GitHub repository into a skill for coding agents working on
 * that codebase. This is deliberately distinct from the documentation mode
 * (github.ts): the repository is analyzed as a software project.
 *
 * Security model (AGENTS.md §12/§21 — identical to documentation mode):
 * - repository contents are untrusted inert text; nothing is cloned, executed,
 *   installed, or built; submodules are never followed;
 * - requests go to api.github.com and GitHub raw content hosts and nowhere
 *   else; a token (SKILLFORGE_GITHUB_TOKEN) only raises the api.github.com
 *   rate limit and is never sent to raw content hosts;
 * - hard bounds everywhere: tree response bytes, selected file count, per-file
 *   bytes, total bytes, path depth, per-request timeout, overall deadline;
 * - the local deterministic pipeline — never a model — owns eligibility,
 *   ranking, and selection;
 * - truncation and skipping are surfaced honestly.
 *
 * This module holds the pure, deterministic half (eligibility filtering,
 * tree reconnaissance, ranking); the networked ingestion entry point is
 * fetchGithubCodebaseSource. Everything here is injectable-fetch testable
 * without any live GitHub traffic.
 */
import type { RepositoryAnalysis } from "../types.js";
import { isSafeRepoPath, parseGithubRepoUrl, GithubSourceError } from "./github.js";

// ---------------------------------------------------------------------------
// Hard limits (independent of documentation mode; exported for tests)
// ---------------------------------------------------------------------------

export const MAX_CODEBASE_FILES = 60;
export const MAX_CODEBASE_FILE_BYTES = 200_000; // per file
export const MAX_CODEBASE_TOTAL_BYTES = 1_400_000; // combined (under ingest's 1.5 MB cap)
export const MAX_CODEBASE_DEPTH = 10; // path segment depth (source trees are deeper than docs trees)
export const CODEBASE_TIMEOUT_MS = 15_000; // per request
export const CODEBASE_OVERALL_TIMEOUT_MS = 90_000; // whole ingestion budget
/** Cap for api.github.com JSON payloads (repo metadata, tree listings). */
export const MAX_CODEBASE_TREE_BYTES = 10_000_000;

export class GithubCodebaseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "GithubCodebaseError";
  }
}

// ---------------------------------------------------------------------------
// Tree entries
// ---------------------------------------------------------------------------

export interface TreeEntryLike {
  path: string;
  type: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Eligibility / safety filtering (deterministic; the allowlist decides —
// binaries and unknown formats are excluded by construction)
// ---------------------------------------------------------------------------

/** Directories that never carry analysis-worthy source content. */
export const CODEBASE_SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".output", ".svelte-kit", ".angular", "target", "bin", "obj",
  ".cache", "tmp", "temp", "__pycache__", ".venv", "venv", ".tox",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", "bower_components",
  "jspm_packages", ".terraform", "Pods", ".idea", ".vscode", ".gradle",
  "__snapshots__", "testdata", ".turbo", ".parcel-cache", ".nyc_output",
]);

/** Extensions eligible for codebase analysis: source, config, build, and
 * instruction text. Everything else (binaries, media, archives, unknown
 * formats) is excluded by construction. */
export const CODEBASE_EXTENSIONS = new Set([
  // code
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".go", ".rs",
  ".java", ".kt", ".kts", ".rb", ".php", ".c", ".h", ".cpp", ".cc", ".cxx",
  ".hpp", ".hh", ".cs", ".swift", ".m", ".mm", ".scala", ".vue", ".svelte",
  ".astro", ".zig", ".ex", ".exs", ".erl", ".hs", ".lua", ".pl", ".r",
  // shell / ops
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  // structured config / data
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".xml", ".properties", ".gradle",
  // docs / text
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc",
  // web & misc
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".graphql", ".gql",
  ".proto", ".tf", ".hcl", ".sql", ".ipynb",
]);

/** Extension-less files eligible by basename (tooling convention files). */
export const CODEBASE_BASENAMES = new Set([
  "makefile", "dockerfile", "codeowners", "license", "notice", "contributing",
  "readme", "changelog", "cmakelists.txt", "go.mod", "go.work", "gemfile",
  "pipfile", "build.gradle", "settings.gradle",
  ".gitignore", ".dockerignore", ".editorconfig", ".gitattributes",
  ".nvmrc", ".node-version", ".python-version", ".ruby-version",
  ".tool-versions", ".prettierrc", ".eslintrc", ".babelrc",
]);

/**
 * Known secret-bearing files: never fetched, never inspected (P1-7). Public
 * repositories can accidentally contain committed credentials — a filename
 * gate is deterministic and cheap, and presence stays tree-metadata-only.
 * Keep this list conservative and exact (no wildcards beyond .env.*).
 */
const SENSITIVE_BASENAMES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".yarnrc.yml",
  "credentials.json", "service-account.json", "serviceaccountkey.json",
  "secrets.yaml", "secrets.yml",
]);
const KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

export function isSensitivePath(path: string): boolean {
  const segments = path.split("/");
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  // Dotenv variants: .env, .env.local, .env.production, …
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot !== -1 && KEY_EXTENSIONS.has(base.slice(dot))) return true;
  if (/^id_rsa|^id_dsa|^id_ed25519/.test(base)) return true;
  return false;
}

/** Lockfiles and checksum files: useful as ecosystem evidence from tree
 * metadata, but never fetched — they would consume the deep-analysis budget
 * without informing an agent. */
export const METADATA_ONLY_BASENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  "cargo.lock", "poetry.lock", "pipfile.lock", "composer.lock",
  "gemfile.lock", "go.sum", "packages.lock.json",
]);

/** Deterministic generated/minified heuristics (basename-level). */
export function isGeneratedOrMinified(path: string): boolean {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (/\.min\.[cm]?[jt]sx?$/.test(base) || /\.min\.css$/.test(base)) return true;
  if (base.endsWith(".map") || base.endsWith(".snap")) return true; // source maps, jest snapshots
  if (base.endsWith(".pb.go") || base.endsWith("_pb2.py") || base.endsWith("_pb2_grpc.py")) return true; // generated protobuf
  if (base.includes(".generated.")) return true;
  if (/\.d\.ts$/.test(base)) return false; // declaration files describe public interfaces — keep
  return false;
}

export interface CodebaseEligibilityContext {
  maxDepth: number;
  /** "" = whole repository; otherwise blobs must live under this path. */
  pathScope: string;
}

export type CodebaseExclusionReason =
  | "submodule"
  | "unsafe_path"
  | "outside_path_scope"
  | "skip_dir"
  | "too_deep"
  | "sensitive_file"
  | "extension_not_allowed"
  | "generated_or_minified"
  | "lockfile_metadata_only";

/** Why a tree entry is not an eligible deep-analysis candidate; null when
 * eligible. Pure and deterministic. */
export function codebaseExclusionReason(
  entry: TreeEntryLike,
  ctx: CodebaseEligibilityContext,
): CodebaseExclusionReason | null {
  if (entry.type === "commit") return "submodule";
  if (entry.type !== "blob") return "extension_not_allowed"; // directories are not candidates
  if (!isSafeRepoPath(entry.path)) return "unsafe_path";
  if (ctx.pathScope !== "" && entry.path !== ctx.pathScope && !entry.path.startsWith(`${ctx.pathScope}/`)) {
    return "outside_path_scope";
  }
  const segments = entry.path.split("/");
  if (segments.slice(0, -1).some((seg) => CODEBASE_SKIP_DIRS.has(seg.toLowerCase()))) return "skip_dir";
  if (segments.length > ctx.maxDepth) return "too_deep";
  const base = segments[segments.length - 1]!;
  const dot = base.lastIndexOf(".");
  const ext = dot === -1 ? "" : base.slice(dot).toLowerCase();
  const baseKey = base.toLowerCase();
  if (isSensitivePath(entry.path)) return "sensitive_file";
  // Metadata-only lockfiles are recognized before the extension allowlist:
  // they are reconnaissance evidence (never fetched) even when their
  // extension is not an analysis format.
  if (METADATA_ONLY_BASENAMES.has(baseKey)) return "lockfile_metadata_only";
  const allowed =
    (dot > 0 && CODEBASE_EXTENSIONS.has(ext)) || CODEBASE_BASENAMES.has(baseKey);
  if (!allowed) return "extension_not_allowed";
  if (isGeneratedOrMinified(entry.path)) return "generated_or_minified";
  return null;
}

// ---------------------------------------------------------------------------
// Reconnaissance detection categories (pure functions over tree entries)
// ---------------------------------------------------------------------------

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".pyi": "Python",
  ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
  ".rb": "Ruby", ".php": "PHP",
  ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++",
  ".cs": "C#", ".swift": "Swift", ".m": "Objective-C", ".mm": "Objective-C",
  ".scala": "Scala", ".zig": "Zig", ".ex": "Elixir", ".erl": "Erlang",
  ".hs": "Haskell", ".lua": "Lua", ".pl": "Perl", ".r": "R",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
};

const MANIFEST_ECOSYSTEM: Array<[string, string]> = [
  ["package.json", "node"],
  ["pnpm-workspace.yaml", "node"],
  ["package-lock.json", "node"],
  ["pnpm-lock.yaml", "node"],
  ["yarn.lock", "node"],
  ["bun.lockb", "node"],
  ["bun.lock", "node"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["pipfile", "python"],
  ["poetry.lock", "python"],
  ["setup.py", "python"],
  ["setup.cfg", "python"],
  ["go.mod", "go"],
  ["go.work", "go"],
  ["cargo.toml", "rust"],
  ["pom.xml", "jvm"],
  ["build.gradle", "jvm"],
  ["build.gradle.kts", "jvm"],
  ["settings.gradle", "jvm"],
  ["settings.gradle.kts", "jvm"],
  ["gemfile", "ruby"],
  ["composer.json", "php"],
  ["makefile", "make"],
  ["cmakelists.txt", "cmake"],
  ["dockerfile", "docker"],
  ["docker-compose.yml", "docker"],
  ["docker-compose.yaml", "docker"],
  ["compose.yml", "docker"],
  ["compose.yaml", "docker"],
];

const SOURCE_ROOT_NAMES = new Set([
  "src", "app", "lib", "packages", "apps", "services", "cmd", "internal",
  "pkg", "server", "client", "web", "api", "core",
]);
const TEST_ROOT_NAMES = new Set(["test", "tests", "__tests__", "spec", "e2e", "integration"]);
const EXAMPLE_ROOT_NAMES = new Set(["examples", "example", "samples", "demo"]);

const INSTRUCTION_BASENAMES = new Set([
  "agents.md", "claude.md", "contributing.md", "development.md", "security.md", "codeowners",
]);
const WORKSPACE_MANIFEST_BASENAMES = new Set([
  "package.json", "pyproject.toml", "cargo.toml", "go.mod",
]);

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 || dot === 0 ? "" : base.slice(dot).toLowerCase();
}

/** Language claims from tree file-extension counts, strongest first. */
export function detectLanguages(entries: TreeEntryLike[]): RepositoryAnalysis["languages"] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const lang = EXTENSION_LANGUAGE[extensionOf(e.path)];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, count]) => ({
      name,
      evidence: [`${count} ${name.toLowerCase()} file(s) in the repository tree`],
    }));
}

/** Ecosystems evidenced by manifests present in the tree. */
export function detectEcosystems(entries: TreeEntryLike[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const base = (e.path.split("/").pop() ?? "").toLowerCase();
    if (base.endsWith(".csproj") || base.endsWith(".sln")) {
      out.add("dotnet");
      continue;
    }
    for (const [manifest, ecosystem] of MANIFEST_ECOSYSTEM) {
      if (base === manifest) out.add(ecosystem);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Manifests (including lockfiles — recorded as metadata-only). `fetched`
 * means exactly "content was actually fetched and included in the inspected
 * file set": the caller passes the post-fetch inspected-path set. Before
 * fetches complete, detection is only tree presence; the ingestion entry
 * point recomputes `fetched` afterwards, so never consume pre-fetch results
 * for evidence claims.
 */
export function detectManifests(entries: TreeEntryLike[], inspected: Set<string>): RepositoryAnalysis["manifests"] {
  const out: RepositoryAnalysis["manifests"] = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const base = (e.path.split("/").pop() ?? "").toLowerCase();
    const isCsproj = base.endsWith(".csproj") || base.endsWith(".sln");
    const known = MANIFEST_ECOSYSTEM.some(([m]) => m === base);
    if (!known && !isCsproj) continue;
    const metadataOnly = METADATA_ONLY_BASENAMES.has(base);
    out.push({
      path: e.path,
      kind: metadataOnly ? "lockfile" : base,
      fetched: !metadataOnly && inspected.has(e.path),
    });
  }
  return out
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 24);
}

export interface DetectedRoots {
  sourceRoots: string[];
  testRoots: string[];
  exampleRoots: string[];
}

/** Path relative to a reconnaissance scope: "" keeps the path unchanged;
 * a scope strips its own prefix so scope-rooted structure looks like root
 * structure. Output paths elsewhere stay in full repository form. */
export function pathRelativeTo(path: string, basePath: string): string {
  if (basePath === "") return path;
  if (path === basePath) return "";
  return path.startsWith(`${basePath}/`) ? path.slice(basePath.length + 1) : path;
}

/** Top-level source/test/example roots actually present in the tree. When
 * `basePath` is set, roots are computed relative to that scope. */
export function detectRoots(entries: TreeEntryLike[], basePath = ""): DetectedRoots {
  const tops = new Set<string>();
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const rel = pathRelativeTo(e.path, basePath);
    if (rel === "") continue;
    tops.add(rel.split("/")[0]!.toLowerCase());
  }
  const pick = (names: Set<string>) =>
    [...names].filter((n) => tops.has(n)).sort((a, b) => a.localeCompare(b)).map((n) => `${n}/`);
  return {
    sourceRoots: pick(SOURCE_ROOT_NAMES),
    testRoots: pick(TEST_ROOT_NAMES),
    exampleRoots: pick(EXAMPLE_ROOT_NAMES),
  };
}

/** Repository instruction files: root-level high-priority files plus nested
 * AGENTS.md/CLAUDE.md files that affect subtrees. Root files first. */
export function detectInstructionFiles(entries: TreeEntryLike[], basePath = ""): string[] {
  const out: { path: string; depth: number }[] = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const base = (e.path.split("/").pop() ?? "").toLowerCase();
    const isReadme = /^readme(\.[a-z0-9]+)?$/.test(base);
    if (!INSTRUCTION_BASENAMES.has(base) && !isReadme) continue;
    out.push({ path: e.path, depth: pathRelativeTo(e.path, basePath).split("/").length });
  }
  return out
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
    .slice(0, 16)
    .map((x) => x.path);
}

/** Workspace/package directories: directories (depth ≥ 1) containing their
 * own package manifest — monorepo boundaries. */
export function detectWorkspacePackages(entries: TreeEntryLike[], basePath = ""): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const segments = pathRelativeTo(e.path, basePath).split("/");
    if (segments.length < 2 || segments.length > 4) continue;
    const base = segments[segments.length - 1]!.toLowerCase();
    if (!WORKSPACE_MANIFEST_BASENAMES.has(base)) continue;
    // Full repository path of the package directory.
    out.add(e.path.split("/").slice(0, -1).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b)).slice(0, 24);
}

/** CI workflow files under .github/workflows/ (inert text; a rich source of
 * canonical commands). */
export function detectCiWorkflows(entries: TreeEntryLike[]): string[] {
  return entries
    .filter((e) => e.type === "blob")
    .map((e) => e.path)
    .filter(
      (p) =>
        p.startsWith(".github/workflows/") &&
        (p.toLowerCase().endsWith(".yml") || p.toLowerCase().endsWith(".yaml")),
    )
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Deterministic candidate ranking (Phase 4 — the selection core)
// ---------------------------------------------------------------------------

const ENTRYPOINT_BASENAME_RE =
  /^(index|main|server|app|__main__|lib|mod|program|application|bootstrap|wsgi|asgi|manage)\.[a-z0-9]+$/i;

const INSTRUCTION_PRIORITY = new Map([
  ["agents.md", 0], ["claude.md", 1],
]);
const ROOT_DOC_PRIORITY = new Map([
  ["readme", 2], ["contributing.md", 3], ["development.md", 4],
  ["security.md", 5], ["changelog", 9], ["codeowners", 10],
]);
const NESTED_INSTRUCTION_PRIORITY = new Map([
  ["agents.md", 0], ["claude.md", 1], ["contributing.md", 3],
  ["development.md", 4], ["security.md", 5], ["codeowners", 10],
]);
const BUILD_CONFIG_PRIORITY = new Map([
  ["package.json", 3], ["pyproject.toml", 3], ["cargo.toml", 3], ["go.mod", 3],
  ["makefile", 4], ["dockerfile", 6], ["cmakelists.txt", 6],
]);

/**
 * Priority score for a codebase candidate: lower sorts first. Ties break by
 * path, so the ordering is fully deterministic given the same tree.
 *
 * Priority order (from the task's strong-priority list):
 * 0–5  repository instructions + root README + primary manifests
 * 8    root build/test/lint config
 * 12   CI workflows
 * 14   entrypoint-named files
 * 18   top-level source-root files (shallow-first within the root)
 * 22   representative tests
 * 24   examples/samples
 * 26   deeper implementation files
 * 34   everything else
 */
export function codebasePriority(path: string): number {
  const segments = path.split("/");
  const base = segments[segments.length - 1]!.toLowerCase();
  const depth = segments.length;
  const top = segments.length > 1 ? segments[0]!.toLowerCase() : "";
  const stem = base.replace(/\.[a-z0-9]+$/i, "");

  // 0. Repository instruction files (root first, then nested). Nested
  // instruction files (e.g. docs/contributing.md) rank only slightly below
  // their root-level counterparts — repository instructions are the highest
  // value content for a coding agent wherever they live.
  const instr = INSTRUCTION_PRIORITY.get(base) ?? NESTED_INSTRUCTION_PRIORITY.get(base);
  if (instr !== undefined) return depth === 1 ? instr : instr + Math.min(depth - 1, 6) * 0.5;
  // Only the ROOT README carries top priority; nested READMEs (examples/,
  // packages) are ordinary directory docs and fall through to their
  // category so they cannot crowd out manifests and instructions.
  if (depth === 1) {
    if (/^readme(\.[a-z0-9]+)?$/.test(base)) return 2;
    const rootDoc = ROOT_DOC_PRIORITY.get(base);
    if (rootDoc !== undefined) return rootDoc;
  }

  // 3. Manifests.
  if (depth === 1 && BUILD_CONFIG_PRIORITY.has(base)) return BUILD_CONFIG_PRIORITY.get(base)!;
  if (depth === 1) {
    // 8. Root build/test/lint configuration files.
    if (/\.(json|ya?ml|toml|ini|cfg)$/.test(base) || base === ".prettierrc" || base === ".eslintrc") return 8;
    if (/^(vite|webpack|rollup|jest|vitest|tsup|esbuild|turbo|nx|webpack)\.config\./.test(base)) return 8;
    if (/^tsconfig/.test(base) || /^jest\.config/.test(base) || /^vitest\.config/.test(base)) return 8;
    if (/^(pytest|tox|setup\.cfg|\.flake8|ruff)/.test(base)) return 8;
    if (/^\.github\/workflows\//.test(path)) return 12;
  }
  if (path.startsWith(".github/workflows/")) return 12;

  // Tests.
  if (top && TEST_ROOT_NAMES.has(top)) return 22;
  if (/\.test\.|\.spec\.|_test\.go$/.test(base)) return 22;

  // Examples.
  if (top && EXAMPLE_ROOT_NAMES.has(top)) return 24;

  // Entrypoint-named files.
  if (ENTRYPOINT_BASENAME_RE.test(base) || stem === "main") return 14;

  // Source-root files: shallow first so public interfaces outrank deep guts.
  if (top && SOURCE_ROOT_NAMES.has(top)) {
    return 18 + Math.min(depth - 1, 8) * 0.5;
  }

  return 26 + Math.min(depth, 8) * 0.5;
}

/**
 * Deterministically select a bounded, diverse candidate set from an eligible
 * list (already filtered by codebaseExclusionReason). Selection proceeds in
 * priority order, but no single top-level directory may consume more than
 * `maxPerTopDir` slots — one huge directory cannot crowd out the rest of the
 * repository. Input order never matters: output is fully determined by paths.
 */
export function selectCodebaseCandidates(
  eligible: TreeEntryLike[],
  maxFiles: number,
  maxPerTopDir = Math.max(4, Math.ceil(maxFiles / 4)),
): TreeEntryLike[] {
  const ranked = eligible
    .map((e) => ({ entry: e, priority: codebasePriority(e.path) }))
    .sort((a, b) => a.priority - b.priority || a.entry.path.localeCompare(b.entry.path));

  const perTop = new Map<string, number>();
  const picked: TreeEntryLike[] = [];
  const deferred: typeof ranked = [];
  for (const r of ranked) {
    if (picked.length >= maxFiles) break;
    const top = r.entry.path.split("/")[0]!;
    const used = perTop.get(top) ?? 0;
    if (used >= maxPerTopDir) {
      deferred.push(r);
      continue;
    }
    perTop.set(top, used + 1);
    picked.push(r.entry);
  }
  // Fill remaining slots from deferred candidates (still in priority order) —
  // a repository dominated by one directory still fills the budget.
  for (const r of deferred) {
    if (picked.length >= maxFiles) break;
    picked.push(r.entry);
  }
  return picked;
}

/** Likely entrypoints from tree structure: entrypoint-name files at shallow
 * depth, preferring source roots. When `basePath` is set, location checks are
 * relative to that scope. Deterministic (score desc, then path). */
export function detectEntrypointCandidates(
  entries: TreeEntryLike[],
  basePath = "",
): { path: string; reason: string }[] {
  const candidates: { path: string; score: number }[] = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const rel = pathRelativeTo(e.path, basePath);
    const segments = rel.split("/");
    if (segments.length > 3) continue;
    const top = segments.length > 1 ? segments[0]!.toLowerCase() : "";
    // Entrypoints live at the scope root, under a source root, or in
    // Go-style cmd/<name>/. CI workflows, docs, tests, and examples are
    // never entrypoints even when they carry entrypoint-shaped names.
    const locationOk = segments.length === 1 || SOURCE_ROOT_NAMES.has(top) || top === "cmd";
    if (!locationOk) continue;
    const base = segments[segments.length - 1]!;
    const dot = base.lastIndexOf(".");
    const stem = (dot === -1 ? base : base.slice(0, dot)).toLowerCase();
    const stemOk = ENTRYPOINT_BASENAME_RE.test(base) || stem === "main";
    if (!stemOk) continue;
    let score = 40; // root-level entrypoints
    if (SOURCE_ROOT_NAMES.has(top)) score = 45;
    if (top === "cmd") score = 44;
    if (/\.test\.|\.spec\./.test(base)) continue; // test files are not entrypoints
    candidates.push({ path: e.path, score });
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 12)
    .map((c) => ({
      path: c.path,
      reason:
        c.score >= 45
          ? "entrypoint-named file under a source root"
          : "entrypoint-named file",
    }));
}

// ---------------------------------------------------------------------------
// Networked ingestion (Phase 5 — bounded fetching + full codebase pipeline)
// ---------------------------------------------------------------------------

import {
  API_HOST,
  apiFetch,
  readBodyWithDeadline,
  fetchRawFile,
  combinedChunkBytes,
  combinedFileChunk,
} from "./github.js";
import { buildRepositoryAnalysisFromFiles } from "../codebase/extract.js";

export interface FetchGithubCodebaseOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Hard budget for the whole ingestion. Default 90 s; when exceeded a typed
   * codebase_deadline_exceeded error is thrown and in-flight fetches abort. */
  overallTimeoutMs?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  /** Optional GitHub API token; sent only to api.github.com. */
  token?: string;
}

export interface GithubCodebaseSourceResult {
  /** Combined inert text of the selected files (same `# path` header
   * convention as the other adapters) — the SourceInput.content. */
  input: {
    type: "github-codebase";
    name: string;
    content: string;
    repository: RepositoryAnalysis;
  };
  repo: { owner: string; repo: string; ref: string; defaultBranchUsed: boolean };
  files: { path: string; content: string }[];
  notes: string[];
  analysis: RepositoryAnalysis;
}

interface GithubTreePayload {
  tree?: TreeEntryLike[];
  truncated?: boolean;
}

/**
 * Ingest a public GitHub repository as a codebase:
 * repo metadata → recursive tree (bounded) → eligibility/safety filtering →
 * deterministic ranked selection (diversity-capped) → bounded raw-content
 * fetches → structured RepositoryAnalysis + combined inert text.
 */
export async function fetchGithubCodebaseSource(
  rawUrl: string,
  opts: FetchGithubCodebaseOptions = {},
): Promise<GithubCodebaseSourceResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CODEBASE_TIMEOUT_MS;
  const overallTimeoutMs = opts.overallTimeoutMs ?? CODEBASE_OVERALL_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(overallTimeoutMs);
  const maxFiles = opts.maxFiles ?? MAX_CODEBASE_FILES;
  const maxFileBytes = opts.maxFileBytes ?? MAX_CODEBASE_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_CODEBASE_TOTAL_BYTES;
  const maxDepth = opts.maxDepth ?? MAX_CODEBASE_DEPTH;
  const token = opts.token ?? (process.env.SKILLFORGE_GITHUB_TOKEN?.trim() || undefined);

  // Reuse the documentation adapter's URL parsing — same URL grammar.
  const ref0 = parseGithubRepoUrl(rawUrl);
  const apiBase = `https://${API_HOST}/repos/${ref0.owner}/${ref0.repo}`;
  const notes: string[] = [];

  // 1. Repository metadata (default-branch resolution).
  let ref = ref0.ref;
  let defaultBranchUsed = false;
  try {
    if (ref === undefined) {
      const res = await apiFetch(fetchImpl, apiBase, { timeoutMs, token, signal: deadline });
      const meta = (await readBodyWithDeadline(res, deadline, "json", MAX_CODEBASE_TREE_BYTES)) as {
        default_branch?: string;
      };
      if (typeof meta.default_branch !== "string" || meta.default_branch.length === 0) {
        throw new GithubCodebaseError(
          `GitHub did not report a default branch for ${ref0.owner}/${ref0.repo}.`,
          "codebase_fetch_failed",
        );
      }
      ref = meta.default_branch;
      defaultBranchUsed = true;
    }

    // 2. One bounded recursive tree request.
    const treeRes = await apiFetch(
      fetchImpl,
      `${apiBase}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { timeoutMs, token, signal: deadline },
    );
    const treePayload = (await readBodyWithDeadline(treeRes, deadline, "json", MAX_CODEBASE_TREE_BYTES)) as GithubTreePayload;
    const allEntries = (Array.isArray(treePayload.tree) ? treePayload.tree : []).filter(
      (e): e is TreeEntryLike & { path: string } => typeof e.path === "string",
    );
    const treeBlobCount = allEntries.filter((e) => e.type === "blob").length;
    if (treePayload.truncated === true) {
      notes.push(
        "GitHub truncated the repository tree listing (very large repository); some files may not have been considered.",
      );
    }

    // 3. Canonical tree reconnaissance sets (P1-1):
    //   allEntries      → raw GitHub listing; only whole-tree metadata (counts).
    //   reconEntries    → safe scoped metadata for ALL analysis claims
    //                     (inside path scope, safe path, not in skip dirs,
    //                     within depth, not sensitive; metadata-only lockfiles
    //                     retained — they are evidence, never fetched).
    //   eligible        → entries allowed for deep fetch (recon + content
    //                     allowlist + not generated/minified + not lockfile).
    //   inspectedFiles  → actually fetched (post-fetch outcome only).
    const reconEntries: TreeEntryLike[] = [];
    const eligible: TreeEntryLike[] = [];
    let skippedUnsafe = 0;
    let skippedSubmodules = 0;
    let skippedSensitive = 0;
    for (const entry of allEntries) {
      const reason = codebaseExclusionReason(entry, { maxDepth, pathScope: ref0.path });
      if (reason === null) {
        reconEntries.push(entry);
        eligible.push(entry);
      } else if (
        // Metadata-only evidence: lockfiles inside the safe scoped/safe-path/
        // skip-dir/depth policy are retained for package-manager evidence but
        // never fetched. Generated/minified output is deliberately NOT
        // claim-bearing reconnaissance — it may not influence language,
        // ecosystem, manifest, root, entrypoint, or instruction claims.
        reason === "lockfile_metadata_only" &&
        isSafeRepoPath(entry.path) &&
        !entry.path.split("/").slice(0, -1).some((seg) => CODEBASE_SKIP_DIRS.has(seg.toLowerCase()))
      ) {
        reconEntries.push(entry);
      } else if (reason === "submodule") {
        skippedSubmodules++;
      } else if (reason === "unsafe_path") {
        skippedUnsafe++;
      } else if (reason === "sensitive_file") {
        skippedSensitive++;
      }
    }
    if (skippedSubmodules > 0) {
      notes.push(`Skipped ${skippedSubmodules} submodule(s) — submodules are never followed.`);
    }
    if (skippedSensitive > 0) {
      notes.push(
        `Excluded ${skippedSensitive} sensitive file(s) (credential-bearing names such as .env, .npmrc) from ingestion — presence is tree metadata only, content is never fetched.`,
      );
    }

    // 4. Deterministic ranked selection with a diversity cap.
    const selected = selectCodebaseCandidates(eligible, maxFiles);
    const candidateCount = eligible.length;
    if (candidateCount === 0) {
      throw new GithubCodebaseError(
        `No analyzable source, config, test, or instruction files were found in ${ref0.owner}/${ref0.repo}@${ref}${ref0.path ? ` under "${ref0.path}"` : ""}. The repository may be empty, docs-only, or composed entirely of unsupported/binary content.`,
        "codebase_no_candidates",
      );
    }
    const notSelected = candidateCount - selected.length;
    const skippedGenerated = allEntries.filter(
      (e) => e.type === "blob" && codebaseExclusionReason(e, { maxDepth, pathScope: ref0.path }) === "generated_or_minified",
    ).length;

    // 5. Bounded raw-content fetches with exact total-byte accounting
    // (identical projection discipline to the docs adapter).
    //
    // Outcome accounting (each selected candidate lands in exactly one
    // bucket); every user-facing summary and the selection stats derive from
    // these actuals — "selected before fetch" is never conflated with
    // "inspected after fetch".
    const files: { path: string; content: string }[] = [];
    let totalBytes = 0;
    let skippedUnreachable = 0;
    let skippedTooLarge = 0;
    let stoppedByTotalBudget = 0;
    for (const entry of selected) {
      if (typeof entry.size === "number" && entry.size > maxFileBytes) {
        skippedTooLarge++;
        notes.push(`Skipped "${entry.path}": too large (${(entry.size / 1000).toFixed(0)} KB, limit ${(maxFileBytes / 1000).toFixed(0)} KB).`);
        continue;
      }
      const rawPath = entry.path.split("/").map(encodeURIComponent).join("/");
      const rawUrl2 = `https://raw.githubusercontent.com/${ref0.owner}/${encodeURIComponent(ref0.repo)}/${encodeURIComponent(ref)}/${rawPath}`;
      const fetched = await fetchRawFile(fetchImpl, rawUrl2, maxFileBytes, timeoutMs, deadline);
      if (fetched.kind === "deadline_exceeded") {
        throw new GithubCodebaseError(
          `Codebase ingestion exceeded its overall time budget (${Math.round(overallTimeoutMs / 1000)} s) after ${files.length} file(s). Scope the URL (e.g. …/tree/main/packages/app) or retry later.`,
          "codebase_deadline_exceeded",
        );
      }
      if (fetched.kind === "unreachable") {
        skippedUnreachable++;
        notes.push(`Skipped "${entry.path}": could not be fetched (missing or unreachable).`);
        continue;
      }
      if (fetched.kind === "too_large") {
        skippedTooLarge++;
        notes.push(`Skipped "${entry.path}": actual content exceeds the ${(maxFileBytes / 1000).toFixed(0)} KB per-file limit.`);
        continue;
      }
      const actualBytes = Buffer.byteLength(fetched.content, "utf8");
      if (actualBytes > maxFileBytes) {
        skippedTooLarge++;
        notes.push(`Skipped "${entry.path}": actual content ${(actualBytes / 1000).toFixed(0)} KB exceeds the ${(maxFileBytes / 1000).toFixed(0)} KB per-file limit (metadata underreported the size).`);
        continue;
      }
      const projected = combinedChunkBytes(entry.path, fetched.content, files.length === 0);
      if (totalBytes + projected > maxTotalBytes) {
        stoppedByTotalBudget++;
        notes.push(`Stopped at the total size limit (${(maxTotalBytes / 1_000_000).toFixed(1)} MB) after ${files.length} file(s); "${entry.path}" (${(actualBytes / 1000).toFixed(0)} KB) would exceed it.`);
        break;
      }
      totalBytes += projected;
      files.push({ path: entry.path, content: fetched.content });
    }
    if (files.length === 0) {
      throw new GithubCodebaseError(
        `Candidate files were listed in ${ref0.owner}/${ref0.repo}@${ref} but none could be fetched within the limits (see the size-limit notes).`,
        "codebase_no_candidates",
      );
    }
    // All summaries derive from the actual outcome buckets.
    const inspectedCount = files.length;
    const selectedCount = selected.length;
    const notSelectedCount = candidateCount - selectedCount;
    const notFetchedCount = selectedCount - inspectedCount;
    if (notFetchedCount === 0 && notSelectedCount === 0) {
      notes.push(`Inspected all ${inspectedCount} eligible file(s) in ${ref0.owner}/${ref0.repo}@${ref}${ref0.path ? ` under "${ref0.path}"` : ""}.`);
    } else if (notFetchedCount === 0) {
      notes.push(
        `Inspected ${inspectedCount} of ${candidateCount} eligible file(s) (bounded, prioritized selection); ${notSelectedCount} eligible candidate(s) were not selected.`,
      );
    } else {
      // The breakdown must account for EVERY unfetched selected file.
      const neverAttempted = Math.max(
        0,
        notFetchedCount - skippedUnreachable - skippedTooLarge - stoppedByTotalBudget,
      );
      const breakdown = [
        skippedUnreachable > 0 ? `${skippedUnreachable} could not be fetched` : null,
        skippedTooLarge > 0 ? `${skippedTooLarge} exceeded the per-file limit` : null,
        stoppedByTotalBudget > 0 ? `${stoppedByTotalBudget} would have exceeded the total size limit` : null,
        neverAttempted > 0 ? `${neverAttempted} not fetched after the size limit stopped ingestion` : null,
      ].filter((x): x is string => x !== null);
      notes.push(
        `Inspected ${inspectedCount} of ${selectedCount} selected file(s) (${breakdown.join(", ")})` +
          (notSelectedCount > 0 ? `; ${notSelectedCount} of ${candidateCount} eligible candidate(s) were not selected` : "") +
          `.`,
      );
    }

    // 6. Structured analysis: SCOPED reconnaissance + extraction from fetched
    // files. Every repository fact describing the requested scope comes from
    // entries inside that scope; whole-tree listing metadata is kept separate
    // (selection.treeBlobCount, labeled as the GitHub tree listing).
    // `selectedCount` means "actually inspected": manifest `fetched` flags and
    // the inspected-file set derive from the post-fetch outcome.
    const scopedEntries = reconEntries;
    const inspectedSet = new Set(files.map((f) => f.path));
    const instructions = detectInstructionFiles(scopedEntries, ref0.path).filter((p) => inspectedSet.has(p));
    const analysis = buildRepositoryAnalysisFromFiles(
      {
        url: `https://github.com/${ref0.owner}/${ref0.repo}`,
        owner: ref0.owner,
        name: ref0.repo,
        ref,
        scope: ref0.path === "" ? undefined : ref0.path,
        treeLockfiles: reconEntries
          .filter((e) => e.type === "blob")
          .map((e) => e.path)
          .filter((p) => {
            const base = (p.split("/").pop() ?? "").toLowerCase();
            return ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"].includes(base);
          }),
        languages: detectLanguages(scopedEntries),
        ecosystems: detectEcosystems(scopedEntries),
        manifests: detectManifests(scopedEntries, inspectedSet),
        structure: {
          ...detectRoots(scopedEntries, ref0.path),
          packages: detectWorkspacePackages(scopedEntries, ref0.path),
        },
        entrypoints: detectEntrypointCandidates(scopedEntries, ref0.path),
        importantFiles: [],
        instructions,
        ciWorkflows: detectCiWorkflows(scopedEntries),
        fetched: files,
        selection: {
          candidateCount,
          selectedCount: inspectedCount,
          treeBlobCount,
          treeTruncated: treePayload.truncated === true,
        },
      },
      [
        ...(treePayload.truncated === true
          ? ["The GitHub tree listing was truncated; parts of the repository were never enumerated."]
          : []),
        ...(notSelectedCount > 0
          ? [`${notSelectedCount} of ${candidateCount} eligible files were not inspected (bounded selection budget).`]
          : []),
        ...(notFetchedCount > 0
          ? [`${notFetchedCount} selected file(s) could not be inspected (unreachable or over size limits).`]
          : []),
        ...(skippedUnsafe > 0 ? [`${skippedUnsafe} unsafe tree path(s) were rejected.`] : []),
        "Repository analysis covers only the inspected selection; the generated skill must not claim whole-repository completeness.",
      ],
    );

    const content = files.map((f) => combinedFileChunk(f.path, f.content)).join("\n\n");
    const label = `${ref0.owner}/${ref0.repo}`;
    return {
      input: {
        type: "github-codebase",
        name: ref0.path ? `${label} codebase (${ref0.path})` : `${label} codebase`,
        content,
        repository: analysis,
      },
      repo: { owner: ref0.owner, repo: ref0.repo, ref, defaultBranchUsed },
      files,
      notes,
      analysis,
    };
  } catch (err) {
    if (err instanceof GithubCodebaseError) throw err;
    if (err instanceof GithubSourceError) {
      throw new GithubCodebaseError(err.message, err.code.replace(/^github_/, "codebase_"));
    }
    throw err;
  }
}
