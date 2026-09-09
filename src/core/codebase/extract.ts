/**
 * Codebase-mode structured extraction from fetched files (pure, no network).
 *
 * Every claim produced here carries evidence pointing at an inspected file —
 * a manifest, CI workflow, instruction file, or test — so the generated skill
 * never asserts a command or convention SkillForge did not observe. Parsing is
 * deliberately lightweight: JSON for manifests, YAML (data-only, already a
 * dependency) for CI workflows, regex/text heuristics for instructions and
 * tests. Malformed files degrade gracefully into notes, never abort ingestion.
 */
import { parse as parseYaml } from "yaml";
import type {
  RepositoryAnalysis,
  RepositoryClaim,
  RepositoryCommand,
  RepositoryConvention,
  RepositoryPublicInterface,
} from "../types.js";
import type { TreeEntryLike } from "../sources/github-codebase.js";

export interface FetchedFile {
  path: string;
  content: string;
}

/** Framework hints worth surfacing when a dependency is observed. Small,
 * curated, and only ever *claimed because the dependency is present*. */
const FRAMEWORK_DEPENDENCIES: Record<string, string> = {
  react: "React", vue: "Vue", "next": "Next.js", svelte: "Svelte",
  express: "Express", fastify: "Fastify", "@nestjs/core": "NestJS", koa: "Koa", hono: "Hono",
  django: "Django", flask: "Flask", fastapi: "FastAPI",
  "actix-web": "Actix Web", axum: "Axum", "tokio": "Tokio",
  rails: "Rails", "spring-boot": "Spring Boot",
  tailwindcss: "Tailwind CSS", vite: "Vite", webpack: "webpack", esbuild: "esbuild",
  typescript: "TypeScript",
};

const TEST_DEPENDENCIES: Record<string, string> = {
  vitest: "vitest", jest: "Jest", mocha: "Mocha", ava: "AVA",
  "@vue/test-utils": "Vue Test Utils", "testing-library": "Testing Library",
  pytest: "pytest", "nose": "nose",
};

function firstLine(text: string): string {
  return text.split("\n")[0]!.trim().slice(0, 300);
}

// ---------------------------------------------------------------------------
// package.json extraction
// ---------------------------------------------------------------------------

export interface PackageJsonInfo {
  path: string;
  name?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  workspaces?: string[];
  typeModule?: boolean;
}

/** Parse one package.json; null on malformed input (graceful degradation). */
export function parsePackageJson(file: FetchedFile): PackageJsonInfo | null {
  try {
    const raw = JSON.parse(file.content) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const info: PackageJsonInfo = { path: file.path };
    if (typeof raw.name === "string") info.name = raw.name;
    if (typeof raw.main === "string") info.main = raw.main;
    if (typeof raw.types === "string") info.types = raw.types;
    if (raw.exports !== undefined) info.exports = raw.exports;
    if (raw.type === "module") info.typeModule = true;
    const ws = raw.workspaces;
    if (Array.isArray(ws)) {
      info.workspaces = ws.filter((w): w is string => typeof w === "string");
    } else if (ws !== null && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
      info.workspaces = (ws as { packages: unknown[] }).packages.filter((w): w is string => typeof w === "string");
    }
    return info;
  } catch {
    return null;
  }
}

/** Script-name → purpose mapping, deterministic first-match. */
const SCRIPT_PURPOSE_RULES: Array<[RegExp, RepositoryCommand["purpose"]]> = [
  [/^type-?check$|^tsc$|^check-?types$|^types$/, "typecheck"],
  [/^(lint|eslint|stylelint|biome)(:|$|-)/, "lint"],
  [/^format$|^prettier/, "format"],
  [/^test|^e2e$/, "test"],
  [/^build$|^compile$|^bundle$|^dist$/, "build"],
  [/^(dev|serve|start)$/, "dev"],
  [/^(install|postinstall|prepare)$/, "install"],
];

export function scriptPurpose(name: string): RepositoryCommand["purpose"] {
  for (const [re, purpose] of SCRIPT_PURPOSE_RULES) {
    if (re.test(name)) return purpose;
  }
  return "other";
}

/**
 * Package-manager evidence, in priority order (P1-5): an explicit
 * `packageManager` field, the repository's lockfile(s), or the install
 * commands observed in CI run steps. Returns null when nothing evidences a
 * runner — callers must then NOT invent one.
 */
/** Path-aware lockfile evidence: one entry per lockfile in the safe scoped
 * reconnaissance set (re-audit P1-2B — never basename-only). */
export interface TreeLockfile {
  path: string;
  basename: string;
}

const MANAGER_LOCKFILES: Array<[string, "npm" | "pnpm" | "yarn" | "bun"]> = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

/** The manager lockfiles that live in the analyzed root's own directory —
 * nested/sibling package lockfiles never evidence the root package. */
function rootDirLockfiles(
  treeLockfiles: TreeLockfile[],
  rootManifestDir: string,
): Array<{ basename: string; manager: "npm" | "pnpm" | "yarn" | "bun" }> {
  return treeLockfiles
    .map((l) => {
      const manager = MANAGER_LOCKFILES.find(([b]) => b === l.basename)?.[1];
      const dir = l.path.includes("/") ? l.path.slice(0, l.path.lastIndexOf("/")) : "";
      return manager ? { basename: l.basename, manager, dir } : null;
    })
    .filter((x): x is { basename: string; manager: "npm" | "pnpm" | "yarn" | "bun"; dir: string } => x !== null)
    .filter((x) => x.dir === rootManifestDir);
}

