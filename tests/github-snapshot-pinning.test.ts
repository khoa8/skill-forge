/**
 * GitHub immutable snapshot pinning (F-01) — one ingestion run, one revision.
 *
 * The requested ref (branch/tag/explicit SHA) is resolved ONCE via the
 * commits API; the recursive tree and every raw file read must then use the
 * pinned commit SHA. These tests simulate a branch advancing mid-ingestion
 * and prove tree metadata and file contents cannot mix revisions.
 *
 * All tests use injected fetch — no live GitHub traffic.
 */
import { describe, expect, it } from "vitest";
import {
  fetchGithubSource,
  GithubSourceError,
} from "../src/core/sources/github.js";
import {
  fetchGithubCodebaseSource,
  GithubCodebaseError,
} from "../src/core/sources/github-codebase.js";
import { manifestRepositoryBlock } from "../src/core/build.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill } from "../src/core/build.js";
import { PlanSchema } from "../src/core/plan.js";
import { validatePackage } from "../src/core/validate.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function raw(content: string, url: string, status = 200): Response {
  const res = new Response(content, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

// ---------------------------------------------------------------------------
// Documentation-mode harness with an explicitly mutable branch
// ---------------------------------------------------------------------------

const README_A = "# Guide\n\nRevision A setup instructions for the widget service.";
const README_B = "# Guide\n\nRevision B setup instructions with different steps.";

interface MutableDocsHarness {
  fetchImpl: typeof fetch;
  urls: string[];
  /** Advance the mutable branch tip from A to B (simulates a push mid-run). */
  flipToB: () => void;
}

/** Branch `main` points at A until flipped; SHA-pinned URLs always serve A. */
function mutableDocsHarness(): MutableDocsHarness {
  const urls: string[] = [];
  let tip = SHA_A;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    void init;
    if (url.includes("/commits/")) {
      // Resolution observes the tip, then the branch advances (race window).
      const seen = tip;
      tip = SHA_B;
      return json({ sha: seen });
    }
    if (url.includes("/git/trees/")) {
      const tree = url.includes(SHA_A)
        ? [{ path: "README.md", type: "blob", size: README_A.length }]
        : [{ path: "README.md", type: "blob", size: README_B.length }];
      return json({ sha: "t", truncated: false, tree });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const seg = url.split("/")[5]!;
      return raw(seg === SHA_A ? README_A : README_B, url);
    }
    return json({ default_branch: "main", private: false, visibility: "public" });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, flipToB: () => { tip = SHA_B; } };
}

