import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseGithubRepoUrl,
  fetchGithubSource,
  docPriority,
  GithubSourceError,
  MAX_GITHUB_FILES,
} from "../src/core/sources/github.js";

/** Injected-fetch harness: routes api.github.com and raw.githubusercontent.com
 * URLs to fixture data. No test in this file touches the network. */
type FetchLog = { urls: string[]; apiHeaders: Record<string, string>; rawHeaders: Record<string, string> };

function githubFetch(o: {
  repo?: Record<string, unknown> | number;
  tree?: Record<string, unknown> | number;
  raw?: Record<string, string>;
  rawStatus?: Record<string, number>;
  failUrls?: string[];
  firstResponse?: Response;
  finalUrlHost?: string;
  log?: FetchLog;
}) {
  const record = o.log;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const isApi = url.startsWith("https://api.github.com/");
    const isRaw = url.startsWith("https://raw.githubusercontent.com/");
    if (isApi) Object.assign(record?.apiHeaders ?? {}, headers);
    if (isRaw) Object.assign(record?.rawHeaders ?? {}, headers);
    record?.urls.push(url);
    if (o.firstResponse) return o.firstResponse;
    if (o.failUrls?.some((f) => url.includes(f))) throw new TypeError("network unreachable");
    if (isApi && !url.includes("/git/trees/")) {
      const status = typeof o.repo === "number" ? o.repo : 200;
      const body = typeof o.repo === "number" ? { message: "Not Found" } : (o.repo ?? { default_branch: "main" });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/git/trees/")) {
      const status = typeof o.tree === "number" ? o.tree : 200;
      const body = typeof o.tree === "number" ? { message: "Not Found" } : o.tree ?? { tree: [], truncated: false };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (isRaw) {
      const rawPath = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
      const body = o.raw?.[rawPath] ?? "not found";
      const status = o.rawStatus?.[rawPath] ?? (o.raw?.[rawPath] !== undefined ? 200 : 404);
      const res = new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
      const finalUrl = `https://${o.finalUrlHost ?? "raw.githubusercontent.com"}/${rawPath}`;
      Object.defineProperty(res, "url", { value: finalUrl });
      return res;
    }
    return new Response("unexpected URL", { status: 500 });
  }) as unknown as typeof fetch;
}

const README = "# WidgetForge\n\nWidgetForge builds widget bundles from a manifest. This guide covers setup and validation.";
const GUIDE = [
  "# Setup",
  "",
  "```bash",
  "npm install widgetforge",
  "```",
  "",
  "## Validate a bundle",
  "",
  "1. Run `widgetforge check manifest.yaml`.",
  "2. Fix every reported error.",
  "3. Re-run the check until it exits zero.",
  "",
  "Warning: never validate against production credentials.",
].join("\n");

function stdTree(): Record<string, unknown> {
  return {
    sha: "abc",
    truncated: false,
    tree: [
      { path: "README.md", type: "blob", size: README.length },
      { path: "docs/guide.md", type: "blob", size: GUIDE.length },
      { path: "CONTRIBUTING.md", type: "blob", size: 500 },
      { path: "src/index.ts", type: "blob", size: 3000 },
      { path: "package.json", type: "blob", size: 400 },
      { path: "docs/img/logo.png", type: "blob", size: 9000 },
    ],
  };
}

function stdRaw(): Record<string, string> {
  return {
    "README.md": README,
    "docs/guide.md": GUIDE,
    "CONTRIBUTING.md": "# Contributing\n\nWe welcome patches; please open an issue before large changes and follow the guide.",
  };
}

