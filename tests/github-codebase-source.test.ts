/**
 * GitHub codebase ingestion — bounded fetching, limits, safety, and
 * structured analysis. All tests use injected fetch (same harness pattern as
 * the documentation-mode suite); no test touches the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGithubCodebaseSource,
  GithubCodebaseError,
  selectCodebaseCandidates,
  codebaseExclusionReason,
} from "../src/core/sources/github-codebase.js";

// ---------------------------------------------------------------------------
// Injected-fetch harness
// ---------------------------------------------------------------------------

type FetchLog = { urls: string[]; apiHeaders: Record<string, string>; rawHeaders: Record<string, string> };

function codebaseFetch(o: {
  repo?: Record<string, unknown> | number;
  tree?: Record<string, unknown> | number;
  raw?: Record<string, string>;
  failUrls?: string[];
  hangRaw?: boolean;
  log?: FetchLog;
}) {
  const record = o.log;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.startsWith("https://api.github.com/")) Object.assign(record?.apiHeaders ?? {}, headers);
    if (url.startsWith("https://raw.githubusercontent.com/")) Object.assign(record?.rawHeaders ?? {}, headers);
    record?.urls.push(url);
    if (o.failUrls?.some((f) => url.includes(f))) throw new TypeError("network unreachable");
    if (url.startsWith("https://api.github.com/repos/") && !url.includes("/git/trees/")) {
      const status = typeof o.repo === "number" ? o.repo : 200;
      const body = typeof o.repo === "number" ? { message: "Not Found" } : (o.repo ?? { default_branch: "main" });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/git/trees/")) {
      const status = typeof o.tree === "number" ? o.tree : 200;
      const body =
        typeof o.tree === "number"
          ? { message: "Not Found" }
          : (o.tree ?? { sha: "x", truncated: false, tree: [] });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      if (o.hangRaw) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        });
      }
      const rawPath = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
      const body = o.raw?.[rawPath] ?? "not found";
      const status = o.raw?.[rawPath] !== undefined ? 200 : 404;
      const res = new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    return new Response("unexpected URL", { status: 500 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Fixture A — small TypeScript service (realistic repository)
// ---------------------------------------------------------------------------

const PKG = JSON.stringify(
  {
    name: "fixture-service",
    main: "src/index.ts",
    scripts: {
      dev: "tsx watch src/server.ts",
      build: "tsc -p tsconfig.json",
      test: "vitest run",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
    },
    dependencies: { fastify: "^4.0.0" },
    devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
  },
  null,
  2,
);

const AGENTS_MD = [
  "# AGENTS.md",
  "",
  "- Never commit secrets to the repository.",
  "- Always run `npm test` before pushing changes.",
  "",
  "## Conventions",
  "",
  "- New modules belong in src/core.",
].join("\n");

const CI = [
  "name: ci",
  "on: push",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm ci",
  "      - run: npm test",
  "      - run: npm run typecheck",
].join("\n");

const INDEX_TS = [
  "import { createServer } from './server.js';",
  "import { Service } from './core/service.js';",
  "",
  "export function main(): void {",
  "  const svc = new Service();",
  "  createServer(svc);",
  "}",
].join("\n");

const SERVICE_TEST = [
  'import { describe, expect, it } from "vitest";',
  'import { Service } from "../src/core/service.js";',
  "",
  'describe("Service", () => {',
  '  it("computes totals", () => {',
  "    expect(new Service().total([1, 2])).toBe(3);",
  "  });",
  "});",
].join("\n");

function fixtureATree(): Record<string, unknown> {
  return {
    sha: "a",
    truncated: false,
    tree: [
      { path: "README.md", type: "blob", size: 800 },
      { path: "AGENTS.md", type: "blob", size: AGENTS_MD.length },
      { path: "package.json", type: "blob", size: PKG.length },
      { path: "package-lock.json", type: "blob", size: 400_000 },
      { path: "tsconfig.json", type: "blob", size: 300 },
      { path: "src/index.ts", type: "blob", size: INDEX_TS.length },
      { path: "src/server.ts", type: "blob", size: 900 },
      { path: "src/core/service.ts", type: "blob", size: 1500 },
      { path: "tests/service.test.ts", type: "blob", size: SERVICE_TEST.length },
      { path: ".github/workflows/ci.yml", type: "blob", size: CI.length },
      { path: "assets/logo.png", type: "blob", size: 40_000 },
      { path: "vendor-lib", type: "commit", size: 0 },
    ],
  };
}

function fixtureARaw(): Record<string, string> {
  return {
    "README.md": "# fixture-service\n\nA small TypeScript service fixture used by SkillForge tests.\n\n## Setup\n\n1. Run `npm install`.\n2. Run `npm run dev` to start.\n3. Verify with `npm test`.\n",
    "AGENTS.md": AGENTS_MD,
    "package.json": PKG,
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "noEmit": true } }',
    "src/index.ts": INDEX_TS,
    "src/server.ts": "export function createServer(svc: unknown): void { void svc; }\n",
    "src/core/service.ts": "export class Service {\n  total(xs: number[]): number {\n    return xs.reduce((a, b) => a + b, 0);\n  }\n}\n",
    "tests/service.test.ts": SERVICE_TEST,
    ".github/workflows/ci.yml": CI,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SKILLFORGE_GITHUB_TOKEN;
});

describe("fetchGithubCodebaseSource (Fixture A — TypeScript service)", () => {
  it("produces a structured, grounded repository analysis", async () => {
    const result = await fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
      fetchImpl: codebaseFetch({ tree: fixtureATree(), raw: fixtureARaw() }),
    });

    // Source input shape.
    expect(result.input.type).toBe("github-codebase");
    expect(result.input.name).toBe("acme/fixture-service codebase");
    expect(result.input.content).toContain("# package.json");
    expect(result.input.content).toContain("vitest run");
    // Combined text is bounded and inspectable.
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(1_400_000);

    const analysis = result.analysis;
    expect(analysis.repository).toEqual({
      url: "https://github.com/acme/fixture-service",
      owner: "acme",
      name: "fixture-service",
      ref: "main",
    });
    expect(analysis.mode).toBe("codebase");
    expect(analysis.ecosystems).toContain("node");
    expect(analysis.languages[0]!.name).toBe("TypeScript");
    // Lockfile present as metadata-only evidence.
    expect(analysis.manifests.find((m) => m.path === "package-lock.json")).toMatchObject({
      kind: "lockfile",
      fetched: false,
    });
    // Commands come from literal package.json scripts + CI (never synthesized).
    const commands = analysis.commands;
    expect(commands.find((c) => c.kind === "package-script" && c.name === "test" && c.command === "vitest run")).toMatchObject({
      evidence: expect.stringContaining("package.json scripts.test"),
    });
    expect(commands.find((c) => c.kind === "ci-run" && c.command === "npm test")).toMatchObject({
      evidence: expect.stringContaining(".github/workflows/ci.yml"),
    });
    expect(commands.find((c) => c.purpose === "typecheck")).toBeTruthy();
    const install = commands.find((c) => c.kind === "ci-run" && c.purpose === "install" && c.command === "npm ci");
    expect(install).toBeTruthy();
    expect(install!.evidence).toContain(".github/workflows/ci.yml");
    expect(analysis.commands.every((c) => !c.evidence.includes("scripts.prepare"))).toBe(true);
    // Framework claims carry dependency evidence.
    expect(analysis.frameworks.find((f) => f.name === "Fastify")?.evidence[0]).toContain("package.json dependencies: fastify");
    // Testing evidence.
    expect(analysis.testing.frameworks).toContain("vitest");
    expect(analysis.testing.relevantFiles).toContain("tests/service.test.ts");
    // Conventions from AGENTS.md with line evidence.
    const never = analysis.conventions.find((c) => c.statement.startsWith("Never commit secrets"));
    expect(never?.evidence[0]).toBe("AGENTS.md:3");
    // Entrypoint from package.json main.
    expect(analysis.entrypoints.find((e) => e.path === "src/index.ts")?.reason).toContain("package.json main");
    // Provenance: inspected files recorded; lockfile never fetched.
    expect(analysis.inspectedFiles).toContain("package.json");
    expect(analysis.inspectedFiles).not.toContain("package-lock.json");
    expect(analysis.selection.selectedCount).toBe(result.files.length);
    expect(analysis.selection.treeBlobCount).toBe(11);
    // Submodule skipped honestly.
    expect(result.notes.some((n) => n.includes("submodule"))).toBe(true);
  });

  it("is fully deterministic for the same tree", async () => {
    const run = () =>
      fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
        fetchImpl: codebaseFetch({ tree: fixtureATree(), raw: fixtureARaw() }),
      });
    const a = await run();
    const b = await run();
    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
    expect(a.input.content).toBe(b.input.content);
    expect(a.analysis).toEqual(b.analysis);
  });

  it("never sends the token to raw content hosts", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    await fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
      fetchImpl: codebaseFetch({ tree: fixtureATree(), raw: fixtureARaw(), log }),
      token: "gh_secret_test_token",
    });
    expect(log.apiHeaders.authorization).toBe("Bearer gh_secret_test_token");
    expect(log.rawHeaders.authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture B — Python project
// ---------------------------------------------------------------------------

function fixtureB(): { tree: Record<string, unknown>; raw: Record<string, string> } {
  const pyproject = [
    "[project]",
    'name = "example"',
    'version = "0.1.0"',
    'description = "Example Python project"',
    "dependencies = [\"fastapi>=0.100\"]",
    "",
    "[tool.pytest.ini_options]",
    "testpaths = [\"tests\"]",
  ].join("\n");
  const raw = {
    "pyproject.toml": pyproject,
    "README.md": "# example\n\nExample Python project with pytest tests.\n",
    "src/example/__init__.py": "",
    "src/example/main.py": "from fastapi import FastAPI\n\napp = FastAPI()\n",
    "tests/test_main.py": "import pytest\n\nfrom example.main import app\n\ndef test_app():\n    assert app is not None\n",
  };
  return {
    tree: {
      sha: "b",
      truncated: false,
      tree: [
        { path: "pyproject.toml", type: "blob", size: pyproject.length },
        { path: "README.md", type: "blob", size: 200 },
        { path: "src/example/__init__.py", type: "blob", size: 1 },
        { path: "src/example/main.py", type: "blob", size: 80 },
        { path: "tests/test_main.py", type: "blob", size: 110 },
      ],
    },
    raw,
  };
}

describe("fetchGithubCodebaseSource (Fixture B — Python project)", () => {
  it("detects the Python stack and pytest evidence", async () => {
    const fb = fixtureB();
    const result = await fetchGithubCodebaseSource("https://github.com/acme/example-py", {
      fetchImpl: codebaseFetch({ tree: fb.tree, raw: fb.raw }),
    });
    expect(result.analysis.ecosystems).toEqual(["python"]);
    expect(result.analysis.languages[0]!.name).toBe("Python");
    expect(result.analysis.frameworks.find((f) => f.name === "FastAPI")).toBeTruthy();
    expect(result.analysis.testing.frameworks).toContain("pytest");
    expect(result.analysis.testing.relevantFiles).toContain("tests/test_main.py");
    expect(result.analysis.entrypoints.some((e) => e.path.endsWith("main.py"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Limits, truncation, and honest reporting
// ---------------------------------------------------------------------------

describe("codebase ingestion limits", () => {
  it("enforces the file-count cap and reports what was not inspected", async () => {
    const raw: Record<string, string> = { "README.md": "# Repo\n\nRoot documentation for the bounded-selection test.\n" };
    const tree: Record<string, unknown>[] = [{ path: "README.md", type: "blob", size: 60 }];
    for (let i = 0; i < 12; i++) {
      raw[`src/mod-${i}.ts`] = `export const mod${i} = ${i};\n`;
      tree.push({ path: `src/mod-${i}.ts`, type: "blob", size: 40 });
    }
    const result = await fetchGithubCodebaseSource("https://github.com/acme/many", {
      fetchImpl: codebaseFetch({ tree: { sha: "c", truncated: false, tree }, raw }),
      maxFiles: 4,
    });
    expect(result.files.length).toBe(4);
    // The outcome-derived note names what was and was not inspected.
    expect(result.notes.some((n) => n.includes("Inspected 4 of 13 eligible file(s)") && n.includes("9 eligible candidate(s) were not selected"))).toBe(true);
    expect(result.analysis.uncertainty.join(" ")).toContain("9 of 13 eligible files were not inspected");
    expect(result.analysis.selection.selectedCount).toBe(4);
    expect(result.analysis.selection.candidateCount).toBe(13);
    expect(result.analysis.uncertainty.join(" ")).toContain("not inspected");
  });

  it("enforces the per-file cap from tree metadata and post-fetch reality", async () => {
    const big = `export const big = "${"x".repeat(150_000)}";\n`;
    const tree = {
      sha: "d",
      truncated: false,
      tree: [
        { path: "src/big.ts", type: "blob", size: 50 }, // underreported
        { path: "README.md", type: "blob", size: 60 },
      ],
    };
    const result = await fetchGithubCodebaseSource("https://github.com/acme/big-file", {
      fetchImpl: codebaseFetch({ tree, raw: { "src/big.ts": big, "README.md": "# Repo\n\nPer-file cap fixture for the codebase adapter.\n" } }),
      maxFileBytes: 100_000,
    });
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(result.notes.some((n) => n.includes("src/big.ts") && n.includes("per-file limit"))).toBe(true);
  });

  it("enforces the total-byte cap as a hard bound on the combined text", async () => {
    const raw: Record<string, string> = {
      "README.md": `# Repo\n\n${"r".repeat(400)}`,
      "src/a.ts": `export const a = "${"a".repeat(400)}";\n`,
      "src/b.ts": `export const b = "${"b".repeat(400)}";\n`,
    };
    const tree = {
      sha: "e",
      truncated: false,
      tree: [
        { path: "README.md", type: "blob", size: 420 },
        { path: "src/a.ts", type: "blob", size: 420 },
        { path: "src/b.ts", type: "blob", size: 420 },
      ],
    };
    const result = await fetchGithubCodebaseSource("https://github.com/acme/total-bytes", {
      fetchImpl: codebaseFetch({ tree, raw }),
      maxTotalBytes: 1_000,
    });
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(1_000);
    expect(result.notes.some((n) => n.includes("total size limit"))).toBe(true);
  });

  it("reports GitHub-truncated tree listings", async () => {
    const tree = { sha: "f", truncated: true, tree: [{ path: "README.md", type: "blob", size: 60 }] };
    const result = await fetchGithubCodebaseSource("https://github.com/acme/truncated", {
      fetchImpl: codebaseFetch({ tree, raw: { "README.md": "# Repo\n\nTruncated-tree fixture.\n" } }),
    });
    expect(result.notes.some((n) => n.includes("truncated"))).toBe(true);
    expect(result.analysis.selection.treeTruncated).toBe(true);
    expect(result.analysis.uncertainty.join(" ")).toContain("truncated");
  });

  it("aborts with a typed error when the overall deadline fires", async () => {
    const t0 = Date.now();
    await expect(
      fetchGithubCodebaseSource("https://github.com/acme/hangs", {
        fetchImpl: codebaseFetch({
          tree: {
            sha: "g",
            truncated: false,
            tree: [
              { path: "README.md", type: "blob", size: 60 },
              { path: "src/a.ts", type: "blob", size: 20 },
            ],
          },
          raw: { "README.md": "# Repo\n\nDeadline fixture.\n" },
          hangRaw: true,
        }),
        overallTimeoutMs: 250,
      }),
    ).rejects.toMatchObject({ code: "codebase_deadline_exceeded" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Safety and typed errors
// ---------------------------------------------------------------------------

describe("codebase ingestion safety", () => {
  it("treats repository content as inert text (scripts preserved verbatim, never executed)", async () => {
    const hostile = `#!/bin/sh\nrm -rf /\nnode -e 'process.exit(1)'\n`;
    const tree = {
      sha: "h",
      truncated: false,
      tree: [{ path: "scripts/deploy.sh", type: "blob", size: hostile.length }],
    };
    const result = await fetchGithubCodebaseSource("https://github.com/acme/hostile", {
      fetchImpl: codebaseFetch({ tree, raw: { "scripts/deploy.sh": hostile } }),
    });
    expect(result.input.content).toContain("rm -rf /");
  });

  it("rejects unsafe tree paths before any fetch", () => {
    expect(codebaseExclusionReason({ path: "../escape.ts", type: "blob" }, { maxDepth: 10, pathScope: "" })).toBe("unsafe_path");
    expect(codebaseExclusionReason({ path: "pkg", type: "commit" }, { maxDepth: 10, pathScope: "" })).toBe("submodule");
  });

  it("survives selection pressure without downloading the whole repository", () => {
    // Fixture C shape: hundreds of low-priority files + a few important ones.
    const entries: { path: string; type: string; size?: number }[] = [
      { path: "README.md", type: "blob", size: 100 },
      { path: "package.json", type: "blob", size: 100 },
      { path: "src/index.ts", type: "blob", size: 100 },
      { path: "tests/idx.test.ts", type: "blob", size: 100 },
    ];
    for (let i = 0; i < 400; i++) entries.push({ path: `assets/generated/part-${i}.ts`, type: "blob", size: 100 });
    const eligible = entries.filter((e) => codebaseExclusionReason(e, { maxDepth: 10, pathScope: "" }) === null);
    const selected = selectCodebaseCandidates(eligible, 60);
    expect(selected.length).toBeLessThanOrEqual(60);
    const paths = selected.map((e) => e.path);
    for (const must of ["README.md", "package.json", "src/index.ts", "tests/idx.test.ts"]) {
      expect(paths).toContain(must);
    }
  });

  it("maps repository-not-found to a typed error", async () => {
    await expect(
      fetchGithubCodebaseSource("https://github.com/acme/ghost", {
        fetchImpl: codebaseFetch({ repo: 404 }),
      }),
    ).rejects.toMatchObject({ code: "codebase_not_found" });
  });

  it("maps ref-not-found distinctly", async () => {
    await expect(
      fetchGithubCodebaseSource("https://github.com/acme/widgets", {
        fetchImpl: codebaseFetch({ repo: { default_branch: "main" }, tree: 404 }),
      }),
    ).rejects.toMatchObject({ code: "codebase_ref_not_found" });
  });

  it("maps rate limiting to a typed error", async () => {
    const limited = new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1735689600" },
    });
    const alwaysLimited = (async () => limited) as unknown as typeof fetch;
    await expect(
      fetchGithubCodebaseSource("https://github.com/acme/widgets", {
        fetchImpl: alwaysLimited,
      }),
    ).rejects.toMatchObject({ code: "codebase_rate_limited" });
  });

  it("errors honestly when nothing analyzable exists", async () => {
    await expect(
      fetchGithubCodebaseSource("https://github.com/acme/empty", {
        fetchImpl: codebaseFetch({ tree: { sha: "i", truncated: false, tree: [{ path: "img/logo.png", type: "blob", size: 900 }] } }),
      }),
    ).rejects.toMatchObject({ code: "codebase_no_candidates" });
  });

  it("errors as GithubCodebaseError instances (typed family)", async () => {
    try {
      await fetchGithubCodebaseSource("https://github.com/acme/ghost", {
        fetchImpl: codebaseFetch({ repo: 404 }),
      });
      expect.fail("expected codebase_not_found");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubCodebaseError);
      expect((err as GithubCodebaseError).message).toContain("public repositories only");
    }
  });
});
