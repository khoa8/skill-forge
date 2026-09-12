import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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
    classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
    set id(id: string) { nodes.set(`#${id}`, this); }
    set innerHTML(_value: string) { this.children = []; this.textContent = ""; }
    append(...children: any[]) { this.children.push(...children); }
    after() {}
    remove() {}
    addEventListener() {}
    setAttribute() {}
    focus() {}
    showModal() {}
    close() {}
    click() {}
    scrollIntoView() {}
  }
  const document = {
    querySelector: (selector: string) => {
      if (!nodes.has(selector) && !["#revalidate-btn", "#validation-request-status"].includes(selector)) nodes.set(selector, new Element());
      return nodes.get(selector) ?? null;
    },
    querySelectorAll: () => [],
    createElement: () => new Element(),
    body: new Element(),
  };
  const fetch = vi.fn();
  const url = { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() };
  const context: any = { document, fetch, URL: url, console, setTimeout: vi.fn(), TextDecoder, Blob };
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\ninit\(\);\s*$/, "");
  runInNewContext(source + "\nglobalThis.ui = { state, renderValidation, revalidate, renderSourceNotes, startEdit, cancelEdit, saveEdit, openProvenance, runExport };", context);
  const ui = context.ui;
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
