/**
 * F-EXTRA-01 regression coverage — untrusted metadata rendering boundary.
 *
 * Invariant (AGENTS.md §3, §8): imported content and imported metadata are
 * untrusted and inert. A source name or collected file path is *identity*, not
 * content: it must never escape the presentation context it is rendered into
 * and become Markdown structure, an extra instruction line, or
 * executable-looking content.
 *
 * These tests cover the failure CLASS (line breaks, control characters, and
 * delimiter-sensitive metadata in every generator-owned sink) rather than the
 * literal strings used during remediation, and they exercise the real
 * production path (`runPipeline` / the HTTP API), not only string helpers.
 */
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { runPipeline } from "../src/core/pipeline.js";
import { createApp } from "../src/server/app.js";
import { combineFiles } from "../src/core/sources/files.js";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis, qualifyEditedFileContent } from "../src/core/build.js";
import { formatCodeSpan, formatMetadataLabel } from "../src/core/util.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

const SOURCE = [
  "# Meridian Payments API",
  "",
  "Meridian processes payments for merchants. It exposes a REST interface.",
  "",
  "## Authentication",
  "",
  "Send your API key in the Authorization header.",
  "",
  "```bash",
  "curl -X POST https://api.meridian.example/v1/payments",
  "echo done",
  "sleep 1",
  "```",
  "",
  "## Errors",
  "",
  "Errors return a JSON body with a code and message. Retry idempotent requests.",
  "",
].join("\n");

const MARKER = "ATTACKER_METADATA_MARKER";

/** The generator's own SKILL.md section contract — nothing else may appear. */
const SKILL_MD_SECTIONS = [
  "## When to use this skill",
  "## Inputs required",
  "## Workflow",
  "## Constraints",
  "## Verification",
  "## Common pitfalls",
  "## References",
];

/**
 * Line-break / control variants the text model can actually carry: the API
 * accepts any JSON string, and `normalizeSource` normalizes source *content*
 * but never the source *name*.
 */
const LINE_BREAK_VARIANTS: Array<[string, string]> = [
  ["LF", "\n"],
  ["CR", "\r"],
  ["CRLF", "\r\n"],
  ["U+2028 line separator", "\u2028"],
  ["U+2029 paragraph separator", "\u2029"],
  ["C1 control (NEL)", "\u0085"],
  ["ESC control", "\u001b"],
  ["NUL control", "\u0000"],
];

function hostileName(sep: string): string {
  return `docs${sep}${sep}## Injected section${sep}${sep}${MARKER}`;
}

/** Every generator-owned sink that renders the source name, for one package. */
function metadataSinks(files: Array<{ path: string; content: string }>): Array<{ path: string; content: string }> {
  return files.filter(
    (f) =>
      f.path === "SKILL.md" ||
      f.path.startsWith("references/") ||
      f.path.startsWith("workflows/") ||
      f.path.startsWith("examples/"),
  );
}

/**
 * Assert the injection never became *structure*: no attacker-authored heading,
 * list item, standalone body line, or extra SKILL.md section. The metadata may
 * still appear inside a rendered label — that is honest identity — but never as
 * its own Markdown block.
 */
