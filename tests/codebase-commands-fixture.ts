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
  groundWorkspaceMembership,
  type FetchedFile,
} from "../src/core/codebase/extract.js";
import type { RepositoryAnalysis as RA } from "../src/core/types.js";

export interface CommandsFixtureInput {
  /** Root package.json content. */
  packageJson: string;
  /** Analysis-root directory (scoped requests); "" = repository root. */
  scope?: string;
  /** Nested package manifests (path + JSON content fields). */
  nested?: { path: string; name: string; scripts?: Record<string, string> }[];
  /** Lockfile paths in the (scoped) tree — path-aware manager evidence. */
  treeLockfiles?: string[];
  /** Optional pnpm-workspace.yaml content (fetched at the analysis root). */
  pnpmWorkspaceYaml?: string;
}

/** Build the analysis the ingestion pipeline would produce for these files. */
export function buildRepositoryAnalysisFromCommandsFixture(
  input: CommandsFixtureInput,
): RepositoryAnalysis {
  const rootManifestPath = input.scope ? `${input.scope}/package.json` : "package.json";
  const files: FetchedFile[] = [{ path: rootManifestPath, content: input.packageJson }];
  for (const n of input.nested ?? []) {
    files.push({
      path: n.path,
      content: JSON.stringify({ name: n.name, ...(n.scripts ? { scripts: n.scripts } : {}) }),
    });
  }
  if (input.pnpmWorkspaceYaml !== undefined) {
    files.push({ path: "pnpm-workspace.yaml", content: input.pnpmWorkspaceYaml });
  }
  const packageManager = detectPackageManager(
    (input.treeLockfiles ?? []).map((p) => ({ path: p, basename: (p.split("/").pop() ?? "").toLowerCase() })),
    [],
    files[0],
    input.scope ?? "",
  );
  // Membership matching goes through the SAME exported helper the real
  // extraction path uses, so fixture results match production behavior.
  const workspaceNames = groundWorkspaceMembership({
    manager: packageManager?.name,
    files,
    rootManifestPath,
  });
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
