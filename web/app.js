/* SkillForge UI logic — vanilla JS, no dependencies. */
"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  health: null,
  samples: [],
  exporters: [],
  selectedSampleId: null,
  running: false,
  skillId: null,
  skill: null,
  validation: null,
  evaluation: null,
  evaluationSkillId: null,
  activeTab: "sample",
  exportTargets: [],
  editingPath: null,
  // Request ownership and sequence tokens (I-02)
  generationSeq: 0,
  sourceNotesSeq: 0,
  sourceNotes: null,
  sourceNotesSkillId: null,
  validateSeq: 0,
  evaluationSeq: 0,
  editSeq: 0,
  provenanceSeq: 0,
  exportSeq: 0,
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  await loadHealth();
  await Promise.all([loadSamples(), loadExporters()]);
  bindEvents();
  updateGenerateButton();
}

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    state.health = await res.json();
    const pill = $("#provider-pill");
    if (state.health.offlineDemo) {
      pill.textContent = "Demo provider · offline · no API key needed";
      pill.classList.add("ok");
    } else if (state.health.providerUsesApiKey) {
      pill.textContent = `Provider: ${state.health.provider} (API key configured)`;
      pill.classList.add("ok");
    } else {
      pill.textContent = `Provider: ${state.health.provider} — missing API key; use demo`;
    }
  } catch {
    $("#provider-pill").textContent = "API unavailable";
  }
}

async function loadSamples() {
  const res = await fetch("/api/samples");
  const data = await res.json();
  state.samples = data.samples ?? [];
  const list = $("#sample-list");
  for (const sample of state.samples) {
    const card = document.createElement("button");
    card.className = "sample-card";
    card.type = "button";
    card.dataset.id = sample.id;
    const h = document.createElement("h4");
    h.textContent = sample.title;
    const p = document.createElement("p");
    p.textContent = sample.description;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = `${sample.id} · ${(sample.sizeBytes / 1024).toFixed(1)} KB · bundled sample`;
    card.append(h, p, size);
    card.addEventListener("click", () => selectSample(sample.id));
    list.append(card);
  }
}

async function loadExporters() {
  const res = await fetch("/api/exporters");
  const data = await res.json();
  state.exporters = data.targets ?? [];
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeTab = tab.dataset.tab;
      // Show exactly the body belonging to the active tab.
      document.querySelectorAll(".tab-body").forEach((body) => {
        body.classList.toggle("hidden", body.id !== `tab-${state.activeTab}`);
      });
      updateGenerateButton();
    });
  });

  $("#source-text").addEventListener("input", () => {
    const len = $("#source-text").value.length;
    $("#text-stats").textContent = `${len.toLocaleString()} characters`;
    updateGenerateButton();
  });

  $("#source-url").addEventListener("input", updateGenerateButton);
  $("#source-path").addEventListener("input", updateGenerateButton);
  $("#source-pdf-path").addEventListener("input", updateGenerateButton);
  $("#source-repo").addEventListener("input", updateGenerateButton);

  $("#prov-close").addEventListener("click", () => $("#provenance-dialog").close());

  $("#file-edit-btn").addEventListener("click", () => {
    const file = state.skill?.files.find((f) => f.path === $("#file-view-path").textContent);
    if (file) startEdit(file);
  });
  $("#file-edit-cancel").addEventListener("click", cancelEdit);
  $("#file-edit-save").addEventListener("click", saveEdit);
  $("#file-edit-textarea").addEventListener("input", () => {
    if (state.editingPath !== null) {
      $("#file-edit-status").textContent = "Editing — unsaved changes are local only.";
    }
  });

  $("#generate-btn").addEventListener("click", runGenerate);
}

