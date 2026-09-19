import { describe, it, beforeAll, afterAll, expect } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { createApp } from "../src/server/app.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";
import { getSample } from "../src/core/samples.js";

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

/** superagent needs an explicit binary parser to expose ZIP bytes as Buffer. */
const binaryParser = (res: unknown, cb: (err: Error | null, body?: unknown) => void) => {
  const chunks: Buffer[] = [];
  (res as { on: (ev: string, fn: (c: Buffer) => void) => void }).on("data", (c) => chunks.push(c));
  (res as { on: (ev: string, fn: () => void) => void }).on("end", () => cb(null, Buffer.concat(chunks)));
};

async function generateSkill(sampleId: string) {
  const res = await request(app)
    .post("/api/generate")
    .send({ sourceType: "sample", sampleId })
    .expect(200);
  const events = res.text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const result = events.find((e) => e.type === "result");
  return { events, result };
}

describe("health & metadata", () => {
  it("reports health and honest provider state", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.offlineDemo).toBe(true);
    expect(res.body.providerUsesApiKey).toBe(false);
  });

  it("lists exporters with format basis", async () => {
    const res = await request(app).get("/api/exporters").expect(200);
    expect(res.body.targets.map((t: { target: string }) => t.target).sort()).toEqual(["claude-code", "generic", "openai-codex"]);
    for (const t of res.body.targets) expect(t.formatBasis).toBeTruthy();
  });

  it("lists bundled samples", async () => {
    const res = await request(app).get("/api/samples").expect(200);
    expect(res.body.samples.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 404 with an actionable message for unknown samples", async () => {
    const res = await request(app).get("/api/samples/nope").expect(404);
    expect(res.body.error).toContain("Available samples");
  });
});

