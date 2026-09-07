import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from "vitest";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import JSZip from "jszip";
import { createApp } from "../src/server/app.js";

/** P1 end-to-end: URL and file source types through the HTTP API, plus
 * persistence of generated skills across store restarts. */
describe("P1 sources via the API", () => {
  let app: ReturnType<typeof createApp>;
let cleanupStore: () => Promise<void>;
beforeAll(async () => {
  const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
  cleanupStore = cleanup;
  app = createApp({ provider: "mock", hasApiKey: false, }, { storeRoot });
});
afterAll(async () => {
  await cleanupStore?.();
});
  let sandbox: string;
  const prevRoot = process.env.SKILLFORGE_DOCS_ROOT;

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "skillforge-api-src-"));
    process.env.SKILLFORGE_DOCS_ROOT = sandbox;
    await writeFile(
      join(sandbox, "tool.md"),
      [
        "# ToolKit",
        "",
        "ToolKit processes widget configuration files and reports errors.",
        "",
        "## Setup",
        "",
        "```bash",
        "npm install toolkit-cli",
        "```",
        "",
        "## Validate",
        "",
        "1. Run `toolkit check config.yaml`.",
        "2. Fix every reported error.",
        "3. Re-run the check until it exits zero.",
        "",
        "Warning: never validate configs against production credentials.",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    if (prevRoot === undefined) delete process.env.SKILLFORGE_DOCS_ROOT;
    else process.env.SKILLFORGE_DOCS_ROOT = prevRoot;
    await rm(sandbox, { recursive: true, force: true });
  });

  function eventsOf(text: string) {
    return text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  it("generates from a workspace file path", async () => {
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "file", path: "tool.md" })
      .expect(200);
    const events = eventsOf(res.text);
    const result = events.find((e) => e.type === "result");
    expect(result.skill.meta.name).toBe("toolkit");
    expect(result.validation.passed).toBe(true);
    expect(events.filter((e) => e.type === "stage" && e.status === "done")).toHaveLength(4);
  });

  it("returns 400 with code for missing/invalid file paths", async () => {
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "file", path: "does-not-exist.md" })
      .expect(400);
    const body = res.body as { code?: string; error?: string };
    expect(body.code).toBe("file_not_found");
    expect(body.error).toContain("allowed root");
  });

  it("returns 400 for url without url field", async () => {
    await request(app).post("/api/generate").send({ sourceType: "url" }).expect(400);
  });

  it("blocks private URLs before any fetch (SSRF via API)", async () => {
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "url", url: "http://127.0.0.1:9/x" })
      .expect(502);
    expect(res.body.code).toBe("url_private_host");
  });

  it("surfaces file-outside-root as 403 (existing outside path)", async () => {
    // Use a path that exists outside the sandbox root so the containment
    // check (not missing-file) refuses it. Node's install dir qualifies.
    const outsidePath = process.execPath; // exists, outside SKILLFORGE_DOCS_ROOT
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "file", path: outsidePath })
      .expect((r) => {
        if (r.status !== 403 && r.status !== 400) throw new Error(`unexpected ${r.status}`);
      });
    expect([403, 400]).toContain(res.status);
    expect(res.body.error).toContain("allowed root");
  });

  it("persists generated skills and re-serves them (restart-safe shape)", async () => {
    // Generate two skills with the same source name to exercise id reuse/overwrite.
    for (const run of [1, 2]) {
      const res = await request(app)
        .post("/api/generate")
        .send({ sourceType: "file", path: "tool.md", name: run === 1 ? "tool.md" : "tool-renamed.md" })
        .expect(200);
      const result = eventsOf(res.text).find((e) => e.type === "result");
      const get = await request(app).get(`/api/skills/${result.skill.id}`).expect(200);
      expect(get.body.source.text).toContain("ToolKit");
      expect(get.body.analysis.sectionCount).toBeGreaterThan(0);
    }
    const list = await request(app).get("/api/skills").expect(200);
    expect(list.body.skills.some((s: { id: string }) => s.id === "toolkit")).toBe(true);
  });

  it("exports a persisted skill to ZIP after storage round-trip", async () => {
    const res = await request(app)
      .post("/api/skills/toolkit/export")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .send({ target: "generic" })
      .expect(200);
    const zip = await JSZip.loadAsync(res.body);
    const names = Object.keys(zip.files).filter((n) => !n.endsWith("/"));
    expect(names).toContain("toolkit/AGENTS.md");
    const skillMd = await zip.files["toolkit/SKILL.md"]!.async("string");
    expect(skillMd).toContain("name: toolkit");
  });
});