function updateGenerateButton() {
  const btn = $("#generate-btn");
  if (state.running) {
    btn.disabled = true;
    return;
  }
  if (state.activeTab === "sample") {
    btn.disabled = !state.selectedSampleId;
    btn.textContent = state.selectedSampleId ? "Generate skill" : "Select a sample first";
  } else if (state.activeTab === "text") {
    const len = $("#source-text").value.trim().length;
    btn.disabled = len < 40;
    btn.textContent = len < 40 ? `Paste at least 40 characters (${len} so far)` : "Generate skill";
  } else if (state.activeTab === "url") {
    const url = $("#source-url").value.trim();
    let ok = false;
    try {
      const parsed = new URL(url);
      ok = ["http:", "https:"].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password;
    } catch { /* invalid URL */ }
    btn.disabled = !ok;
    btn.textContent = ok ? "Generate skill" : "Enter an http(s) URL";
  } else if (state.activeTab === "github") {
    const repo = $("#source-repo").value.trim();
    const ok = /^https:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+/.test(repo);
    btn.disabled = !ok;
    btn.textContent = ok ? "Generate skill" : "Enter a github.com repository URL";
  } else if (state.activeTab === "pdf") {
    const p = $("#source-pdf-path").value.trim();
    btn.disabled = p.length === 0;
    btn.textContent = p.length > 0 ? "Generate skill" : "Enter a server-side PDF path";
  } else if (state.activeTab === "file") {
    const p = $("#source-path").value.trim();
    btn.disabled = p.length === 0;
    btn.textContent = p.length > 0 ? "Generate skill" : "Enter a workspace-relative path";
  }
}

