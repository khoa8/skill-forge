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
 * Configuration isolation: `npm start` must run with cwd = repoRoot, so the
 * child would otherwise discover the developer's repository `.env`. The
 * smoke writes a temp `.env` and passes it via SKILLFORGE_ENV_FILE (the
 * documented explicit-file override, which skips discovery entirely), so
 * the runtime configuration context is deterministic on local machines and
 * CI alike, regardless of whether a repository `.env` exists. PORT is
 * pinned INSIDE that file: if the child were not reading it, nothing would
 * listen on the expected port and the smoke would fail. Process-environment
 * values still take precedence over file values.
 *
 * Failure handling: `fail()` throws a SmokeFailure; cleanup (process-tree
 * teardown + temp dir removal) always runs first, and the diagnostic prints
 * exactly once afterwards. Exits nonzero on any failure.
 *
 * Usage: npm run build && npm prune --omit=dev && npm run smoke:production
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "server", "index.js");
const sampleAsset = join(repoRoot, "dist", "core", "samples", "meridian-payments-api.md");
const CHILD_BUDGET_MS = 90_000;

class SmokeFailure extends Error {}
function fail(message) {
  throw new SmokeFailure(message);
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

async function run() {
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

  const deadline = Date.now() + CHILD_BUDGET_MS;
  const assertTime = () => {
    if (Date.now() > deadline) fail(`smoke exceeded the ${CHILD_BUDGET_MS} ms budget`);
  };

  const port = await ephemeralPort();
  const workDir = mkdtempSync(join(tmpdir(), "skillforge-smoke-"));
  // The explicit env file is the ONLY file the child loads (discovery is
  // skipped when SKILLFORGE_ENV_FILE is set), so the developer's repository
  // .env can never leak into this check. PORT is pinned inside that file to
  // prove the child really consumes it.
  writeFileSync(join(workDir, ".env"), `PORT=${port}\n`, "utf8");
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmBin, ["start"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SKILLFORGE_PROVIDER: "mock",
      HOST: "127.0.0.1",
      SKILLFORGE_ENV_FILE: join(workDir, ".env"),
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
  // A nonzero exit is recorded, not thrown — the polling loop below turns it
  // into a clean SmokeFailure (never an uncaught exception mid-teardown).
  let earlyExit = null;
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      earlyExit = { code, output: (stderr || stdout).slice(0, 600) };
    }
  });

  let failures = 0;
  const check = (label, ok, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
    if (!ok) failures += 1;
  };

  async function waitHealthy() {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      assertTime();
      if (earlyExit) fail(`npm start exited early with code ${earlyExit.code}: ${earlyExit.output}`);
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
    check("isolated env file consumed by the child (PORT from SKILLFORGE_ENV_FILE)", health.ok === true);
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
  } finally {
    // Teardown always runs — process tree first, then temp files.
    await stopServer(child);
    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures > 0) fail(`${failures} check(s) failed`);
}

/** Kill the entire npm → node process group (SIGTERM, then SIGKILL). */
async function stopServer(child) {
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

try {
  await run();
  console.log("production smoke OK (npm start with isolated env file → health, UI, bundled samples, generate → export)");
} catch (err) {
  // One clean diagnostic — cleanup already completed in run()'s finally.
  if (err instanceof SmokeFailure) {
    console.error(`production smoke FAILED: ${err.message}`);
  } else {
    console.error(`production smoke crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