export function detectPackageManager(
  treeLockfiles: TreeLockfile[],
  ciInstallCommands: string[],
  packageJson: FetchedFile | undefined,
  rootManifestDir: string,
): { name: "npm" | "pnpm" | "yarn" | "bun"; evidence: string; yarnGeneration?: YarnGeneration; lockfilePresent: boolean } | null {
  // Lockfiles in the analyzed root's own directory only (path-aware).
  const rootLockfiles = rootDirLockfiles(treeLockfiles, rootManifestDir);
  const rootManagerLockfiles = new Set(rootLockfiles.map((l) => l.manager));
  const managerFromLockfiles =
    rootManagerLockfiles.size === 1 ? ([...rootManagerLockfiles][0] as "npm" | "pnpm" | "yarn" | "bun") : undefined;

  // 1. Explicit packageManager field (strongest evidence). For Yarn the
  //    pinned version identifies the generation (1.x vs 2+/3+/4+).
  if (packageJson) {
    try {
      const raw = JSON.parse(packageJson.content) as Record<string, unknown>;
      const pm = typeof raw.packageManager === "string" ? raw.packageManager : "";
      const m = pm.match(/^(npm|pnpm|yarn|bun)@/);
      if (m) {
        const yarnGeneration = m[1] === "yarn" ? yarnGenerationFromSpec(pm) : undefined;
        // Yarn generation is corroborated by root-dir config files only:
        // .yarnrc.yml is modern Yarn, .yarnrc (without .yarnrc.yml) is Yarn 1.
        let generation = yarnGeneration;
        if (m[1] === "yarn" && generation === undefined) {
          const hasModern = treeLockfiles.some((l) => l.path === (rootManifestDir === "" ? ".yarnrc.yml" : `${rootManifestDir}/.yarnrc.yml`));
          const hasClassic = treeLockfiles.some((l) => l.path === (rootManifestDir === "" ? ".yarnrc" : `${rootManifestDir}/.yarnrc`));
          generation = hasModern ? 2 : hasClassic ? 1 : undefined;
        }
        return {
          name: m[1] as "npm" | "pnpm" | "yarn" | "bun",
          evidence: `${packageJson.path} packageManager: ${pm.slice(0, 80)}`,
          yarnGeneration: generation,
          lockfilePresent: m[1] === managerFromLockfiles,
        };
      }
    } catch {
      // malformed manifest — fall through to weaker evidence
    }
  }
  // 2. Exactly one manager's lockfile in the root directory names the manager.
  if (managerFromLockfiles !== undefined) {
    const lockfile = rootLockfiles.find((l) => l.manager === managerFromLockfiles)!;
    // Yarn generation from config-file evidence only (see above).
    const yarnGeneration =
      managerFromLockfiles === "yarn"
        ? treeLockfiles.some((l) => l.path === (rootManifestDir === "" ? ".yarnrc.yml" : `${rootManifestDir}/.yarnrc.yml`))
          ? (2 as YarnGeneration)
          : treeLockfiles.some((l) => l.path === (rootManifestDir === "" ? ".yarnrc" : `${rootManifestDir}/.yarnrc`))
            ? (1 as YarnGeneration)
            : undefined
        : undefined;
    return { name: managerFromLockfiles, evidence: `${lockfile.basename} in the analyzed root directory (lockfile)`, yarnGeneration, lockfilePresent: true };
  }
  // 3. CI install commands (only when unambiguous).
  const ciMatches = ciInstallCommands
    .map((c) => c.match(/^(npm ci|npm install|pnpm install|pnpm i( |$)|yarn install|yarn( |$)|bun install|bun i( |$))/)?.[0])
    .filter((x): x is string => x !== undefined);
  const pmNames = new Set(
    ciMatches.map((c) => (c.startsWith("npm") ? "npm" : c.startsWith("pnpm") ? "pnpm" : c.startsWith("yarn") ? "yarn" : "bun")),
  );
  if (pmNames.size === 1) {
    const name = [...pmNames][0] as "npm" | "pnpm" | "yarn" | "bun";
    const yarnGeneration =
      name === "yarn" && ciMatches.some((c) => c.includes("--immutable"))
        ? (2 as YarnGeneration)
        : undefined;
    return { name, evidence: `CI install step "${ciMatches[0]}"`, yarnGeneration, lockfilePresent: false };
  }
  return null;
}

/** Yarn generation from a `packageManager: yarn@X.Y.Z` spec. */
function yarnGenerationFromSpec(spec: string): YarnGeneration | undefined {
  const m = spec.match(/^yarn@(\d+)\./);
  if (!m) return undefined;
  return Number(m[1]) === 1 ? 1 : 2;
}

/** Lifecycle scripts run automatically on install events — never presented as
 * dependency-install commands the agent should run (P1-5). */
const LIFECYCLE_SCRIPTS = new Set(["prepare", "postinstall", "preinstall", "install", "prepublish", "prepublishOnly"]);

/**
 * Yarn generation from lockfile/CI evidence (P1-2): Yarn 1 (`yarn.lock`
 * classic format, `yarn install`) and modern Yarn (`yarn install --immutable`)
 * have different conventions. Returns the generation when it can be
 * determined, null when ambiguous.
 */
export type YarnGeneration = 1 | 2;

/** Synthetic install commands are only legal when the manager's PREREQUISITES
 * are evidenced: `npm ci` needs package-lock.json; `pnpm install
 * --frozen-lockfile` and Yarn-2+ `--immutable` need their lockfile. Yarn 1 and
 * bun have plain forms. CI-observed install commands are always preferred. */
export function syntheticInstallCommand(
  packageManager: { name: "npm" | "pnpm" | "yarn" | "bun"; evidence: string; yarnGeneration?: YarnGeneration; lockfilePresent: boolean } | null,
  rootManifestDir = "",
): RepositoryCommand | null {
  if (!packageManager) return null;
  const mk = (command: string, evidence: string): RepositoryCommand => ({
    purpose: "install",
    command,
    evidence,
    // The manager's install form runs from the analysis root's directory —
    // which, in repository-root coordinates, is the scope itself.
    cwd: rootManifestDir,
    synthesized: true,
  });
  const pm = packageManager.name;
  if (pm === "yarn" && packageManager.yarnGeneration === 1) {
    return mk("yarn install", `${packageManager.evidence} (Yarn 1)`);
  }
  if (pm === "yarn" && packageManager.yarnGeneration === 2) {
    // --immutable is only meaningful with a lockfile to enforce; without one
    // the plain (generation-neutral) form is the evidenced command.
    if (packageManager.lockfilePresent) {
      return mk("yarn install --immutable", `${packageManager.evidence} (Yarn 2+, lockfile present)`);
    }
    return mk("yarn install", `${packageManager.evidence} (Yarn 2+, no lockfile — plain form)`);
  }
  if (pm === "yarn" && packageManager.yarnGeneration === undefined) {
    // Yarn identity alone does not select a flag convention — refuse to guess.
    return null;
  }
  if (pm === "npm") {
    // `npm ci` requires a lockfile; identity alone does not prove one exists.
    if (packageManager.lockfilePresent) {
      return mk("npm ci", packageManager.evidence);
    }
    return null;
  }
  if (pm === "pnpm") {
    if (packageManager.lockfilePresent) {
      return mk("pnpm install --frozen-lockfile", packageManager.evidence);
    }
    // pnpm's plain install form is valid without a lockfile.
    return mk("pnpm install", packageManager.evidence);
  }
  // bun install is the manager's own plain form.
  return mk("bun install", packageManager.evidence);
}

/**
 * Deterministic workspace-glob matching (final remediation P1-2C). Supported
 * patterns: exact directory ("packages/web"), one-level star
 * ("packages/*"), and deep star ("packages/**"). A nested manifest joins the
 * workspace only when its directory matches a declared pattern.
 */
export function workspaceGlobMatches(pattern: string, manifestDir: string): boolean {
  const p = pattern.replace(/\/+$/, "");
  if (p === manifestDir) return true;
  if (p.endsWith("/**")) {
    const base = p.slice(0, -3);
    return manifestDir.startsWith(base === "" ? "" : `${base}/`);
  }
  if (p.endsWith("/*")) {
    const base = p.slice(0, -2);
    if (base === "") return !manifestDir.includes("/");
    return manifestDir.startsWith(`${base}/`) && !manifestDir.slice(base.length + 1).includes("/");
  }
  return false;
}

/**
 * The one canonical analysis-root-relative path helper (final remediation
 * P2-1): returns the directory of `path` relative to the analysis-root
 * directory, or null when the path is NOT under the root (sibling/
 * out-of-scope entries never participate in root-relative matching).
 */
export function pathRelativeToAnalysisRoot(path: string, rootManifestPath: string): string | null {
  const rootDir = rootManifestPath.includes("/")
    ? rootManifestPath.slice(0, rootManifestPath.lastIndexOf("/"))
    : "";
  if (rootDir === "") {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }
  if (path === rootManifestPath || path === rootDir) return "";
  if (!path.startsWith(`${rootDir}/`)) return null;
  const rel = path.slice(rootDir.length + 1);
  return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
}

