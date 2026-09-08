/**
 * GitHub codebase mode — eligibility/safety filtering, tree reconnaissance,
 * and deterministic candidate ranking. All pure functions: no network.
 */
import { describe, expect, it } from "vitest";
import {
  codebaseExclusionReason,
  codebasePriority,
  selectCodebaseCandidates,
  detectLanguages,
  detectEcosystems,
  detectManifests,
  detectRoots,
  detectInstructionFiles,
  detectWorkspacePackages,
  detectCiWorkflows,
  detectEntrypointCandidates,
  MAX_CODEBASE_FILES,
  MAX_CODEBASE_FILE_BYTES,
  MAX_CODEBASE_TOTAL_BYTES,
  MAX_CODEBASE_DEPTH,
  CODEBASE_TIMEOUT_MS,
  CODEBASE_OVERALL_TIMEOUT_MS,
  type TreeEntryLike,
} from "../src/core/sources/github-codebase.js";

const ctx = { maxDepth: 10, pathScope: "" };
const blob = (path: string, size = 100): TreeEntryLike => ({ path, type: "blob", size });

describe("codebase eligibility / safety filtering", () => {
  it("accepts source, test, config, and instruction files", () => {
    for (const path of [
      "src/index.ts",
      "src/core/service.ts",
      "tests/service.test.ts",
      "package.json",
      "tsconfig.json",
      "Makefile",
      "Dockerfile",
      "CODEOWNERS",
      "README.md",
      "AGENTS.md",
      ".github/workflows/ci.yml",
      "scripts/build.sh",
      "src/types.d.ts", // declaration files describe public interfaces
    ]) {
      expect(codebaseExclusionReason(blob(path), ctx), path).toBeNull();
    }
  });

  it("excludes binaries, media, and archives by construction (allowlist)", () => {
    for (const path of [
      "assets/logo.png",
      "assets/photo.jpg",
      "docs/spec.pdf",
      "lib/native.so",
      "fonts/font.woff2",
      "media/video.mp4",
      "compiled.class",
      "no-extension-binary",
    ]) {
      expect(codebaseExclusionReason(blob(path), ctx), path).toBe("extension_not_allowed");
    }
    // Build directories are refused even earlier (skip-dir rule).
    expect(codebaseExclusionReason(blob("dist/archive.zip"), ctx)).toBe("skip_dir");
  });

  it("excludes generated/minified content deterministically", () => {
    expect(codebaseExclusionReason(blob("src/bundle.min.js"), ctx)).toBe("generated_or_minified");
    expect(codebaseExclusionReason(blob("src/styles.min.css"), ctx)).toBe("generated_or_minified");
    expect(codebaseExclusionReason(blob("api/v1/foo.pb.go"), ctx)).toBe("generated_or_minified");
    expect(codebaseExclusionReason(blob("proto/generated/bar_pb2.py"), ctx)).toBe("generated_or_minified");
    // .map/.snap are not in the extension allowlist either way — never eligible.
    expect(codebaseExclusionReason(blob("src/app.map"), ctx)).not.toBeNull();
    expect(codebaseExclusionReason(blob("src/out.js.snap"), ctx)).not.toBeNull();
  });

  it("excludes build/vendor/generated directories", () => {
    for (const path of [
      "node_modules/pkg/index.js",
      "vendor/lib/go.go",
      "dist/bundle.js",
      "build/out.js",
      "coverage/lcov.info",
      "target/debug/main.rs",
      "__pycache__/mod.cpython.pyc",
      "testdata/golden.txt",
    ]) {
      expect(codebaseExclusionReason(blob(path), ctx), path).toBe("skip_dir");
    }
  });

  it("treats lockfiles as metadata-only (never fetched)", () => {
    expect(codebaseExclusionReason(blob("package-lock.json"), ctx)).toBe("lockfile_metadata_only");
    expect(codebaseExclusionReason(blob("pnpm-lock.yaml"), ctx)).toBe("lockfile_metadata_only");
    // Lockfiles with non-allowlisted extensions are refused just the same:
    // the invariant is that no lockfile is ever fetched.
    for (const path of ["yarn.lock", "Cargo.lock", "go.sum", "poetry.lock"]) {
      expect(codebaseExclusionReason(blob(path), ctx), path).not.toBeNull();
    }
  });

  it("never follows submodules and rejects unsafe paths", () => {
    expect(codebaseExclusionReason({ path: "vendor-lib", type: "commit" }, ctx)).toBe("submodule");
    expect(codebaseExclusionReason(blob("../escape.ts"), ctx)).toBe("unsafe_path");
    expect(codebaseExclusionReason(blob("a\\b.ts"), ctx)).toBe("unsafe_path");
    expect(codebaseExclusionReason(blob("/absolute.ts"), ctx)).toBe("unsafe_path");
  });

  it("enforces the path-depth bound and the /tree/ path scope", () => {
    const deep = "a/b/c/d/e/f/g/h/i/j/deep.ts";
    expect(codebaseExclusionReason(blob(deep), ctx)).toBe("too_deep");
    expect(codebaseExclusionReason(blob(deep), { maxDepth: 11, pathScope: "" })).toBeNull();
    const scoped = { maxDepth: 10, pathScope: "packages/a" };
    expect(codebaseExclusionReason(blob("packages/a/src/x.ts"), scoped)).toBeNull();
    expect(codebaseExclusionReason(blob("packages/b/src/x.ts"), scoped)).toBe("outside_path_scope");
  });
});

