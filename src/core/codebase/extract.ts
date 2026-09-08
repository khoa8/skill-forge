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
export function detectPackageManager(
  treeBaseNames: Set<string>,
  ciInstallCommands: string[],
  packageJson?: FetchedFile,
): { name: "npm" | "pnpm" | "yarn" | "bun"; evidence: string; yarnGeneration?: YarnGeneration; lockfilePresent: boolean } | null {
  // 1. Explicit packageManager field (strongest evidence). For Yarn the
  //    pinned version identifies the generation (1.x vs 2+/3+/4+).
  if (packageJson) {
    try {
      const raw = JSON.parse(packageJson.content) as Record<string, unknown>;
      const pm = typeof raw.packageManager === "string" ? raw.packageManager : "";
      const m = pm.match(/^(npm|pnpm|yarn|bun)@/);
      if (m) {
        const yarnGeneration = m[1] === "yarn" ? yarnGenerationFromSpec(pm) : undefined;
        const lockfilePresent =
          (m[1] === "npm" && treeBaseNames.has("package-lock.json")) ||
          (m[1] === "pnpm" && treeBaseNames.has("pnpm-lock.yaml")) ||
          (m[1] === "yarn" && treeBaseNames.has("yarn.lock")) ||
          (m[1] === "bun" && (treeBaseNames.has("bun.lockb") || treeBaseNames.has("bun.lock")));
        return { name: m[1] as "npm" | "pnpm" | "yarn" | "bun", evidence: `${packageJson.path} packageManager: ${pm.slice(0, 80)}`, yarnGeneration, lockfilePresent };
      }
    } catch {
      // malformed manifest — fall through to weaker evidence
    }
  }
  // 2. Lockfile presence (mutually exclusive lockfiles name the manager).
  const lockfiles: Array<[string, "npm" | "pnpm" | "yarn" | "bun"]> = [
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ];
  const present = lockfiles.filter(([lock]) => treeBaseNames.has(lock));
  if (present.length === 1) {
    // Yarn generation from config-file evidence only: .yarnrc.yml is modern
    // Yarn, .yarnrc (without .yarnrc.yml) is Yarn 1. yarn.lock alone is
    // ambiguous, so yarnGeneration stays undefined.
    const yarnGeneration =
      present[0]![1] === "yarn"
        ? treeBaseNames.has(".yarnrc.yml")
          ? (2 as YarnGeneration)
          : treeBaseNames.has(".yarnrc")
            ? (1 as YarnGeneration)
            : undefined
        : undefined;
    return { name: present[0]![1], evidence: `${present[0]![0]} in the repository tree (lockfile)`, yarnGeneration, lockfilePresent: true };
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
): RepositoryCommand | null {
  if (!packageManager) return null;
  const pm = packageManager.name;
  if (pm === "yarn" && packageManager.yarnGeneration === 1) {
    return { purpose: "install", command: "yarn install", evidence: `${packageManager.evidence} (Yarn 1)` };
  }
  if (pm === "yarn" && packageManager.yarnGeneration === 2) {
    return { purpose: "install", command: "yarn install --immutable", evidence: `${packageManager.evidence} (Yarn 2+)` };
  }
  if (pm === "yarn" && packageManager.yarnGeneration === undefined) {
    // Yarn identity alone does not select a flag convention — refuse to guess.
    return null;
  }
  if (pm === "npm") {
    // `npm ci` requires a lockfile; identity alone does not prove one exists.
    if (packageManager.lockfilePresent) {
      return { purpose: "install", command: "npm ci", evidence: packageManager.evidence };
    }
    return null;
  }
  if (pm === "pnpm") {
    if (packageManager.lockfilePresent) {
      return { purpose: "install", command: "pnpm install --frozen-lockfile", evidence: packageManager.evidence };
    }
    // pnpm's plain install form is valid without a lockfile.
    return { purpose: "install", command: "pnpm install", evidence: packageManager.evidence };
  }
  // bun install is the manager's own plain form.
  return { purpose: "install", command: "bun install", evidence: packageManager.evidence };
}

/** Script-name → runnable invocation through the evidenced manager, respecting
 * npm's bare-`test` shortcut. */
function scriptInvocation(manager: "npm" | "pnpm" | "yarn" | "bun", key: string): string {
  return manager === "npm" && key === "test" ? "npm test" : `${manager} run ${key}`;
}

/** Workspace context for a nested package.json: how a script there is
 * actually run from the repository root. Only pnpm/yarn workspace selectors
 * and npm -w are synthesized, and only when the manifest is nested (P1-2C). */
function workspaceInvocation(
  manager: "npm" | "pnpm" | "yarn" | "bun",
  key: string,
  manifestPath: string,
  workspaceNames: ReadonlyMap<string, string>,
): { command: string; contextEvidence: string } | null {
  const manifestDir = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/")) : "";
  if (manifestDir === "") return null; // root manifest: plain invocation
  // Find the workspace name for this manifest path.
  const workspaceName = workspaceNames.get(manifestPath);
  if (!workspaceName) return null; // cannot ground the selector — omit
  const base = scriptInvocation(manager, key);
  switch (manager) {
    case "pnpm":
      return { command: `pnpm --filter ${workspaceName} run ${key}`, contextEvidence: `workspace ${workspaceName} (pnpm --filter)` };
    case "yarn":
      return { command: `yarn workspace ${workspaceName} run ${key}`, contextEvidence: `workspace ${workspaceName} (yarn workspace)` };
    case "npm":
      return { command: `npm run ${key} --workspace ${workspaceName}`, contextEvidence: `workspace ${workspaceName} (npm --workspace)` };
    case "bun":
      return { command: `bun --cwd ${manifestDir} run ${key}`, contextEvidence: `${manifestDir}/ (bun --cwd)` };
  }
}

/** Commands from package.json scripts (root and workspaces).
 *
 * Evidence model (re-audit P1-2): `RepositoryCommand.command` is ALWAYS a
 * genuinely runnable command from a stated context, or the script is not
 * emitted as a command at all. Without manager evidence a script definition
 * is preserved as structured non-runnable evidence via
 * `scriptDefinitions`, never stuffed into a command string. Nested workspace
 * scripts either get a grounded workspace selector or are omitted from
 * runnable commands (their definitions remain in scriptDefinitions). */
export function commandsFromPackageJson(
  files: FetchedFile[],
  packageManager: { name: "npm" | "pnpm" | "yarn" | "bun"; evidence: string; yarnGeneration?: YarnGeneration } | null,
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
        // need a grounded workspace selector.
        const isRootManifest = file.path === rootManifestPath;
        const ws = isRootManifest ? null : workspaceInvocation(packageManager?.name ?? "npm", key, file.path, workspaces);
        if (packageManager && (isRootManifest || ws)) {
          commands.push({
            purpose,
            command: ws ? ws.command : scriptInvocation(packageManager.name, key),
            evidence: `${file.path} scripts.${key} = "${value.slice(0, 120)}"${ws ? ` (${ws.contextEvidence})` : ""}`,
          });
        } else {
          // No grounded execution context: preserve as non-runnable evidence.
          scriptDefinitions.push({
            purpose,
            command: "",
            evidence: `${file.path} scripts.${key} = "${value.slice(0, 120)}"`,
          });
        }
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
function collectRunCommands(node: unknown, out: string[]): void {
  if (out.length >= 20) return;
  if (typeof node === "string") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRunCommands(item, out);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "run" && typeof value === "string") {
        for (const line of value.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("echo ")) {
            out.push(trimmed);
          }
        }
      } else {
        collectRunCommands(value, out);
      }
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

/** Commands evidenced by CI workflow run steps (documentation only — SkillForge
 * never executes anything it reads). */
export function commandsFromCiWorkflows(files: FetchedFile[]): RepositoryCommand[] {
  const commands: RepositoryCommand[] = [];
  for (const file of files) {
    if (!file.path.startsWith(".github/workflows/")) continue;
    let doc: unknown;
    try {
      doc = parseYaml(file.content);
    } catch {
      continue; // malformed workflow degrades gracefully
    }
    const runs: string[] = [];
    collectRunCommands(doc, runs);
    for (const run of runs) {
      if (commands.length >= 30) break;
      const purpose = CI_COMMAND_RULES.find(([re]) => re.test(run))?.[1];
      if (!purpose) continue;
      commands.push({ purpose, command: firstLine(run), evidence: `${file.path} (CI run step)` });
    }
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Instruction files (AGENTS.md, CONTRIBUTING.md, …)
// ---------------------------------------------------------------------------

const CONSTRAINT_LINE_RE =
  /\b(must|must not|never|always|do not|don'?t|avoid|required|forbidden|prohibited|make sure|ensure|before (?:pushing|committing|merging)|only)\b/i;

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
  /** Lowercased basenames present in the repository tree — used for
   * package-manager lockfile evidence (never for content claims). */
  treeBaseNames?: Set<string>;
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
  // Package-manager evidence: CI install steps first (they may name the
  // runner), then the tree lockfiles via input.treeBaseNames + the analysis
  // root package.json's packageManager field.
  const ciCommandsRaw = commandsFromCiWorkflows(input.fetched);
  const ciInstallCommands = ciCommandsRaw
    .filter((c) => c.purpose === "install")
    .map((c) => c.command);
  const rootManifestPath = input.scope ? `${input.scope}/package.json` : "package.json";
  const rootPackageJson = input.fetched.find(
    (f) => f.path === rootManifestPath,
  ) ?? input.fetched.find((f) => (f.path.split("/").pop() ?? "").toLowerCase() === "package.json");
  const packageManager = detectPackageManager(input.treeBaseNames ?? new Set(), ciInstallCommands, rootPackageJson);
  // Workspace names grounded in the root manifest's workspaces declaration
  // (npm/pnpm/yarn) — bun's --cwd needs no declaration.
  const workspaceNames = new Map<string, string>();
  if (packageManager && rootPackageJson) {
    try {
      const rootRaw = JSON.parse(rootPackageJson.content) as Record<string, unknown>;
      const ws = rootRaw.workspaces;
      const globs = Array.isArray(ws)
        ? ws.filter((w): w is string => typeof w === "string")
        : ws !== null && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)
          ? (ws as { packages: unknown[] }).packages.filter((w): w is string => typeof w === "string")
          : [];
      if (globs.length > 0 || packageManager.name === "bun") {
        for (const file of input.fetched) {
          if (file.path === rootPackageJson.path) continue;
          if ((file.path.split("/").pop() ?? "").toLowerCase() !== "package.json") continue;
          try {
            const nested = JSON.parse(file.content) as Record<string, unknown>;
            if (typeof nested.name === "string" && nested.name.length > 0) {
              workspaceNames.set(file.path, nested.name);
            }
          } catch {
            // malformed nested manifest — no workspace entry
          }
        }
      }
    } catch {
      // malformed root manifest — no workspace grounding
    }
  }
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
  // CI evidence first; only when CI shows no install step may the manager's
  // deterministic install form be synthesized — and only when its
  // prerequisites are provable (npm ci needs package-lock.json; Yarn needs a
  // generation to pick its flag convention).
  const installCommand =
    ciInstallCommands.length > 0
      ? ciCommandsRaw.find((c) => c.purpose === "install")!
      : syntheticInstallCommand(packageManager);
  const ciCommands = ciCommandsRaw.filter(
    (c) => !(c.purpose === "install" && installCommand && c.command === installCommand.command),
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
    uncertainty: uncertainty.slice(0, 12),
  };
}

// Re-export for tests that want a tree-entry-shaped helper.
export type { TreeEntryLike };
