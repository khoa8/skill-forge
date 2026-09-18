import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { isEditablePath } from "../src/server/store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Execute the real browser handlers with a small DOM surface. Deferred body
// decoding exercises ownership across awaits, not source-text token matching.
function harness() {
  const nodes = new Map<string, any>();
  class Element {
    children: any[] = [];
    textContent = "";
    value = "";
    disabled = false;
    dataset: Record<string, string> = {};
    style = {};
    className = "";
    classList: { contains(name: string): boolean; add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): void } = {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter((n) => !names.includes(n)).join(" "); },
      toggle: (name: string, force?: boolean) => { if (force ?? !this.classList.contains(name)) this.classList.add(name); else this.classList.remove(name); },
    };
    listeners = new Map<string, () => unknown>();
    set id(id: string) { nodes.set(`#${id}`, this); }
    set innerHTML(_value: string) { this.children = []; this.textContent = ""; }
    append(...children: any[]) { this.children.push(...children); }
    after() {}
    remove() {}
    addEventListener(name: string, fn: () => unknown) { this.listeners.set(name, fn); }
    setAttribute() {}
    focus() {}
    showModal() {}
    close() {}
    click() { if (!this.disabled) return this.listeners.get("click")?.(); }
    scrollIntoView() {}
  }
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element();
    el.className = tag[0].match(/class="([^"]*)"/)?.[1] ?? "";
    nodes.set(`#${tag[1]}`, el);
  }
  for (const tag of html.matchAll(/<[^>]+data-stage="([^"]+)"[^>]*>/g)) {
    const el = new Element();
    el.className = tag[0].match(/class="([^"]*)"/)?.[1] ?? "";
    nodes.set(`.step[data-stage="${tag[1]}"]`, el);
  }
  const document = {
    querySelector: (selector: string) => {
      if (!nodes.has(selector) && !["#revalidate-btn", "#validation-request-status"].includes(selector)) nodes.set(selector, new Element());
      return nodes.get(selector) ?? null;
    },
    querySelectorAll: (selector: string) => selector === "#file-list li" ? nodes.get("#file-list")?.children ?? [] : [],
    createElement: () => new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
    body: new Element(),
  };
  const fetch = vi.fn();
  const url = Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
  const context: any = { document, fetch, URL: url, console, setTimeout: vi.fn(), TextDecoder, Blob };
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\ninit\(\);\s*$/, "");
  runInNewContext(source + "\nglobalThis.ui = { state, renderValidation, revalidate, renderSourceNotes, startEdit, cancelEdit, saveEdit, openProvenance, runExport, bindEvents, showFile, handlePipelineEvent, updateGenerateButton, runGenerate, consumeNdjson, renderEvaluationState, runEvaluation };", context);
  const ui = context.ui;
  ui.bindEvents();
  const original = { executed: true, passed: true, checks: [], warningCount: 0, errorCount: 0 };
  ui.state.skillId = "skill-a";
  ui.state.skill = { files: [] };
  ui.state.validation = original;
  ui.renderValidation(original, false);
  const text = (node: any): string => [node.textContent, ...node.children.map(text)].join(" ");
  return { ui, fetch, nodes, original, text, url };
}
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data });
const decoded = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("UI request ownership and errors", () => {
  it("enables PDF generation only with a path and submits the local-path contract", async () => {
    const h = harness();
    h.ui.state.activeTab = "pdf";
    h.ui.updateGenerateButton();
    expect(h.nodes.get("#generate-btn").disabled).toBe(true);
    h.nodes.get("#source-pdf-path").value = "  docs/guide.pdf  ";
    h.nodes.get("#source-pdf-path").listeners.get("input")();
    expect(h.nodes.get("#generate-btn").disabled).toBe(false);
    h.fetch.mockResolvedValueOnce(response({ error: "fixture stops before generation" }, false));
    await h.ui.runGenerate();
    expect(h.fetch.mock.calls[0]![0]).toBe("/api/generate");
    expect(JSON.parse(h.fetch.mock.calls[0]![1].body)).toMatchObject({ sourceType: "pdf", path: "docs/guide.pdf" });
    expect(h.ui.state.sourceType).toBe("pdf");
  });

  it("rejects an older revalidation response even when its JSON finishes last", async () => {
    const h = harness();
    const old = deferred<any>();
    h.fetch.mockResolvedValueOnce({ ok: true, json: () => old.promise });
    const first = h.ui.revalidate();
    await decoded();
    expect(h.nodes.get("#revalidate-btn").disabled).toBe(true);
    const newest = { ...h.original, warningCount: 3 };
    h.fetch.mockResolvedValueOnce(response({ validation: newest }));
    await h.ui.revalidate();
    old.resolve({ validation: { ...h.original, passed: false } });
    await first;
    expect(h.ui.state.validation).toBe(newest);
    expect(h.nodes.get("#revalidate-btn").disabled).toBe(false);
  });

  it("unrelated provenance work does not invalidate revalidation", async () => {
    const h = harness();
    const validation = deferred<any>();
    h.fetch.mockResolvedValueOnce({ ok: true, json: () => validation.promise });
    const pending = h.ui.revalidate();
    await decoded();
    h.fetch.mockResolvedValueOnce(response({ source: {}, returned: { start: 1, end: 1 }, totalLines: 1, text: "source" }));
    await h.ui.openProvenance({ extraction: "test", sourceLines: [1, 1] });
    const latest = { ...h.original, warningCount: 2 };
    validation.resolve({ validation: latest });
    await pending;
    expect(h.ui.state.validation).toBe(latest);
  });

  it.each(["network", "HTTP"])("shows %s revalidation failure and keeps the last report", async (kind) => {
    const h = harness();
    if (kind === "network") h.fetch.mockRejectedValueOnce(new Error("offline"));
    else h.fetch.mockResolvedValueOnce(response({ error: "unavailable" }, false));
    await h.ui.revalidate();
    expect(h.ui.state.validation).toBe(h.original);
    expect(h.nodes.get("#validation-request-status").textContent).toContain("Revalidation failed");
    expect(h.nodes.get("#revalidate-btn").disabled).toBe(false);
  });

  it.each(["network", "HTTP"])("preserves known source notes on %s failure", async (kind) => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response({ source: { notes: ["Tree listing truncated"] } }));
    await h.ui.renderSourceNotes();
    if (kind === "network") h.fetch.mockRejectedValueOnce(new Error("offline"));
    else h.fetch.mockResolvedValueOnce(response({ error: "unavailable" }, false));
    await h.ui.renderSourceNotes();
    const shown = h.text(h.nodes.get("#source-notes"));
    expect(shown).toContain("Tree listing truncated");
    expect(shown).toContain("Could not reload source notes");
  });

  it("discards stale source notes after body decoding", async () => {
    const h = harness();
    const older = deferred<any>();
    h.fetch.mockResolvedValueOnce({ ok: true, json: () => older.promise });
    const first = h.ui.renderSourceNotes();
    await decoded();
    h.fetch.mockResolvedValueOnce(response({ source: { notes: ["Current notes"] } }));
    await h.ui.renderSourceNotes();
    older.resolve({ source: { notes: ["Obsolete notes"] } });
    await first;
    expect(h.ui.state.sourceNotes).toEqual(["Current notes"]);
  });

  it("a canceled edit cannot apply a response whose JSON was still pending", async () => {
    const h = harness();
    const before = h.ui.state.skill;
    h.ui.startEdit({ path: "SKILL.md", content: "old" });
    const body = deferred<any>();
    h.fetch.mockResolvedValueOnce({ ok: true, json: () => body.promise });
    const save = h.ui.saveEdit();
    await decoded();
    h.ui.cancelEdit();
    body.resolve({ skill: { files: [] }, validation: { passed: false } });
    await save;
    expect(h.ui.state.skill).toBe(before);
    expect(h.ui.state.validation).toBe(h.original);
    h.ui.startEdit({ path: "SKILL.md", content: "next" });
    expect(h.nodes.get("#file-edit-cancel").disabled).toBe(false);
  });

  it("a saved edit supersedes validation and downloads for the previous package", async () => {
    const h = harness();
    const validationBody = deferred<any>();
    const zipBody = deferred<Blob>();
    h.fetch.mockResolvedValueOnce({ ok: true, json: () => validationBody.promise });
    const validation = h.ui.revalidate();
    h.fetch.mockResolvedValueOnce({ ok: true, blob: () => zipBody.promise });
    const download = h.ui.runExport("generic");
    await decoded();
    h.ui.startEdit({ path: "SKILL.md", content: "changed" });
    const edited = { files: [{ path: "SKILL.md", content: "changed", userEdited: true }] };
    const report = { ...h.original, passed: false, errorCount: 1 };
    h.fetch.mockResolvedValueOnce(response({ skill: edited, validation: report }));
    await h.ui.saveEdit();
    validationBody.resolve({ validation: h.original });
    zipBody.resolve(new Blob(["obsolete zip"]));
    await Promise.all([validation, download]);
    expect(h.ui.state.skill).toBe(edited);
    expect(h.ui.state.validation).toBe(report);
    expect(h.url.createObjectURL).not.toHaveBeenCalled();
    expect(h.nodes.get("#revalidate-btn").disabled).toBe(false);
  });

  it("a saved edit invalidates an in-flight evaluation for the previous package (F-03)", async () => {
    const h = harness();
    const evalBody = deferred<any>();
    h.fetch.mockResolvedValueOnce({ ok: true, json: () => evalBody.promise });
    const evaluation = h.ui.runEvaluation();
    await decoded();
    h.ui.startEdit({ path: "SKILL.md", content: "changed" });
    const edited = { files: [{ path: "SKILL.md", content: "changed", userEdited: true }] };
    const report = { ...h.original, passed: false, errorCount: 1 };
    h.fetch.mockResolvedValueOnce(response({ skill: edited, validation: report }));
    await h.ui.saveEdit();
    const staleReport = { executed: true, counts: { passed: 1, concern: 0, notExecutable: 0 }, checks: [] };
    evalBody.resolve({ evaluation: staleReport });
    await evaluation;
    expect(h.ui.state.skill).toBe(edited);
    expect(h.ui.state.evaluation).not.toBe(staleReport);
    expect(h.ui.state.evaluationSkillId).not.toBe("skill-a");
  });

  it("a stale export error cannot replace the new skill's validation", async () => {
    const h = harness();
    const body = deferred<any>();
    h.fetch.mockResolvedValueOnce({ ok: false, status: 422, json: () => body.promise });
    const pending = h.ui.runExport("generic");
    await decoded();
    h.ui.state.skillId = "skill-b";
    body.resolve({ error: "obsolete", validation: { passed: false } });
    await pending;
    expect(h.ui.state.validation).toBe(h.original);
    expect(h.url.createObjectURL).not.toHaveBeenCalled();
  });

  it("superseded export blobs are not downloaded and failures stay visible after cleanup", async () => {
    const h = harness();
    const body = deferred<Blob>();
    h.fetch.mockResolvedValueOnce({ ok: true, blob: () => body.promise });
    const first = h.ui.runExport("generic");
    await decoded();
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    await h.ui.runExport("claude-code");
    body.resolve(new Blob(["old zip"]));
    await first;
    expect(h.url.createObjectURL).not.toHaveBeenCalled();
    expect(h.nodes.get("#export-note").textContent).toContain("Export failed: offline");
  });
});

