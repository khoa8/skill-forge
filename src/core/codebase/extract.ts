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
import {
  RepositoryAnalysis,
  type RepositoryClaim,
  type RepositoryCommand,
  type RepositoryCiRun,
  type RepositoryConvention,
  type RepositoryPackageScript,
  type RepositoryPublicInterface,
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
];

export function scriptPurpose(name: string): RepositoryCommand["purpose"] {
  for (const [re, purpose] of SCRIPT_PURPOSE_RULES) {
    if (re.test(name)) return purpose;
  }
  return "other";
}

/**
 * Extract observed package.json script definitions as observational facts,
 * along with framework and test dependencies. No package-manager commands
 * or workspace invocations are synthesized.
 */
export function commandsFromPackageJson(
  files: FetchedFile[],
  _packageManager?: unknown,
  _context?: unknown,
): { commands: RepositoryPackageScript[]; frameworks: RepositoryClaim[]; testing: string[]; omittedCount: number } {
  const commands: RepositoryPackageScript[] = [];
  const frameworkClaims: RepositoryClaim[] = [];
  const testingFrameworks = new Set<string>();
  const frameworkEvidence = new Map<string, string[]>();
  let omittedCount = 0;

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
        if (typeof value !== "string") continue;
        const name = key.trim();
        const command = value.trim();
        if (name.length === 0 || command.length === 0) continue;

        // Bounded metadata limits: omit oversized facts rather than silently mutating them
        if (name.length > 120 || command.length > 300) {
          omittedCount++;
          continue;
        }

        const fullEv = `${file.path} scripts.${name} = "${command}"`;
        const compactEv = `${file.path} scripts.${name}`;
        const evidence = fullEv.length <= 300 ? fullEv : compactEv;
        if (evidence.length > 300) {
          omittedCount++;
          continue;
        }

        if (commands.length >= 30) break;
        const purpose = scriptPurpose(key);
        commands.push({
          kind: "package-script",
          purpose,
          name,
          command,
          evidence,
        });
      }
    }
    for (const depField of ["dependencies", "devDependencies"] as const) {
      const deps = raw[depField];
      if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
      for (const dep of Object.keys(deps as Record<string, unknown>)) {
        const fw = FRAMEWORK_DEPENDENCIES[dep] ?? FRAMEWORK_DEPENDENCIES[dep.split("/").pop()!];
        if (fw) {
          const ev = `${file.path} ${depField}: ${dep}`.slice(0, 300);
          frameworkEvidence.set(fw, [...(frameworkEvidence.get(fw) ?? []), ev].slice(0, 8));
        }
        for (const [testDep, fwName] of Object.entries(TEST_DEPENDENCIES)) {
          if (dep === testDep || (testDep === "testing-library" && dep.startsWith("@testing-library/"))) {
            testingFrameworks.add(fwName.slice(0, 80));
          }
        }
      }
    }
  }
  for (const [fw, ev] of frameworkEvidence) {
    frameworkClaims.push({ name: fw.slice(0, 120), evidence: ev });
  }
  frameworkClaims.sort((a, b) => a.name.localeCompare(b.name));
  return {
    commands: commands.slice(0, 30),
    frameworks: frameworkClaims.slice(0, 16),
    testing: [...testingFrameworks].sort(),
    omittedCount,
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
      if (fw) {
        const ev = `${file.path} dependencies: ${name}`.slice(0, 300);
        frameworks.set(fw, [...(frameworks.get(fw) ?? []), ev].slice(0, 8));
      }
      if (TEST_DEPENDENCIES[name]) testing.add(TEST_DEPENDENCIES[name].slice(0, 80));
    }
  }
  if (/\[tool\.pytest[^\]]*\]/.test(file.content)) testing.add("pytest");
  return {
    frameworks: [...frameworks.entries()]
      .map(([name, evidence]) => ({ name: name.slice(0, 120), evidence }))
      .sort((a, b) => a.name.localeCompare(b.name)),
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
/**
 * Collect run steps with their execution context.
 */
function collectRunSteps(node: unknown, out: CiRunStep[], file: string, workflowWd: WdDefault): void {
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
      const runText = s.run.trim();
      if (runText.length === 0 || runText.startsWith("#") || runText.startsWith("echo ")) continue;
      const cwd = resolveStepCwd(stepWorkingDirectory(s), jobWd, workflowWd);
      out.push({ command: runText, cwd: cwd || undefined, file, line: 0 });
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
 * CI run steps → commands as observational facts. Literal command text is
 * preserved without synthesis or shell reconstruction.
 */
export function commandsFromCiWorkflows(
  files: FetchedFile[],
  _telemetry?: unknown,
): RepositoryCiRun[] & { omittedCount?: number } {
  const commands: RepositoryCiRun[] = [];
  let omittedCount = 0;

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
    collectRunSteps(doc, steps, file.path, wfWd);
    for (const step of steps) {
      if (commands.length >= 30) break;
      const cmdText = step.command.trim();
      if (cmdText.length === 0) continue;

      // Bounded metadata limits: omit oversized facts rather than silently mutating them
      if (cmdText.length > 300) {
        omittedCount++;
        continue;
      }
      if (step.cwd && step.cwd.trim().length > 300) {
        omittedCount++;
        continue;
      }

      const cwd = step.cwd ? step.cwd.trim() : undefined;
      const evidence = `${step.file} (CI run step${cwd ? `, working-directory: ${cwd}` : ""})`;
      if (evidence.length > 300) {
        omittedCount++;
        continue;
      }

      const purpose = CI_COMMAND_RULES.find(([re]) => re.test(step.command))?.[1] ?? "other";
      commands.push({
        kind: "ci-run",
        purpose,
        command: cmdText,
        evidence,
        ...(cwd ? { cwd } : {}),
      });
    }
  }

  Object.defineProperty(commands, "omittedCount", {
    value: omittedCount,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return commands as RepositoryCiRun[] & { omittedCount?: number };
}

// ---------------------------------------------------------------------------
// Instruction files (AGENTS.md, CONTRIBUTING.md, …)
// ---------------------------------------------------------------------------

const CONSTRAINT_LINE_RE =
  /\b(must|must not|never|always|do not|don'?t|avoid|required|forbidden|prohibited|make sure|ensure|before (?:pushing|committing|merging)|only|use|prefer|keep)\b/i;

/** Convention statements from repository instruction files, each traceable to
 * `path:line`. Observational evidence only. */
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
      const statement = text.slice(0, 500);
      const evItem = `${file.path}:${i + 1}`.slice(0, 300);
      const existing = out.find((c) => c.statement === statement);
      if (existing) {
        if (existing.evidence.length < 4 && !existing.evidence.includes(evItem)) {
          existing.evidence.push(evItem);
        }
      } else {
        out.push({ statement, evidence: [evItem] });
      }
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
          name: info.name?.slice(0, 200),
          path: file.path.slice(0, 300),
          description: `package.json main: ${info.main}`.slice(0, 300),
        });
      }
      if (info.exports !== undefined && typeof info.exports === "object") {
        out.push({
          name: info.name?.slice(0, 200),
          path: file.path.slice(0, 300),
          description: `package.json exports field defines the public entrypoints (${Math.min(JSON.stringify(info.exports).length, 160)} bytes of export map)`.slice(0, 300),
        });
      }
      if (info.types) {
        out.push({
          name: info.types.slice(0, 200),
          path: file.path.slice(0, 300),
          description: `package.json types: ${info.types}`.slice(0, 300),
        });
      }
    } else if (base === "go.mod") {
      const m = file.content.match(/^module\s+(\S+)$/m);
      if (m) {
        out.push({
          name: m[1]!.slice(0, 200),
          path: file.path.slice(0, 300),
          description: `Go module path: ${m[1]}`.slice(0, 300),
        });
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
   * — path-aware package-manager evidence. */
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
}

/**
 * Assemble the RepositoryAnalysis: tree reconnaissance + extraction from the
 * bounded fetched files. `uncertainty` records honest limits.
 */
export function buildRepositoryAnalysisFromFiles(
  input: AnalysisFromFilesInput,
  uncertainty: string[],
): RepositoryAnalysis {
  const ciCommandsRaw = commandsFromCiWorkflows(input.fetched);
  const omittedCiCount = ciCommandsRaw.omittedCount ?? 0;
  const {
    commands: scriptCommands,
    frameworks: depFrameworks,
    testing: depTesting,
    omittedCount: omittedScriptsCount = 0,
  } = commandsFromPackageJson(input.fetched);

  // Python ecosystem evidence (pyproject.toml has no scripts; frameworks only).
  let pyFrameworks: RepositoryClaim[] = [];
  for (const file of input.fetched) {
    if ((file.path.split("/").pop() ?? "").toLowerCase() !== "pyproject.toml") continue;
    const py = frameworksFromPyproject(file);
    pyFrameworks = py.frameworks;
    depTesting.push(...py.testing);
  }

  const seenCommands = new Set<string>();
  const commandsOut: RepositoryCommand[] = [];
  for (const c of [...scriptCommands, ...ciCommandsRaw]) {
    const key = `${c.kind}::${c.purpose}::${c.command}`;
    if (seenCommands.has(key)) continue;
    seenCommands.add(key);
    commandsOut.push(c);
  }

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
      const resolved = `${manifestDir === "" ? "" : `${manifestDir}/`}${info.main.replace(/^\.\//, "")}`.slice(0, 300);
      const existing = entrypoints.find((e) => e.path === resolved);
      if (existing) {
        existing.reason = `${existing.reason} + package.json main field (${file.path})`.slice(0, 300);
      } else {
        entrypoints.push({ path: resolved, reason: `package.json main field (${file.path})`.slice(0, 300) });
      }
    }
  }

  // Important files: instructions first (they were a selection priority).
  const importantFiles = [...input.importantFiles];
  for (const path of input.instructions.slice(0, 8)) {
    if (importantFiles.some((f) => f.path === path)) continue;
    importantFiles.push({
      path: path.slice(0, 300),
      reason: (/readme/i.test(path)
        ? "primary repository documentation"
        : "repository instruction file").slice(0, 300),
    });
  }

  const omissionNotes: string[] = [];
  if (omittedScriptsCount > 0) {
    const s = omittedScriptsCount === 1 ? "" : "s";
    const wasWere = omittedScriptsCount === 1 ? "was" : "were";
    const itsTheir = omittedScriptsCount === 1 ? "its" : "their";
    omissionNotes.push(
      `${omittedScriptsCount} package script fact${s} ${wasWere} omitted because ${itsTheir} name or command exceeded the supported metadata length.`,
    );
  }
  if (omittedCiCount > 0) {
    const s = omittedCiCount === 1 ? "" : "s";
    const wasWere = omittedCiCount === 1 ? "was" : "were";
    const itsTheir = omittedCiCount === 1 ? "its" : "their";
    omissionNotes.push(
      `${omittedCiCount} CI run fact${s} ${wasWere} omitted because ${itsTheir} command or working-directory metadata exceeded supported bounds.`,
    );
  }

  const analysis: RepositoryAnalysis = {
    repository: {
      url: input.url.slice(0, 300),
      owner: input.owner.slice(0, 100),
      name: input.name.slice(0, 100),
      ref: input.ref.slice(0, 100),
      ...(input.scope ? { scope: input.scope.slice(0, 300) } : {}),
    },
    mode: "codebase",
    languages: input.languages.slice(0, 12),
    ecosystems: input.ecosystems.slice(0, 12).map((e) => e.slice(0, 80)),
    frameworks: [...depFrameworks, ...pyFrameworks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 16),
    manifests: input.manifests.slice(0, 24),
    commands: commandsOut.slice(0, 30),
    structure: input.structure,
    entrypoints: entrypoints.slice(0, 12),
    importantFiles: importantFiles.slice(0, 24),
    conventions: conventions.slice(0, 20),
    publicInterfaces: publicInterfaces.slice(0, 16),
    testing: {
      frameworks: testing.frameworks.slice(0, 8),
      relevantFiles: testing.relevantFiles.slice(0, 24),
    },
    inspectedFiles: input.fetched.map((f) => f.path.slice(0, 300)).slice(0, 200),
    selection: input.selection,
    uncertainty: [...omissionNotes, ...uncertainty]
      .map((u) => u.trim().slice(0, 300))
      .filter((u) => u.length > 0)
      .slice(0, 12),
  };

  return RepositoryAnalysis.parse(analysis);
}

// Re-export for tests that want a tree-entry-shaped helper.
export type { TreeEntryLike };
