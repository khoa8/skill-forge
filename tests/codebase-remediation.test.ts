/**
 * Remediation regression tests.
 *
 * P1-1: codebase-mode normalization must preserve source markup/code verbatim
 *       (no HTML stripping, no entity decoding); docs mode keeps its behavior.
 * P1-2: /tree/<ref>/<path> scope must constrain ALL structured reconnaissance.
 */
import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import {
  fetchGithubCodebaseSource,
  detectRoots,
  detectWorkspacePackages,
  detectEntrypointCandidates,
  detectInstructionFiles,
  pathRelativeTo,
} from "../src/core/sources/github-codebase.js";

// ---------------------------------------------------------------------------
// P1-1 — normalization preservation
// ---------------------------------------------------------------------------

const VUE = [
  "<template>",
  '  <button class="btn" @click="count++">Clicked {{ count }}</button>',
  "</template>",
  "",
  "<script>",
  "export default {",
  "  data() { return { count: 0, html: '<b>bold &amp; unescaped</b>' }; },",
  "};",
  "</script>",
  "",
  "<style>",
  ".btn { color: red; }",
  "</style>",
].join("\n");

const HTML_WITH_SCRIPT = [
  "<!doctype html>",
  "<html>",
  "  <head>",
  "    <style>body { margin: 0; }</style>",
  "    <script>alert('kept verbatim') && console.log('&amp; entities stay');</script>",
  "  </head>",
  "  <body></body>",
  "</html>",
].join("\n");

const TSX = [
  "export const App = () => (",
  "  <div className=\"app\" onClick={() => fetch('/api')}>",
  "    {items.map((i) => <li key={i}>{i}</li>)}",
  "  </div>",
  ");",
].join("\n");

const XML = '<?xml version="1.0"?>\n<configuration><setting name="x" value="&lt;placeholder&gt;" /></configuration>';

describe("P1-1: codebase normalization preserves source verbatim", () => {
  it("keeps Vue single-file component markup, script, and entities", () => {
    const normalized = normalizeSource({ type: "github-codebase", name: "comp.vue", content: VUE });
    expect(normalized.text).toContain("<script>");
    expect(normalized.text).toContain("</script>");
    expect(normalized.text).toContain("<style>");
    expect(normalized.text).toContain("&amp;");
    expect(normalized.text).toContain("{{ count }}");
    // No docs-style stripping note.
    expect(normalized.notes.join(" ")).not.toContain("HTML markup was detected");
  });

  it("keeps <script> and <style> bodies of HTML files intact", () => {
    const normalized = normalizeSource({ type: "github-codebase", name: "index.html", content: HTML_WITH_SCRIPT });
    expect(normalized.text).toContain("alert('kept verbatim')");
    expect(normalized.text).toContain("body { margin: 0; }");
    expect(normalized.text).toContain("&amp; entities stay");
  });

  it("keeps TSX and XML tag-like syntax", () => {
    const tsx = normalizeSource({ type: "github-codebase", name: "App.tsx", content: TSX });
    expect(tsx.text).toContain("<div className=\"app\"");
    const xml = normalizeSource({ type: "github-codebase", name: "cfg.xml", content: XML });
    expect(xml.text).toContain("&lt;placeholder&gt;");
    expect(xml.text).toContain("<configuration>");
  });

  it("keeps interior blank lines and whitespace (only line endings + trailing end normalized)", () => {
    const code = "const a = 1;\n\n\n\nconst b = `line with trailing spaces   `;\n\n\n";
    const normalized = normalizeSource({ type: "github-codebase", name: "x.ts", content: code.replace(/\n/g, "\r\n") });
    // Interior characters verbatim; the final trailing newline follows the
    // same shared lineCount convention as every other source type.
    expect(normalized.text).toBe("const a = 1;\n\n\n\nconst b = `line with trailing spaces   `;");
  });

  it("keeps the analyzed (normalized) source usable for repository analysis/provider context", () => {
    const combined = `# src/App.vue\n\n${VUE}\n\n# index.html\n\n${HTML_WITH_SCRIPT}\n`;
    const normalized = normalizeSource({ type: "github-codebase", name: "repo codebase", content: combined });
    const analysis = analyzeSource(normalized);
    // Line-range provenance slices return the preserved markup.
    const section = analysis.sections.find((s) => s.heading.includes("App.vue"));
    expect(section).toBeTruthy();
    const slice = normalized.text.split("\n").slice(section!.startLine - 1, section!.endLine).join("\n");
    expect(slice).toContain("export default {");
    expect(slice).toContain("&amp;");
  });

  it("still strips HTML for documentation-mode sources (regression guard)", () => {
    const normalized = normalizeSource({
      type: "text",
      name: "docs",
      content: "# Docs\n\n<script>alert('stripped')</script>\nReal content &amp; entities decoded, long enough to ingest cleanly.",
    });
    expect(normalized.text).not.toContain("<script>");
    expect(normalized.text).toContain("&");
    expect(normalized.notes.join(" ")).toContain("HTML markup was detected and stripped");
  });
});