describe("initialized preview controls and truthful steps", () => {
  const file = { path: "SKILL.md", content: "Original instructions", purpose: "instructions" };
  const step = (h: ReturnType<typeof harness>, name: string) => h.nodes.get(`.step[data-stage="${name}"]`).classList;
  it("reveals the real Edit control according to store policy and restores preview on cancel/save/switch", async () => {
    const h = harness();
    const edit = h.nodes.get("#file-edit-btn");
    expect(edit.classList.contains("hidden")).toBe(true);
    const files = [file, ...["references/setup.md", "workflows/setup.md", "examples/setup.sh", "evals/README.md", "evals/evals.json", "manifest.json"].map((path) => ({ ...file, path }))];
    h.ui.state.skill = { files };
    for (const selected of files) {
      h.ui.showFile(h.ui.state.skill, selected.path);
      expect(edit.classList.contains("hidden")).toBe(!isEditablePath(selected.path));
    }
    h.ui.showFile(h.ui.state.skill, file.path);
    edit.click();
    expect(h.ui.state.editingPath).toBe(file.path);
    expect(edit.classList.contains("hidden")).toBe(true);
    expect(h.nodes.get("#file-edit-box").classList.contains("hidden")).toBe(false);
    h.nodes.get("#file-edit-cancel").click();
    expect(h.ui.state.editingPath).toBeNull();
    expect(edit.classList.contains("hidden")).toBe(false);
    edit.click();
    h.ui.showFile(h.ui.state.skill, "manifest.json");
    expect(h.ui.state.editingPath).toBeNull();
    expect(edit.classList.contains("hidden")).toBe(true);
    expect(h.nodes.get("#file-edit-box").classList.contains("hidden")).toBe(true);
    h.ui.showFile(h.ui.state.skill, file.path);
    edit.click();
    const updated = { files: [{ ...file, content: "Edited instructions", userEdited: true }] };
    const failed = { ...h.original, passed: false, errorCount: 1 };
    h.fetch.mockResolvedValueOnce(response({ skill: updated, validation: failed }));
    await h.nodes.get("#file-edit-save").click();
    expect(h.ui.state.editingPath).toBeNull();
    expect(edit.classList.contains("hidden")).toBe(false);
    expect(h.nodes.get("#file-view-content").textContent).toBe("Edited instructions");
    expect(step(h, "validate").contains("error")).toBe(true);
    expect(step(h, "export").contains("active")).toBe(false);
  });
  it("uses validation outcomes rather than generic stage completion", async () => {
    const h = harness();
    h.ui.handlePipelineEvent({ type: "stage", stage: "validate", status: "start" });
    expect(step(h, "validate").contains("active")).toBe(true);
    h.ui.handlePipelineEvent({ type: "stage", stage: "validate", status: "done" });
    expect(step(h, "validate").contains("done")).toBe(false);
    for (const [executed, passed, expected] of [[true, true, "done"], [true, false, "error"], [false, false, "idle"]] as const) {
      h.fetch.mockResolvedValueOnce(response({ source: { notes: [] } }));
      h.ui.handlePipelineEvent({ type: "result", skill: { id: "skill-a", files: [file], meta: { displayName: "Test", generator: "mock", gaps: [] } }, validation: { ...h.original, executed, passed } });
      expect(step(h, "validate").contains("done")).toBe(expected === "done");
      expect(step(h, "validate").contains("error")).toBe(expected === "error");
      expect(step(h, "export").contains("active")).toBe(false);
      await decoded();
    }
    const pending = deferred<any>();
    h.fetch.mockReturnValueOnce(pending.promise);
    const validation = h.ui.revalidate();
    expect(step(h, "validate").contains("active")).toBe(true);
    pending.resolve(response({ validation: { ...h.original, passed: false } }));
    await validation;
    expect(step(h, "validate").contains("error")).toBe(true);
    h.fetch.mockResolvedValueOnce(response({ validation: h.original }));
    await h.ui.revalidate();
    expect(step(h, "validate").contains("done")).toBe(true);
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    await h.ui.revalidate();
    expect(step(h, "validate").contains("error")).toBe(true);
  });
  it("marks export active only during its operation, then done or error", async () => {
    const h = harness();
    const pending = deferred<any>();
    h.fetch.mockReturnValueOnce(pending.promise);
    const exporting = h.ui.runExport("generic");
    expect(step(h, "export").contains("active")).toBe(true);
    pending.resolve({ ok: true, blob: async () => new Blob(["zip"]), headers: new Headers() });
    await exporting;
    expect(step(h, "export").contains("done")).toBe(true);
    h.fetch.mockResolvedValueOnce(response({ error: "blocked", validation: { ...h.original, passed: false } }, false));
    await h.ui.runExport("generic");
    expect(step(h, "export").contains("error")).toBe(true);
    expect(step(h, "validate").contains("done")).toBe(false);
  });
  it.each([
    ["https://[2606:4700::1111]/docs", true], ["http://[2606:4700::1111]", true],
    ["https://example.com/docs", true], ["http://8.8.8.8/docs", true],
    ["file:///docs", false], ["not a URL", false], ["https://[broken]", false], ["https://user:pass@example.com", false],
  ])("URL eligibility for %s is %s", (url, allowed) => {
    const h = harness();
    h.ui.state.activeTab = "url";
    h.nodes.get("#source-url").value = url;
    h.ui.updateGenerateButton();
    expect(h.nodes.get("#generate-btn").disabled).toBe(!allowed);
  });
});