function selectSample(id) {
  state.selectedSampleId = id;
  document.querySelectorAll(".sample-card").forEach((c) => {
    c.classList.toggle("selected", c.dataset.id === id);
  });
  updateGenerateButton();
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

function setStep(stage, status) {
  const el = document.querySelector(`.step[data-stage="${stage}"]`);
  if (!el) return;
  el.classList.remove("active", "done", "error");
  if (status) el.classList.add(status);
}

function resetStepper() {
  for (const stage of ["source", "ingest", "generate", "validate", "preview", "export"]) {
    setStep(stage, null);
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function logProgress(stageName, text, ms, isError) {
  const li = document.createElement("li");
  if (isError) li.className = "err";
  const name = document.createElement("span");
  name.className = "stage-name";
  name.textContent = stageName;
  const body = document.createElement("span");
  body.textContent = text;
  li.append(name, body);
  if (ms !== null && ms !== undefined) {
    const msEl = document.createElement("span");
    msEl.className = "ms";
    msEl.textContent = `${ms} ms`;
    li.append(msEl);
  }
  $("#progress-log").append(li);
}

async function runGenerate() {
  if (state.running) return;
  state.running = true;
  const genToken = ++state.generationSeq;
  // Changing the displayed generation invalidates its outstanding requests,
  // even if a later result happens to reuse the same skill ID.
  for (const key of ["sourceNotesSeq", "validateSeq", "evaluationSeq", "editSeq", "provenanceSeq", "exportSeq"]) state[key]++;
  cancelEdit();
  state.skillId = null;
  state.skill = null;
  state.validation = null;
  state.evaluation = null;
  state.evaluationSkillId = null;
  updateGenerateButton();
  $("#generate-error").classList.add("hidden");
  $("#progress-log").innerHTML = "";
  $("#progress-box").classList.remove("hidden");
  $("#empty-state").classList.add("hidden");
  $("#results").classList.add("hidden");
  resetStepper();
  setStep("source", "done");
  setStep("ingest", "active");

  const body =
    state.activeTab === "sample"
      ? { sourceType: "sample", sampleId: state.selectedSampleId }
      : state.activeTab === "pdf"
        ? { sourceType: "pdf", path: $("#source-pdf-path").value.trim() }
      : state.activeTab === "url"
        ? { sourceType: "url", url: $("#source-url").value.trim() }
        : state.activeTab === "github"
          ? {
              sourceType: "github",
              repo: $("#source-repo").value.trim(),
              mode: document.querySelector('input[name="github-mode"]:checked')?.value ?? "docs",
            }
          : state.activeTab === "file"
            ? {
                sourceType: "file",
                path: $("#source-path").value.trim(),
                recursive: $("#source-recursive").checked,
              }
            : {
                sourceType: "text",
                content: $("#source-text").value,
                name: $("#source-name").value.trim() || undefined,
              };
  const requestedName = $("#requested-name").value.trim();
  if (requestedName) body.requestedName = requestedName;
  state.sourceType = body.sourceType === "github" && body.mode === "codebase" ? "github-codebase" : body.sourceType;

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (state.generationSeq !== genToken) return;
    if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
      const err = await res.json();
      throw new Error(`${err.error}${err.detail ? ` (${err.detail})` : ""}`);
    }
    await consumeNdjson(
      res,
      (ev) => {
        if (state.generationSeq === genToken) {
          handlePipelineEvent(ev);
        }
      },
      () => state.generationSeq === genToken,
    );
  } catch (err) {
    if (state.generationSeq === genToken) {
      resetStepper();
      setStep("generate", "error");
      state.skillId = null;
      state.skill = null;
      state.validation = null;
      $("#results").classList.add("hidden");
      showFatal(err.message || String(err));
    }
  } finally {
    if (state.generationSeq === genToken) {
      state.running = false;
      updateGenerateButton();
    }
  }
}

async function consumeNdjson(res, onEvent, isValid = () => true) {
  if (!res.body) throw new Error("Generation stream has no response body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalSeen = false;
  const consumeLine = (line) => {
    if (!line.trim() || !isValid()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error("Generation stream protocol failure: malformed NDJSON."); }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      throw new Error("Generation stream protocol failure: invalid event.");
    }
    if (event.type === "result" || event.type === "error") {
      if (terminalSeen) throw new Error("Generation stream protocol failure: duplicate terminal outcome.");
      terminalSeen = true;
    } else if (terminalSeen && event.type !== "done") {
      throw new Error("Generation stream protocol failure: event after terminal outcome.");
    }
    onEvent(event);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (!isValid()) return;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        consumeLine(line);
      }
    }
    if (!isValid()) return;
    buffer += decoder.decode();
    consumeLine(buffer); // A final JSON event need not end with a newline.
    if (!terminalSeen) throw new Error("Generation stream ended before a result or error (incomplete stream). Please try again.");
  } finally {
    // Release pending transport on malformed or obsolete streams as well as EOF.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Pipeline stage → stepper element (the "Analyze" step covers ingest+analyze).
const STEP_FOR_STAGE = { ingest: "ingest", analyze: "ingest", generate: "generate", validate: "validate" };
// Raw pipeline stage names for the progress log.
const LOG_LABEL = { ingest: "ingest", analyze: "analyze", generate: "generate", validate: "validate" };

function handlePipelineEvent(ev) {
  if (ev.type === "stage") {
    const step = STEP_FOR_STAGE[ev.stage] ?? ev.stage;
    if (ev.status === "start") {
      setStep(step, "active");
      logProgress(LOG_LABEL[ev.stage] ?? ev.stage, "running…", null, false);
    } else if (ev.status === "done") {
      // Validation completion is not proof of a passing report.
      if (step !== "validate") setStep(step, "done");
      logProgress(LOG_LABEL[ev.stage] ?? ev.stage, ev.detail ?? "done", ev.ms, false);
    }
  } else if (ev.type === "source-note") {
    // Adapter ingestion notes (truncation, skipped files, redirects) are part
    // of the honest record — shown individually, never folded into a stage line.
    logProgress("source note", ev.note, null, false);
  } else if (ev.type === "error") {
    for (const stage of ["ingest", "generate", "validate"]) {
      if ($(`.step[data-stage="${stage}"]`)?.classList.contains("active")) setStep(stage, null);
    }
    const step = STEP_FOR_STAGE[ev.stage] ?? ev.stage ?? "ingest";
    setStep(step, "error");
    logProgress(LOG_LABEL[ev.stage] ?? ev.stage ?? "pipeline", `${ev.message} [${ev.code}]`, null, true);
    showFatal(`${ev.message} (stage: ${ev.stage}, code: ${ev.code})`);
  } else if (ev.type === "result") {
    setStep("preview", "done");
    setStep("export", null);
    renderResults(ev.skill, ev.validation);
  }
}

function showFatal(message) {
  const box = $("#generate-error");
  box.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = "Generation failed.";
  const p = document.createElement("div");
  p.textContent = message;
  box.append(strong, p);
  box.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------

function renderResults(skill, validation) {
  state.skillId = skill.id;
  state.skill = skill;
  state.validation = validation;

  $("#skill-title").textContent = skill.meta.displayName;
  $("#skill-subtitle").textContent =
    `id: ${skill.id} · generator: ${skill.meta.generator} · ${skill.files.length} files · source: ${skill.plan ? "" : ""}` +
    `${analysisSummary(skill)}`;

  const badges = $("#skill-badges");
  badges.innerHTML = "";
  addBadge(badges, skill.meta.generator === "mock" ? "offline demo provider" : `provider: ${skill.meta.generator}`, "ok");
  if (state.sourceType === "github-codebase") {
    addBadge(badges, "GitHub codebase mode — bounded, prioritized repository inspection", "ok");
  }
  addBadge(badges, `${skill.meta.gaps.length} gap(s) marked`, skill.meta.gaps.length > 0 ? "warn" : "ok");
  const editedCount = (skill.files ?? []).filter((f) => f.userEdited).length;
  if (editedCount > 0) {
    addBadge(badges, `${editedCount} file(s) user-edited — provenance not claimed for them`, "warn");
  }
  if (validation.executed) {
    addBadge(badges, `${validation.checks.length} deterministic checks`, "ok");
    if (validation.warningCount > 0) addBadge(badges, `${validation.warningCount} warning(s)`, "warn");
  } else {
    addBadge(badges, "validation not executed", "warn");
  }

  renderValidation(validation, true);
  renderEvaluationState();
  renderFiles(skill);
  renderExportCards();
  renderSourceNotes();
  $("#results").classList.remove("hidden");
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Persisted adapter ingestion notes (truncation, skipped files) — kept with
 * the skill so the record stays honest after a reload. Rendered as safe text. */
function paintSourceNotes(status = "") {
  const box = $("#source-notes");
  if (!box) return;
  box.innerHTML = "";
  const notes = state.sourceNotes;
  if (!status && (!notes || notes.length === 0)) {
    box.classList.add("hidden");
    return;
  }
  const h = document.createElement("h2");
  h.textContent = "Source notes";
  const ul = document.createElement("ul");
  ul.className = "source-notes-list";
  for (const note of notes ?? []) {
    const li = document.createElement("li");
    li.textContent = String(note);
    ul.append(li);
  }
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  message.textContent = status;
  box.append(h, ul, message);
  box.classList.remove("hidden");
}

async function renderSourceNotes() {
  if (!state.skillId) return;
  const skillId = state.skillId;
  const token = ++state.sourceNotesSeq;
  if (state.sourceNotesSkillId !== skillId) {
    state.sourceNotes = null;
    state.sourceNotesSkillId = skillId;
  }
  paintSourceNotes("Loading source notes…");
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}`);
    const data = await res.json();
    if (state.skillId !== skillId || state.sourceNotesSeq !== token) return;
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    state.sourceNotes = Array.isArray(data.source?.notes) ? data.source.notes : [];
    paintSourceNotes();
  } catch (err) {
    if (state.skillId !== skillId || state.sourceNotesSeq !== token) return;
    paintSourceNotes(`Could not reload source notes: ${err.message ?? err}. Previously loaded notes are retained when available.`);
  }
}

function analysisSummary(_skill) {
  return "generated from your source with line-range provenance";
}

function addBadge(parent, text, kind) {
  const b = document.createElement("span");
  b.className = `badge ${kind ?? ""}`;
  b.textContent = text;
  parent.append(b);
}

function renderValidation(validation, fresh) {
  setStep("validate", !validation.executed ? null : validation.passed ? "done" : "error");
  const banner = $("#validation-banner");
  banner.className = "validation-banner";
  banner.innerHTML = "";

  const head = document.createElement("div");
  if (!validation.executed) {
    banner.classList.add("skipped");
    head.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = "Validation was not executed — no success is claimed.";
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = validation.checks[0]?.message ?? "Run validation to obtain real results.";
    head.append(strong, sub);
  } else if (validation.passed) {
    banner.classList.add("pass");
    const strong = document.createElement("strong");
    strong.textContent = `Validation passed — ${validation.checks.length} deterministic checks, ${validation.warningCount} warning(s).`;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = fresh
      ? "Executed during generation. Warnings do not block export; errors would."
      : "Re-executed on demand.";
    head.append(strong, sub);
  } else {
    banner.classList.add("fail");
    const strong = document.createElement("strong");
    strong.textContent = `Validation failed — ${validation.errorCount} error(s), ${validation.warningCount} warning(s).`;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = "Errors block export. Fix the findings below or regenerate from a stronger source.";
    head.append(strong, sub);
  }
  banner.append(head);

  const rerun = document.createElement("button");
  rerun.id = "revalidate-btn";
  rerun.className = "btn";
  rerun.style.marginTop = "8px";
  rerun.textContent = "Re-run validation";
  rerun.addEventListener("click", revalidate);
  const requestStatus = document.createElement("div");
  requestStatus.id = "validation-request-status";
  requestStatus.setAttribute("role", "status");
  banner.append(rerun, requestStatus);

  const checksEl = $("#validation-checks");
  checksEl.innerHTML = "";
  for (const check of validation.checks) {
    const row = document.createElement("div");
    row.className = "check";
    const status = document.createElement("span");
    status.className = `status ${check.status}`;
    status.textContent = check.status.toUpperCase();
    const bodyEl = document.createElement("div");
    bodyEl.className = "body";
    const title = document.createElement("div");
    title.textContent = check.title;
    bodyEl.append(title);
    if (check.message) {
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = check.message;
      bodyEl.append(msg);
    }
    if (check.filePath) {
      const loc = document.createElement("span");
      loc.className = "loc";
      loc.textContent = check.filePath;
      bodyEl.append(loc);
    }
    row.append(status, bodyEl);
    checksEl.append(row);
  }
}

// ---------------------------------------------------------------------------
// Evaluation (advisory, deterministic — distinct from validation)
// ---------------------------------------------------------------------------

const EVAL_STATUS_ICON = { pass: "✓", concern: "⚠", "not-executable": "○" };

function evaluationStatusLine(evaluation) {
  const parts = [];
  if (evaluation.counts.passed > 0) parts.push(`${evaluation.counts.passed} passed`);
  if (evaluation.counts.concern > 0) parts.push(`${evaluation.counts.concern} concern(s)`);
  if (evaluation.counts.notExecutable > 0) parts.push(`${evaluation.counts.notExecutable} not executable / manual`);
  return parts.length > 0 ? parts.join(", ") : "no evaluable checks";
}

function renderEvaluationState() {
  const head = $("#evaluation-head");
  const checksEl = $("#evaluation-checks");
  const stale = state.evaluation && state.evaluationSkillId !== state.skillId;
  head.innerHTML = "";
  checksEl.innerHTML = "";

  const strong = document.createElement("strong");  const sub = document.createElement("div");
  sub.className = "sub";
  const runBtn = document.createElement("button");
  runBtn.id = "evaluate-btn";
  runBtn.className = "btn";
  runBtn.style.marginTop = "8px";
  runBtn.addEventListener("click", runEvaluation);
  const status = document.createElement("div");
  status.id = "evaluation-request-status";
  status.setAttribute("role", "status");

  const evaluation = state.evaluation;
  const staleAfterEdit =
    evaluation && state.evaluationSkillId !== state.skillId;
  if (!evaluation) {
    head.className = "evaluation-head skipped";
    strong.textContent = "Evaluation not run — no quality claims are made.";
    sub.textContent = "Evaluation is advisory: it compares the package against source-derived expectations without executing anything.";
  } else if (staleAfterEdit) {
    head.className = "evaluation-banner skipped";
    strong.textContent = "Evaluation is stale — the package changed after this report was produced.";
    sub.textContent = evaluationStatusLine(evaluation) + " — this report described the package before the edit; re-run it for current results.";
  } else if (!evaluation.executed) {
    head.className = "evaluation-banner skipped";
    strong.textContent = "Evaluation could not run — no result is claimed.";
    sub.textContent = evaluation.checks[0]?.message ?? "Evaluation was skipped, not passed.";
  } else {
    head.className = "evaluation-banner pass";
    strong.textContent = `Evaluation — ${evaluationStatusLine(evaluation)}.`;
    sub.textContent = "Advisory source-coverage checks. This does not prove the skill works in a real agent runtime, and it does not gate export (validation does).";
  }
  head.append(strong, sub, runBtn, status);

  if (!evaluation || staleAfterEdit) return;
  for (const check of evaluation.checks) {
    const row = document.createElement("div");
    row.className = "check";
    const statusEl = document.createElement("span");
    statusEl.className = `status ${check.status === "pass" ? "pass" : check.status === "concern" ? "warn" : "skipped"}`;
    statusEl.textContent = `${EVAL_STATUS_ICON[check.status] ?? "○"} ${check.status}`;
    const bodyEl = document.createElement("div");
    bodyEl.className = "body";
    const title = document.createElement("div");
    title.textContent = check.title;
    bodyEl.append(title);
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = check.message;
    bodyEl.append(msg);
    if (check.filePath) {
      const loc = document.createElement("span");
      loc.className = "loc";
      loc.textContent = check.filePath;
      bodyEl.append(loc);
    }
    row.append(statusEl, bodyEl);
    checksEl.append(row);
  }
}

async function runEvaluation() {
  if (!state.skillId) return;
  const skillId = state.skillId;
  const token = ++state.evaluationSeq;
  const btn = $("#evaluate-btn");
  if (btn) btn.disabled = true;
  $("#evaluation-request-status").textContent = "Evaluating…";
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/evaluation`);
    if (state.skillId !== skillId || state.evaluationSeq !== token) return;
    const data = await res.json();
    if (state.skillId !== skillId || state.evaluationSeq !== token) return;
    if (!res.ok || !data.evaluation) throw new Error(data.error ?? `Evaluation failed (HTTP ${res.status}).`);
    state.evaluation = data.evaluation;
    state.evaluationSkillId = skillId;
    renderEvaluationState();
  } catch (err) {
    if (state.skillId !== skillId || state.evaluationSeq !== token) return;
    $("#evaluation-request-status").textContent = `Evaluation failed: ${err.message ?? err}. No result claimed.`;
  } finally {
    if (state.skillId === skillId && state.evaluationSeq === token && btn) {
      btn.disabled = false;
    }
  }
}