function expectNoInjectedStructure(files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    // A standalone attacker-authored line is never legitimate in any format.
    expect(file.content, `${file.path}: injected standalone line`).not.toMatch(new RegExp(`^\\s*${MARKER}`, "m"));
    expect(file.content, `${file.path}: injected list item`).not.toMatch(/^\s*[-*+]\s+Injected/);
    // Markdown sinks: the attacker's payload may legitimately appear *inside*
    // a rendered single-line label (honest identity), but it must never have
    // become a line of its own — i.e. no surviving line break.
    if (file.path.endsWith(".md")) {
      expect(file.content, `${file.path}: attacker heading became its own line`).not.toMatch(/^#{1,6}\s+Injected\b/m);
      expect(file.content, `${file.path}: attacker heading became a list item`).not.toMatch(/^\s*[-*+]\s+Injected\b/m);
    }
    if (file.path === "SKILL.md") {
      const sections = file.content.split("\n").filter((l) => /^##\s/.test(l));
      expect(sections, "SKILL.md section set is generator-owned").toEqual(SKILL_MD_SECTIONS);
    }
  }
}

async function generate(sourceName: string) {
  const events: unknown[] = [];
  for await (const event of runPipeline(
    { type: "text", name: sourceName, content: SOURCE },
    { provider: "mock" },
  )) {
    events.push(event);
  }
  const error = events.find((e): e is { type: "error"; code: string; message: string } =>
    (e as { type?: string }).type === "error",
  );
  expect(error, `pipeline error: ${error?.code} ${error?.message}`).toBeUndefined();
  const result = events.find((e): e is { type: "result"; skill: any; validation: any } =>
    (e as { type?: string }).type === "result",
  );
  expect(result).toBeDefined();
  return result!;
}

describe("F-EXTRA-01 — shared untrusted-metadata rendering boundary", () => {
  it("M1: line-break and control-character variants cannot become Markdown structure in any generated file", async () => {
    for (const [label, sep] of LINE_BREAK_VARIANTS) {
      const result = await generate(hostileName(sep));
      expectNoInjectedStructure(metadataSinks(result.skill.files));
      // Validation is genuinely clean: the boundary is structural, not a
      // warning that happens to mention the injection.
      expect(result.validation.passed, `${label} should validate`).toBe(true);
      expect(result.validation.errorCount, `${label} error count`).toBe(0);
    }
  });

  it("M2: backticks in a source name cannot terminate the SKILL.md provenance code span", async () => {
    const raw = "docs` ## Injected section `ATTACKER_METADATA_MARKER`";
    const result = await generate(raw);
    const skillMd = result.skill.files.find((f: { path: string }) => f.path === "SKILL.md")!.content;
    const banner = skillMd.split("\n").find((l: string) => l.includes("Generated by SkillForge"))!;
    expect(banner).toBeDefined();

    // The rendered banner is a well-formed CommonMark code span: the name is
    // wrapped in a delimiter longer than any run of backticks inside it.
    expect(banner).toContain(formatCodeSpan(raw));
    expectNoInjectedStructure(metadataSinks(result.skill.files));
  });

  it("M3: a hostile source name cannot inject extra lines into example comment headers", async () => {
    const result = await generate(hostileName("\n"));
    const example = result.skill.files.find((f: { path: string }) => f.path.startsWith("examples/"));
    expect(example, "the fixture must produce an example file").toBeDefined();

    const lines = example.content.split("\n");
    // Exactly one generator comment header, then the verbatim block, then the
    // trailing newline — no attacker-authored lines.
    expect(lines[0]).toBe(
      `# Source: ${formatMetadataLabel(hostileName("\n"))}, lines 9–13 (under "Authentication"). Verbatim code block.`,
    );
    expect(lines.slice(1, -1).join("\n")).toBe(
      "curl -X POST https://api.meridian.example/v1/payments\necho done\nsleep 1",
    );
    expect(example.content).not.toMatch(new RegExp(`^${MARKER}`, "m"));
  });

  it("M4: combineFiles keeps a hostile path structurally inert at the synthetic file boundary", () => {
    const hostilePath = `docs/bad\n\n## Injected by path\n\n${MARKER}.md`;
    const label = formatMetadataLabel(hostilePath);
    const combined = combineFiles([
      { path: "docs/a.md", content: "# A\n\nalpha" },
      { path: hostilePath, content: "# B\n\nbeta" },
    ]);

    // Exactly two synthetic boundaries — one per collected file, no more.
    const boundaryLines = combined.content
      .split("\n")
      .filter((l) => l === "# docs/a.md" || l === `# ${label}`);
    expect(boundaryLines).toHaveLength(2);
    expect(combined.content.startsWith("# docs/a.md\n\n")).toBe(true);
    expect(combined.content).toContain(`\n\n# ${label}\n\n`);
    expect(combined.content).not.toMatch(/^#{2,6}\s/m);
    expect(combined.content).not.toMatch(new RegExp(`^${MARKER}`, "m"));
    // Raw identity is preserved in the structured source name, not rewritten.
    expect(combineFiles([{ path: hostilePath, content: "# B\n\nbeta" }], hostilePath).name).toBe(hostilePath);
    expect(combined.name).toBe("2 files: docs/a.md (+1 more)");
  });

  it("M5: the analyzer receives no attacker-authored Markdown blocks from path metadata", async () => {
    const hostilePath = `docs/bad\n\n## Injected by path\n\n${MARKER}.md`;
    const combined = combineFiles([
      { path: "docs/a.md", content: "# A\n\nalpha" },
      { path: hostilePath, content: "# B\n\nbeta" },
    ]);

    // The hostile path contributes exactly one heading (its single-line
    // boundary label) and no body paragraph of its own.
    const analysis = analyzeSource(normalizeSource(combined));
    const headings = analysis.sections.map((s) => s.heading);
    expect(headings).toContain(formatMetadataLabel(hostilePath));
    expect(headings).not.toContain("Injected by path");
    expect(analysis.sections.filter((s) => s.heading === MARKER)).toHaveLength(0);

    // …and the real pipeline built from it stays structurally clean.
    const events: unknown[] = [];
    for await (const event of runPipeline(combined, { provider: "mock" })) events.push(event);
    const multi = events.find((e): e is { type: "result"; skill: any; validation: any } =>
      (e as { type?: string }).type === "result",
    );
    expect(multi).toBeDefined();
    expect(multi!.skill.files.some((f: { path: string }) => f.path.includes("injected"))).toBe(false);
    expectNoInjectedStructure(metadataSinks(multi!.skill.files));
    expect(multi!.validation.passed).toBe(true);
  });

  it("M6: ordinary human-readable names and paths still render readably", async () => {
    const result = await generate("Meridian Payments API v2");
    const skillMd = result.skill.files.find((f: { path: string }) => f.path === "SKILL.md")!.content;
    expect(skillMd).toContain("from `Meridian Payments API v2`.");
    const reference = result.skill.files.find((f: { path: string }) => f.path.startsWith("references/"))!;
    expect(reference.content).toContain('> Excerpt from source "Meridian Payments API v2" (lines');
    expect(reference.content).toContain("_Source: Meridian Payments API v2, lines");

    // A normal multi-file path is unchanged by the boundary.
    const combined = combineFiles([
      { path: "docs/a.md", content: "# A\n\nalpha" },
      { path: "docs/b.md", content: "# B\n\nbeta" },
    ]);
    expect(combined.content).toContain("# docs/a.md\n");
    expect(combined.content).toContain("# docs/b.md\n");
    expect(combined.name).toBe("2 files: docs/a.md (+1 more)");
  });

  it("M7: the metadata boundary is shared, not one-off per sink", () => {
    // Line/control characters collapse to single-line presentation text …
    expect(formatMetadataLabel("a\nb\rc\u2028d\u2029e\u0085f\u001bg\u0000h")).toBe("a b c d e f g h");
    expect(formatMetadataLabel("  docs/guide.md  ")).toBe("docs/guide.md");
    // … and the code-span boundary is the same rule plus delimiter sizing.
    expect(formatCodeSpan("docs/guide.md")).toBe("`docs/guide.md`");
    expect(formatCodeSpan("a\nb")).toBe("`a b`");
    expect(formatCodeSpan("a`b")).toBe("``a`b``");
  });

  it("M8: structured identity is not rewritten — manifest keeps the raw source name", async () => {
    const raw = hostileName("\n");
    const result = await generate(raw);
    const manifest = JSON.parse(
      result.skill.files.find((f: { path: string }) => f.path === "manifest.json")!.content,
    );
    expect(manifest.source.name).toBe(raw);
    expect(manifest.displayName).toBe("Meridian Payments API");
  });

  it("M9: post-edit provenance qualification still recognizes generator-owned text", async () => {
    const raw = hostileName("\n");
    const result = await generate(raw);

    const skillMd = result.skill.files.find((f: { path: string }) => f.path === "SKILL.md")!.content;
    const qualifiedSkill = qualifyEditedFileContent("SKILL.md", `${skillMd}\nUser prose.`, raw);
    expect(qualifiedSkill).toContain("edited after generation");
    expect(qualifiedSkill).not.toContain("Every factual claim below is grounded in that source");

    const reference = result.skill.files.find((f: { path: string }) => f.path.startsWith("references/"))!;
    const qualifiedRef = qualifyEditedFileContent(reference.path, reference.content, raw);
    expect(qualifiedRef).toContain("edited after generation");
    expect(qualifiedRef).not.toContain("Verbatim except for this header");
    expect(qualifiedRef).not.toContain("_Source:");

    const example = result.skill.files.find((f: { path: string }) => f.path.startsWith("examples/"))!;
    const qualifiedExample = qualifyEditedFileContent(example.path, example.content, raw);
    expect(qualifiedExample).toContain("edited after generation");
    expect(qualifiedExample).not.toContain("Verbatim code block");

    // Legacy spelling: records generated before the boundary existed used the
    // raw name, and editing them must still drop the false provenance.
    const legacy =
      "> Generated by SkillForge (`mock`) from `" +
      raw +
      "`. Every factual claim below is grounded in that source; explicit gaps are marked.";
    const qualifiedLegacy = qualifyEditedFileContent("SKILL.md", legacy, raw);
    expect(qualifiedLegacy).toContain("edited after generation");
    expect(qualifiedLegacy).not.toContain("Every factual claim below is grounded");
  });

  it("M12: a source name reused as the display-name fallback cannot escape the SKILL.md title", () => {
    // A source whose first meaningful line is only "#" has no usable H1, so
    // `analyzeSource` falls back to the raw source name — and a provider may
    // legitimately omit `displayName`. That fallback is metadata and must go
    // through the same boundary.
    const raw = hostileName("\n");
    const content = [
      "#",
      "",
      "Meridian processes payments for merchants. It exposes a REST interface.",
      "",
      "## Setup",
      "",
      "1. Create a token.",
      "2. Configure the client.",
      "3. Send a request.",
      "",
    ].join("\n");
    const normalized = normalizeSource({ type: "text", name: raw, content });
    const analysis = analyzeSource(normalized);
    expect(analysis.title).toBe(raw); // the fallback is genuinely in play
    const plan = { ...derivePlanFromAnalysis(analysis), displayName: undefined };
    const skill = buildCanonicalSkill(normalized, analysis, plan, "glm");
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!.content;

    expect(skill.meta.displayName).toBe(formatMetadataLabel(raw));
    expect(skillMd).toContain(`# ${formatMetadataLabel(raw)}\n`);
    // The pre-fix failure mode was a bare "## Injected section" block.
    expect(skillMd).not.toMatch(/^## Injected section$/m);
    expectNoInjectedStructure(metadataSinks(skill.files));
  });

  it("M13: a source name of only control characters never produces a match-anything provenance banner", () => {
    const controlOnly = "\n\r\u2028\u0000";
    const normalized = normalizeSource({ type: "text", name: controlOnly, content: SOURCE });
    const skill = buildCanonicalSkill(
      normalized,
      analyzeSource(normalized),
      { whenToUse: [], inputs: [], steps: [], constraints: [], verification: [], pitfalls: [] },
      "mock",
    );
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!.content;
    // Empty rendered label => empty code span, and the banner is still inert.
    expect(skillMd).toContain("from ``.");
    const qualified = qualifyEditedFileContent("SKILL.md", skillMd, controlOnly);
    expect(qualified).toContain("edited after generation");
    // An empty alternation must not match arbitrary user prose elsewhere.
    const untouched = qualifyEditedFileContent("references/unknown.md", "# Kept\n\nUser prose only.\n", controlOnly);
    expect(untouched).toBe("# Kept\n\nUser prose only.\n");
  });
});

describe("F-EXTRA-01 — server path: generate → validate → export → edit", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  /** Fresh app + isolated store per test (skill ids are deterministic). */
  async function freshApp() {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    cleanups.push(cleanup);
    return createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
  }

  const binaryParser = (res: unknown, cb: (err: Error | null, body?: unknown) => void) => {
    const chunks: Buffer[] = [];
    (res as { on: (ev: string, fn: (c: Buffer) => void) => void }).on("data", (c) => chunks.push(c));
    (res as { on: (ev: string, fn: () => void) => void }).on("end", () => cb(null, Buffer.concat(chunks)));
  };

  it("M10: an API request with hostile metadata validates and exports a package with no injected structure", async () => {
    const app = await freshApp();
    const raw = hostileName("\n");
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", name: raw, content: SOURCE })
      .expect(200);
    const events = res.text.trim().split("\n").map((l) => JSON.parse(l));
    const result = events.find((e) => e.type === "result");
    expect(result, JSON.stringify(events.find((e) => e.type === "error"))).toBeDefined();
    expect(result.validation.passed).toBe(true);
    expect(result.validation.errorCount).toBe(0);
    expectNoInjectedStructure(metadataSinks(result.skill.files));

    // Export re-validates server-side and must produce a real ZIP.
    const zipRes = await request(app)
      .post(`/api/skills/${result.skill.id}/export`)
      .send({ target: "generic" })
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const zip = await JSZip.loadAsync(zipRes.body);
    const skillMd = await zip.file(`${result.skill.id}/SKILL.md`)!.async("string");
    expect(skillMd).not.toMatch(/^#{1,6}\s+Injected\b/m);
    expect(skillMd).not.toMatch(new RegExp(`^${MARKER}`, "m"));
    expect(skillMd).toContain(formatCodeSpan(raw));
  });

  it("M11: editing a generated file through the API drops generator provenance honestly", async () => {
    const app = await freshApp();
    const raw = hostileName("\n");
    const res = await request(app)
      .post("/api/generate")
      .send({ sourceType: "text", name: raw, content: SOURCE })
      .expect(200);
    const result = res.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "result");
    expect(result).toBeDefined();
    const skillMd = result.skill.files.find((f: { path: string }) => f.path === "SKILL.md")!.content;

    const edited = await request(app)
      .post(`/api/skills/${result.skill.id}/update-file`)
      .send({ path: "SKILL.md", content: `${skillMd}\n\nUser-authored instruction.` })
      .expect(200);
    const newSkillMd = edited.body.skill.files.find((f: { path: string }) => f.path === "SKILL.md").content;
    expect(newSkillMd).toContain("edited after generation");
    expect(newSkillMd).not.toContain("Every factual claim below is grounded in that source");
    // The edited file must not have re-injected the raw multi-line name.
    expect(newSkillMd).not.toMatch(/^#{1,6}\s+Injected\b/m);
    expect(newSkillMd).not.toMatch(new RegExp(`^${MARKER}`, "m"));
  });
});