describe("stack detection from tree reconnaissance", () => {
  it("detects a TypeScript/Node project", () => {
    const entries = [
      blob("package.json"), blob("tsconfig.json"), blob("package-lock.json"),
      blob("README.md"), blob("src/index.ts"), blob("src/core/service.ts"),
      blob("tests/service.test.ts"), blob(".github/workflows/ci.yml"),
      blob("packages/app/package.json"), blob("packages/app/src/main.ts"),
    ];
    expect(detectLanguages(entries)[0]!.name).toBe("TypeScript");
    expect(detectEcosystems(entries)).toEqual(["node"]);
    const manifests = detectManifests(entries, new Set(["package.json"]));
    expect(manifests.find((m) => m.path === "package.json")).toMatchObject({ kind: "package.json", fetched: true });
    expect(manifests.find((m) => m.path === "package-lock.json")).toMatchObject({ kind: "lockfile", fetched: false });
    expect(detectRoots(entries)).toEqual({ sourceRoots: ["packages/", "src/"], testRoots: ["tests/"], exampleRoots: [] });
    expect(detectWorkspacePackages(entries)).toEqual(["packages/app"]);
    expect(detectCiWorkflows(entries)).toEqual([".github/workflows/ci.yml"]);
  });

  it("detects a Python project", () => {
    const entries = [
      blob("pyproject.toml"), blob("README.md"),
      blob("src/example/__init__.py"), blob("src/example/main.py"),
      blob("tests/test_main.py"),
    ];
    expect(detectEcosystems(entries)).toEqual(["python"]);
    expect(detectLanguages(entries)[0]!.name).toBe("Python");
    expect(detectRoots(entries)).toEqual({ sourceRoots: ["src/"], testRoots: ["tests/"], exampleRoots: [] });
  });

  it("detects a Go project and its cmd entrypoints", () => {
    const entries = [
      blob("go.mod"), blob("README.md"),
      blob("cmd/server/main.go"), blob("internal/store/store.go"),
    ];
    expect(detectEcosystems(entries)).toEqual(["go"]);
    const eps = detectEntrypointCandidates(entries);
    expect(eps.some((e) => e.path === "cmd/server/main.go")).toBe(true);
  });

  it("detects a Rust project", () => {
    const entries = [blob("Cargo.toml"), blob("src/main.rs"), blob("src/lib.rs")];
    expect(detectEcosystems(entries)).toEqual(["rust"]);
    expect(detectLanguages(entries)[0]!.name).toBe("Rust");
  });

  it("orders instruction files root-first and includes nested AGENTS.md", () => {
    const entries = [
      blob("packages/x/AGENTS.md"), blob("AGENTS.md"), blob("README.md"),
      blob("CONTRIBUTING.md"), blob("docs/CLAUDE.md"),
    ];
    const files = detectInstructionFiles(entries);
    expect(files[0]).toBe("AGENTS.md");
    expect(files).toContain("packages/x/AGENTS.md");
    expect(files.indexOf("AGENTS.md")).toBeLessThan(files.indexOf("packages/x/AGENTS.md"));
  });
});

