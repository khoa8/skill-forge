#!/usr/bin/env node
/**
 * Production smoke check for a PRUNED installation (dev dependencies
 * removed). Dependency-free: plain Node + Node built-ins + npm itself.
 *
 * The server is started through the ACTUAL package contract — `npm start`,
 * resolved from the repository's package.json — not a hand-built node
 * invocation, so a regression in the start script (renamed, pointing at a
 * wrong path, or depending on a devDependency like tsx) fails this check.
 *
 * Verifies against the compiled server:
 *   1. npm start launches and serves;
 *   2. /api/health returns ok with the mock (offline) provider;
 *   3. static UI / is served;
 *   4. bundled sample assets are present and readable;
 *   5. one full sample generation → export ZIP round-trip works.
 *
 * Exits nonzero with an actionable message on any failure.
 * Usage: npm run build && npm prune --omit=dev && npm run smoke:production
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "server", "index.js");
const sampleAsset = join(repoRoot, "dist", "core", "samples", "meridian-payments-api.md");
const CHILD_BUDGET_MS = 90_000;

function fail(message) {
  console.error(`production smoke FAILED: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

if (!existsSync(entry)) {
  fail("dist/server/index.js not found — run `npm run build` first.");
}
if (!existsSync(sampleAsset)) {
  fail(`bundled sample asset missing in build output (${sampleAsset}) — rebuild.`);
}
// Resolve the start script from the package manifest; the smoke exercises
// whatever npm start actually does, but a missing script is a hard failure.
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (!pkg.scripts?.start) {
  fail("package.json has no start script — the documented production command is broken.");
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

// `npm start` resolves the start script from package.json. Port and host are
// injected via the environment (documented contract), not by editing npm.
// detached + process-group kill ensures the whole tree (npm → node server)
// is terminated on both macOS and Linux CI; nothing is left orphaned.
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmBin, ["start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    SKILLFORGE_PROVIDER: "mock",
    HOST: "127.0.0.1",
    PORT: String(port),
    SKILLFORGE_DATA_ROOT: join(workDir, ".data-store"),
    SKILLFORGE_ACKNOWLEDGE_EXPOSURE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => (stdout += c.toString()));
child.stderr.on("data", (c) => (stderr += c.toString()));
let finished = false;
child.on("exit", (code, signal) => {
  if (!finished && code !== 0 && code !== null) {
    fail(`npm start exited early with code ${code}: ${(stderr || stdout).slice(0, 500)}`);
  }
});

/** Kill the entire npm → node process group (SIGTERM, then SIGKILL). */
async function stopServer() {
  if (child.exitCode !== null && child.signalCode === null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  } catch {
    /* already gone */
  }
  const gone = new Promise((r) => child.once("exit", () => r()));
  const force = new Promise((r) => setTimeout(() => {
    try {
      if (process.platform !== "win32" && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    r();
  }, 3_000));
  await Promise.race([gone, force]);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

async function waitHealthy() {
  const until = Date.now() + 20_000;
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
  fail(`server never became healthy on /api/health. stderr: ${stderr.slice(0, 500)}`);
}

try {
  const health = await waitHealthy();
  check("npm start (package start script) launches the compiled server", true);
  check("start script points at the compiled entry", pkg.scripts.start.includes("dist/server/index.js"), pkg.scripts.start);
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
  await stopServer();
  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) fail(`${failures} check(s) failed`);
console.log("production smoke OK (npm start → health, UI, bundled samples, generate → export)");