/**
 * Deterministic workspace membership from a declared pattern list (final
 * remediation P1-3): positive match AND no applicable exclusion. Supports
 * "dir", "dir/*", "dir/**" positives and "!"-prefixed exclusions of the same
 * shapes. Anything else (negations of complex globs, BraceExpansion,
 * incremental ":" syntax, non-strings) is outside the supported subset —
 * fail closed: the whole declaration yields no grounded members.
 */
export function isWorkspaceMember(patterns: readonly string[], manifestDir: string): boolean {
  let sawPositive = false;
  for (const raw of patterns) {
    if (typeof raw !== "string") return false; // non-string → fail closed
    const pattern = raw.trim();
    if (pattern.length === 0) continue;
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    const supported = /^[A-Za-z0-9_@./-]*(\/\*)?$|^[A-Za-z0-9_@./-]+(\/\*\*)?$|^\*$|^\*\*$/.test(body) || body === "." || /^[^*{}[\]!]*$/.test(body);
    if (!supported) return false; // unsupported syntax → fail closed
    const matches = workspaceGlobMatches(body, manifestDir);
    if (matches) {
      if (negated) return false; // exclusion wins
      sawPositive = true;
    }
  }
  return sawPositive;
}

/**
 * Ground workspace membership per manager (final remediation P1-2C):
 * npm/yarn read the analysis-root manifest's `workspaces` globs; pnpm reads
 * pnpm-workspace.yaml (its native mechanism — package.json workspaces do NOT
 * ground pnpm selectors); bun's --cwd needs only the package's own directory
 * and name. Membership is matched deterministically against each nested
 * manifest's path; nested manifests without a usable name are skipped.
 * Returns a map of nested-manifest path → workspace package name.
 */
export function groundWorkspaceMembership(opts: {
  manager: "npm" | "pnpm" | "yarn" | "bun" | undefined;
  files: FetchedFile[];
  rootManifestPath: string;
}): Map<string, string> {
  const workspaceNames = new Map<string, string>();
  const rootManifestDir = opts.rootManifestPath.includes("/")
    ? opts.rootManifestPath.slice(0, opts.rootManifestPath.lastIndexOf("/"))
    : "";
  let globs: string[] = [];
  const rootPackageJson = opts.files.find((f) => f.path === opts.rootManifestPath);
  if (opts.manager === "pnpm") {
    const wsFile = opts.files.find(
      (f) => f.path === (rootManifestDir === "" ? "pnpm-workspace.yaml" : `${rootManifestDir}/pnpm-workspace.yaml`),
    );
    if (wsFile) {
      try {
        const doc = parseYaml(wsFile.content) as { packages?: unknown } | null;
        if (doc !== null && typeof doc === "object" && Array.isArray(doc.packages)) {
          globs = doc.packages.filter((g): g is string => typeof g === "string");
        }
      } catch {
        // malformed pnpm-workspace.yaml — no pnpm workspace grounding
      }
    }
  } else if (rootPackageJson && (opts.manager === "npm" || opts.manager === "yarn")) {
    try {
      const rootRaw = JSON.parse(rootPackageJson.content) as Record<string, unknown>;
      const ws = rootRaw.workspaces;
      globs = Array.isArray(ws)
        ? ws.filter((w): w is string => typeof w === "string")
        : ws !== null && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)
          ? (ws as { packages: unknown[] }).packages.filter((w): w is string => typeof w === "string")
          : [];
    } catch {
      // malformed root manifest — no workspace grounding
    }
  }
  for (const file of opts.files) {
    if (file.path === opts.rootManifestPath) continue;
    if ((file.path.split("/").pop() ?? "").toLowerCase() !== "package.json") continue;
    // Candidate dirs are compared relative to the analysis root (final
    // remediation P2-1): workspace patterns are declared relative to the
    // workspace root, not the repository root. Sibling/out-of-scope paths
    // (not under the root at all) never participate.
    const manifestDir = pathRelativeToAnalysisRoot(file.path, opts.rootManifestPath);
    // bun: --cwd needs only the package's own directory and name (no
    // workspaces declaration required) — but the package must still be in
    // scope: sibling/out-of-scope manifests never participate (P2-1).
    if (opts.manager === "bun") {
      if (manifestDir === null) continue; // sibling/out-of-scope — never participates
      try {
        const nested = JSON.parse(file.content) as Record<string, unknown>;
        if (typeof nested.name === "string" && nested.name.length > 0) {
          workspaceNames.set(file.path, nested.name);
        }
      } catch {
        // malformed nested manifest — no workspace entry
      }
      continue;
    }
    if (manifestDir === null) continue; // sibling/out-of-scope — never participates
    if (globs.length === 0) continue;
    if (!isWorkspaceMember(globs, manifestDir)) continue;
    try {
      const nested = JSON.parse(file.content) as Record<string, unknown>;
      if (typeof nested.name === "string" && nested.name.length > 0) {
        workspaceNames.set(file.path, nested.name);
      }
    } catch {
      // malformed nested manifest — no workspace entry
    }
  }
  return workspaceNames;
}

// ---------------------------------------------------------------------------
// Argv-safe command synthesis (final remediation P1-1)
// ---------------------------------------------------------------------------

/**
 * True when a repository-controlled value can appear as ONE positional argv
 * token with no shell interpretation at all: no whitespace, no
 * shell-significant characters (`;` `&` `|` `$` backtick quotes globs),
 * no leading dash (which a consumer's parser could read as a flag). Leading
 * `.`/`_`/`@` are fine (npm names, dot-directories).
 *
 * This is the fail-closed synthesis gate (P1-1): a value that fails it never
 * reaches a command string. The command is OMITTED from runnable evidence —
 * never quoted-and-hoped, never rewritten into a different command. The
 * original repository fact stays visible in non-runnable evidence.
 */
export function isPositionalSafeValue(value: string): boolean {
  return /^[A-Za-z0-9_./@:][A-Za-z0-9_./@:-]*$/.test(value);
}

/**
 * Final presentation-boundary renderer for structured invocations. Defense in
 * depth: every token must be a plain shell word (trusted literal flags like
 * `--filter` included); if any token is not, the command is dropped (null)
 * rather than rendered. Repository-controlled tokens were already gated by
 * `isPositionalSafeValue` at construction; this re-check means even a
 * construction bug cannot put shell syntax into `RepositoryCommand.command`.
 */
function renderArgv(argv: readonly string[]): string | null {
  for (const token of argv) {
    if (!/^[-A-Za-z0-9_./@:]+$/.test(token)) return null;
  }
  return argv.join(" ");
}

/**
 * Build one synthesized script invocation as structured argv, then render it.
 * Fails closed: a script name that is not positional-safe (shell-significant
 * characters, whitespace, leading dash) returns null — the script stays in
 * non-runnable `scriptDefinitions` evidence instead of becoming a runnable
 * command. The manager executable and fixed subcommands are the only trusted
 * parts; untrusted values are always whole argv tokens.
 */
function scriptInvocationArgv(
  manager: "npm" | "pnpm" | "yarn" | "bun",
  key: string,
): string[] | null {
  if (!isPositionalSafeValue(key)) return null;
  // npm's bare-`test` shortcut keeps its canonical evidenced form.
  return manager === "npm" && key === "test" ? ["npm", "test"] : [manager, "run", key];
}

