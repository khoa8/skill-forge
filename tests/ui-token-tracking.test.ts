import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("I-02: UI request ownership and sequence token tracking", () => {
  const appJs = readFileSync(join(process.cwd(), "web", "app.js"), "utf8");

  it("defines sequence tokens in state for all async flows", () => {
    expect(appJs).toContain("generationSeq: 0");
    expect(appJs).toContain("sourceNotesSeq: 0");
    expect(appJs).toContain("validateSeq: 0");
    expect(appJs).toContain("editSeq: 0");
    expect(appJs).toContain("provenanceSeq: 0");
    expect(appJs).toContain("exportSeq: 0");
  });

  it("guards runGenerate against stale or superseded streaming events", () => {
    expect(appJs).toContain("const genToken = ++state.generationSeq;");
    expect(appJs).toContain("state.generationSeq === genToken");
  });

  it("guards renderSourceNotes against skillId drift or superseding loads", () => {
    expect(appJs).toContain("const token = ++state.sourceNotesSeq;");
    expect(appJs).toContain("state.skillId !== skillId || state.sourceNotesSeq !== token");
  });

  it("guards revalidate against superseding revalidation requests", () => {
    expect(appJs).toContain("const token = ++state.validateSeq;");
    expect(appJs).toContain("state.skillId !== skillId || state.validateSeq !== token");
  });

  it("guards saveEdit and cancelEdit against stale saves or canceled edits", () => {
    expect(appJs).toContain("state.editSeq++;");
    expect(appJs).toContain("const token = ++state.editSeq;");
    expect(appJs).toContain("state.skillId !== skillId || state.editingPath !== path || state.editSeq !== token");
  });

  it("guards openProvenance against stale provenance excerpt responses", () => {
    expect(appJs).toContain("const token = ++state.provenanceSeq;");
    expect(appJs).toContain("state.skillId !== skillId || state.provenanceSeq !== token");
  });

  it("guards runExport against concurrent or superseded export downloads", () => {
    expect(appJs).toContain("const token = ++state.exportSeq;");
    expect(appJs).toContain("state.skillId !== skillId || state.exportSeq !== token");
  });
});