async function revalidate() {  if (!state.skillId) return;
  const skillId = state.skillId;
  const token = ++state.validateSeq;
  const revalidateBtn = $("#revalidate-btn");
  if (revalidateBtn) revalidateBtn.disabled = true;
  $("#validation-request-status").textContent = "Revalidating…";
  setStep("validate", "active");
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (state.skillId !== skillId || state.validateSeq !== token) return;
    const data = await res.json();
    if (state.skillId !== skillId || state.validateSeq !== token) return;
    if (!res.ok || !data.validation) throw new Error(data.error ?? `Revalidation failed (HTTP ${res.status}).`);
    if (data.validation) {
      state.validation = data.validation;
      renderValidation(data.validation, false);
      renderExportCards();
    }
  } catch (err) {
    if (state.skillId !== skillId || state.validateSeq !== token) return;
    setStep("validate", "error");
    $("#validation-request-status").textContent = `Revalidation failed: ${err.message ?? err}. Last validation result retained.`;
  } finally {
    if (state.skillId === skillId && state.validateSeq === token && revalidateBtn) {
      revalidateBtn.disabled = false;
    }
  }
}

const FILE_ORDER = (a, b) => {
  const rank = (p) => (p === "SKILL.md" ? 0 : p === "manifest.json" ? 99 : p.split("/")[0] === "references" ? 1 : p.split("/")[0] === "workflows" ? 2 : p.split("/")[0] === "examples" ? 3 : 4);
  return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
};

