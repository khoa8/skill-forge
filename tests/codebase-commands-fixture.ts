/**
 * Shared fixture helper for re-audit command-model tests: builds a
 * RepositoryAnalysis through the real extraction path with a minimal
 * in-memory file set.
 */
import type { RepositoryAnalysis, RepositoryCommand } from "../src/core/types.js";
import {
  commandsFromPackageJson,
  detectPackageManager,
  syntheticInstallCommand,
  type FetchedFile,
} from "../src/core/codebase/extract.js";
import type { RepositoryAnalysis as RA } from "../src/core/types.js";

export interface CommandsFixtureInput {
  /** Root package.json content. */
  packageJson: string;
  /** Nested package manifests (path + JSON content fields). */
  nested?: { path: string; name: string; scripts?: Record<string, string> }[];
  /** Lowercased basenames present in the (scoped) tree — lockfile evidence. */
  treeBaseNames: Set<string>;
}

/** Build the analysis the ingestion pipeline would produce for these files. */
export function buildRepositoryAnalysisFromCommandsFixture(
  input: CommandsFixtureInput,
): RepositoryAnalysis {
  const files: FetchedFile[] = [{ path: "package.json", content: input.packageJson }];
  for (const n of input.nested ?? []) {
    files.push({
      path: n.path,
      content: JSON.stringify({ name: n.name, ...(n.scripts ? { scripts: n.scripts } : {}) }),
    });
  }
  const packageManager = detectPackageManager(input.treeBaseNames, [], files[0]);
  const rootManifestPath = "package.json";
  const workspaceNames = new Map<string, string>();
  // Ground workspace names only when the root declares workspaces.
  let declaresWorkspaces = false;
  try {
    const rootRaw = JSON.parse(input.packageJson) as Record<string, unknown>;
    declaresWorkspaces =
      Array.isArray(rootRaw.workspaces) ||
      (rootRaw.workspaces !== null &&
        typeof rootRaw.workspaces === "object" &&
        Array.isArray((rootRaw.workspaces as { packages?: unknown }).packages));
  } catch {
    declaresWorkspaces = false;
  }
  if (declaresWorkspaces) {
    for (const f of files.slice(1)) {
      try {
        const nested = JSON.parse(f.content) as { name?: unknown };
        if (typeof nested.name === "string" && nested.name.length > 0) {
          workspaceNames.set(f.path, nested.name);
        }
      } catch {
        // malformed — skip
      }
    }
  }
  const { commands, scriptDefinitions } = commandsFromPackageJson(files, packageManager, {
    rootManifestPath,
    workspaceNames,
  });
  const install =
    syntheticInstallCommand(packageManager) as RepositoryCommand | null;
  const commandsOut: RepositoryCommand[] = [];
  const seen = new Set<string>();
  for (const c of [install, ...commands]) {
    if (!c) continue;
    const key = `${c.purpose}::${c.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    commandsOut.push(c);
  }
  void scriptDefinitions;
  return {
    repository: { url: "https://github.com/acme/fixture", owner: "acme", name: "fixture", ref: "main" },
    mode: "codebase",
    languages: [{ name: "TypeScript", evidence: ["fixture"] }],
    ecosystems: ["node"],
    frameworks: [],
    manifests: [{ path: "package.json", kind: "package.json", fetched: true }],
    commands: commandsOut,
    structure: { sourceRoots: ["src/"], testRoots: [], exampleRoots: [], packages: [] },
    entrypoints: [],
    importantFiles: [],
    conventions: [],
    publicInterfaces: [],
    testing: { frameworks: [], relevantFiles: [] },
    inspectedFiles: files.map((f) => f.path),
    selection: { candidateCount: files.length, selectedCount: files.length, treeBlobCount: files.length, treeTruncated: false },
    uncertainty: [],
  } as RA;
}
