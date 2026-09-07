import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from "vitest";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/server/app.js";

/** Source-note propagation: adapter notes (truncation, skipped files) must
 * reach the client stream, the persisted record, and never fail validation. */

function eventsOf(text: string) {
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function stubGithubFetch(o: { files: { path: string; type?: string; size?: number }[]; truncated?: boolean; raw?: Record<string, string> }) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/") && !url.includes("/git/trees/")) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/git/trees/")) {
      return new Response(
        JSON.stringify({ sha: "x", truncated: o.truncated ?? false, tree: o.files }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const path = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
      const body = o.raw?.[path] ?? "# Placeholder\n\nNot fetched in this test.";
      const res = new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("source notes reach the client and the store", () => {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces GitHub file-count truncation in stream + persisted notes", async () => {
    const files = Array.from({ length: 45 }, (_, i) => ({ path: `docs/page-${String(i).padStart(2, "0")}.md`, type: "blob", size: 40 }));
    const raw: Record<string, string> = {};
    for (let i = 0; i < 45; i++) raw[`docs/page-${String(i).padStart(2, "0")}.md`] = `# Page ${i}\n\nContent for page ${i} of the truncation fixture.`;
    vi.stubGlobal("fetch", stubGithubFetch({ files, raw }));

    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/truncated" })
      .expect(200);
    const events = eventsOf(res.text);
    const result = events.find((e) => e.type === "result");
    const notes: string[] = result.sourceNotes;

    // Streamed as individual source-note events (client-visible).
    const noteEvents = events.filter((e) => e.type === "source-note");
    expect(noteEvents.some((e) => e.note.includes("file limit"))).toBe(true);

    // Result event carries them; validation still passes (notes are not errors).
    expect(notes.some((n) => n.includes("file limit"))).toBe(true);
    expect(result.validation.passed).toBe(true);

    // Persisted with the skill and served after reload.
    const get = await request(app).get(`/api/skills/${result.skill.id}`).expect(200);
    expect(Array.isArray(get.body.source.notes)).toBe(true);
    expect(get.body.source.notes.some((n: string) => n.includes("file limit"))).toBe(true);
  }, 20000);

  it("surfaces GitHub tree truncation notes", async () => {
    vi.stubGlobal(
      "fetch",
      stubGithubFetch({
        files: [{ path: "README.md", type: "blob", size: 200 }],
        truncated: true,
        raw: { "README.md": "# Tiny Repo\n\nSmall but long enough for the minimum source length check to pass." },
      }),
    );
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "github", repo: "https://github.com/acme/huge" })
      .expect(200);
    const events = eventsOf(res.text);
    const result = events.find((e) => e.type === "result");
    expect(events.some((e) => e.type === "source-note" && e.note.includes("truncated"))).toBe(true);
    expect(result.sourceNotes.some((n: string) => n.includes("truncated"))).toBe(true);
    expect(result.validation.passed).toBe(true);
  }, 20000);

  it("surfaces local skipped-file notes", async () => {
    const prevRoot = process.env.SKILLFORGE_DOCS_ROOT;
    const sandbox = await mkdtemp(join(tmpdir(), "skillforge-notes-"));
    process.env.SKILLFORGE_DOCS_ROOT = sandbox;
    try {
      await writeFile(
        join(sandbox, "guide.md"),
        "# Local Guide\n\nLocal docs content long enough to satisfy the minimum source length check easily.",
      );
      await mkdir(join(sandbox, "docs", "nested"), { recursive: true });
      await writeFile(
        join(sandbox, "docs", "overview.md"),
        "# Overview\n\nDocs directory content long enough to satisfy the minimum source length check.",
      );
      await writeFile(
        join(sandbox, "docs", "nested", "inner.md"),
        "# Inner\n\nNested file that non-recursive ingestion must skip and report.",
      );

      // Single file: reports the read count.
      const res = await request(app).post("/api/generate").send({ sourceType: "file", path: "guide.md" }).expect(200);
      const result = eventsOf(res.text).find((e) => e.type === "result");
      expect(result.sourceNotes.some((n: string) => n.includes("Read 1 file(s)"))).toBe(true);
      expect(result.validation.passed).toBe(true);

      // Directory, non-recursive: the subdirectory skip must be surfaced.
      const res2 = await request(app).post("/api/generate").send({ sourceType: "file", path: "docs", recursive: false }).expect(200);
      const result2 = eventsOf(res2.text).find((e) => e.type === "result");
      expect(
        result2.sourceNotes.some((n: string) => n.startsWith("Skipped:") && n.includes("subdirectory")),
      ).toBe(true);
      // Persisted with the skill and served after reload.
      const get = await request(app).get(`/api/skills/${result2.skill.id}`).expect(200);
      expect(get.body.source.notes.some((n: string) => n.includes("subdirectory"))).toBe(true);
    } finally {
      if (prevRoot === undefined) delete process.env.SKILLFORGE_DOCS_ROOT;
      else process.env.SKILLFORGE_DOCS_ROOT = prevRoot;
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 20000);
});