function renderFiles(skill, selectedPath) {
  const list = $("#file-list");
  list.innerHTML = "";
  const files = [...skill.files].sort(FILE_ORDER);
  const edited = files.filter((f) => f.userEdited).length;
  $("#file-count").textContent =
    `${files.length} files · every file carries a documented purpose` + (edited > 0 ? ` · ${edited} user-edited` : "");

  files.forEach((file, i) => {
    const li = document.createElement("li");
    li.dataset.path = file.path;
    const name = document.createElement("span");
    name.textContent = file.path + (file.userEdited ? " ✎" : "");
    const bytes = document.createElement("span");
    bytes.className = "bytes";
    bytes.textContent = `${(file.content.length / 1024).toFixed(1)}K`;
    li.append(name, bytes);
    li.addEventListener("click", () => showFile(skill, file.path));
    list.append(li);
  });
  showFile(skill, selectedPath ?? (files[0] ? files[0].path : ""));
}

function showFile(skill, path) {
  const file = skill.files.find((f) => f.path === path);
  if (!file) return;
  document.querySelectorAll("#file-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.path === path);
  });
  cancelEdit();
  $("#file-view-path").textContent = file.path;
  updateEditControl(file);
  const lines = file.content.split("\n").length;
  $("#file-view-meta").textContent =
    `${lines} lines · ${new Blob([file.content]).size} bytes` + (file.userEdited ? " · user-edited" : "");
  $("#file-view-purpose").textContent = `Purpose: ${file.purpose}`;
  const prov = (skill.provenance ?? []).filter((p) => p.filePath === path);
  const provEl = $("#file-view-provenance");
  provEl.innerHTML = "";
  if (file.userEdited) {
    provEl.textContent =
      "Provenance: this file was edited by you after generation, so its content is no longer claimed as source-derived.";
  } else if (prov.length > 0) {
    const label = document.createElement("span");
    label.textContent = "Provenance: ";
    provEl.append(label);
    prov.forEach((p, i) => {
      if (i > 0) provEl.append(document.createTextNode(" "));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prov-record";
      btn.textContent =
        `${p.extraction} — lines ${p.sourceLines[0]}–${p.sourceLines[1]}` +
        (p.sourceHeading ? `, under "${p.sourceHeading}"` : "") +
        " · view source ↗";
      btn.title = "Show the exact source lines supporting this content";
      btn.addEventListener("click", () => openProvenance(p));
      provEl.append(btn);
    });
    provEl.classList.remove("hidden");
  } else {
    provEl.textContent = "Provenance: synthesized by the generator (no verbatim excerpt).";
  }
  $("#file-view-content").textContent = file.content;
}