// ---------------------------------------------------------------------------
// P1-2 — scoped /tree/<ref>/<path> reconnaissance
// ---------------------------------------------------------------------------

function monorepoTree(): Record<string, unknown>[] {
  return [
    // Root area (outside the requested scope).
    { path: "README.md", type: "blob", size: 500 },
    { path: "package.json", type: "blob", size: 400 },
    { path: "go.mod", type: "blob", size: 100 },
    { path: ".github/workflows/ci.yml", type: "blob", size: 200 },
    { path: "src/root-main.ts", type: "blob", size: 100 },
    { path: "vendor/lib.py", type: "blob", size: 100 },
    // packages/a — TypeScript service (the requested scope).
    { path: "packages/a/package.json", type: "blob", size: 300 },
    { path: "packages/a/AGENTS.md", type: "blob", size: 200 },
    { path: "packages/a/src/index.ts", type: "blob", size: 100 },
    { path: "packages/a/src/main.ts", type: "blob", size: 100 },
    { path: "packages/a/tests/a.test.ts", type: "blob", size: 100 },
    { path: "packages/a/.github/workflows/a.yml", type: "blob", size: 100 },
    // packages/b — Python (must NOT leak into scoped facts).
    { path: "packages/b/pyproject.toml", type: "blob", size: 200 },
    { path: "packages/b/src/b/main.py", type: "blob", size: 100 },
    { path: "packages/b/tests/test_b.py", type: "blob", size: 100 },
    { path: "packages/b/cmd/b/main.go", type: "blob", size: 100 },
  ];
}

const RAW: Record<string, string> = {
  "README.md": "# Root\n\nRoot readme, outside the scope.\n",
  "package.json": JSON.stringify({ name: "root", scripts: { test: "root-runner" } }),
  "go.mod": "module example.com/root\n\ngo 1.21\n",
  ".github/workflows/ci.yml": "on: push\njobs:\n  x:\n    steps:\n      - run: root-ci-command\n",
  "src/root-main.ts": "export const root = 1;\n",
  "vendor/lib.py": "print('vendored')\n",
  "packages/a/package.json": JSON.stringify({
    name: "pkg-a",
    main: "src/index.ts",
    scripts: { test: "vitest run", build: "tsc -p tsconfig.json" },
    devDependencies: { vitest: "^1" },
  }),
  "packages/a/AGENTS.md": "# AGENTS.md\n\n- Always run `vitest run` before pushing.\n",
  "packages/a/src/index.ts": "export const a = 1;\n",
  "packages/a/src/main.ts": "main();\n",
  "packages/a/tests/a.test.ts": 'import { it } from "vitest";\nit("works", () => {});\n',
  "packages/a/.github/workflows/a.yml": "on: push\njobs:\n  y:\n    steps:\n      - run: npm ci\n",
  "packages/b/pyproject.toml": '[project]\nname = "pkg-b"\ndependencies = ["fastapi>=0.1"]\n',
  "packages/b/src/b/main.py": "from fastapi import FastAPI\n",
  "packages/b/tests/test_b.py": "import pytest\n",
  "packages/b/cmd/b/main.go": "package main\n",
};