describe("documentation mode snapshot pinning", () => {
  it("pins tree and raw reads to one commit when the branch advances mid-run", async () => {
    const h = mutableDocsHarness();
    const result = await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl: h.fetchImpl,
    });
    // Requested ref is preserved for display; the inspected revision is exact.
    expect(result.repo.ref).toBe("main");
    expect(result.repo.defaultBranchUsed).toBe(true);
    expect(result.repo.commitSha).toBe(SHA_A);
    // Content comes from the pinned revision, not the moved branch tip.
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(result.input.content).toContain("Revision A");
    expect(result.input.content).not.toContain("Revision B");
    // Every revision-sensitive URL uses the pinned SHA — the mutable branch
    // name appears only in the single resolution request.
    const sensitive = h.urls.filter(
      (u) => u.includes("/git/trees/") || u.startsWith("https://raw.githubusercontent.com/"),
    );
    expect(sensitive.length).toBeGreaterThan(0);
    for (const u of sensitive) expect(u).toContain(SHA_A);
    expect(sensitive.some((u) => u.includes("/main/") || u.includes("/trees/main"))).toBe(false);
    // Human-readable provenance names both concepts.
    expect(result.notes.some((n) => n.includes(SHA_A) && n.includes("@main"))).toBe(true);
  });

  it("pins explicit /tree/<branch>/<path> URLs while keeping the scope", async () => {
    const h = mutableDocsHarness();
    const result = await fetchGithubSource("https://github.com/acme/widgets/tree/main/docs", {
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        h.urls.push(url);
        if (url.includes("/commits/")) return json({ sha: SHA_A });
        if (url.includes("/git/trees/")) {
          expect(url).toContain(SHA_A);
          return json({
            sha: "t",
            truncated: false,
            tree: [
              { path: "README.md", type: "blob", size: 10 },
              { path: "docs/guide.md", type: "blob", size: README_A.length },
            ],
          });
        }
        if (url.startsWith("https://raw.githubusercontent.com/")) {
          expect(url).toContain(SHA_A);
          return raw(README_A, url);
        }
        return json({ default_branch: "main", private: false, visibility: "public" });
      }) as unknown as typeof fetch,
    });
    expect(result.repo.ref).toBe("main");
    expect(result.repo.commitSha).toBe(SHA_A);
    expect(result.files.map((f) => f.path)).toEqual(["docs/guide.md"]);
  });

  it("treats an explicit commit SHA as the pinned revision", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/commits/")) return json({ sha: SHA_A });
      if (url.includes("/git/trees/")) {
        return json({ sha: "t", truncated: false, tree: [{ path: "docs/guide.md", type: "blob", size: README_A.length }] });
      }
      if (url.startsWith("https://raw.githubusercontent.com/")) return raw(README_A, url);
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    const result = await fetchGithubSource(`https://github.com/acme/widgets/tree/${SHA_A}/docs`, {
      fetchImpl,
    });
    // The first tree path segment is the ref; an explicit SHA round-trips.
    expect(result.repo.ref).toBe(SHA_A);
    expect(result.repo.commitSha).toBe(SHA_A);
    expect(result.files.map((f) => f.path)).toEqual(["docs/guide.md"]);
    expect(urls.some((u) => u.includes(`/git/trees/${SHA_A}?`))).toBe(true);
    expect(urls.some((u) => u.startsWith(`https://raw.githubusercontent.com/acme/widgets/${SHA_A}/`))).toBe(true);
  });

  it("maps a missing ref on the resolution request to ref-not-found", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/")) return json({ message: "Not Found" }, 404);
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    await expect(
      fetchGithubSource("https://github.com/acme/widgets/tree/nope/docs", { fetchImpl }),
    ).rejects.toMatchObject({ code: "github_ref_not_found" });
  });

  it("rejects private repositories before ref resolution (no /commits/ request)", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return json({ default_branch: "main", private: true, visibility: "private" });
    }) as unknown as typeof fetch;
    await expect(
      fetchGithubSource("https://github.com/acme/secret", { fetchImpl }),
    ).rejects.toMatchObject({ code: "github_private_repo" });
    expect(urls).toEqual(["https://api.github.com/repos/acme/secret"]);
  });

  it("fails closed when the resolution response carries no valid commit SHA", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/")) return json({ sha: "not-a-sha" });
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", { fetchImpl }),
    ).rejects.toMatchObject({ code: "github_fetch_failed" });
  });

  it("maps rate limiting on the resolution request to the typed error", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/")) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", { fetchImpl }),
    ).rejects.toMatchObject({ code: "github_rate_limited" });
  });

  it("keeps the token off raw content hosts with pinned URLs", async () => {
    const apiHeaders: Record<string, string> = {};
    const rawHeaders: Record<string, string> = {};
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.startsWith("https://api.github.com/")) Object.assign(apiHeaders, headers);
      if (url.startsWith("https://raw.githubusercontent.com/")) Object.assign(rawHeaders, headers);
      if (url.includes("/commits/")) return json({ sha: SHA_A });
      if (url.includes("/git/trees/")) {
        return json({ sha: "t", truncated: false, tree: [{ path: "README.md", type: "blob", size: README_A.length }] });
      }
      if (url.startsWith("https://raw.githubusercontent.com/")) return raw(README_A, url);
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    await fetchGithubSource("https://github.com/acme/widgets", {
      fetchImpl,
      token: "ghp_test_token",
    });
    expect(apiHeaders.authorization).toBe("Bearer ghp_test_token");
    expect(rawHeaders.authorization).toBeUndefined();
  });

  it("aborts the resolution request under the overall deadline", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/commits/")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        });
      }
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(
      fetchGithubSource("https://github.com/acme/widgets", { fetchImpl, overallTimeoutMs: 250 }),
    ).rejects.toMatchObject({ code: "github_deadline_exceeded" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Codebase-mode harness with an explicitly mutable branch
// ---------------------------------------------------------------------------

const INDEX_A = "import { Service } from './core/service.js';\nexport function main(): void { new Service(); }\n";
const INDEX_B = "import { Other } from './core/other.js';\nexport function main(): void { new Other(); }\n";
const PKG_A = JSON.stringify({ name: "fixture", scripts: { test: "vitest run" } }, null, 2);

function mutableCodebaseHarness() {
  const urls: string[] = [];
  let tip = SHA_A;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/commits/")) {
      const seen = tip;
      tip = SHA_B; // the branch advances immediately after resolution
      return json({ sha: seen });
    }
    if (url.includes("/git/trees/")) {
      // A stale mutable-ref tree read would observe B (with a B-only file).
      const tree = url.includes(SHA_A)
        ? [
            { path: "package.json", type: "blob", size: PKG_A.length },
            { path: "src/index.ts", type: "blob", size: INDEX_A.length },
          ]
        : [
            { path: "package.json", type: "blob", size: PKG_A.length },
            { path: "src/index.ts", type: "blob", size: INDEX_B.length },
            { path: "src/b-only.ts", type: "blob", size: 50 },
          ];
      return json({ sha: "t", truncated: false, tree });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const seg = url.split("/")[5]!;
      const path = decodeURIComponent(url.split("/").slice(6).join("/"));
      if (path === "package.json") return raw(PKG_A, url);
      return raw(seg === SHA_A ? INDEX_A : INDEX_B, url);
    }
    return json({ default_branch: "main", private: false, visibility: "public" });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("codebase mode snapshot pinning", () => {
  it("keeps tree reconnaissance and fetched files on one commit when the branch moves", async () => {
    const h = mutableCodebaseHarness();
    const result = await fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
      fetchImpl: h.fetchImpl,
    });
    expect(result.repo.ref).toBe("main");
    expect(result.repo.commitSha).toBe(SHA_A);
    // No B-only tree candidate leaked into selection/inspection …
    expect(result.files.some((f) => f.path === "src/b-only.ts")).toBe(false);
    expect(result.analysis.inspectedFiles).not.toContain("src/b-only.ts");
    // … and fetched content is the pinned revision.
    const index = result.files.find((f) => f.path === "src/index.ts")!;
    expect(index.content).toContain("core/service.js");
    expect(index.content).not.toContain("core/other.js");
    // Every revision-sensitive URL uses the pinned SHA.
    const sensitive = h.urls.filter(
      (u) => u.includes("/git/trees/") || u.startsWith("https://raw.githubusercontent.com/"),
    );
    expect(sensitive.length).toBeGreaterThan(0);
    for (const u of sensitive) expect(u).toContain(SHA_A);
    // Structured provenance records both concepts distinctly.
    expect(result.analysis.repository.ref).toBe("main");
    expect(result.analysis.repository.commitSha).toBe(SHA_A);
    expect(result.notes.some((n) => n.includes(SHA_A) && n.includes("@main"))).toBe(true);
  });

  it("keeps /tree/<ref>/<path> scope pinned to the same commit", async () => {
    const h = mutableCodebaseHarness();
    const result = await fetchGithubCodebaseSource("https://github.com/acme/fixture-service/tree/main/src", {
      fetchImpl: h.fetchImpl,
    });
    expect(result.repo.ref).toBe("main");
    expect(result.repo.commitSha).toBe(SHA_A);
    expect(result.analysis.repository.scope).toBe("src");
    expect(result.analysis.repository.commitSha).toBe(SHA_A);
    expect(result.analysis.inspectedFiles.every((p) => p === "src" || p.startsWith("src/"))).toBe(true);
  });

  it("embeds the pinned commit in the manifest block and still validates", async () => {
    const h = mutableCodebaseHarness();
    const result = await fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
      fetchImpl: h.fetchImpl,
    });
    const block = manifestRepositoryBlock(result.analysis);
    expect(block.ref).toBe("main");
    expect(block.commitSha).toBe(SHA_A);
    // Full build → manifest → deterministic validation passes with provenance.
    const normalized = normalizeSource({
      type: "github-codebase",
      name: "acme/fixture-service codebase",
      content: result.input.content,
      notes: result.notes,
      repository: result.analysis,
    });
    const skill = buildCanonicalSkill(normalized, analyzeSource(normalized), PlanSchema.parse({ name: "fixture" }), "mock");
    const report = validatePackage({ skill, sourceText: normalized.text, sourceType: "github-codebase" });
    expect(report.passed).toBe(true);
    const manifest = JSON.parse(skill.files.find((f) => f.path === "manifest.json")!.content) as {
      source: { repository: Record<string, unknown> };
    };
    expect(manifest.source.repository.commitSha).toBe(SHA_A);
    expect(manifest.source.repository.ref).toBe("main");
  });

  it("treats legacy records without a commit as valid (absence is not an error)", async () => {
    const h = mutableCodebaseHarness();
    const result = await fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
      fetchImpl: h.fetchImpl,
    });
    const { commitSha: _dropped, ...repositoryWithoutCommit } = result.analysis.repository;
    void _dropped;
    const normalized = normalizeSource({
      type: "github-codebase",
      name: "acme/fixture-service codebase",
      content: result.input.content,
      notes: result.notes,
      repository: { ...result.analysis, repository: repositoryWithoutCommit },
    });
    const skill = buildCanonicalSkill(normalized, analyzeSource(normalized), PlanSchema.parse({ name: "fixture" }), "mock");
    const report = validatePackage({ skill, sourceText: normalized.text, sourceType: "github-codebase" });
    expect(report.passed).toBe(true);
  });

  it("rejects a malformed commit identity in the manifest", async () => {
    const h = mutableCodebaseHarness();
    const result = await fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
      fetchImpl: h.fetchImpl,
    });
    const normalized = normalizeSource({
      type: "github-codebase",
      name: "acme/fixture-service codebase",
      content: result.input.content,
      notes: result.notes,
      repository: result.analysis,
    });
    const skill = buildCanonicalSkill(normalized, analyzeSource(normalized), PlanSchema.parse({ name: "fixture" }), "mock");
    const manifestFile = skill.files.find((f) => f.path === "manifest.json")!;
    const manifest = JSON.parse(manifestFile.content) as { source: { repository: Record<string, unknown> } };
    manifest.source.repository.commitSha = "not-a-sha";
    manifestFile.content = JSON.stringify(manifest, null, 2) + "\n";
    const report = validatePackage({ skill, sourceText: normalized.text, sourceType: "github-codebase" });
    expect(report.passed).toBe(false);
    expect(
      report.checks.some(
        (c) => c.id === "repository-provenance" && c.status === "fail" && c.message?.includes("commitSha"),
      ),
    ).toBe(true);
  });

  it("maps a missing ref on the resolution request to codebase_ref_not_found", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/")) return json({ message: "Not Found" }, 404);
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    await expect(
      fetchGithubCodebaseSource("https://github.com/acme/ghost/tree/nope/src", { fetchImpl }),
    ).rejects.toMatchObject({ code: "codebase_ref_not_found" });
  });

  it("rejects private repositories before ref resolution (no /commits/ request)", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return json({ default_branch: "main", private: true, visibility: "private" });
    }) as unknown as typeof fetch;
    await expect(
      fetchGithubCodebaseSource("https://github.com/acme/secret", { fetchImpl }),
    ).rejects.toMatchObject({ code: "codebase_private_repo" });
    expect(urls).toEqual(["https://api.github.com/repos/acme/secret"]);
  });

  it("keeps the token off raw content hosts with pinned URLs", async () => {
    const apiHeaders: Record<string, string> = {};
    const rawHeaders: Record<string, string> = {};
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.startsWith("https://api.github.com/")) Object.assign(apiHeaders, headers);
      if (url.startsWith("https://raw.githubusercontent.com/")) Object.assign(rawHeaders, headers);
      if (url.includes("/commits/")) return json({ sha: SHA_A });
      if (url.includes("/git/trees/")) {
        return json({
          sha: "t",
          truncated: false,
          tree: [
            { path: "package.json", type: "blob", size: PKG_A.length },
            { path: "src/index.ts", type: "blob", size: INDEX_A.length },
          ],
        });
      }
      if (url.startsWith("https://raw.githubusercontent.com/")) {
        const path = decodeURIComponent(url.split("/").slice(6).join("/"));
        return raw(path === "package.json" ? PKG_A : INDEX_A, url);
      }
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    const result = await fetchGithubCodebaseSource("https://github.com/acme/fixture-service", {
      fetchImpl,
      token: "ghp_test_token",
    });
    expect(result.repo.commitSha).toBe(SHA_A);
    expect(apiHeaders.authorization).toBe("Bearer ghp_test_token");
    expect(rawHeaders.authorization).toBeUndefined();
  });
});

describe("error identity is preserved", () => {
  it("GithubSourceError codes survive the added resolution step", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/")) return json({ sha: SHA_A });
      if (url.includes("/git/trees/")) return json({ message: "Not Found" }, 404);
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    try {
      await fetchGithubSource("https://github.com/acme/widgets/tree/main/docs", { fetchImpl });
      expect.fail("expected github_ref_not_found");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubSourceError);
      expect((err as GithubSourceError).code).toBe("github_ref_not_found");
    }
  });

  it("codebase errors keep the codebase_ prefix through resolution", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/commits/")) return json({ sha: SHA_A });
      if (url.includes("/git/trees/")) return json({ message: "Not Found" }, 404);
      return json({ default_branch: "main", private: false, visibility: "public" });
    }) as unknown as typeof fetch;
    try {
      await fetchGithubCodebaseSource("https://github.com/acme/ghost", { fetchImpl });
      expect.fail("expected codebase_ref_not_found");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubCodebaseError);
      expect((err as GithubCodebaseError).code).toBe("codebase_ref_not_found");
    }
  });
});