// ---------------------------------------------------------------------------
// Edit generated files before export
// ---------------------------------------------------------------------------

// Mirrors the store isEditablePath policy; a parity regression covers the file inventory.
function updateEditControl(file = state.skill?.files.find((f) => f.path === $("#file-view-path").textContent)) {
  $("#file-edit-btn").classList.toggle("hidden", !file || file.path === "manifest.json" || state.editingPath !== null);
}

function startEdit(file) {
  if (file.path === "manifest.json") return;
  state.editSeq++;
  state.editingPath = file.path;
  updateEditControl(file);
  $("#file-edit-cancel").disabled = false;
  $("#file-view-content").classList.add("hidden");
  $("#file-edit-box").classList.remove("hidden");
  const ta = $("#file-edit-textarea");
  ta.value = file.content;
  $("#file-edit-status").textContent = "Editing — unsaved changes are local only.";
  $("#file-edit-error").classList.add("hidden");
  $("#file-edit-save").disabled = false;
  ta.focus();
}

function cancelEdit() {
  state.editSeq++;
  state.editingPath = null;
  updateEditControl();
  const box = $("#file-edit-box");
  if (box) {
    box.classList.add("hidden");
    $("#file-view-content").classList.remove("hidden");
    $("#file-edit-error").classList.add("hidden");
  }
}

