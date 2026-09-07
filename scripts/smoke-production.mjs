#!/usr/bin/env node
/**
 * Production smoke check for a PRUNED installation (dev dependencies
 * removed). Dependency-free: plain Node + built-in fetch only — by
 * construction it cannot depend on Vitest, tsx, or any devDependency.
 *
 * Verifies against the COMPILED server (dist/server/index.js):
 *   1. npm start launches;
 *   2. /api/health returns ok with the mock (offline) provider;
 *   3. static UI / is served;
 *   4. bundled sample assets are present and served;
 *   5. one full sample generation → export ZIP round-trip works.
 *
 * Exits nonzero with an actionable message on any failure.
 * Usage: npm run build && npm prune --omit=dev && npm run smoke:production
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "server", "index.js");
const sampleAsset = join(repoRoot, "dist", "core", "samples", "meridian-payments-api.md");
const CHILD_BUDGET_MS = 60_000;

function fail(message) {
  console.error(`production smoke FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(entry)) {
  fail("dist/server/index.js not found — run `npm run build` first.");
}
if (!existsSync(sampleAsset)) {
  fail(`bundled sample asset missing in build output (${sampleAsset}) — rebuild.`);
}

/** Grab an ephemeral TCP port from the OS, release it, return it. */
const ephemeralPort = () =>
  new Promise((resolvePort, rejectPort) => {
    const taker = createServer();
    taker.on("error", rejectPort);
    taker.listen(0, "127.0.0.1", () => {
      const port = taker.address().port;
      taker.close(() => resolvePort(port));
    });
  });

const deadline = Date.now() + CHILD_BUDGET_MS;
const assertTime = () => {
  if (Date.now() > deadline) fail(`smoke exceeded the ${CHILD_BUDGET_MS} ms budget`);
};

const port = await ephemeralPort();
const workDir = mkdtempSync(join(tmpdir(), "skillforge-smoke-"));
// Comment-only .env pins the lookup here so the developer's real .env (if
// any) can never leak into the check.
writeFileSync(join(workDir, ".env"), "# smoke: isolated from any real .env\n", "utf8");

const child = spawn(process.execPath, [entry], {
  cwd: workDir,
  env: {
    ...process.env,
    SKILLFORGE_PROVIDER: "mock",
    HOST: "127.0.0.1",
    PORT: String(port),
    SKILLFORGE_DATA_ROOT: join(workDir, ".data-store"),
    SKILLFORGE_ACKNOWLEDGE_EXPOSURE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c.toString()));
child.on("exit", (code, signal) => {
  if (!finished && code !== 0 && code !== null) {
    fail(`server exited early with code ${code}: ${stderr.slice(0, 500)}`);
  }
});

let finished = false;
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

async function waitHealthy() {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    assertTime();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail("server never became healthy on /api/health");
}

try {
  const health = await waitHealthy();
  check("npm start (compiled server) launches", true);
  check("/api/health ok with mock provider", health.ok === true && health.provider === "mock" && health.offlineDemo === true, JSON.stringify(health));

  const ui = await fetch(`http://127.0.0.1:${port}/`);
  const uiHtml = await ui.text();
  check("static UI / served", ui.status === 200 && (ui.headers.get("content-type") ?? "").includes("text/html") && uiHtml.includes("SkillForge"));

  const samplesRes = await fetch(`http://127.0.0.1:${port}/api/samples`);
  const samples = (await samplesRes.json()).samples ?? [];
  check("bundled sample assets present and listed", samplesRes.ok && samples.length > 0);
  const sampleId = samples[0]?.id;
  const sampleRes = await fetch(`http://127.0.0.1:${port}/api/samples/${sampleId}`);
  const sampleBody = await sampleRes.json();
  check("sample content readable from build output", sampleRes.ok && (sampleBody.content ?? "").length > 200);

  // One full generation → export round-trip through the running server.
  const gen = await fetch(`http://127.0.0.1:${port}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceType: "sample", sampleId }),
  });
  const genText = await gen.text();
  const resultEvent = genText
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((e) => e.type === "result");
  check("sample generation produces a validated skill", Boolean(resultEvent?.skill?.id && resultEvent?.validation?.passed === true));

  const skillId = resultEvent.skill.id;
  const exportRes = await fetch(`http://127.0.0.1:${port}/api/skills/${skillId}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "claude-code" }),
  });
  const zip = Buffer.from(await exportRes.arrayBuffer());
  check("export streams a real ZIP", exportRes.status === 200 && zip.subarray(0, 2).toString("latin1") === "PK" && zip.byteLength > 1000, `status ${exportRes.status}`);
  check("validation header rides along honestly", (exportRes.headers.get("x-skillforge-validation") ?? "").includes('"passed":true'));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  finished = true;
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolveForce) => setTimeout(() => {
      child.kill("SIGKILL");
      resolveForce();
    }, 3_000)),
  ]);
  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) fail(`${failures} check(s) failed`);
console.log("production smoke OK (compiled server, health, UI, bundled samples, generate → export)");