/**
 * Workspace context for a nested package.json: how a script there is
 * actually run from the repository root. Only pnpm/yarn workspace selectors
 * and npm -w are synthesized, and only when the manifest is nested AND the
 * workspace name is positional-safe (P1-1: `@scope/pkg` is safe;
 * `web && curl attacker` fails closed → null).
 */
function workspaceInvocationArgv(
  manager: "npm" | "pnpm" | "yarn" | "bun",
  key: string,
  manifestPath: string,
  workspaceNames: ReadonlyMap<string, string>,
  rootManifestPath: string,
): { argv: string[]; contextEvidence: string } | null {
  const manifestDir = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/")) : "";
  if (manifestDir === "") return null; // root manifest: plain invocation
  // Find the workspace name for this manifest path.
  const workspaceName = workspaceNames.get(manifestPath);
  if (!workspaceName) return null; // cannot ground the selector — omit
  if (!isPositionalSafeValue(workspaceName)) return null; // unsafe selector — omit
  const base = scriptInvocationArgv(manager, key);
  if (!base) return null;
  switch (manager) {
    case "pnpm":
      return { argv: ["pnpm", "--filter", workspaceName, ...base.slice(1)], contextEvidence: `workspace ${workspaceName} (pnpm --filter)` };
    case "yarn":
      return { argv: ["yarn", "workspace", workspaceName, ...base.slice(1)], contextEvidence: `workspace ${workspaceName} (yarn workspace)` };
    case "npm":
      // npm requires the workspace selector before `--`-separated args; keep
      // `run <script>` together: npm run <key> --workspace <name>.
      return { argv: ["npm", "run", key, "--workspace", workspaceName], contextEvidence: `workspace ${workspaceName} (npm --workspace)` };
    case "bun": {
      // --cwd uses the manifest's own repository-root-relative directory (the
      // same cwd frame CI working-directory values use); out-of-scope
      // manifests never participate.
      const rel = manifestDir;
      if (!isPositionalSafeValue(rel)) return null; // unsafe path — omit
      return { argv: ["bun", "--cwd", rel, ...base.slice(1)], contextEvidence: `${rel}/ (bun --cwd)` };
    }
  }
}

/** Commands from package.json scripts (root and workspaces).
 *
 * Evidence model (re-audit P1-2 + final remediation P1-1): a script becomes a
 * runnable `RepositoryCommand` only when (a) manager evidence exists, (b) the
 * execution context is grounded (analysis-root manifest, or a workspace
 * selector whose name is positional-safe), and (c) the script name itself is
 * positional-safe. Synthesized invocations are structured argv rendered at
 * the boundary; unsafe or ungroundable scripts are preserved as structured
 * non-runnable evidence via `scriptDefinitions`, never stuffed into a
 * command string. */
export function commandsFromPackageJson(
  files: FetchedFile[],
  packageManager: { name: "npm" | "pnpm" | "yarn" | "bun"; evidence: string; yarnGeneration?: YarnGeneration; lockfilePresent: boolean } | null,
  context?: { rootManifestPath?: string; workspaceNames?: ReadonlyMap<string, string> },
): { commands: RepositoryCommand[]; frameworks: RepositoryClaim[]; testing: string[]; scriptDefinitions: RepositoryCommand[] } {
  const workspaceNames = context?.workspaceNames ?? new Map<string, string>();
  const rootManifestPath = context?.rootManifestPath ?? "package.json";
  const commands: RepositoryCommand[] = [];
  const scriptDefinitions: RepositoryCommand[] = [];
  const frameworkClaims: RepositoryClaim[] = [];
  const testingFrameworks = new Set<string>();
  const frameworkEvidence = new Map<string, string[]>();
  const workspaces = workspaceNames;

  for (const file of files) {
    if ((file.path.split("/").pop() ?? "").toLowerCase() !== "package.json") continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(file.content) as Record<string, unknown>;
    } catch {
      continue; // malformed manifest degrades gracefully
    }
    const scripts = raw.scripts;
    if (scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)) {
      for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
        if (typeof value !== "string" || value.trim().length === 0) continue;
        if (commands.length >= 30) break;
        const purpose = scriptPurpose(key);
        if (LIFECYCLE_SCRIPTS.has(key)) {
          // Lifecycle scripts run automatically during install; the only
          // honest install command is the manager's evidenced install form
          // (added separately). Record nothing here.
          continue;
        }
        // Every runnable command needs a grounded execution context. The
        // analysis-root manifest uses the plain invocation; nested manifests
        // need a grounded workspace selector. Untrusted values (script name,
        // workspace name) are whole argv tokens or the command is omitted.
        const isRootManifest = file.path === rootManifestPath;
        const manifestDir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
        const ws = isRootManifest
          ? null
          : workspaceInvocationArgv(packageManager?.name ?? "npm", key, file.path, workspaces, rootManifestPath);
        const argv = packageManager
          ? isRootManifest
            ? scriptInvocationArgv(packageManager.name, key)
            : (ws?.argv ?? null)
          : null;
        if (argv) {
          const command = renderArgv(argv);
          if (command !== null) {
            commands.push({
              purpose,
              command,
              evidence: `${file.path} scripts.${key} = "${value.slice(0, 120)}"${ws ? ` (${ws.contextEvidence})` : ""}`,
              // Repository-root-relative execution directory: the manifest's
              // own directory ("" = repository root). Selector forms run from
              // the workspace root; bun --cwd names the manifest directory.
              cwd: isRootManifest ? (rootManifestPath.includes("/") ? rootManifestPath.slice(0, rootManifestPath.lastIndexOf("/")) : "") : manifestDir,
              synthesized: true,
            });
            continue;
          }
        }
        // No grounded execution context / unsafe name: preserve as
        // non-runnable evidence.
        scriptDefinitions.push({
          purpose,
          command: "",
          evidence: `${file.path} scripts.${key} = "${value.slice(0, 120)}"`,
        });
      }
    }
    for (const depField of ["dependencies", "devDependencies"] as const) {
      const deps = raw[depField];
      if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
      for (const dep of Object.keys(deps as Record<string, unknown>)) {
        const fw = FRAMEWORK_DEPENDENCIES[dep] ?? FRAMEWORK_DEPENDENCIES[dep.split("/").pop()!];
        if (fw) {
          const ev = `${file.path} ${depField}: ${dep}`;
          frameworkEvidence.set(fw, [...(frameworkEvidence.get(fw) ?? []), ev].slice(0, 8));
        }
        for (const [testDep, fwName] of Object.entries(TEST_DEPENDENCIES)) {
          // Exact match, or scope match for the @testing-library org — a loose
          // substring match would false-positive on unrelated packages.
          if (dep === testDep || (testDep === "testing-library" && dep.startsWith("@testing-library/"))) {
            testingFrameworks.add(fwName);
          }
        }
      }
    }
  }
  for (const [fw, ev] of frameworkEvidence) {
    frameworkClaims.push({ name: fw, evidence: ev });
  }
  frameworkClaims.sort((a, b) => a.name.localeCompare(b.name));
  return {
    commands: commands.slice(0, 30),
    frameworks: frameworkClaims.slice(0, 16),
    testing: [...testingFrameworks].sort(),
    scriptDefinitions: scriptDefinitions.slice(0, 12),
  };
}



/**
 * Framework/testing evidence from pyproject.toml without a TOML parser:
 * dependency strings are extracted from the `dependencies`/`optional-dependencies`
 * arrays by regex, version specs are stripped, and only names in the curated
 * framework map are claimed (always with the pyproject file as evidence).
 * A malformed file simply yields nothing.
 */