function showEditError(message) {
  const box = $("#file-edit-error");
  box.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = "Save failed.";
  const p = document.createElement("div");
  p.textContent = message;
  box.append(strong, p);
  box.classList.remove("hidden");
}

async function saveEdit() {
  if (state.editingPath === null || !state.skillId) return;
  const skillId = state.skillId;
  const path = state.editingPath;
  const token = ++state.editSeq;
  const content = $("#file-edit-textarea").value;
  const saveBtn = $("#file-edit-save");
  const cancelBtn = $("#file-edit-cancel");
  saveBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  $("#file-edit-status").textContent = "Saving…";
  $("#file-edit-error").classList.add("hidden");
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/update-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    if (state.skillId !== skillId || state.editingPath !== path || state.editSeq !== token) return;
    const data = await res.json().catch(() => ({}));
    if (state.skillId !== skillId || state.editingPath !== path || state.editSeq !== token) return;
    if (!res.ok) {
      showEditError(data.error ?? `Save failed (HTTP ${res.status}).`);
      saveBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      $("#file-edit-status").textContent = "Not saved — fix the error or cancel.";
      return;
    }
    // The server persisted the edit, re-ran deterministic validation, and
    // returned the full updated package + validation.
    // Pending validation/downloads refer to the package before this edit.
    state.validateSeq++;
    state.exportSeq++;
    setStep("export", null);
    state.skill = data.skill;
    state.validation = data.validation;
    if (state.evaluation && state.evaluationSkillId === skillId) {
      state.evaluationSkillId = null;
    }
    cancelEdit();
    renderValidation(data.validation, false);
    renderEvaluationState();
    renderFiles(data.skill, path);
    renderExportCards();
  } catch (err) {
    if (state.skillId !== skillId || state.editingPath !== path || state.editSeq !== token) return;
    showEditError(err.message ?? String(err));
    saveBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    $("#file-edit-status").textContent = "Not saved — network error.";
  }
}

// ---------------------------------------------------------------------------
// Provenance click-through
// ---------------------------------------------------------------------------

