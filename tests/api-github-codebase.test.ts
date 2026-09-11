/**
 * API integration for sourceType=github + mode=codebase. Global fetch is
 * stubbed (same approach as the docs-mode API tests); no live GitHub traffic.
 * Covers: mode dispatch, backwards compatibility of docs mode, validation of
 * malformed mode values, repository provenance persistence, and export.
 */
import { describe, it, beforeAll, afterAll, afterEach, expect, vi } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { createApp } from "../src/server/app.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

const PKG = JSON.stringify(
  {
    name: "widget-service",
    main: "src/index.ts",
    scripts: { dev: "tsx watch src/server.ts", build: "tsc -p tsconfig.json", test: "vitest run", typecheck: "tsc --noEmit" },
    dependencies: { fastify: "^4" },
    devDependencies: { typescript: "^5", vitest: "^1" },
  },
  null,
  2,
);
const AGENTS = "# AGENTS.md\n\n- Never commit secrets to the repository.\n- Always run `npm test` before pushing.\n";
const README = "# widget-service\n\nA fixture TypeScript service.\n\n## Setup\n\n1. Run `npm install`.\n2. Run `npm run dev`.\n3. Verify with `npm test`.\n";
const INDEX = "import { Service } from './core/service.js';\nexport function main(): void { new Service(); }\n";
const TEST = 'import { describe, expect, it } from "vitest";\ndescribe("s", () => { it("works", () => expect(1).toBe(1)); });\n';
const CI = "name: ci\non: push\njobs:\n  b:\n    steps:\n      - run: npm ci\n      - run: npm test\n";