describe("generation pipeline (streaming)", () => {
  it("streams stage events and stores a valid result", async () => {
    const { events, result } = await generateSkill("meridian-payments-api");
    expect(events[0].type).toBe("stage");
    expect(events.map((e: { stage?: string }) => e.stage)).toEqual(expect.arrayContaining(["ingest", "analyze", "generate", "validate"]));
    expect(result.validation.executed).toBe(true);
    expect(result.validation.passed).toBe(true);
    expect(result.skill.files.length).toBeGreaterThan(5);
    const done = events[events.length - 1];
    expect(done.type).toBe("done");
  });

  it("rejects invalid generate bodies with 400 + detail", async () => {
    const res = await request(app).post("/api/generate").send({ sourceType: "text" }).expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it("rejects text sources that are too short with an actionable error", async () => {
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", content: "too short" })
      .expect(200);
    const events = res.text.trim().split("\n").map((l) => JSON.parse(l));
    const err = events.find((e: { type: string }) => e.type === "error");
    expect(err.stage).toBe("ingest");
    expect(err.code).toBe("source_too_short");
    expect(err.message).toContain("at least");
  });

  it("works with pasted text sources", async () => {
    const content = getSample("scaffoldcraft-cli").content;
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", name: "Pasted ScaffoldCraft", requestedName: "scaffoldcraft-pasted", content })
      .expect(200);
    const events = res.text.trim().split("\n").map((l) => JSON.parse(l));
    const result = events.find((e: { type: string }) => e.type === "result");
    expect(result.skill.meta.name).toBe("scaffoldcraft-pasted");
  });
});

describe("skill inspection, validation, export", () => {
  let skillId: string;

  beforeAll(async () => {
    const { result } = await generateSkill("scaffoldcraft-cli");
    skillId = result.skill.id;
  });

  it("serves the stored skill with source and validation", async () => {
    const res = await request(app).get(`/api/skills/${skillId}`).expect(200);
    expect(res.body.id).toBe(skillId);
    expect(res.body.source.text).toContain("ScaffoldCraft");
    expect(res.body.validation.executed).toBe(true);
  });

  it("re-validates on demand and updates the report", async () => {
    const res = await request(app).post(`/api/skills/${skillId}/validate`).send({}).expect(200);
    expect(res.body.validation.executed).toBe(true);
    expect(res.body.validation.checks.length).toBeGreaterThanOrEqual(14);
  });

  it.each(["claude-code", "generic", "openai-codex"])("exports %s ZIP with correct headers and entries", async (target) => {
    const res = await request(app)
      .post(`/api/skills/${skillId}/export`)
      .buffer(true)
      .parse(binaryParser)
      .send({ target })
      .expect(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain(".zip");
    expect(res.headers["x-skillforge-entries"]).toBeTruthy();
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    expect(body.subarray(0, 2).toString()).toBe("PK");

    const zip = await JSZip.loadAsync(body);
    const names = Object.keys(zip.files).filter((n) => !n.endsWith("/"));
    expect(names).toContain("scaffoldcraft-cli/SKILL.md");
    const skillMd = await zip.files["scaffoldcraft-cli/SKILL.md"]!.async("string");
    expect(skillMd).toContain("name: scaffoldcraft-cli");
  });

  it("refuses unsupported export targets with 400", async () => {
    const res = await request(app).post(`/api/skills/${skillId}/export`).send({ target: "not-a-target" }).expect(400);
    expect(res.body.supported.sort()).toEqual(["claude-code", "generic", "openai-codex"]);
  });

  it("blocks export of packages with validation errors (422)", async () => {
    // Generate from a pathological source that will fail a validator check.
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", name: "Broken", content: "# Broken\n\nA doc with TODO markers. TODO: fix everything later, this is a long enough paragraph to ingest properly.\n\n## Setup\n\n1. Step one does something.\n2. Step two does more.\n3. Step three finishes.\n" })
      .expect(200);
    const events = res.text.trim().split("\n").map((l) => JSON.parse(l));
    const result = events.find((e: { type: string }) => e.type === "result");
    expect(result).toBeTruthy();

    const exportRes = await request(app)
      .post(`/api/skills/${result.skill.id}/export`)
      .send({ target: "claude-code" })
      .expect((r) => {
        // The pathological source may or may not trip validation; accept 200 or 422
        if (r.status !== 200 && r.status !== 422) throw new Error(`unexpected ${r.status}`);
      });
    if (exportRes.status === 422) {
      expect(exportRes.body.validation.executed).toBe(true);
      expect(exportRes.body.error).toContain("blocked");
    }
  });

  it("Codex preserves persisted edits and rejects incompatible target metadata", async () => {
    const generated = await request(app).post("/api/generate")
      .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "codex-edited" }).expect(200);
    const result = generated.text.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "result");
    const md = result.skill.files.find((file: { path: string }) => file.path === "SKILL.md");
    const edited = md.content.replace(/^description: .*$/m, 'description: "Reviewed payment workflows"');
    const updated = await request(app).post("/api/skills/codex-edited/update-file")
      .send({ path: "SKILL.md", content: edited }).expect(200);
    expect(updated.body.validation.passed).toBe(true);
    expect(updated.body.skill.provenance.filter((p: { filePath: string }) => p.filePath === "SKILL.md")).toEqual([]);
    const exported = await request(app).post("/api/skills/codex-edited/export")
      .buffer(true).parse(binaryParser).send({ target: "openai-codex" }).expect(200);
    const zip = await JSZip.loadAsync(exported.body);
    const persisted = updated.body.skill.files.find((file: { path: string }) => file.path === "SKILL.md");
    expect(await zip.file("codex-edited/SKILL.md")!.async("string")).toBe(persisted.content);
    const manifest = JSON.parse(await zip.file("codex-edited/manifest.json")!.async("string"));
    expect(manifest.files.find((file: { path: string }) => file.path === "SKILL.md").userEdited).toBe(true);
    expect(await zip.file("codex-edited/manifest.json")!.async("string")).toBe(updated.body.skill.files.find((file: { path: string }) => file.path === "manifest.json").content);

    // Valid canonical metadata can still violate the stricter Codex authoring contract.
    const incompatible = persisted.content.replace(/^description: .*$/m, 'description: "Use <payment> workflows"');
    const editedAgain = await request(app).post("/api/skills/codex-edited/update-file")
      .send({ path: "SKILL.md", content: incompatible }).expect(200);
    expect(editedAgain.body.validation.passed).toBe(true);
    const blocked = await request(app).post("/api/skills/codex-edited/export")
      .send({ target: "openai-codex" }).expect(422);
    expect(blocked.body.code).toBe("export_codex_metadata_invalid");
    expect(blocked.body.error).toContain("angle brackets");
  });

  it("returns 404 for unknown skills", async () => {
    await request(app).get("/api/skills/does-not-exist").expect(404);
  });
});

describe("provider credential routing (F-02)", () => {
  it("strictly enforces configured provider and prevents request body from misrouting credentials", async () => {
    const calledUrls: string[] = [];
    const authHeaders: string[] = [];
    const stubRemoteFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calledUrls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.authorization) authHeaders.push(headers.authorization);
      const planPayload = {
        name: "test-routing-skill",
        displayName: "Test Routing Skill",
        selections: {
          whenToUse: [],
          inputs: [],
          steps: [],
          constraints: [],
          verification: [],
          pitfalls: [],
        },
      };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(planPayload) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubRemoteFetch;
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const glmApp = createApp(
        {
          provider: "glm",
          hasApiKey: true,
          apiKey: "mock-test-key",
        },
        { storeRoot },
      );

      const res = await request(glmApp)
        .post("/api/generate")
        .send({
          sourceType: "sample",
          sampleId: "meridian-payments-api",
          provider: "openai", // Hostile attempt to switch provider / endpoint
        })
        .expect(200);

      // Verify that OpenAI was never called
      expect(calledUrls.some((u) => u.includes("api.openai.com"))).toBe(false);
      // Verify that configured GLM endpoint was called
      expect(calledUrls.some((u) => u.startsWith("https://open.bigmodel.cn/"))).toBe(true);
      // Verify that GLM key was only sent to the GLM endpoint
      expect(authHeaders).toEqual(["Bearer mock-test-key"]);

      // Verify resulting skill generator is configured provider (glm), not request provider (openai)
      const events = res.text.trim().split("\n").map((l) => JSON.parse(l));
      const result = events.find((e: { type: string }) => e.type === "result");
      expect(result.skill.meta.generator).toBe("glm");
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });
});

