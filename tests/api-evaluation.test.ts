import { describe, it, beforeAll, afterAll, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

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

async function generateSkill(sampleId: string, requestedName?: string) {
  const res = await request(app)
    .post("/api/generate")
    .send({ sourceType: "sample", sampleId, ...(requestedName ? { requestedName } : {}) })
    .expect(200);
  const events = res.text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const result = events.find((e) => e.type === "result");
  return { events, result };
}

describe("deterministic skill evaluation API", () => {
  let skillId: string;

  beforeAll(async () => {
    const { result } = await generateSkill("meridian-payments-api", "eval-api-target");
    skillId = result.skill.id;
  });

  it("returns an executed advisory report for a healthy generated skill", async () => {
    const res = await request(app).get(`/api/skills/${skillId}/evaluation`).expect(200);
    const evaluation = res.body.evaluation;
    expect(evaluation.executed).toBe(true);
    expect(evaluation.counts.passed).toBeGreaterThan(0);
    expect(evaluation.evaluatorVersion).toBeTruthy();
    for (const check of evaluation.checks) {
      expect(["pass", "concern", "not-executable"]).toContain(check.status);
    }
    const manual = evaluation.checks.find((c: { status: string }) => c.status === "not-executable");
    if (manual) expect(manual.message).toMatch(/manual|not execute/i);
  });

  it("is deterministic across repeated calls", async () => {
    const first = await request(app).get(`/api/skills/${skillId}/evaluation`).expect(200);
    const second = await request(app).get(`/api/skills/${skillId}/evaluation`).expect(200);
    expect(second.body.evaluation).toEqual(first.body.evaluation);
  });

  it("keeps evaluation separate from validation and does not gate export", async () => {
    const stored = await request(app).get(`/api/skills/${skillId}`).expect(200);
    expect(stored.body.validation.passed).toBe(true);
    const evaluation = (await request(app).get(`/api/skills/${skillId}/evaluation`).expect(200)).body.evaluation;
    if (evaluation.counts.concern > 0 || evaluation.counts.notExecutable > 0) {
      const zip = await request(app)
        .post(`/api/skills/${skillId}/export`)
        .send({ target: "claude-code" })
        .expect(200);
      expect(zip.headers["content-type"]).toBe("application/zip");
    }
  });

  it("returns 404 for a missing skill", async () => {
    const res = await request(app).get("/api/skills/no-such-skill/evaluation").expect(404);
    expect(res.body.error).toContain("No skill with id");
  });

  it("surfaces a concern after an edit that removes source-derived coverage while validation still passes", async () => {
    const skill = (await request(app).get(`/api/skills/${skillId}`).expect(200)).body.skill;
    const targetPath = skill.files.find((f: { path: string }) => f.path.startsWith("references/")).path;
    const file = skill.files.find((f: { path: string }) => f.path === targetPath);
    const edited = await request(app)
      .post(`/api/skills/${skillId}/update-file`)
      .send({ path: targetPath, content: file.content.split("\n")[0] + "\n\nUser rewrote this section." })
      .expect(200);
    expect(edited.body.validation.passed).toBe(true);

    const evaluation = (await request(app).get(`/api/skills/${skillId}/evaluation`).expect(200)).body.evaluation;
    expect(evaluation.executed).toBe(true);
    expect(evaluation.counts.concern).toBeGreaterThan(0);
    const concern = evaluation.checks.find((c: { status: string }) => c.status === "concern");
    expect(concern.filePath).toBe(targetPath);
    expect(concern.message.toLowerCase()).toMatch(/edited|retain/);
  });
});