export function frameworksFromPyproject(file: FetchedFile): { frameworks: RepositoryClaim[]; testing: string[] } {
  const frameworks = new Map<string, string[]>();
  const testing = new Set<string>();
  const depsBlock = file.content.match(/^dependencies\s*=\s*\[([^\]]*)\]/m);
  if (depsBlock) {
    for (const m of depsBlock[1]!.matchAll(/"([^"]+)"/g)) {
      const name = m[1]!
        .split(/[;\[\]><=~!]/)[0]!
        .trim()
        .toLowerCase();
      const fw = FRAMEWORK_DEPENDENCIES[name];
      if (fw) frameworks.set(fw, [...(frameworks.get(fw) ?? []), `${file.path} dependencies: ${name}`].slice(0, 8));
      if (TEST_DEPENDENCIES[name]) testing.add(TEST_DEPENDENCIES[name]);
    }
  }
  if (/\[tool\.pytest[^\]]*\]/.test(file.content)) testing.add("pytest");
  return {
    frameworks: [...frameworks.entries()].map(([name, evidence]) => ({ name, evidence })).sort((a, b) => a.name.localeCompare(b.name)),
    testing: [...testing],
  };
}

// ---------------------------------------------------------------------------
// CI workflow extraction
// ---------------------------------------------------------------------------

/** Collect `run:` command strings from a parsed YAML document. */
/** One CI run step with its resolved execution context (final remediation
 * P1-2): `cwd` is the effective working-directory (step-level overrides
 * job/workflow defaults). A dynamic/unsupported cwd (${{
 ... }}) or a
 * non-string value yields `cwd: undefined` — the command stays documented but
 * is NOT runnable evidence, never a guessed directory. */
export interface CiRunStep {
  command: string;
  /** Concrete execution directory relative to the repository root, "" = root.
   * undefined = execution context unknown/dynamic (non-runnable). */
  cwd?: string;
  file: string;
  line: number;
}

/** GitHub Actions `defaults.run.working-directory` state (final remediation
 * P1-2): "absent" (nothing declared → consider the next level), a concrete
 * string, or "unknown" (dynamic `${{ … }}` / non-string — the effective
 * directory is unknowable and must NOT inherit). Absence and unknown are
 * distinct states. */
type WdDefault = { state: "absent" } | { state: "concrete"; value: string } | { state: "unknown" };

function defaultsWorkingDirectory(node: unknown): WdDefault {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return { state: "absent" };
  const defaults = (node as Record<string, unknown>).defaults;
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) return { state: "absent" };
  const run = (defaults as Record<string, unknown>).run;
  if (run === null || typeof run !== "object" || Array.isArray(run)) return { state: "absent" };
  const wd = (run as Record<string, unknown>)["working-directory"];
  if (wd === undefined) return { state: "absent" };
  if (typeof wd !== "string" || wd.includes("${{")) return { state: "unknown" };
  return { state: "concrete", value: wd.replace(/\/+$/, "") };
}

/** Step-level working-directory, three-state (final remediation P1-2): a
 * dynamic `${{ … }}` or non-string value is UNKNOWN — the step is
 * non-runnable and must NOT inherit job/workflow defaults. */
function stepWorkingDirectory(step: Record<string, unknown>): WdDefault {
  const wd = step.workingDirectory ?? step["working-directory"];
  if (wd === undefined) return { state: "absent" };
  if (typeof wd !== "string" || wd.includes("${{")) return { state: "unknown" };
  return { state: "concrete", value: wd.replace(/\/+$/, "") };
}

/**
 * Effective execution-directory resolution (final remediation P1-2): step
 * concrete > job concrete > workflow concrete > analysis root (""). An
 * unknown value at ANY level makes the result unknown and never falls back to
 * a lower-precedence level: a dynamic job default must not inherit the
 * workflow default, and a dynamic workflow default must not become the root.
 */
function resolveStepCwd(step: WdDefault, job: WdDefault, workflow: WdDefault): string | undefined {
  for (const level of [step, job, workflow]) {
    if (level.state === "concrete") return level.value;
    if (level.state === "unknown") return undefined;
  }
  return "";
}

/**
 * P1-2 fail-closed run-value policy. GitHub Actions executes a `run:` value
 * as ONE shell process, so a block with multiple command lines cannot have
 * its execution context reconstructed line-by-line (`cd`, `pushd`, `export`,
 * `source` all change state for later lines). Policy: a run value yields a
 * runnable command only when it contains exactly ONE non-empty, non-comment
 * line — provably identical execution semantics to a single-line `run:`.
 * Any other block is non-runnable evidence (counted in telemetry and
 * surfaced as analysis uncertainty, never guessed at).
 */
function singleCommandRunValue(raw: string): string | null {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return lines.length === 1 ? lines[0]! : null;
}

/** Skipped-step accounting surfaced honestly through analysis uncertainty. */
export interface CiExtractionTelemetry {
  /** `run:` blocks that are not provably a single command (fail-closed). */
  nonRunnableRunBlocks: number;
  /** Steps whose effective cwd is dynamic/non-string (non-runnable). */
  unknownCwdSteps: number;
  /** Steps whose concrete cwd cannot be embedded unambiguously (P1-1). */
  unsafeCwdSteps: number;
}

/**
 * Collect run steps with their execution context. Deterministic direct walk:
 * top-level steps (composite workflow actions) + jobs[].steps, resolving each
 * step's cwd through the tri-state chain. Multiline run blocks and
 * unknown/unsafe execution contexts never become runnable steps.
 */
function collectRunSteps(node: unknown, out: CiRunStep[], telemetry: CiExtractionTelemetry, file: string, workflowWd: WdDefault): void {
  if (out.length >= 30) return;
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const root = node as Record<string, unknown>;

  const collectSteps = (steps: unknown, jobWd: WdDefault): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (out.length >= 30) return;
      if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
      const s = step as Record<string, unknown>;
      if (typeof s.run !== "string") continue;
      if (s.run.trim().length === 0) continue;
      const runText = singleCommandRunValue(s.run);
      if (runText === null) {
        telemetry.nonRunnableRunBlocks++;
        continue;
      }
      if (runText.startsWith("#") || runText.startsWith("echo ")) continue;
      const cwd = resolveStepCwd(stepWorkingDirectory(s), jobWd, workflowWd);
      if (cwd === undefined) {
        telemetry.unknownCwdSteps++;
        continue;
      }
      if (cwd !== "" && !isPositionalSafeValue(cwd)) {
        telemetry.unsafeCwdSteps++;
        continue;
      }
      out.push({ command: runText, cwd, file, line: 0 });
    }
  };

  // Top-level steps (composite workflow actions): no job level.
  collectSteps(root.steps, { state: "absent" });

  // Jobs: job-level defaults.run.working-directory overrides workflow-level;
  // an unknown job default stays unknown (never inherits the workflow value).
  const jobs = root.jobs;
  if (jobs !== null && typeof jobs === "object" && !Array.isArray(jobs)) {
    for (const job of Object.values(jobs as Record<string, unknown>)) {
      if (out.length >= 30) return;
      if (job === null || typeof job !== "object" || Array.isArray(job)) continue;
      collectSteps((job as Record<string, unknown>).steps, defaultsWorkingDirectory(job));
    }
  }
}

