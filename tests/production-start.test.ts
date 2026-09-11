/**
 * Production smoke test: the COMPILED server must start and serve traffic
 * with plain Node — no tsx/TypeScript/Vitest in the runtime path — and the
 * startup configuration contract must be enforced before anything listens.
 *
 * Runs against `dist/server/index.js`; build first (`npm run build`). The
 * CI quality gate builds before testing, so this is a hard gate there.
 *
 * Isolation: each spawn runs with cwd = temp dir holding a comment-only
 * `.env`, so the developer's real `.env` (if any) is never read, and the
 * skill store is pointed at a temp root. Explicit env overrides (mock
 * provider, loopback host) beat any inherited configuration.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "server", "index.js");
const distReady = existsSync(entry);

interface Running {
  stop: () => Promise<void>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  stdout: () => string;
  stderr: () => string;
}

/** Grab an ephemeral TCP port from the OS, release it, and return it. */
async function ephemeralPort(): Promise<number> {
  const taker = createServer();
  const port: number = await new Promise((resolvePort) => {
    taker.listen(0, "127.0.0.1", () => resolvePort((taker.address() as { port: number }).port));
  });
  await new Promise<void>((r) => taker.close(() => r()));
  return port;
}

/** Start the compiled server with plain node on an ephemeral port in an isolated cwd. */
function startServer(env: Record<string, string>): Running {
  const dir = mkdtempSync(join(tmpdir(), "skillforge-prod-smoke-"));
  // Comment-only .env pins the lookup to THIS file so a developer's real
  // repo .env can never leak into the test.
  writeFileSync(join(dir, ".env"), "# production smoke test (isolated; never the developer's real .env)\n", "utf8");
  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    env: {
      ...process.env,
      SKILLFORGE_PROVIDER: "mock",
      HOST: "127.0.0.1",
      SKILLFORGE_DATA_ROOT: join(dir, ".data-store"),
      SKILLFORGE_ACKNOWLEDGE_EXPOSURE: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      rmSync(dir, { recursive: true, force: true });
      resolveExit({ code, signal });
    });
  });
  return {
    stop: () =>
      new Promise<void>((resolveStop) => {
        exited.then(() => resolveStop());
        child.kill("SIGTERM");
      }),
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** Poll until the health endpoint responds or the budget expires. */
async function waitHealthy(port: number, budgetMs = 15_000): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const deadline = Date.now() + budgetMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        return { ok: true, body: (await res.json()) as Record<string, unknown> };
      }
      lastError = `health returned ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: false, body: { error: lastError } };
}

(distReady ? describe : describe.skip)("compiled production server", () => {
  it("starts with plain node, serves a truthful /api/health and the static UI", async () => {
    const port = await ephemeralPort();
    const running = startServer({ PORT: String(port) });
    try {
      const health = await waitHealthy(port);
      expect(health.ok, `server did not become healthy: ${JSON.stringify(health.body)}`).toBe(true);
      // Truthful health: the mock provider really is the offline demo path.
      expect(health.body.ok).toBe(true);
      expect(health.body.provider).toBe("mock");
      expect(health.body.offlineDemo).toBe(true);
      expect(health.body.providerUsesApiKey).toBe(false);

      const ui = await fetch(`http://127.0.0.1:${port}/`);
      expect(ui.status).toBe(200);
      expect((ui.headers.get("content-type") ?? "").includes("text/html")).toBe(true);
      const html = await ui.text();
      expect(html).toContain("SkillForge");
      expect(html).toContain("stepper");
    } finally {
      await running.stop();
    }
  });

  it("refuses to start a remote provider without an API key (exits before serving)", async () => {
    const port = await ephemeralPort();
    const started = Date.now();
    const running = startServer({ PORT: String(port), SKILLFORGE_PROVIDER: "glm", SKILLFORGE_API_KEY: "" });
    const exit = await Promise.race([running.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
    expect(exit).not.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(15_000);
    // Nothing may ever have answered on that port…
    expect((await waitHealthy(port, 300)).ok).toBe(false);
    // …and the failure must be actionable, with no listening banner printed.
    expect(running.stderr()).toContain("SKILLFORGE_API_KEY");
    expect(running.stdout()).not.toContain("listening");
  });

  it("refuses an unsupported SKILLFORGE_PROVIDER", async () => {
    const running = startServer({ PORT: String(await ephemeralPort()), SKILLFORGE_PROVIDER: "definitely-not-a-provider" });
    const exit = await Promise.race([running.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
    expect(exit).not.toBe("timeout");
    expect(running.stderr()).toContain("Unsupported SKILLFORGE_PROVIDER");
    expect(running.stdout()).not.toContain("listening");
  });

  it("refuses non-loopback binding without explicit SKILLFORGE_ALLOWED_HOSTS", async () => {
    const running = startServer({
      PORT: String(await ephemeralPort()),
      HOST: "0.0.0.0",
      SKILLFORGE_ALLOWED_HOSTS: "",
    });
    const exit = await Promise.race([running.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
    expect(exit).not.toBe("timeout");
    expect(running.stderr()).toContain("SKILLFORGE_ALLOWED_HOSTS");
    expect(running.stdout()).not.toContain("listening");
  });
});