describe("advisory evaluation summary styling (A-03, F-02)", () => {
  function rendered(counts: { passed: number; concern: number; notExecutable: number }) {
    const h = harness();
    const checks = [
      ...(counts.passed > 0
        ? [{ id: "eval-1", title: "Topic", status: "pass", message: "Retained and discoverable.", filePath: "references/setup.md" }]
        : []),
      ...(counts.concern > 0
        ? [{ id: "eval-2", title: "Topic", status: "concern", message: "No SKILL.md link.", filePath: "references/other.md" }]
        : []),
      ...(counts.notExecutable > 0
        ? [{ id: "eval-3", title: "Manual", status: "not-executable", message: "Manual grounding question." }]
        : []),
    ];
    h.ui.state.evaluation = { executed: true, counts, checks };
    h.ui.state.evaluationSkillId = "skill-a";
    h.ui.renderEvaluationState();
    return h;
  }
  it("does not style an executed report with concerns as an aggregate pass", () => {
    const h = rendered({ passed: 0, concern: 2, notExecutable: 4 });
    const head = h.nodes.get("#evaluation-head");
    expect(head.className).toContain("concern");
    expect(head.className).not.toContain("pass");
    expect(h.text(head)).toContain("2 concern(s)");
    expect(h.text(head)).toContain("4 not executable / manual");
  });
  it("keeps the pass treatment only when every check is executable and passed", () => {
    const h = rendered({ passed: 3, concern: 0, notExecutable: 0 });
    const head = h.nodes.get("#evaluation-head");
    expect(head.className).toContain("pass");
    expect(h.text(head)).toContain("3 passed");
  });
  it("gives a mixed pass/manual report neutral treatment, not aggregate pass or failure", () => {
    const h = rendered({ passed: 3, concern: 0, notExecutable: 1 });
    const head = h.nodes.get("#evaluation-head");
    expect(head.className).toContain("neutral");
    expect(head.className).not.toContain("pass");
    expect(head.className).not.toContain("concern");
    expect(head.className).not.toContain("fail");
    expect(h.text(head)).toContain("3 passed");
    expect(h.text(head)).toContain("1 not executable / manual");
  });
  it("gives an all-manual report neutral treatment with honest counts", () => {
    const h = rendered({ passed: 0, concern: 0, notExecutable: 4 });
    const head = h.nodes.get("#evaluation-head");
    expect(head.className).toContain("neutral");
    expect(head.className).not.toContain("pass");
    expect(head.className).not.toContain("concern");
    expect(head.className).not.toContain("fail");
    expect(h.text(head)).toContain("4 not executable / manual");
    const statuses = h.nodes.get("#evaluation-checks").children.map((row: any) => row.children[0].textContent);
    expect(statuses).toEqual(["○ not-executable"]);
  });
  it("still renders checks, advisory copy, and the re-run control", () => {
    const h = rendered({ passed: 1, concern: 1, notExecutable: 1 });
    expect(h.nodes.get("#evaluation-checks").children.length).toBe(3);
    expect(h.text(h.nodes.get("#evaluation-head"))).toContain("does not gate export");
    expect(h.nodes.get("#evaluate-btn")).toBeDefined();
  });
});

