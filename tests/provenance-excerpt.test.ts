import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { normalizeSource, sourceSlice } from "../src/core/ingest.js";

/** Provenance click-through: the excerpt endpoint must return the exact
 * normalized-source lines a provenance record refers to — never a
 * reconstruction that could silently disagree with the record. */

const SOURCE = [
  "# Widget Compiler",
  "",
  "Widget Compiler turns widget manifests into deployable bundles.",
  "",
  "## Setup",
  "",
  "```bash",
  "npm install widget-compiler",
  "```",
  "",
  "## Compile a bundle",
  "",
  "1. Run `widget-compiler compile manifest.yaml`.",
  "2. Fix every reported error.",
  "3. Re-run until the exit code is zero.",
  "",
  "Warning: never compile manifests containing production credentials.",
  "",
].join("\n");

function eventsOf(text: string) {
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("provenance excerpt endpoint", () => {
  const app = createApp({ provider: "mock", hasApiKey: false });
  let skillId: string;
  let firstRecord: { filePath: string; sourceLines: [number, number]; extraction: string };

  it("returns the exact normalized lines a provenance record references", async () => {
    const gen = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", content: SOURCE })
      .expect(200);
    const result = eventsOf(gen.text).find((e) => e.type === "result");
    skillId = result.skill.id;
    const record = result.skill.provenance.find((p: { filePath: string }) => p.filePath === "SKILL.md");
    expect(record).toBeDefined();
    firstRecord = record;

    const res = await request(app)
      .get(`/api/skills/${skillId}/provenance/excerpt`)
      .query({ start: record.sourceLines[0], end: record.sourceLines[1] })
      .expect(200);
    const expected = sourceSlice(
      normalizeSource({ type: "text", name: "pasted-source", content: SOURCE }),
      record.sourceLines[0],
      record.sourceLines[1],
    );
    expect(res.body.text).toBe(expected);
    expect(res.body.returned).toEqual({ start: record.sourceLines[0], end: record.sourceLines[1] });
    expect(res.body.source.type).toBe("text");
    expect(res.body.totalLines).toBe(
      normalizeSource({ type: "text", name: "pasted-source", content: SOURCE }).lineCount,
    );
  });

  it("clamps an end line beyond the source honestly", async () => {
    const normalized = normalizeSource({ type: "text", name: "x", content: SOURCE });
    const res = await request(app)
      .get(`/api/skills/${skillId}/provenance/excerpt`)
      .query({ start: firstRecord.sourceLines[0], end: normalized.lineCount + 5 })
      .expect(200);
    expect(res.body.returned.end).toBe(normalized.lineCount);
    expect(res.body.returned.end).not.toBe(normalized.lineCount + 5);
    const expected = sourceSlice(
      normalizeSource({ type: "text", name: "x", content: SOURCE }),
      firstRecord.sourceLines[0],
      normalized.lineCount,
    );
    expect(res.body.text).toBe(expected);
  });

  it("rejects a start line beyond the source instead of fabricating text", async () => {
    const normalized = normalizeSource({ type: "text", name: "x", content: SOURCE });
    const res = await request(app)
      .get(`/api/skills/${skillId}/provenance/excerpt`)
      .query({ start: normalized.lineCount + 10, end: normalized.lineCount + 20 })
      .expect(422);
    expect(res.body.code).toBe("provenance_out_of_range");
    expect(res.body.totalLines).toBe(normalized.lineCount);
  });

  it("validates query parameters", async () => {
    await request(app).get(`/api/skills/${skillId}/provenance/excerpt`).query({ start: 0, end: 4 }).expect(400);
    await request(app)
      .get(`/api/skills/${skillId}/provenance/excerpt`)
      .query({ start: "abc", end: 4 })
      .expect(400);
    await request(app).get(`/api/skills/${skillId}/provenance/excerpt`).query({ start: 9, end: 3 }).expect(400);
    await request(app)
      .get(`/api/skills/${skillId}/provenance/excerpt`)
      .query({ start: 1, end: 500 })
      .expect(400);
  });

  it("404s for unknown skill ids", async () => {
    await request(app)
      .get("/api/skills/does-not-exist/provenance/excerpt")
      .query({ start: 1, end: 2 })
      .expect(404);
  });

  it("works after storage round-trip (new request, reloaded skill)", async () => {
    // skillId was generated earlier in this describe block and reloaded from
    // disk by every request; repeat one excerpt fetch to confirm stability.
    const res = await request(app)
      .get(`/api/skills/${skillId}/provenance/excerpt`)
      .query({ start: firstRecord.sourceLines[0], end: firstRecord.sourceLines[1] })
      .expect(200);
    expect(typeof res.body.text).toBe("string");
    expect(res.body.text.length).toBeGreaterThan(0);
  });
});
