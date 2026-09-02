import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";

function analyze(body: string) {
  return analyzeSource(normalizeSource({ type: "text", name: "test", content: body }));
}

describe("analyzeSource", () => {
  it("extracts sections with exact line ranges", () => {
    const a = analyze("# Project\n\nIntro text.\n\n## Setup\n\nInstall things.\n\n## Usage\n\nUse things.\n");
    const setup = a.sections.find((s) => s.heading === "Setup");
    expect(setup).toBeDefined();
    expect(setup!.level).toBe(2);
    expect(setup!.startLine).toBe(5);
    expect(setup!.text).toContain("Install things.");
    expect(a.sections).toHaveLength(3);
  });

  it("extracts fenced code blocks with language and enclosing heading", () => {
    const a = analyze("## Build\n\n```bash\nfast build\nfast test\n```\n");
    expect(a.codeBlocks).toHaveLength(1);
    expect(a.codeBlocks[0]!.language).toBe("bash");
    expect(a.codeBlocks[0]!.heading).toBe("Build");
    expect(a.codeBlocks[0]!.code).toBe("fast build\nfast test");
  });

  it("does not treat fences inside code blocks as structure", () => {
    const a = analyze("## Example\n\n````\ninner ``` fence\n````\n\nAfter.\n");
    expect(a.codeBlocks).toHaveLength(1);
    expect(a.codeBlocks[0]!.code).toContain("inner ``` fence");
  });

  it("detects shell commands from bash blocks and strips prompts", () => {
    const a = analyze("## Run\n\n```bash\nnpm install\n$ npm test\n```\n");
    expect(a.commands.map((c) => c.raw).sort()).toEqual(["npm install", "npm test"]);
  });

  it("ignores non-shell code blocks for command detection", () => {
    const a = analyze("## Config\n\nHere is the full payload definition for the endpoint.\n\n```json\n{\"a\": 1}\n```\n");
    expect(a.commands).toHaveLength(0);
    expect(a.codeBlocks[0]!.language).toBe("json");
  });

  it("detects ordered procedures", () => {
    const a = analyze("## Deploy\n\n1. Build the app.\n2. Run the tests.\n3. Push to the server.\n");
    expect(a.procedures).toHaveLength(1);
    expect(a.procedures[0]!.title).toBe("Deploy");
    expect(a.procedures[0]!.steps).toHaveLength(3);
    expect(a.procedures[0]!.steps[2]!.line).toBe(5);
  });

  it("does not treat 2-item lists or prose as procedures", () => {
    const a = analyze("## Two\n\n1. Only one.\n2. And two.\n\nJust a sentence with a number 3. inline.\n");
    expect(a.procedures).toHaveLength(0);
  });

  it("detects warning lines including wrapped continuations", () => {
    const a = analyze("## Deploy\n\nWarning: deploying is destructive and\nimmediate. Plan carefully.\n");
    expect(a.warningLines).toHaveLength(1);
    expect(a.warningLines[0]).toContain("immediate. Plan carefully.");
  });

  it("detects github-style callouts", () => {
    const a = analyze("## Notes\n\n> [!WARNING]\n> Do not run this in production.\n");
    expect(a.warningLines.some((w) => w.toLowerCase().includes("do not run"))).toBe(true);
  });

  it("extracts title and intro from an h1 document", () => {
    const a = analyze("# My Tool\n\nMy Tool does useful things. It is fast.\n\n## Usage\n");
    expect(a.title).toBe("My Tool");
    expect(a.intro).toContain("useful things");
  });

  it("falls back to the first line when there is no h1", () => {
    const a = analyze("Some Standalone Doc\n\nBody text that explains. Enough content here to matter.\n");
    expect(a.title).toBe("Some Standalone Doc");
  });

  it("classifies constraint headings", () => {
    const a = analyze("## Requirements\n\nYou need Node.\n\n## Usage\n\nUse it.\n");
    expect(a.constraintHeadings).toContain("Requirements");
    expect(a.constraintHeadings).not.toContain("Usage");
  });
});