describe("deterministic candidate ranking", () => {
  it("orders the strong-priority categories", () => {
    expect(codebasePriority("AGENTS.md")).toBeLessThan(codebasePriority("README.md"));
    expect(codebasePriority("README.md")).toBeLessThan(codebasePriority("package.json"));
    expect(codebasePriority("package.json")).toBeLessThan(codebasePriority("tsconfig.json"));
    expect(codebasePriority("tsconfig.json")).toBeLessThan(codebasePriority(".github/workflows/ci.yml"));
    expect(codebasePriority(".github/workflows/ci.yml")).toBeLessThan(codebasePriority("src/index.ts"));
    expect(codebasePriority("src/index.ts")).toBeLessThan(codebasePriority("src/core/deep/module.ts"));
    expect(codebasePriority("src/core/deep/module.ts")).toBeLessThan(codebasePriority("tests/service.test.ts"));
    expect(codebasePriority("tests/service.test.ts")).toBeLessThan(codebasePriority("examples/demo/main.ts"));
    expect(codebasePriority("examples/demo/main.ts")).toBeLessThan(codebasePriority("misc/other.js"));
  });

  it("selection is deterministic given the same tree", () => {
    const entries = [
      blob("README.md"), blob("package.json"), blob("src/index.ts"),
      blob("src/core/a.ts"), blob("src/core/b.ts"), blob("tests/a.test.ts"),
      blob("examples/demo.ts"), blob("docs/guide.md"),
    ];
    const a = selectCodebaseCandidates(entries, 5);
    const b = selectCodebaseCandidates([...entries].reverse(), 5);
    expect(a.map((e) => e.path)).toEqual(b.map((e) => e.path));
  });

  it("one crowded directory cannot crowd out other major areas", () => {
    const entries: TreeEntryLike[] = [
      blob("README.md"), blob("package.json"),
      blob("src/core/service.ts"),
      blob("tests/service.test.ts"),
    ];
    for (let i = 0; i < 50; i++) entries.push(blob(`big/generated-${i}.ts`));
    const selected = selectCodebaseCandidates(entries, 10);
    const fromBig = selected.filter((e) => e.path.startsWith("big/")).length;
    expect(selected.map((e) => e.path)).toContain("README.md");
    expect(selected.map((e) => e.path)).toContain("package.json");
    expect(selected.map((e) => e.path)).toContain("src/core/service.ts");
    expect(selected.map((e) => e.path)).toContain("tests/service.test.ts");
    expect(fromBig).toBeLessThanOrEqual(6); // diversity cap + budget fill
    const tops = new Set(selected.map((e) => e.path.split("/")[0]));
    expect(tops.size).toBeGreaterThanOrEqual(4);
  });

  it("fills the remaining budget when one directory dominates the tree", () => {
    const entries: TreeEntryLike[] = [blob("README.md")];
    for (let i = 0; i < 30; i++) entries.push(blob(`only/big-${i}.ts`));
    const selected = selectCodebaseCandidates(entries, 10);
    expect(selected).toHaveLength(10);
    expect(selected[0]!.path).toBe("README.md");
  });
});

describe("codebase limits are exported and bounded", () => {
  it("pins the default limits", () => {
    expect(MAX_CODEBASE_FILES).toBe(60);
    expect(MAX_CODEBASE_FILE_BYTES).toBe(200_000);
    expect(MAX_CODEBASE_TOTAL_BYTES).toBe(1_400_000);
    expect(MAX_CODEBASE_DEPTH).toBe(10);
    expect(CODEBASE_TIMEOUT_MS).toBe(15_000);
    expect(CODEBASE_OVERALL_TIMEOUT_MS).toBe(90_000);
    // The combined-text bound must stay under ingest's hard 1.5 MB cap.
    expect(MAX_CODEBASE_TOTAL_BYTES).toBeLessThan(1_500_000);
  });
});