function scopedFetchHarness() {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/") && !url.includes("/git/trees/")) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/git/trees/")) {
      return new Response(JSON.stringify({ sha: "x", truncated: false, tree: monorepoTree() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const p = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
      const body = RAW[p];
      const res = new Response(body ?? "not found", { status: body !== undefined ? 200 : 404, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("P1-2: scoped /tree/ analysis contains no out-of-scope facts", () => {
  it("reports only packages/a facts for a scoped request", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/monorepo/tree/main/packages/a", {
      fetchImpl: scopedFetchHarness(),
    });
    const a = r.analysis;
    expect(a.repository.scope).toBe("packages/a");

    // Languages/ecosystems: TypeScript/Node only — no Python, no Go.
    expect(a.languages.map((l) => l.name)).toEqual(["TypeScript"]);
    expect(a.ecosystems).toEqual(["node"]);
    // Manifests: only the scoped package.json — no root package.json, no go.mod, no pyproject.toml.
    expect(a.manifests.map((m) => m.path)).toEqual(["packages/a/package.json"]);
    // Roots computed relative to the scope.
    expect(a.structure.sourceRoots).toEqual(["src/"]);
    expect(a.structure.testRoots).toEqual(["tests/"]);
    // Entrypoints from the scope only (packages/b/cmd/b/main.go must not appear).
    expect(a.entrypoints.every((e) => e.path.startsWith("packages/a/"))).toBe(true);
    expect(a.entrypoints.some((e) => e.path === "packages/a/src/index.ts")).toBe(true);
    // CI workflows: only the scoped one, if any — the root workflow must not leak.
    expect(a.importantFiles.every((f) => f.path.startsWith("packages/a/"))).toBe(true);
    // Commands from the scoped package.json only.
    expect(a.commands.every((c) => c.evidence.startsWith("packages/a/"))).toBe(true);
    // Inspected files all inside the scope.
    expect(a.inspectedFiles.every((p) => p.startsWith("packages/a/"))).toBe(true);
  });

  it("keeps whole-repository analysis unchanged for unscoped requests", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/monorepo", {
      fetchImpl: scopedFetchHarness(),
    });
    expect(r.analysis.repository.scope).toBeUndefined();
    expect(r.analysis.ecosystems.sort()).toEqual(["go", "node", "python"]);
  });

  it("pathRelativeTo strips scope prefixes for structure computation", () => {
    expect(pathRelativeTo("packages/a/src/x.ts", "packages/a")).toBe("src/x.ts");
    expect(pathRelativeTo("packages/a", "packages/a")).toBe("");
    expect(pathRelativeTo("packages/b/src/x.ts", "packages/a")).toBe("packages/b/src/x.ts");
    expect(pathRelativeTo("src/x.ts", "")).toBe("src/x.ts");
  });

  it("scoped detectors treat the scope root as the root", () => {
    const entries = monorepoTree().map((e) => e as { path: string; type: string; size?: number });
    const scoped = entries.filter((e) => e.path.startsWith("packages/a/"));
    expect(detectRoots(scoped, "packages/a")).toEqual({ sourceRoots: ["src/"], testRoots: ["tests/"], exampleRoots: [] });
    expect(detectWorkspacePackages(scoped, "packages/a")).toEqual([]); // no nested manifests within a
    expect(detectWorkspacePackages(entries).sort()).toEqual(["packages/a", "packages/b"]);
    const eps = detectEntrypointCandidates(scoped, "packages/a");
    expect(eps.map((e) => e.path).sort()).toEqual(["packages/a/src/index.ts", "packages/a/src/main.ts"].sort());
    const instructions = detectInstructionFiles(scoped, "packages/a");
    expect(instructions[0]).toBe("packages/a/AGENTS.md");
  });
});

// ---------------------------------------------------------------------------
// P1-3 + P2-1 — manifest fetched state + inspection accounting
// ---------------------------------------------------------------------------

import { deriveCodebasePlan } from "../src/core/codebase/plan.js";

