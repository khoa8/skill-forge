/**
 * End-to-end bundled demo test: no API key, no network — both bundled samples
 * complete Source → Generate → Validate → Export, and the produced ZIPs are
 * read back and inspected entry by entry.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { runPipeline } from "../src/core/pipeline.js";
import { listSamples, getSample } from "../src/core/samples.js";
import { exportPackage, buildZip } from "../src/core/export/exporters.js";

async function runForSample(id: string) {
  const sample = getSample(id);
  let result: { skill: any; validation: any } | null = null;
  const events: any[] = [];
  for await (const ev of runPipeline(
    { type: "sample", name: sample.meta.title, content: sample.content },
    { provider: "mock" },
  )) {
    events.push(ev);
    if (ev.type === "result") result = { skill: ev.skill, validation: ev.validation };
  }
  return { events, result: result! };
}

describe("bundled demo end-to-end (offline, no key)", () => {
  for (const sample of listSamples()) {
    it(`completes the full pipeline for sample "${sample.id}"`, async () => {
      const { events, result } = await runForSample(sample.id);

      // Pipeline surfaced all four stages in order with real timings.
      const stageDones = events.filter((e) => e.type === "stage" && e.status === "done");
      expect(stageDones.map((e) => e.stage)).toEqual(["ingest", "analyze", "generate", "validate"]);
      expect(stageDones.every((e) => typeof e.ms === "number")).toBe(true);

      // Deterministic validation executed and passed with real checks.
      expect(result.validation.executed).toBe(true);
      expect(result.validation.passed).toBe(true);
      expect(result.validation.checks.length).toBeGreaterThanOrEqual(14);

      // Package contains only purposeful, non-empty files.
      expect(result.skill.files.length).toBeGreaterThan(5);
      for (const file of result.skill.files) {
        expect(file.content.trim().length).toBeGreaterThan(0);
        expect(file.purpose).toBeTruthy();
      }
      expect(result.skill.provenance.length).toBeGreaterThan(0);

      // All export targets produce inspectable, non-empty ZIPs.
      for (const target of ["claude-code", "generic", "openai-codex"] as const) {
        const exported = exportPackage(result.skill, target);
        const zip = await buildZip(exported);
        expect(zip.buffer.length).toBeGreaterThan(1000);
        expect(zip.fileName).toMatch(new RegExp(`^${result.skill.id}-${target}\\.zip$`));

        const readBack = await JSZip.loadAsync(zip.buffer);
        const entries = Object.values(readBack.files).filter((f) => !f.dir);
        expect(entries.length).toBe(zip.entries.length);
        const skillMdEntry = entries.find((f) => f.name.endsWith("/SKILL.md"));
        expect(skillMdEntry).toBeDefined();
        const skillMd = await skillMdEntry!.async("string");
        expect(skillMd).toContain("name: " + result.skill.id);
        for (const entry of entries) {
          const content = await entry.async("string");
          expect(content.trim().length).toBeGreaterThan(0);
        }
      }
    });
  }

  it("uses the bundled sample registry consistently", () => {
    for (const meta of listSamples()) {
      const { content } = getSample(meta.id);
      expect(content.length).toBeGreaterThan(500);
    }
    expect(() => getSample("nonexistent")).toThrow(/Available samples/);
  });
});