async function openProvenance(record) {
  if (!state.skillId) return;
  const skillId = state.skillId;
  const token = ++state.provenanceSeq;
  const dlg = $("#provenance-dialog");
  const [start, end] = record.sourceLines;
  $("#prov-extraction").textContent = `Extraction: ${record.extraction}`;
  $("#prov-meta").textContent = "Loading source excerpt…";
  $("#prov-lines").textContent = "";
  dlg.showModal();

  try {
    const res = await fetch(
      `/api/skills/${encodeURIComponent(skillId)}/provenance/excerpt?start=${start}&end=${end}`,
    );
    if (state.skillId !== skillId || state.provenanceSeq !== token) return;
    const data = await res.json().catch(() => ({}));
    if (state.skillId !== skillId || state.provenanceSeq !== token) return;
    if (!res.ok) {
      // Never fabricate an excerpt — surface the failure honestly.
      $("#prov-meta").textContent = "";
      $("#prov-lines").textContent = `Source excerpt unavailable (${res.status}): ${data.error ?? res.statusText}`;
      return;
    }
    const returned = data.returned ?? {};
    let meta = `source: ${data.source?.name ?? "?"} (${data.source?.type ?? "?"}) — lines ${returned.start}–${returned.end} of ${data.totalLines}`;
    if (data.partial) {
      meta += ` · PARTIAL excerpt (requested through line ${data.requestedEnd}; limit ${data.excerptLimit} lines)`;
    } else if (returned.end !== end) {
      meta += ` (requested up to ${end})`;
    }
    $("#prov-meta").textContent = meta;
    const bodyLines = String(data.text ?? "").split("\n");
    const width = String(returned.end).length;
    $("#prov-lines").textContent = bodyLines
      .map((line, i) => `${String(returned.start + i).padStart(width, " ")} │ ${line}`)
      .join("\n");
  } catch (err) {
    if (state.skillId !== skillId || state.provenanceSeq !== token) return;
    $("#prov-meta").textContent = "";
    $("#prov-lines").textContent = `Source excerpt unavailable: ${err.message ?? err}`;
  }
}

function renderExportCards(preserveNote = false) {
  const container = $("#export-cards");
  container.innerHTML = "";
  const validation = state.validation;
  const blocked = validation && validation.executed && !validation.passed;

  for (const target of state.exporters) {
    const card = document.createElement("div");
    card.className = "export-card";
    const h = document.createElement("h4");
    h.textContent = target.label;
    const p = document.createElement("p");
    p.textContent = target.description;
    const basis = document.createElement("div");
    basis.className = "basis";
    basis.textContent = target.formatBasis;
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.dataset.target = target.target;
    btn.textContent = blocked ? "Export blocked (validation errors)" : "Download ZIP";
    btn.disabled = Boolean(blocked);
    btn.addEventListener("click", () => runExport(target.target));
    card.append(h, p, btn, basis);
    container.append(card);
  }

  const note = $("#export-note");
  if (!preserveNote) note.textContent = blocked
    ? ""
    : "Export re-runs deterministic validation server-side before packaging; packages with errors are refused (HTTP 422).";
  // Replace (not stack) the blocked explanation across re-renders.
  document.querySelectorAll(".export-blocked").forEach((el) => el.remove());
  if (blocked) {
    const blockedBox = document.createElement("div");
    blockedBox.className = "export-blocked";
    blockedBox.textContent = "Export is blocked because deterministic validation reported errors. This gate is intentional: SkillForge never packages a package that failed validation.";
    container.after(blockedBox);
  }
}

async function runExport(target) {
  if (!state.skillId) return;
  const skillId = state.skillId;
  const token = ++state.exportSeq;
  setStep("export", "active");
  const exportButtons = document.querySelectorAll(".export-card button");
  exportButtons.forEach((btn) => {
    btn.disabled = true;
    if (btn.dataset.target === target) btn.textContent = "Downloading…";
  });
  const note = $("#export-note");
  note.textContent = `Preparing ${target} export package…`;

  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
    });
    if (state.skillId !== skillId || state.exportSeq !== token) return;
    if (!res.ok) {
      let message = `Export failed (HTTP ${res.status})`;
      try {
        const data = await res.json();
        if (state.skillId !== skillId || state.exportSeq !== token) return;
        message = data.error ?? message;
        if (data.validation) {
          state.validation = data.validation;
          renderValidation(data.validation, false);
          renderExportCards();
        }
      } catch { /* keep default message */ }
      if (state.skillId !== skillId || state.exportSeq !== token) return;
      setStep("export", "error");
      note.textContent = message;
      return;
    }
    const blob = await res.blob();
    if (state.skillId !== skillId || state.exportSeq !== token) return;
    const disposition = res.headers.get("content-disposition") ?? "";
    const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? `skillforge-${target}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    setStep("export", "done");
    const entries = res.headers.get("x-skillforge-entries");
    note.textContent = `Downloaded ${fileName} (${(blob.size / 1024).toFixed(1)} KB, ${entries ?? "?"} entries). Unzip it and drop the folder into your agent's skills directory.`;
  } catch (err) {
    if (state.skillId !== skillId || state.exportSeq !== token) return;
    setStep("export", "error");
    note.textContent = `Export failed: ${err.message ?? err}`;
  } finally {
    if (state.skillId === skillId && state.exportSeq === token) {
      renderExportCards(true);
    }
  }
}

init();
