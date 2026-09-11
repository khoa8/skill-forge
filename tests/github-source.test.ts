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
      const body = typeof o.repo === "number" ? { message: "Not Found" } : (o.repo ?? { default_branch: "main", private: false, visibility: "public" });
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

  it("uses an explicit ref from tree URLs while validating publicness via metadata", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    const result = await fetchGithubSource("https://github.com/acme/widgets/tree/v2/docs", {
      fetchImpl: githubFetch({ tree: stdTree(), raw: stdRaw(), log }),
    });
    expect(result.repo.defaultBranchUsed).toBe(false);
    expect(result.repo.ref).toBe("v2");
    expect(log.urls[0]).toBe("https://api.github.com/repos/acme/widgets");
    expect(log.urls[1]).toContain("/git/trees/v2?");
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
    const raw: Record<string, string> = {
      "docs/a.md": `# A\n\n${"a".repeat(400)}`,
      "docs/b.md": `# B\n\n${"b".repeat(400)}`,
      "docs/c.md": `# C\n\n${"c".repeat(400)}`,
    };
    const tree = { sha: "x", truncated: false, tree: Object.keys(raw).map((p) => ({ path: p, type: "blob", size: 410 })) };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw }),
      maxTotalBytes: 700,
    });
    expect(result.files.length).toBe(1);
    expect(result.notes.some((n) => n.includes("total size limit") && n.includes("docs/b.md"))).toBe(true);
    // Hard guarantee on the actual combined content.
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(700);
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

  it("enforces the total-size bound as a hard cap on the final combined source", async () => {
    // Metadata sizes are missing / underreported; the real bodies are large.
    // The projection must account for the synthetic "# path" headers and
    // separators exactly, and the combined result must never exceed the cap.
    const big1 = `# Big One\n\n${"x".repeat(600)}`;
    const big2 = `# Big Two\n\n${"y".repeat(600)}`;
    const tree = {
      sha: "x",
      truncated: false,
      tree: [
        { path: "docs/one.md", type: "blob" }, // size deliberately missing
        { path: "docs/two.md", type: "blob", size: 10 }, // deliberately underreported
      ],
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "docs/one.md": big1, "docs/two.md": big2 } }),
      maxTotalBytes: 700,
    });
    expect(result.files.map((f) => f.path)).toEqual(["docs/one.md"]);
    expect(result.notes.some((n) => n.includes("total size limit") && n.includes("docs/two.md"))).toBe(true);
    // Hard guarantee — no tolerance.
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(700);
  });

  it("rejects a file whose content alone fits but whose combined contribution crosses the cap", async () => {
    // The first file fits alone; the second file's content is also under the
    // cap by itself, but adding its synthetic "# path" header and join
    // separator pushes the projected combined size over the cap.
    const cap = 250;
    const first = "a".repeat(200);
    const second = "b".repeat(45); // + "# docs/b.md\n\n" + "\n" + separator exceeds 250
    const tree = {
      sha: "x",
      truncated: false,
      tree: [
        { path: "docs/a.md", type: "blob", size: first.length },
        { path: "docs/b.md", type: "blob", size: second.length },
      ],
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "docs/a.md": first, "docs/b.md": second } }),
      maxTotalBytes: cap,
    });
    expect(result.files.map((f) => f.path)).toEqual(["docs/a.md"]);
    expect(result.notes.some((n) => n.includes("total size limit") && n.includes("docs/b.md"))).toBe(true);
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(cap);
  });

  it("keeps multiple boundary-adjacent files within the exact cap", async () => {
    // Three files each sized so that all three together (with headers and
    // separators) land exactly at the cap; nothing may exceed it.
    const mk = (n: string, filler: string, len: number) => `# ${n}\n\n${filler.repeat(len)}`;
    const a = mk("A", "a", 86);
    const b = mk("B", "b", 86);
    const c = mk("C", "c", 86);
    const tree = {
      sha: "x",
      truncated: false,
      tree: [
        { path: "docs/a.md", type: "blob", size: a.length },
        { path: "docs/b.md", type: "blob", size: b.length },
        { path: "docs/c.md", type: "blob", size: c.length },
      ],
    };
    const cap = 320;
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "docs/a.md": a, "docs/b.md": b, "docs/c.md": c } }),
      maxTotalBytes: cap,
    });
    expect(result.files.length).toBeGreaterThanOrEqual(2);
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(cap);
  });

  it("skips a file whose actual body exceeds the per-file limit despite honest metadata", async () => {
    const huge = `# Huge\n\n${"z".repeat(150_000)}`;
    const tree = {
      sha: "x",
      truncated: false,
      tree: [
        { path: "README.md", type: "blob", size: README.length },
        { path: "docs/huge.md", type: "blob", size: 500 }, // underreported
      ],
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "README.md": README, "docs/huge.md": huge } }),
      maxFileBytes: 100_000,
    });
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(result.notes.some((n) => n.includes("docs/huge.md") && n.includes("per-file limit"))).toBe(true);
  });

  it("a single file with trailing whitespace can never bypass the total cap", async () => {
    // Meaningful text is modest; trailing whitespace makes the raw body far
    // larger than the cap. The projected (trimmed) chunk used to pass while
    // the returned raw content exceeded the cap — the invariant is on the
    // FINAL representation, so this must never happen.
    const body = `# Trailing\n\n${"meaningful text here. ".repeat(10)}${" ".repeat(400)}\n\n`;
    const tree = {
      sha: "x",
      truncated: false,
      tree: [{ path: "docs/trailing.md", type: "blob" }], // size missing too
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "docs/trailing.md": body } }),
      maxTotalBytes: 500,
    });
    // The returned representation is the projected one (trimmed + header), so
    // the raw 634-byte body cannot leak past the cap.
    expect(result.files.map((f) => f.path)).toEqual(["docs/trailing.md"]);
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(500);
    expect(result.input.content.includes(" ".repeat(400))).toBe(false);
  });

  it("a single file exactly under the cap is returned with header, trimmed", async () => {
    const body = `# Compact\n\n${"k".repeat(120)}`;
    const tree = {
      sha: "x",
      truncated: false,
      tree: [{ path: "docs/compact.md", type: "blob", size: 5 }], // underreported
    };
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree, raw: { "docs/compact.md": body } }),
      maxTotalBytes: 500,
    });
    expect(result.files.map((f) => f.path)).toEqual(["docs/compact.md"]);
    expect(Buffer.byteLength(result.input.content, "utf8")).toBeLessThanOrEqual(500);
    // Unified representation: single-file output also carries the header and
    // trimmed content — no drift between projection and output.
    expect(result.input.content).toBe("# docs/compact.md\n\n# Compact\n\n" + "k".repeat(120) + "\n");
  });

  it("multibyte UTF-8 content is bounded by UTF-8 byte length, not character count", async () => {
    // Each "日" is 3 bytes in UTF-8; 200 chars = 600 bytes + header > 500 cap.
    const body = `# Multibyte\n\n${"日".repeat(200)}`;
    const tree = {
      sha: "x",
      truncated: false,
      tree: [{ path: "docs/mb.md", type: "blob", size: 100 }], // underreported, char-like
    };
    // The trimmed chunk is 628 bytes > the 500 cap, so the candidate cannot
    // fit under the final representation: the adapter must stop honestly and
    // report the typed outcome instead of returning an oversized source.
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ tree, raw: { "docs/mb.md": body } }),
        maxTotalBytes: 500,
      }),
    ).rejects.toMatchObject({ code: "github_no_docs" });
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
        fetchImpl: githubFetch({ repo: { default_branch: "main", private: false, visibility: "public" }, tree: 404 }),
      }),
    ).rejects.toMatchObject({ code: "github_ref_not_found" });
  });

  it("rejects private repositories at root URLs before tree or raw fetching", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    await expect(
      fetchGithubSource("https://github.com/acme/private-repo", {
        fetchImpl: githubFetch({ repo: { default_branch: "main", private: true, visibility: "private" }, log }),
      }),
    ).rejects.toMatchObject({
      code: "github_private_repo",
      message: expect.stringContaining("Private GitHub repositories are not supported"),
    });
    // Metadata was fetched, but tree and raw were NEVER requested.
    expect(log.urls).toEqual(["https://api.github.com/repos/acme/private-repo"]);
  });

  it("rejects private repositories at explicit /tree/ URLs before tree or raw fetching", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    await expect(
      fetchGithubSource("https://github.com/acme/private-repo/tree/v1/docs", {
        fetchImpl: githubFetch({ repo: { default_branch: "main", private: true, visibility: "private" }, log }),
      }),
    ).rejects.toMatchObject({
      code: "github_private_repo",
      message: expect.stringContaining("Private GitHub repositories are not supported"),
    });
    expect(log.urls).toEqual(["https://api.github.com/repos/acme/private-repo"]);
  });

  it("rejects private repositories when a token is provided without leaking token or fetching tree", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    await expect(
      fetchGithubSource("https://github.com/acme/private-repo", {
        fetchImpl: githubFetch({ repo: { default_branch: "main", private: true }, log }),
        token: "ghp_secret_token_123",
      }),
    ).rejects.toMatchObject({
      code: "github_private_repo",
    });
    expect(log.urls).toEqual(["https://api.github.com/repos/acme/private-repo"]);
    expect(log.apiHeaders.authorization).toBe("Bearer ghp_secret_token_123");
  });

  it("fails closed when repository metadata omits private status", async () => {
    const log: FetchLog = { urls: [], apiHeaders: {}, rawHeaders: {} };
    await expect(
      fetchGithubSource("https://github.com/acme/unconfirmed-repo", {
        fetchImpl: githubFetch({ repo: { default_branch: "main" }, log }),
      }),
    ).rejects.toMatchObject({
      code: "github_fetch_failed",
      message: expect.stringContaining("did not confirm public status"),
    });
    expect(log.urls).toEqual(["https://api.github.com/repos/acme/unconfirmed-repo"]);
  });

  it("rejects repositories where visibility is non-public", async () => {
    await expect(
      fetchGithubSource("https://github.com/acme/internal-repo", {
        fetchImpl: githubFetch({ repo: { default_branch: "main", private: false, visibility: "internal" } }),
      }),
    ).rejects.toMatchObject({
      code: "github_private_repo",
    });
  });

  it("maps GitHub rate-limit responses with valid reset to typed error and formatted UTC message", async () => {
    // 1735689600 = 2025-01-01T00:00:00Z -> 00:00 UTC
    const limited = new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1735689600" },
    });
    try {
      await fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ firstResponse: limited }),
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GithubSourceError;
      expect(e.code).toBe("github_rate_limited");
      expect(e.message).toContain("Try again after 00:00 UTC");
      expect(e.message).toContain("optional GitHub token for higher public-repository limits");
      expect(e.message).not.toContain("api.github.com");
    }
  });

  it("maps GitHub rate-limit responses with missing reset to fallback message", async () => {
    const limited = new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    try {
      await fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ firstResponse: limited }),
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GithubSourceError;
      expect(e.code).toBe("github_rate_limited");
      expect(e.message).toContain("Try again later or configure an optional GitHub token for higher public-repository limits.");
      expect(e.message).not.toContain("Invalid Date");
    }
  });

  it("handles malformed/invalid reset headers gracefully without throwing Invalid Date", async () => {
    const limited = new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "not-a-number" },
    });
    try {
      await fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: githubFetch({ firstResponse: limited }),
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GithubSourceError;
      expect(e.code).toBe("github_rate_limited");
      expect(e.message).toContain("Try again later");
      expect(e.message).not.toContain("Invalid Date");
    }
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

  it("never claims private-repository access in errors (public-only policy)", async () => {
    // 404 on the repository metadata call is how private repos appear; the
    // error must state the public-only policy, not suggest a token enables them.
    try {
      await fetchGithubSource("https://github.com/acme/private-widgets", {
        fetchImpl: githubFetch({ repo: 404 }),
      });
      expect.fail("expected github_not_found");
    } catch (err) {
      const e = err as GithubSourceError;
      expect(e.code).toBe("github_not_found");
      expect(e.message).toContain("public repositories only");
      expect(e.message.toLowerCase()).not.toMatch(/token with access|need a.*token/);
    }
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

  it("bounds total ingestion latency with a typed deadline error", async () => {
    // Raw fetches hang until aborted (modeling a stalled CDN route); the
    // overall budget must abort them and surface a typed error quickly.
    const hangingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        return new Response(
          JSON.stringify(
            url.includes("/git/trees/")
              ? {
                  sha: "x",
                  truncated: false,
                  tree: [
                    { path: "README.md", type: "blob", size: README.length },
                    { path: "docs/guide.md", type: "blob", size: GUIDE.length },
                  ],
                }
              : { default_branch: "main", private: false, visibility: "public" },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: hangingFetch,
        overallTimeoutMs: 250,
      }),
    ).rejects.toMatchObject({ code: "github_deadline_exceeded" });
    // The deadline, not the per-request timeout, ended the run.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("maps a stalled raw response body to the typed deadline error", async () => {
    // Headers return immediately; res.text() hangs until the deadline fires.
    const stallBody = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        return new Response(
          JSON.stringify(
            url.includes("/git/trees/")
              ? { sha: "x", truncated: false, tree: [{ path: "README.md", type: "blob", size: README.length }] }
              : { default_branch: "main", private: false, visibility: "public" },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const res = new Response("never delivered", { status: 200, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: String(url) });
      // Stall the body stream itself (production reads res.body, not
      // res.text()): the stream never enqueues and never ends; the abort
      // signal raced into the reader rejects the read at the deadline.
      Object.defineProperty(res, "body", {
        value: new ReadableStream<Uint8Array>({ start() {} }),
      });
      return res;
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: stallBody,
        overallTimeoutMs: 250,
      }),
    ).rejects.toMatchObject({ code: "github_deadline_exceeded" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("maps a stalled API JSON body to the typed deadline error", async () => {
    // The default-branch request returns headers at once but json() stalls
    // until the overall deadline aborts it (same mechanism as the raw case).
    const stallJson = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ sha: "x", truncated: false, tree: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const res = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(res, "url", { value: String(url) });
      // Stall the body stream itself (production reads res.body, not
      // res.json()): the stream never enqueues and never ends; the abort
      // signal raced into the reader rejects the read at the deadline.
      Object.defineProperty(res, "body", {
        value: new ReadableStream<Uint8Array>({ start() {} }),
      });
      return res;
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", {
        fetchImpl: stallJson,
        overallTimeoutMs: 250,
      }),
    ).rejects.toMatchObject({ code: "github_deadline_exceeded" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("completes normally when the overall budget is sufficient (ordering unchanged)", async () => {
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: githubFetch({ tree: stdTree(), raw: stdRaw() }),
      overallTimeoutMs: 5000,
    });
    expect(result.files.map((f) => f.path)).toEqual(["README.md", "docs/guide.md", "CONTRIBUTING.md"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SKILLFORGE_GITHUB_TOKEN;
  });

  it("keeps the default file bound aligned with the documented constant", () => {
    expect(MAX_GITHUB_FILES).toBe(40);
  });
});