const CI_COMMAND_RULES: Array<[RegExp, RepositoryCommand["purpose"]]> = [
  [/^(npm (ci|install)|yarn(\s+install)?|pnpm(\s+i| install)|bun install)/, "install"],
  [/(^|\s)(npm (run |test)|yarn test|pnpm (run )?test|pytest|cargo test|go test|make test|gradle test|mvn test)/, "test"],
  [/(npm run build|cargo build|go build|make build|gradle build|mvn (package|verify))/, "build"],
  [/(npm run lint|eslint|stylelint|ruff|flake8|pylint|golangci|clippy)/, "lint"],
  [/(tsc( --noEmit)?|mypy|pyright|vue-tsc)/, "typecheck"],
  [/(prettier|cargo fmt|gofmt|black|ruff format)/, "format"],
];

/**
 * CI run steps → commands with preserved execution context (final remediation
 * P1-2, telemetry-augmented). Only provably single-command steps with a
 * concrete, safe cwd become runnable evidence; a concrete cwd renders the
 * canonical `cd <dir> && <command>` form so "npm ci at root" and "npm ci in
 * packages/web" remain context-distinct. The optional `telemetry` out-param
 * records every step that was excluded fail-closed so the analysis can state
 * the limitation honestly instead of silently dropping it.
 */
export function commandsFromCiWorkflows(
  files: FetchedFile[],
  telemetry?: CiExtractionTelemetry,
): RepositoryCommand[] {
  const commands: RepositoryCommand[] = [];
  const tally: CiExtractionTelemetry = { nonRunnableRunBlocks: 0, unknownCwdSteps: 0, unsafeCwdSteps: 0 };
  for (const file of files) {
    if (!file.path.startsWith(".github/workflows/")) continue;
    let doc: unknown;
    try {
      doc = parseYaml(file.content);
    } catch {
      continue; // malformed workflow degrades gracefully
    }
    const wfWd = defaultsWorkingDirectory(doc);
    const steps: CiRunStep[] = [];
    collectRunSteps(doc, steps, tally, file.path, wfWd);
    for (const step of steps) {
      if (commands.length >= 30) break;
      const purpose = CI_COMMAND_RULES.find(([re]) => re.test(step.command))?.[1];
      if (!purpose) continue;
      const rendered = step.cwd === "" ? step.command : `cd ${step.cwd} && ${step.command}`;
      commands.push({
        purpose,
        command: rendered,
        evidence: `${step.file} (CI run step${step.cwd === "" ? "" : `, working-directory: ${step.cwd}`})`,
        // The command TEXT is directly observed; only the cd prefix (when
        // present) was synthesized from the workflow's own declared context.
        cwd: step.cwd,
      });
    }
  }
  if (telemetry) Object.assign(telemetry, tally);
  return commands;
}

// ---------------------------------------------------------------------------
// Instruction files (AGENTS.md, CONTRIBUTING.md, …)
// ---------------------------------------------------------------------------