describe("generation stream terminal protocol", () => {
  const start = { type: "stage", stage: "generate", status: "start" };
  const result = { type: "result", skill: { id: "new-skill", files: [], meta: { displayName: "Stream result", generator: "mock", gaps: [] } }, validation: { executed: true, passed: true, checks: [], errorCount: 0, warningCount: 0 } };
  function streamed(text: string) {
    return { ok: true, headers: new Headers(), body: new ReadableStream<Uint8Array>({ start(controller) {
      // Small chunks exercise partial JSON and multi-byte UTF-8 boundaries.
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }) };
  }
  async function generate(text: string) {
    const h = harness();
    h.fetch.mockResolvedValueOnce(streamed(text)).mockResolvedValue(response({ source: { notes: [] } }));
    await h.ui.runGenerate();
    return h;
  }
  const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
  it("accepts exactly one result, an optional done trailer, and final JSON without newline", async () => {
    for (const trailing of ["", '\n{"type":"done"}\n']) {
      const h = await generate(lines(start, { type: "source-note", note: "café 東京" }, result) + trailing);
      expect(h.ui.state.skillId).toBe("new-skill");
      expect(h.ui.state.running).toBe(false);
      expect(h.nodes.get("#generate-error").classList.contains("hidden")).toBe(true);
    }
  });
  it("renders an explicit terminal error and clears active stages", async () => {
    const h = await generate(lines(start, { type: "error", code: "provider_failed", message: "Provider failed", stage: "generate" }, { type: "done" }));
    expect(h.text(h.nodes.get("#generate-error"))).toContain("Provider failed");
    expect(h.ui.state.skillId).toBeNull();
    expect(h.nodes.get('.step[data-stage="generate"]').classList.contains("error")).toBe(true);
    expect(h.nodes.get('.step[data-stage="ingest"]').classList.contains("active")).toBe(false);
  });
  it.each(["", lines(start), lines(start, { type: "stage", stage: "validate", status: "start" }), lines(start, { type: "done" })])("rejects incomplete EOF: %s", async (text) => {
    const h = await generate(text);
    expect(h.text(h.nodes.get("#generate-error"))).toContain("incomplete stream");
    expect(h.ui.state.running).toBe(false);
    expect(h.ui.state.skillId).toBeNull();
    expect(h.nodes.get('.step[data-stage="validate"]').classList.contains("active")).toBe(false);
    expect(h.nodes.get('.step[data-stage="generate"]').classList.contains("error")).toBe(true);
  });
  it.each([lines(start) + "\n{broken", lines(start, result) + "\nnot json\n", lines(null), lines(result, result), lines(result, { type: "error" })])("rejects corrupted or duplicate terminal streams: %s", async (text) => {
    const h = await generate(text);
    expect(h.text(h.nodes.get("#generate-error"))).toContain("protocol failure");
    expect(h.ui.state.skillId).toBeNull();
    expect(h.nodes.get("#results").classList.contains("hidden")).toBe(true);
    expect(h.nodes.get('.step[data-stage="validate"]').classList.contains("done")).toBe(false);
  });
  it.each(["EOF", "late result", "malformed line"])("ignores obsolete %s after a new generation owns the page", async (ending) => {
    const h = harness();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const oldBody = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    h.fetch.mockResolvedValueOnce({ ok: true, body: oldBody, headers: new Headers() });
    const old = h.ui.runGenerate();
    await decoded();
    // Model the established generation token invalidation mechanism.
    h.ui.state.generationSeq++;
    h.ui.state.running = false;
    h.fetch.mockResolvedValueOnce(streamed(lines(result))).mockResolvedValue(response({ source: { notes: [] } }));
    await h.ui.runGenerate();
    if (ending !== "EOF") controller.enqueue(new TextEncoder().encode(ending === "late result" ? lines({ ...result, skill: { ...result.skill, id: "obsolete" } }) : "broken"));
    controller.close();
    await old;
    expect(h.ui.state.skillId).toBe("new-skill");
    expect(h.nodes.get("#generate-error").classList.contains("hidden")).toBe(true);
  });
});
