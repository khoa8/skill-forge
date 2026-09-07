import { describe, expect, it, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/app.js";

/** API integration for sourceType=github. The global fetch is stubbed so no
 * test depends on live GitHub availability (same injection approach as the
 * URL/provider tests, applied at the process level). */

const README = "# RepoGuide\n\nRepoGuide turns repository docs into widget bundles. Setup and validation are covered below.";
const GUIDE = [
  "# Setup",
  "",
  "```bash",
  "npm install repoguide",
  "```",
  "",
  "## Verify",
  "",
  "1. Run `repoguide check bundle.yaml`.",
  "2. Fix every reported error.",
  "3. Re-run until the exit code is zero.",
  "",
  "Warning: never point checks at production systems.",
].join("\n");

function stubFetch(options: {
  repo?: Record<string, unknown> | number;
  tree?: Record<string, unknown> | number;
  raw?: Record<string, string>;
}) {
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/") && !url.includes("/git/trees/")) {
      const status = typeof options.repo === "number" ? options.repo : 200;
      const body =
        typeof options.repo === "number" ? { message: "Not Found" } : (options.repo ?? { default_branch: "main" });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/git/trees/")) {
      const status = typeof options.tree === "number" ? options.tree : 200;
      const body =
        typeof options.tree === "number"
          ? { message: "Not Found" }
          : (options.tree ?? {
              sha: "x",
              truncated: false,
              tree: [
                { path: "README.md", type: "blob", size: README.length },
                { path: "docs/guide.md", type: "blob", size: GUIDE.length },
              ],
            });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const path = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
      const body = options.raw?.[path] ?? "not found";
      const status = options.raw?.[path] !== undefined ? 200 : 404;
      const res = new Response(body, { status, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", impl);
}

function eventsOf(text: string) {
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("GitHub source via the API", () => {
  const app = createApp({ provider: "mock", hasApiKey: false });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when repo is missing", async () => {
    await request(app).post("/api/generate").send({ sourceType: "github" }).expect(400);
  });

  it("returns 400 with a typed code for malformed repository URLs", async () => {
    stubFetch({});
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://gitlab.com/acme/widgets" })
      .expect(400);
    expect(res.body.code).toBe("github_unsupported_host");
  });

  it("generates a validated package from a stubbed repository", async () => {
    stubFetch({ raw: { "README.md": README, "docs/guide.md": GUIDE } });
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/widgets" })
      .expect(200);
    const events = eventsOf(res.text);
    const result = events.find((e) => e.type === "result");
    expect(result.validation.passed).toBe(true);
    expect(result.skill.files.length).toBeGreaterThan(0);
    // The source name reflects the repository.
    expect(String(result.skill.meta.displayName).length).toBeGreaterThan(0);

    // The stored skill records the github source type and combined text.
    const get = await request(app).get(`/api/skills/${result.skill.id}`).expect(200);
    expect(get.body.source.type).toBe("github");
    expect(get.body.source.text).toContain("npm install repoguide");
    expect(get.body.source.name).toContain("acme/widgets");
  });

  it("maps repository-not-found to 404 with the typed code", async () => {
    stubFetch({ repo: 404 });
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/ghost" })
      .expect(404);
    expect(res.body.code).toBe("github_not_found");
  });

  it("maps rate limiting to 429 with the typed code", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
        })) as unknown as typeof fetch,
    );
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/widgets" })
      .expect(429);
    expect(res.body.code).toBe("github_rate_limited");
  });

  it("maps missing documentation to 422 with the typed code", async () => {
    stubFetch({ tree: { sha: "x", truncated: false, tree: [{ path: "src/index.ts", type: "blob", size: 1000 }] } });
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/code-only" })
      .expect(422);
    expect(res.body.code).toBe("github_no_docs");
    expect(res.body.error).toContain("Repository source code is not ingested");
  });

  it("keeps other source types working after the enum extension", async () => {
    const res = await request(app)
      .post("/api/generate")
      .send({
        sourceType: "text",
        content: `${README}\n\n## Steps\n\n1. Run the checker.\n2. Fix findings.\n3. Re-run to confirm.`,
      })
      .expect(200);
    const result = eventsOf(res.text).find((e) => e.type === "result");
    expect(result.validation.passed).toBe(true);
  });
});