const CONSTRAINT_LINE_RE =
  /\b(must|must not|never|always|do not|don'?t|avoid|required|forbidden|prohibited|make sure|ensure|before (?:pushing|committing|merging)|only|use|prefer|keep)\b/i;

/**
 * Deterministic trust-boundary classification (final remediation P1-5).
 *
 * Subject/domain-centered, not a blacklist: repository content may govern the
 * TARGET CODEBASE (developer_convention) but never the agent instruction
 * hierarchy (meta_instruction), secret disclosure / data exfiltration
 * (secret_exfiltration), or anything unclassifiable (unknown). Only
 * developer_convention is promoted into RepositoryAnalysis.conventions —
 * unknown suspicious directives are omitted (fail closed), never guessed.
 */
export type ConventionCategory =
  | "developer_convention"
  | "meta_instruction"
  | "secret_exfiltration"
  | "unknown";

/** Instruction-hierarchy domain: any mention pairing an agent/instruction
 * role with hierarchy vocabulary, or a hierarchy verb with such an object. */
const HIERARCHY_RE = [
  /\b(system|developer|user|assistant|model|planner|ai|llm)\b[^.\n]{0,50}\b(prompt|prompts|message|messages|instruction|instructions|direction|directions|request|policy|policies|rules?|safeguard|guardrail|guardrails|priority|priorities|hierarchy|behavior)\b/i,
  /\b(obey|follow|prioritize|prioritise|prefer|supersede|defer to|override|disregard|ignore|replace|take precedence|precedence over|trump|outrank|above|over|instead of)\b[^.\n]{0,60}\b(system|developer|user|assistant|model|planner|prompt|prompts|message|messages|instruction|instructions|request|policies?|rules?|safeguards?|guardrails?)\b/i,
  /\b(treat|regard|consider)\b[^.\n]{0,60}\b(higher|lower) priority/i,
  /\bhigher priority than (?:the )?(?:system|developer|user)/i,
  /\bthis file|this document\b[^.\n]{0,50}\b(above|over|instead of|supersede)/i,
];

/** Agent-behavior / output-control domain: repository text must not govern
 * what the model answers with or how it behaves. */
const BEHAVIOR_RE = [
  /\byou (?:are|'re|must|should|will)\b[^.\n]{0,50}\b(now|DeploymentBot|a different|an? (?:unrestricted|uncensored|evil))\b/i,
  /\b(answers?|respond|responds|reply|replies|output)\b[^.\n]{0,40}\b(only|exclusively)\b[^.\n]{0,40}\b(using|with|from|per)\b/i,
  /\b(only|exclusively)\b[^.\n]{0,40}\b(answer|answers|respond|responds|reply|replies|output)\b[^.\n]{0,40}\b(using|with|from|per|as|in)\b/i,
  /\b(change|modify|alter|replace|update)\b[^.\n]{0,50}\b(output|response|answer)\b[^.\n]{0,30}\b(schema|format|template|specification)\b/i,
  /\b(hidden prompt|chain[- ]of[- ]thought|developer mode|jailbreak|pretend to be|roleplay as|adopt the persona)/i,
];

/** Secret-disclosure / data-exfiltration domain: any transmission or
 * disclosure of sensitive material toward a destination or audience. */
const SECRET_EXFIL_RE = [
  /\b(reveal|show|print|expose|disclose|display|repeat|leak|emit)\b[^.\n]{0,60}\b(system prompt|hidden prompt|api[- ]?keys?|credentials?|secrets?|tokens?|passwords?)\b/i,
  /\b(send|upload|post|transmit|forward|exfiltrate|copy|deliver|push)\b[^.\n]{0,80}\b(source code|sources?|code|data|secrets?|credentials?|environment|\.env|keys?)\b[^.\n]{0,80}\b(to|at|into)\b[^.\n]{0,40}\b(https?:\/\/|external|remote|third[- ]party|server|endpoint|attacker|evil)\b/i,
  /\b(send|upload|post|transmit|exfiltrate|curl|wget|fetch)\b[^.\n]{0,60}\b(https?:\/\/|evil\.|attacker|webhook\.site|requestbin)/i,
];

/** Development-domain signals: the vocabulary of codebase conventions. */
const DEV_DOMAIN_RE =
  /\b(test|tests|testing|pytest|vitest|jest|mocha|lint|eslint|typecheck|tsc|mypy|ruff|build|compile|commit|commits|push|branch|branches|merge|merging|rebase|pr|pull request|review|migration|migrations|database|db|schema|api|module|modules|file|files|folder|folders|directory|directories|src|deps|dependenc(?:y|ies)|package|packages|version|versions|format|formatter|prettier|naming|style|docs|documentation|readme|changelog|ci|release|deploy|config|configs|env|environment|workspace|workspaces|script|scripts|generated|codegen|imports?|exports?|types?|typescript|javascript|python|node|npm|pnpm|yarn|bun|cargo|go|gem|bundle|repo|repository|codebase|generated files|public api)\b/i;

export function classifyConvention(line: string): ConventionCategory {
  const text = line.replace(/\*\*/g, "").trim();
  if (SECRET_EXFIL_RE.some((re) => re.test(text))) return "secret_exfiltration";
  if (HIERARCHY_RE.some((re) => re.test(text))) return "meta_instruction";
  if (BEHAVIOR_RE.some((re) => re.test(text))) return "meta_instruction";
  // Developer conventions must be ABOUT the codebase; anything without a
  // development-domain signal is unknown → fail closed.
  return DEV_DOMAIN_RE.test(text) ? "developer_convention" : "unknown";
}

/** Kept for the adversarial-suite call sites: true when the line may NOT be
 * promoted (anything that is not a developer convention). */
export function isMetaInstruction(line: string): boolean {
  return classifyConvention(line) !== "developer_convention";
}

/** Convention statements from repository instruction files, each traceable to
 * `path:line`. Imperative bullet/constraint lines only — never prose summaries. */
export function conventionsFromInstructionFiles(files: FetchedFile[]): RepositoryConvention[] {
  const out: RepositoryConvention[] = [];
  const instructionFiles = files
    .filter((f) => {
      const base = (f.path.split("/").pop() ?? "").toLowerCase();
      return (
        base === "agents.md" || base === "claude.md" || base === "contributing.md" ||
        base === "development.md" || base === "security.md" || base === "codeowners" ||
        /^readme(\.[a-z0-9]+)?$/.test(base) || base === "testing.md" || base === "docs.md"
      );
    })
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));

  for (const file of instructionFiles) {
    if (out.length >= 20) break;
    const lines = file.content.split("\n");
    let inFence = false;
    for (let i = 0; i < lines.length && out.length < 20; i++) {
      const line = lines[i]!;
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const bullet = line.match(/^\s{0,3}[-*+]\s+(.+)$/);
      const text = (bullet ? bullet[1]! : line).replace(/\*\*/g, "").trim();
      if (text.length < 12 || text.length > 400) continue;
      if (!CONSTRAINT_LINE_RE.test(text)) continue;
      // Untrusted instruction text is promoted ONLY when it classifies as a
      // repository development convention (final remediation P1-5); meta/
      // secret/unknown directives fail closed.
      if (classifyConvention(text) !== "developer_convention") continue;
      out.push({ statement: text, evidence: [`${file.path}:${i + 1}`] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Public interfaces from manifest evidence (package.json entry fields, go.mod
 * module path). Deliberately conservative — nothing is inferred from source. */
export function publicInterfacesFromFiles(files: FetchedFile[]): RepositoryPublicInterface[] {
  const out: RepositoryPublicInterface[] = [];
  for (const file of files) {
    const base = (file.path.split("/").pop() ?? "").toLowerCase();
    if (base === "package.json") {
      const info = parsePackageJson(file);
      if (!info) continue;
      if (info.main) {
        out.push({
          name: info.name,
          path: file.path,
          description: `package.json main: ${info.main}`,
        });
      }
      if (info.exports !== undefined && typeof info.exports === "object") {
        out.push({
          name: info.name,
          path: file.path,
          description: `package.json exports field defines the public entrypoints (${Math.min(JSON.stringify(info.exports).length, 160)} bytes of export map)`,
        });
      }
      if (info.types) {
        out.push({
          name: info.types,
          path: file.path,
          description: `package.json types: ${info.types}`,
        });
      }
    } else if (base === "go.mod") {
      const m = file.content.match(/^module\s+(\S+)$/m);
      if (m) {
        out.push({ name: m[1], path: file.path, description: `Go module path: ${m[1]}` });
      }
    }
  }
  return out.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Testing evidence
// ---------------------------------------------------------------------------

/** Testing frameworks evidenced by test dependencies and selected test files. */
export function testingEvidence(
  files: FetchedFile[],
  depFrameworks: string[],
): { frameworks: string[]; relevantFiles: string[] } {
  const frameworks = new Set(depFrameworks);
  const relevantFiles: string[] = [];
  for (const file of files) {
    const base = file.path.split("/").pop() ?? "";
    const isTestFile =
      /(\.test\.|\.spec\.|_test\.go|\.bak$)/.test(base) ||
      file.path.split("/").some((seg) => ["tests", "test", "__tests__", "spec", "e2e"].includes(seg.toLowerCase()));
    if (!isTestFile) continue;
    if (relevantFiles.length < 24) relevantFiles.push(file.path);
    if (/import\s+(pytest|unittest)|from\s+pytest/.test(file.content)) frameworks.add("pytest");
    if (/from\s+"vitest"|from\s+'vitest'|require\("vitest"\)/.test(file.content)) frameworks.add("vitest");
    if (/from\s+"jest"|@jest\/globals|require\("jest"\)/.test(file.content)) frameworks.add("Jest");
    if (/_test\.go$/.test(base)) frameworks.add("go test");
  }
  if (relevantFiles.some((p) => p.endsWith("_test.go"))) frameworks.add("go test");
  return { frameworks: [...frameworks].sort().slice(0, 8), relevantFiles };
}

// ---------------------------------------------------------------------------
// Full structured analysis assembly
// ---------------------------------------------------------------------------

export interface AnalysisFromFilesInput {
  url: string;
  owner: string;
  name: string;
  ref: string;
  /** Subpath scope the analysis covers; undefined = whole repository. */
  scope?: string;
  /** Paths of metadata-only lockfiles in the safe scoped reconnaissance set
   * — path-aware package-manager evidence (final remediation P1-2B). */
  treeLockfiles?: string[];
  /** Reconnaissance results from the tree (already computed). */
  languages: RepositoryAnalysis["languages"];
  ecosystems: string[];
  manifests: RepositoryAnalysis["manifests"];
  structure: RepositoryAnalysis["structure"];
  entrypoints: RepositoryAnalysis["entrypoints"];
  importantFiles: RepositoryAnalysis["importantFiles"];
  instructions: string[];
  ciWorkflows: string[];
  /** Files actually fetched and inspected. */
  fetched: FetchedFile[];
  selection: RepositoryAnalysis["selection"];
  /** Instruction-file paths among the fetched files (for importantFiles). */
}

/**
 * Assemble the RepositoryAnalysis: tree reconnaissance + extraction from the
 * bounded fetched files. `uncertainty` records honest limits.
 */
export function buildRepositoryAnalysisFromFiles(
  input: AnalysisFromFilesInput,
  uncertainty: string[],
): RepositoryAnalysis {
  const rootManifestPath = input.scope ? `${input.scope}/package.json` : "package.json";
  const rootManifestDir = input.scope ?? "";
  // EXACT analysis-root manifest only (final remediation P1-1): a nested
  // package manifest must never silently become root package-manager
  // evidence. No fallback — when the exact root manifest is absent, the
  // root manager stays unknown (root-scoped lockfiles/CI commands can still
  // evidence it independently).
  const rootPackageJson = input.fetched.find((f) => f.path === rootManifestPath);
  const treeLockfiles: TreeLockfile[] = (input.treeLockfiles ?? [])
    .map((p) => ({ path: p, basename: (p.split("/").pop() ?? "").toLowerCase() }))
    .filter((l) => MANAGER_LOCKFILES.some(([b]) => b === l.basename));
  // CI extraction first (telemetry records every fail-closed exclusion).
  const ciTelemetry: CiExtractionTelemetry = { nonRunnableRunBlocks: 0, unknownCwdSteps: 0, unsafeCwdSteps: 0 };
  const ciCommandsRaw = commandsFromCiWorkflows(input.fetched, ciTelemetry);
  // CI evidence is root-scoped ONLY when the step's structurally-resolved
  // working-directory is exactly the analysis root ("" for a whole-repository
  // analysis, the scope itself for scoped requests — working-directory values
  // are repository-root-relative per GitHub semantics). Structural selection
  // on the `cwd` field — never string matching on the rendered `cd …` form
  // (final remediation P1-2).
  const isRootScopedCi = (c: RepositoryCommand): boolean => c.cwd === rootManifestDir;
  const rootCiInstallCommands = ciCommandsRaw
    .filter((c) => c.purpose === "install" && isRootScopedCi(c))
    .map((c) => c.command);
  const packageManager = detectPackageManager(treeLockfiles, rootCiInstallCommands, rootPackageJson, rootManifestDir);
  const workspaceNames = groundWorkspaceMembership({
    manager: packageManager?.name,
    files: input.fetched,
    rootManifestPath,
  });
  const { commands, frameworks: depFrameworks, testing: depTesting, scriptDefinitions } = commandsFromPackageJson(
    input.fetched,
    packageManager,
    { rootManifestPath, workspaceNames },
  );

  // Python ecosystem evidence (pyproject.toml has no scripts; frameworks only).
  let pyFrameworks: RepositoryClaim[] = [];
  for (const file of input.fetched) {
    if ((file.path.split("/").pop() ?? "").toLowerCase() !== "pyproject.toml") continue;
    const py = frameworksFromPyproject(file);
    pyFrameworks = py.frameworks;
    depTesting.push(...py.testing);
  }
  // Install command precedence (P1-2): EXACT commands observed in inspected
  // ROOT-SCOPED CI evidence first; only when root-scoped CI shows no install
  // step may the manager's deterministic install form be synthesized — and
  // only when its prerequisites are provable (npm ci needs
  // package-lock.json; Yarn needs a generation to pick its flag convention).
  // A CI install step in a nested directory (its cwd ≠ analysis root) must
  // never become root install evidence.
  const rootScopedCiInstall = ciCommandsRaw.find((c) => c.purpose === "install" && isRootScopedCi(c));
  const installCommand = rootScopedCiInstall ?? syntheticInstallCommand(packageManager, rootManifestDir);
  const ciCommands = ciCommandsRaw.filter(
    (c) => !(c.purpose === "install" && installCommand && c.command === installCommand.command && c.evidence === installCommand.evidence),
  );
  // Manifest commands first (authoritative), then the evidenced install
  // command, then CI commands as corroboration.
  const seenCommands = new Set<string>();
  const commandsOut: RepositoryCommand[] = [];
  for (const c of [installCommand, ...commands, ...ciCommands].filter(
    (c): c is RepositoryCommand => c !== null,
  )) {
    const key = `${c.purpose}::${c.command}`;
    if (seenCommands.has(key)) continue;
    seenCommands.add(key);
    commandsOut.push(c);
  }
  // Non-runnable script definitions are analysis evidence, never rendered as
  // commands; keep them out of the commands list entirely.
  void scriptDefinitions;

  const conventions = conventionsFromInstructionFiles(input.fetched);
  const publicInterfaces = publicInterfacesFromFiles(input.fetched);
  const testing = testingEvidence(input.fetched, depTesting);

  // Entry-point evidence from package.json main/types fields. Manifest field
  // values are manifest-relative and are resolved against the manifest's own
  // directory (correct for scoped monorepo packages). When tree
  // reconnaissance already named the same file, the manifest evidence is
  // merged into that entry's reason instead of duplicating it.
  const entrypoints = [...input.entrypoints];
  for (const file of input.fetched) {
    if ((file.path.split("/").pop() ?? "").toLowerCase() !== "package.json") continue;
    const info = parsePackageJson(file);
    if (!info) continue;
    if (info.main) {
      const manifestDir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      const resolved = `${manifestDir === "" ? "" : `${manifestDir}/`}${info.main.replace(/^\.\//, "")}`;
      const existing = entrypoints.find((e) => e.path === resolved);
      if (existing) {
        existing.reason = `${existing.reason} + package.json main field (${file.path})`;
      } else {
        entrypoints.push({ path: resolved, reason: `package.json main field (${file.path})` });
      }
    }
  }

  // Important files: instructions first (they were a selection priority).
  const importantFiles = [...input.importantFiles];
  for (const path of input.instructions.slice(0, 8)) {
    if (importantFiles.some((f) => f.path === path)) continue;
    importantFiles.push({
      path,
      reason: /readme/i.test(path)
        ? "primary repository documentation"
        : "repository instruction file (conventions and workflow authority)",
    });
  }

  // Fail-closed CI exclusions are surfaced honestly (never silently dropped):
  // multiline run blocks, dynamic-cwd steps, and unsafe-cwd steps are
  // documented as non-runnable analysis limits (final remediation P1-2).
  const ciLimits: string[] = [];
  if (ciTelemetry.nonRunnableRunBlocks > 0) {
    ciLimits.push(
      `${ciTelemetry.nonRunnableRunBlocks} CI run block(s) contain more than one command line; SkillForge does not reconstruct shell state (cd/pushd/export) within a block, so those steps were treated as non-runnable documentation.`,
    );
  }
  if (ciTelemetry.unknownCwdSteps > 0) {
    ciLimits.push(
      `${ciTelemetry.unknownCwdSteps} CI step(s) use a dynamic or non-string working-directory; their execution directory is unknown, so they were treated as non-runnable documentation.`,
    );
  }
  if (ciTelemetry.unsafeCwdSteps > 0) {
    ciLimits.push(
      `${ciTelemetry.unsafeCwdSteps} CI step(s) declare a working-directory that cannot be represented unambiguously as a command argument; they were treated as non-runnable documentation.`,
    );
  }

  return {
    repository: {
      url: input.url,
      owner: input.owner,
      name: input.name,
      ref: input.ref,
      ...(input.scope ? { scope: input.scope } : {}),
    },
    mode: "codebase",
    languages: input.languages,
    ecosystems: input.ecosystems,
    frameworks: [...depFrameworks, ...pyFrameworks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 16),
    manifests: input.manifests,
    commands: commandsOut.slice(0, 30),
    structure: input.structure,
    entrypoints: entrypoints.slice(0, 12),
    importantFiles: importantFiles.slice(0, 24),
    conventions,
    publicInterfaces,
    testing: {
      frameworks: testing.frameworks,
      relevantFiles: testing.relevantFiles,
    },
    inspectedFiles: input.fetched.map((f) => f.path),
    selection: input.selection,
    uncertainty: [...ciLimits, ...uncertainty].slice(0, 12),
  };
}

// Re-export for tests that want a tree-entry-shaped helper.
export type { TreeEntryLike };