function stubCodebaseFetch(o: { repo?: number; tree?: Record<string, unknown> | number } = {}) {
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/") && !url.includes("/git/trees/")) {
      const status = typeof o.repo === "number" ? o.repo : 200;
      const body = typeof o.repo === "number" ? { message: "Not Found" } : { default_branch: "main" };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/git/trees/")) {
      const status = typeof o.tree === "number" ? o.tree : 200;
      const body =
        typeof o.tree === "number"
          ? { message: "Not Found" }
          : (o.tree ?? {
              sha: "x",
              truncated: false,
              tree: [
                { path: "README.md", type: "blob", size: README.length },
                { path: "AGENTS.md", type: "blob", size: AGENTS.length },
                { path: "package.json", type: "blob", size: PKG.length },
                { path: "package-lock.json", type: "blob", size: 400_000 },
                { path: "src/index.ts", type: "blob", size: INDEX.length },
                { path: "tests/service.test.ts", type: "blob", size: TEST.length },
                { path: ".github/workflows/ci.yml", type: "blob", size: CI.length },
                { path: "vendor-lib", type: "commit", size: 0 },
              ],
            });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const path = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
      const bodies: Record<string, string> = {
        "README.md": README,
        "AGENTS.md": AGENTS,
        "package.json": PKG,
        "src/index.ts": INDEX,
        "tests/service.test.ts": TEST,
        ".github/workflows/ci.yml": CI,
      };
      const body = bodies[path] ?? "not found";
      const status = bodies[path] !== undefined ? 200 : 404;
      const res = new Response(body, { status, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", impl);
}

function eventsOf(text: string) {
  return text.trim().split("\n").map((l) => JSON.parse(l));
}

describe("GitHub codebase source via the API", () => {
  let app: ReturnType<typeof createApp>;
  let cleanupStore: () => Promise<void>;
  beforeAll(async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    cleanupStore = cleanup;
    app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
  });
  afterAll(async () => {
    await cleanupStore?.();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates a codebase-oriented, validated package (mode: codebase)", async () => {
    stubCodebaseFetch();
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/widget-service", mode: "codebase" })
      .expect(200);
    const events = eventsOf(res.text);
    const result = events.find((e) => e.type === "result") as {
      skill: { id: string; files: { path: string; content: string }[] };
      validation: { passed: boolean };
    };
    expect(result.validation.passed).toBe(true);

    // Codebase-oriented SKILL.md, not a generic docs summary.
    const skillMd = result.skill.files.find((f) => f.path === "SKILL.md")!.content;
    expect(skillMd).toContain("acme/widget-service");
    expect(skillMd).toContain("Inspect `package.json`, CI workflows, and repository configuration");
    expect(skillMd).toContain("vitest");

    // Source notes stream as events (bounded-selection honesty).
    const notes = events.filter((e) => e.type === "source-note").map((e) => (e as { note: string }).note);
    expect(notes.join(" ")).toContain("Inspected all 6 eligible file(s)");
    // Submodule refusal also streams as a note.
    expect(notes.join(" ")).toContain("submodule");

    // Persisted record keeps the codebase mode + repository provenance.
    const get = await request(app).get(`/api/skills/${result.skill.id}`).expect(200);
    expect(get.body.source.type).toBe("github-codebase");
    const repo = get.body.source.repository as {
      mode: string;
      repository: { owner: string; name: string };
      inspectedFiles: string[];
      commands: { purpose: string; command: string }[];
      conventions: { statement: string }[];
    };
    expect(repo.mode).toBe("codebase");
    expect(repo.repository.owner).toBe("acme");
    expect(repo.inspectedFiles).toContain("package.json");
    expect(repo.inspectedFiles).not.toContain("package-lock.json");
    expect(repo.commands.find((c) => c.purpose === "test")).toBeTruthy();
    expect(repo.conventions.some((c) => c.statement.includes("Never commit secrets"))).toBe(true);
    return { skillId: result.skill.id as string, events };
  });

  it("keeps documentation mode working (default and explicit)", async () => {
    stubCodebaseFetch();
    for (const body of [
      { sourceType: "github", repo: "https://github.com/acme/widget-service" },
      { sourceType: "github", repo: "https://github.com/acme/widget-service", mode: "docs" },
    ]) {
      const res = await request(app).post("/api/generate").send(body).expect(200);
      const result = eventsOf(res.text).find((e) => e.type === "result");
      const get = await request(app).get(`/api/skills/${result.skill.id}`).expect(200);
      expect(get.body.source.type).toBe("github");
      expect(get.body.source.repository).toBeUndefined();
    }
  });

  it("rejects invalid mode values with a clean 400", async () => {
    stubCodebaseFetch();
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/widget-service", mode: "stealth" })
      .expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects mode on non-github source types", async () => {
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", content: "# Doc\n\nLong enough documentation content for the mode rejection test.", mode: "codebase" })
      .expect(400);
    expect(res.body.error).toContain("only supported for sourceType 'github'");
  });

  it("maps codebase failures to typed statuses", async () => {
    stubCodebaseFetch({ repo: 404 });
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/ghost", mode: "codebase" })
      .expect(404);
    expect(res.body.code).toBe("codebase_not_found");
  });

  it("blocks nothing at export: the codebase skill exports a real ZIP", async () => {
    stubCodebaseFetch();
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/widget-service", mode: "codebase" })
      .expect(200);
    const result = eventsOf(res.text).find((e) => e.type === "result");
    const binaryParser = (res2: unknown, cb: (err: Error | null, body?: unknown) => void) => {
      const chunks: Buffer[] = [];
      (res2 as { on: (ev: string, fn: (c: Buffer) => void) => void }).on("data", (c) => chunks.push(c));
      (res2 as { on: (ev: string, fn: () => void) => void }).on("end", () => cb(null, Buffer.concat(chunks)));
    };
    const exportRes = await request(app)
      .post(`/api/skills/${result.skill.id}/export`)
      .buffer(true)
      .parse(binaryParser)
      .send({ target: "claude-code" })
      .expect(200);
    expect(exportRes.headers["content-type"]).toBe("application/zip");
    const zip = await JSZip.loadAsync(exportRes.body);
    const names = Object.keys(zip.files).filter((n) => !n.endsWith("/"));
    expect(names.some((n) => n.endsWith("/SKILL.md"))).toBe(true);
    const manifestEntry = Object.values(zip.files).find((f) => f.name.endsWith("/manifest.json"))!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    expect(manifest.source.repository).toMatchObject({
      owner: "acme",
      name: "widget-service",
      mode: "codebase",
    });
  });
});
