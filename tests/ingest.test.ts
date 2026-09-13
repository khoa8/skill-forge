import { describe, expect, it } from "vitest";
import { normalizeSource, IngestError, MAX_SOURCE_BYTES } from "../src/core/ingest.js";

const doc = (body: string) => ({ type: "text" as const, name: "test", content: body });

describe("normalizeSource", () => {
  it("keeps PDF markup and Unicode literal with stable re-normalized lines", () => {
    const input = { type: "pdf" as const, name: "guide.pdf", content: '<div>Literal ﬀ and &amp; text remain source evidence.</div>\r\n\r\n\r\n  Indented procedure.\r\n' };
    const normalized = normalizeSource(input);
    expect(normalized.text).toBe(input.content.replace(/\r\n/g, "\n").trimEnd());
    expect(normalizeSource({ ...input, content: normalized.text })).toEqual(normalized);
    expect(normalized.notes).toEqual([]);
  });

  it("normalizes line endings and collapses blank lines", () => {
    const src = normalizeSource(doc("# Title Heading\n\n\n\nBody line of the document goes right here.\n"));
    expect(src.text).toBe("# Title Heading\n\nBody line of the document goes right here.");
    expect(src.lineCount).toBe(3);
  });

  it("strips HTML and records a note", () => {
    const src = normalizeSource(doc("<h1>Setup</h1>\n<p>Install the tool with <code>npm i</code>.</p>"));
    expect(src.text).not.toContain("<h1>");
    expect(src.notes.some((n) => n.toLowerCase().includes("html"))).toBe(true);
  });

  it("decodes basic entities", () => {
    const src = normalizeSource(doc("Use &amp; and &lt;tag&gt; carefully. Entities are common in web copy. Enjoy."));
    expect(src.text).toContain("& and <tag>");
  });

  it("rejects empty/short sources with an actionable error", () => {
    expect(() => normalizeSource(doc("too short"))).toThrow(IngestError);
    try {
      normalizeSource(doc("nope"));
    } catch (err) {
      expect((err as IngestError).code).toBe("source_too_short");
    }
  });

  it("rejects oversized sources", () => {
    const huge = "x".repeat(MAX_SOURCE_BYTES + 1);
    expect(() => normalizeSource(doc(huge))).toThrow(/limit/);
  });

  it("computes a stable sha256 of the normalized text", () => {
    const a = normalizeSource(doc("# Same\n\nContent body goes here for hashing."));
    const b = normalizeSource(doc("# Same\r\n\r\nContent body goes here for hashing."));
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