describe("parseGithubRepoUrl", () => {
  it("parses repository root URLs", () => {
    expect(parseGithubRepoUrl("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
      path: "",
    });
  });

  it("normalizes .git suffix, www host, and trailing slash", () => {
    const ref = parseGithubRepoUrl("https://www.github.com/acme/widgets.git/");
    expect(ref.owner).toBe("acme");
    expect(ref.repo).toBe("widgets");
  });

  it("parses tree URLs with ref and path scope", () => {
    expect(parseGithubRepoUrl("https://github.com/acme/widgets/tree/main/docs")).toEqual({
      owner: "acme",
      repo: "widgets",
      ref: "main",
      path: "docs",
    });
  });

  it("rejects non-github hosts, non-https, and non-repository pages", () => {
    for (const bad of [
      "https://gitlab.com/acme/widgets",
      "http://github.com/acme/widgets",
      "https://github.com/acme/widgets/issues/12",
      "https://github.com/acme",
      "https://github.com/acme/widgets/tree", // /tree without a ref
      "not a url at all",
    ]) {
      try {
        parseGithubRepoUrl(bad);
        expect.fail(`expected rejection for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(GithubSourceError);
        expect((err as GithubSourceError).code).toMatch(/^github_(invalid_url|unsupported_host)$/);
      }
    }
  });

  it("normalizes dot-segment traversal out of URL paths (WHATWG URL parsing)", () => {
    // The URL constructor resolves /../ segments before parsing, so traversal
    // cannot survive into any request URL. Paths arriving from the GitHub API
    // tree (the untrusted surface) are rejected separately — see the
    // unsafe-tree-entries test.
    expect(parseGithubRepoUrl("https://github.com/acme/widgets/tree/main/../..")).toEqual({
      owner: "acme",
      repo: "widgets",
      path: "",
    });
  });
});

describe("docPriority", () => {
  it("orders README before docs/ before root files before nested files", () => {
    expect(docPriority("README.md")).toBeLessThan(docPriority("docs/guide.md"));
    expect(docPriority("docs/guide.md")).toBeLessThan(docPriority("CONTRIBUTING.md"));
    expect(docPriority("CONTRIBUTING.md")).toBeLessThan(docPriority("deep/nested/other.md"));
  });
});

describe("fetchGithubSource (injected fetch)", () => {
  it("resolves the default branch when the URL omits a ref", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree: stdTree(), raw: stdRaw(), log }),
    });
    expect(result.repo.defaultBranchUsed).toBe(true);
    expect(result.repo.ref).toBe("main");
    expect(log.urls[0]).toBe("https://api.github.com/repos/acme/widgets");
    expect(log.urls[1]).toContain("/git/trees/main?");
    // Raw content URLs carry the resolved ref.
    expect(log.urls.some((u) => u.startsWith("https://raw.githubusercontent.com/acme/widgets/main/"))).toBe(true);
  });

  it("uses an explicit ref from tree URLs without resolving the default branch", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    const result = await fetchGithubSource("https://github.com/acme/widgets/tree/v2/docs", {
      fetchImpl: githubFetch({ tree: stdTree(), raw: stdRaw(), log }),
    });
    expect(result.repo.defaultBranchUsed).toBe(false);
    expect(result.repo.ref).toBe("v2");
    expect(log.urls.every((u) => !u.endsWith("api.github.com/repos/acme/widgets"))).toBe(true);
  });

  it("combines documentation with path headers and README first, in deterministic order", async () => {
    const run = async () => {
      const result = await fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ tree: stdTree(), raw: stdRaw() }),
      });
      return result;
    };
    const a = await run();
    const b = await run();
    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
    // Extensions filtered: source code and binaries are not ingested.
    expect(a.files.map((f) => f.path)).toEqual(["README.md", "docs/guide.md", "CONTRIBUTING.md"]);
    // Multi-file content joins with `# path` headers.
    expect(a.input.content).toContain("# README.md");
    expect(a.input.content).toContain("# docs/guide.md");
    expect(a.input.content).toContain("npm install widgetforge");
    expect(a.input.type).toBe("github");
    expect(a.input.name).toContain("acme/widgets");
  });

  it("scopes ingestion to the tree URL subpath", async () => {
    const result = await fetchGithubSource("https://github.com/acme/widgets/tree/main/docs", {
      fetchImpl: githubFetch({ tree: stdTree(), raw: stdRaw() }),
    });
    expect(result.files.map((f) => f.path)).toEqual(["docs/guide.md"]);
    expect(result.input.content).not.toContain("# README.md");
  });

  it("enforces the file-count bound and reports it", async () => {
    const raw = stdRaw();
    for (let i = 0; i < 10; i++) raw[`docs/page-${i}.md`] = `# Page ${i}\n\nFiller content long enough to be a useful documentation page for the generator.`;
    const tree = { sha: "x", truncated: false, tree: Object.keys(raw).map((p) => ({ path: p, type: "blob", size: 100 })) };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw }),
      maxFiles: 3,
    });
    expect(result.files.length).toBe(3);
    expect(result.notes.some((n) => n.includes("file limit"))).toBe(true);
  });

  it("enforces the total-size bound and reports it", async () => {
    const raw = stdRaw();
    const tree = { sha: "x", truncated: false, tree: Object.keys(raw).map((p) => ({ path: p, type: "blob", size: 600 })) };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw }),
      maxTotalBytes: 700,
    });
    expect(result.files.length).toBe(1);
    expect(result.notes.some((n) => n.includes("total size limit"))).toBe(true);
  });

  it("skips over-large files instead of fetching them", async () => {
    const tree = {
      sha: "x",
      truncated: false,
      tree: [
        { path: "README.md", type: "blob", size: 1_000_000 },
        { path: "docs/guide.md", type: "blob", size: GUIDE.length },
      ],
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "docs/guide.md": GUIDE, "README.md": README } }),
      maxFileBytes: 100_000,
    });
    expect(result.files.map((f) => f.path)).toEqual(["docs/guide.md"]);
    expect(result.notes.some((n) => n.includes("README.md") && n.includes("too large"))).toBe(true);
  });

  it("ignores tree entries deeper than the path depth bound", async () => {
    const tree = {
      sha: "x",
      truncated: false,
      tree: [
        { path: "README.md", type: "blob", size: README.length },
        { path: "a/b/c/d/e/f/deep.md", type: "blob", size: 100 },
        { path: "a/b/c/d/e/ok.md", type: "blob", size: 100 },
      ],
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "README.md": README, "a/b/c/d/e/ok.md": GUIDE, "a/b/c/d/e/f/deep.md": GUIDE } }),
    });
    expect(result.files.map((f) => f.path).sort()).toEqual(["README.md", "a/b/c/d/e/ok.md"]);
  });

  it("skips unsafe tree entries and never follows submodules", async () => {
    const tree = {
      sha: "x",
      truncated: false,
      tree: [
        { path: "README.md", type: "blob", size: README.length },
        { path: "../escape.md", type: "blob", size: 10 },
        { path: "/absolute.md", type: "blob", size: 10 },
        { path: "a\\b.md", type: "blob", size: 10 },
        { path: "vendor-lib", type: "commit", size: 0 }, // submodule
      ],
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "README.md": README } }),
    });
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(result.notes.some((n) => n.includes("submodule"))).toBe(true);
    // The escaped path must never appear anywhere in the combined source.
    expect(result.input.content).not.toContain("../escape.md");
  });

  it("reports GitHub-truncated tree listings honestly", async () => {
    const tree = { sha: "x", truncated: true, tree: [{ path: "README.md", type: "blob", size: README.length }] };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "README.md": README } }),
    });
    expect(result.notes.some((n) => n.includes("truncated"))).toBe(true);
  });

  it("reports repository not-found (including private-repository guidance)", async () => {
    await expect(
      fetchGithubSource("https://github.com/acme/private-widgets", {
        fetchImpl: githubFetch({ repo: 404, tree: stdTree() }),
      }),
    ).rejects.toMatchObject({ code: "github_not_found" });
  });

  it("distinguishes ref-not-found from repository-not-found", async () => {
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ repo: { default_branch: "main" }, tree: 404 }),
      }),
    ).rejects.toMatchObject({ code: "github_ref_not_found" });
  });

  it("maps GitHub rate-limit responses to a typed error", async () => {
    const limited = new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1735689600" },
    });
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ firstResponse: limited }),
      }),
    ).rejects.toMatchObject({ code: "github_rate_limited" });
  });

  it("maps network failures to a typed error", async () => {
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ failUrls: ["api.github.com"] }),
      }),
    ).rejects.toMatchObject({ code: "github_fetch_failed" });
  });

  it("errors honestly when documentation is listed but none is fetchable", async () => {
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ tree: stdTree(), raw: {}, rawStatus: { "README.md": 404 } }),
      }),
    ).rejects.toMatchObject({ code: "github_no_docs" });
  });

  it("sends an optional token only to api.github.com", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree: stdTree(), raw: stdRaw(), log }),
      token: "gh_secret_test_token",
    });
    expect(log.apiHeaders.authorization).toBe("Bearer gh_secret_test_token");
    expect(log.rawHeaders.authorization).toBeUndefined();
  });

  it("treats repository file content as inert text (never executed)", async () => {
    const hostile = `${README}\n<script>alert("xss")</script>\n<!-- no execution -->`;
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({
        tree: { sha: "x", truncated: false, tree: [{ path: "README.md", type: "blob", size: hostile.length }] },
        raw: { "README.md": hostile },
      }),
    });
    expect(result.input.content).toContain('alert("xss")');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SKILLFORGE_GITHUB_TOKEN;
  });

  it("keeps the default file bound aligned with the documented constant", () => {
    expect(MAX_GITHUB_FILES).toBe(40);
  });
});
