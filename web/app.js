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
  validation: null,
  activeTab: "sample",
  exportTargets: [],
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
      $("#tab-sample").classList.toggle("hidden", state.activeTab !== "sample");
      $("#tab-text").classList.toggle("hidden", state.activeTab !== "text");
      updateGenerateButton();
    });
  });

  $("#source-text").addEventListener("input", () => {
    const len = $("#source-text").value.length;
    $("#text-stats").textContent = `${len.toLocaleString()} characters`;
    updateGenerateButton();
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
  } else {
    const len = $("#source-text").value.trim().length;
    btn.disabled = len < 40;
    btn.textContent = len < 40 ? `Paste at least 40 characters (${len} so far)` : "Generate skill";
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
      : {
          sourceType: "text",
          content: $("#source-text").value,
          name: $("#source-name").value.trim() || undefined,
        };
  const requestedName = $("#requested-name").value.trim();
  if (requestedName) body.requestedName = requestedName;

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
      const err = await res.json();
      throw new Error(`${err.error}${err.detail ? ` (${err.detail})` : ""}`);
    }
    await consumeNdjson(res, handlePipelineEvent);
  } catch (err) {
    showFatal(err.message || String(err));
  } finally {
    state.running = false;
    updateGenerateButton();
  }
}

async function consumeNdjson(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        onEvent(JSON.parse(line));
      } catch (err) {
        console.error("Bad NDJSON line:", line, err);
      }
    }
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
      setStep(step, "done");
      logProgress(LOG_LABEL[ev.stage] ?? ev.stage, ev.detail ?? "done", ev.ms, false);
    }
  } else if (ev.type === "error") {
    const step = STEP_FOR_STAGE[ev.stage] ?? ev.stage ?? "ingest";
    setStep(step, "error");
    logProgress(LOG_LABEL[ev.stage] ?? ev.stage ?? "pipeline", `${ev.message} [${ev.code}]`, null, true);
    showFatal(`${ev.message} (stage: ${ev.stage}, code: ${ev.code})`);
  } else if (ev.type === "result") {
    setStep("preview", "done");
    setStep("export", "active");
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
  state.validation = validation;

  $("#skill-title").textContent = skill.meta.displayName;
  $("#skill-subtitle").textContent =
    `id: ${skill.id} · generator: ${skill.meta.generator} · ${skill.files.length} files · source: ${skill.plan ? "" : ""}` +
    `${analysisSummary(skill)}`;

  const badges = $("#skill-badges");
  badges.innerHTML = "";
  addBadge(badges, skill.meta.generator === "mock" ? "offline demo provider" : `provider: ${skill.meta.generator}`, "ok");
  addBadge(badges, `${skill.meta.gaps.length} gap(s) marked`, skill.meta.gaps.length > 0 ? "warn" : "ok");
  if (validation.executed) {
    addBadge(badges, `${validation.checks.length} deterministic checks`, "ok");
    if (validation.warningCount > 0) addBadge(badges, `${validation.warningCount} warning(s)`, "warn");
  } else {
    addBadge(badges, "validation not executed", "warn");
  }

  renderValidation(validation, true);
  renderFiles(skill);
  renderExportCards();
  $("#results").classList.remove("hidden");
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
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
  rerun.className = "btn";
  rerun.style.marginTop = "8px";
  rerun.textContent = "Re-run validation";
  rerun.addEventListener("click", revalidate);
  banner.append(rerun);

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

async function revalidate() {
  if (!state.skillId) return;
  const res = await fetch(`/api/skills/${encodeURIComponent(state.skillId)}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const data = await res.json();
  if (data.validation) {
    state.validation = data.validation;
    renderValidation(data.validation, false);
    renderExportCards();
  }
}

const FILE_ORDER = (a, b) => {
  const rank = (p) => (p === "SKILL.md" ? 0 : p === "manifest.json" ? 99 : p.split("/")[0] === "references" ? 1 : p.split("/")[0] === "workflows" ? 2 : p.split("/")[0] === "examples" ? 3 : 4);
  return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
};

function renderFiles(skill) {
  const list = $("#file-list");
  list.innerHTML = "";
  const files = [...skill.files].sort(FILE_ORDER);
  $("#file-count").textContent = `${files.length} files · every file carries a documented purpose`;

  files.forEach((file, i) => {
    const li = document.createElement("li");
    li.dataset.path = file.path;
    const name = document.createElement("span");
    name.textContent = file.path;
    const bytes = document.createElement("span");
    bytes.className = "bytes";
    bytes.textContent = `${(file.content.length / 1024).toFixed(1)}K`;
    li.append(name, bytes);
    li.addEventListener("click", () => showFile(skill, file.path));
    list.append(li);
    if (i === 0) showFile(skill, file.path);
  });
}

function showFile(skill, path) {
  const file = skill.files.find((f) => f.path === path);
  if (!file) return;
  document.querySelectorAll("#file-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.path === path);
  });
  $("#file-view-path").textContent = file.path;
  const lines = file.content.split("\n").length;
  $("#file-view-meta").textContent = `${lines} lines · ${new Blob([file.content]).size} bytes`;
  $("#file-view-purpose").textContent = `Purpose: ${file.purpose}`;
  const prov = (skill.provenance ?? []).filter((p) => p.filePath === path);
  const provEl = $("#file-view-provenance");
  if (prov.length > 0) {
    const p = prov[0];
    provEl.textContent = `Provenance: ${p.extraction} — source lines ${p.sourceLines[0]}–${p.sourceLines[1]}` +
      (p.sourceHeading ? `, under "${p.sourceHeading}"` : "");
    provEl.classList.remove("hidden");
  } else {
    provEl.textContent = "Provenance: synthesized by the generator (no verbatim excerpt).";
  }
  $("#file-view-content").textContent = file.content;
}

function renderExportCards() {
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
    btn.textContent = blocked ? "Export blocked (validation errors)" : "Download ZIP";
    btn.disabled = Boolean(blocked);
    btn.addEventListener("click", () => runExport(target.target));
    card.append(h, p, btn, basis);
    container.append(card);
  }

  const note = $("#export-note");
  note.textContent = blocked
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
  const res = await fetch(`/api/skills/${encodeURIComponent(state.skillId)}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    let message = `Export failed (HTTP ${res.status})`;
    try {
      const data = await res.json();
      message = data.error ?? message;
      if (data.validation) {
        state.validation = data.validation;
        renderValidation(data.validation, false);
        renderExportCards();
      }
    } catch { /* keep default message */ }
    const note = $("#export-note");
    note.textContent = message;
    return;
  }
  const blob = await res.blob();
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
  $("#export-note").textContent = `Downloaded ${fileName} (${(blob.size / 1024).toFixed(1)} KB, ${entries ?? "?"} entries). Unzip it and drop the folder into your agent's skills directory.`;
}

init();