function accountingHarness(o: {
  rawMissing?: string[];
  oversize?: string[];
  maxTotalBytes?: number;
}) {
  const tree: Record<string, unknown>[] = [
    { path: "README.md", type: "blob", size: 60 },
    { path: "package.json", type: "blob", size: 120 },
    { path: "package-lock.json", type: "blob", size: 400_000 },
    { path: "apps/web/package.json", type: "blob", size: (o.oversize?.includes("apps/web/package.json") ? 900_000 : 120) },
    { path: "apps/api/package.json", type: "blob", size: 120 },
    { path: "libs/core/package.json", type: "blob", size: 120 },
    { path: "libs/core/index.ts", type: "blob", size: 40 },
  ];
  const bodies: Record<string, string> = {
    "README.md": "# Repo\n\nInspection accounting fixture.\n",
    "package.json": JSON.stringify({ name: "root", scripts: { test: "vitest run" } }),
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { test: "web-test" } }),
    "apps/api/package.json": JSON.stringify({ name: "api", scripts: { test: "api-test" } }),
    "libs/core/package.json": JSON.stringify({ name: "core", scripts: { test: "core-test" } }),
    "libs/core/index.ts": "export {};\n",
  };
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/") && !url.includes("/git/trees/")) {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/git/trees/")) {
      return new Response(JSON.stringify({ sha: "x", truncated: false, tree }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const p = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
      const missing = o.rawMissing?.includes(p) ?? false;
      const body = bodies[p];
      const status = !missing && body !== undefined ? 200 : 404;
      const res = new Response(!missing && body !== undefined ? body : "not found", { status, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("P1-3: RepositoryManifest.fetched reflects actual inspection", () => {
  it("marks manifests fetched only when their content was actually inspected", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/accounting", {
      fetchImpl: accountingHarness({ rawMissing: ["apps/api/package.json"], oversize: ["apps/web/package.json"] }),
    });
    const m = Object.fromEntries(r.analysis.manifests.map((x) => [x.path, x.fetched]));
    // Fetched.
    expect(m["package.json"]).toBe(true);
    expect(m["libs/core/package.json"]).toBe(true);
    // Lockfile: metadata-only, never fetched.
    expect(m["package-lock.json"]).toBe(false);
    // Selected but over per-file limit.
    expect(m["apps/web/package.json"]).toBe(false);
    // Selected but unreachable.
    expect(m["apps/api/package.json"]).toBe(false);
    // Consistency: every fetched manifest is in the inspected set.
    for (const manifest of r.analysis.manifests) {
      if (manifest.fetched) expect(r.analysis.inspectedFiles).toContain(manifest.path);
      else expect(r.analysis.inspectedFiles).not.toContain(manifest.path);
    }
  });

  it("planning never presents an uninspected manifest as inspected input", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/accounting", {
      fetchImpl: accountingHarness({ rawMissing: ["apps/api/package.json"], oversize: ["apps/web/package.json"] }),
    });
    const plan = deriveCodebasePlan(r.analysis);
    const inputs = plan.inputs.join(" ");
    expect(inputs).toContain("`package.json`");
    expect(inputs).toContain("`libs/core/package.json`");
    expect(inputs).not.toContain("apps/web/package.json");
    expect(inputs).not.toContain("apps/api/package.json");
    expect(inputs).not.toContain("package-lock.json");
  });
});

describe("P2-1: inspection accounting is internally consistent", () => {
  it("all fetched: notes, selection, and inspectedFiles agree", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/accounting", {
      fetchImpl: accountingHarness({}),
    });
    // 7 blobs; lockfile excluded from eligibility → 6 candidates, all fetched.
    expect(r.analysis.selection.candidateCount).toBe(6);
    expect(r.analysis.selection.selectedCount).toBe(6);
    expect(r.analysis.inspectedFiles.length).toBe(6);
    expect(r.notes.some((n) => n.startsWith("Inspected all 6 eligible file(s)"))).toBe(true);
  });

  it("oversized + unreachable skips produce an accurate breakdown and uncertainty", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/accounting", {
      fetchImpl: accountingHarness({ rawMissing: ["apps/api/package.json"], oversize: ["apps/web/package.json"] }),
    });
    expect(r.analysis.selection.selectedCount).toBe(4);
    expect(r.analysis.inspectedFiles.length).toBe(4);
    const note = r.notes.find((n) => n.startsWith("Inspected 4 of 6 selected"));
    expect(note).toBeTruthy();
    expect(note).toContain("1 could not be fetched");
    expect(note).toContain("1 exceeded the per-file limit");
    // All 6 eligible candidates WERE selected — the two skips happened at
    // fetch time, so no "not selected" clause may appear.
    expect(note).not.toContain("not selected");
    expect(r.analysis.uncertainty.join(" ")).toContain("2 selected file(s) could not be inspected");
  });

  it("total-byte budget stop is counted and reported consistently", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/accounting", {
      fetchImpl: accountingHarness({}),
      maxTotalBytes: 200,
    });
    // selectedCount means "actually inspected" (P2-1); the budget stop shows
    // up as fewer inspected than eligible candidates plus an explicit note.
    expect(r.analysis.selection.selectedCount).toBe(3);
    expect(r.notes.some((n) => n.includes("would have exceeded the total size limit"))).toBe(true);
    expect(r.notes.some((n) => n.includes("Inspected 3 of 6 selected file(s)") && n.includes("would have exceeded the total size limit") && n.includes("2 not fetched after the size limit stopped ingestion"))).toBe(true);
    expect(r.analysis.uncertainty.join(" ")).toContain("selected file(s) could not be inspected");
    // Hard bound holds on the combined text.
    expect(Buffer.byteLength(r.input.content, "utf8")).toBeLessThanOrEqual(200);
  });

  it("candidate count exceeding the selection budget is reflected in uncertainty", async () => {
    const r = await fetchGithubCodebaseSource("https://github.com/acme/accounting", {
      fetchImpl: accountingHarness({}),
      maxFiles: 2,
    });
    expect(r.analysis.selection.selectedCount).toBe(2);
    expect(r.analysis.selection.candidateCount).toBe(6);
    expect(r.analysis.uncertainty.join(" ")).toContain("4 of 6 eligible files were not inspected");
  });
});
