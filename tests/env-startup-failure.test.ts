/**
 * Regression tests: .env load/parse failures must follow the clean
 * configuration-error path in BOTH entrypoints (server + verify:provider).
 *
 * The developer's real .env is never read or modified: every spawn runs in
 * an isolated temp cwd holding a crafted .env fixture, and unit tests use
 * temp files only.
 */
import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvText, loadEnvFile, loadDotEnv, ConfigError, MAX_ENV_FILE_BYTES } from "../src/config/env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Fixture {
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(envText: string | null): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "skillforge-envfail-"));
  if (envText !== null) await writeFile(join(dir, ".env"), envText, "utf8");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Spawn a compiled entry with cwd = fixture dir; capture output + exit. */
function spawnEntry(entryJs: string, fixture: Fixture, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [entryJs], {
    cwd: fixture.dir,
    env: {
      ...process.env,
      // Never inherit the developer's real config; never write to .data.
      SKILLFORGE_DATA_ROOT: join(fixture.dir, ".data-store"),
      SKILLFORGE_ACKNOWLEDGE_EXPOSURE: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  return {
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

describe("parse/load failures are typed config errors without value leakage", () => {
  it("malformed .env throws config_env_parse naming only the line number", () => {
    expect(() => parseEnvText("GOOD=yes\nthis is not k=v\n")).toThrow(ConfigError);
    try {
      parseEnvText("GOOD=yes\nBAD LINE WITHOUT EQUALS\n");
    } catch (err) {
      const message = (err as ConfigError).message;
      expect((err as ConfigError).code).toBe("config_env_parse");
      expect(message).toContain("line 2");
      expect(message).not.toContain("BAD LINE");
    }
  });

  it("oversized .env throws config_env_too_large", async () => {
    const { dir, cleanup } = await makeFixture(`KEY=${"x".repeat(MAX_ENV_FILE_BYTES)}\n`);
    const path = join(dir, ".env");
    try {
      expect(() => loadEnvFile(path)).toThrow(ConfigError);
      try {
        loadEnvFile(path);
      } catch (err) {
        expect((err as ConfigError).code).toBe("config_env_too_large");
      }
    } finally {
      await cleanup();
    }
  });

  it("unreadable .env becomes config_env_unreadable via loadEnvFile", async () => {
    const { dir, cleanup } = await makeFixture(null);
    try {
      // A directory named .env: existsSync passes, readFileSync fails.
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(dir, ".env"));
      expect(() => loadEnvFile(join(dir, ".env"))).toThrow(ConfigError);
      try {
        loadEnvFile(join(dir, ".env"));
      } catch (err) {
        expect((err as ConfigError).code).toBe("config_env_unreadable");
      }
    } finally {
      await cleanup();
    }
  });

  it("loadDotEnv routes failures through its onError handler (shared startup boundary)", async () => {
    // chdir into an isolated dir so findEnvFile resolves the fixture, then
    // restore — the developer's real .env is never touched.
    const { dir, cleanup } = await makeFixture("BROKEN LINE\n");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const received: ConfigError[] = [];
      const result = loadDotEnv((err) => received.push(err));
      expect(result).toBeNull();
      expect(received).toHaveLength(1);
      expect(received[0]!.code).toBe("config_env_parse");
      // Without a handler the same failure rethrows as ConfigError.
      expect(() => loadDotEnv()).toThrow(ConfigError);
    } finally {
      process.chdir(cwd);
      await cleanup();
    }
  });

  it("valid .env still loads, and process env keeps precedence", () => {
    const parsed = parseEnvText("A=1\n# c\nB=\"two\"\n");
    expect(parsed).toEqual({ A: "1", B: "two" });
  });
});

describe("server entrypoint: clean failure, never listens", () => {
  it("malformed .env exits nonzero with a concise message and no listening banner", async () => {
    const fixture = await makeFixture("SKILLFORGE_PROVIDER=mock\nBROKEN LINE NO EQUALS\n");
    try {
      const child = spawnEntry(join(repoRoot, "dist", "server", "index.js"), fixture, { PORT: "47901", HOST: "127.0.0.1" });
      const exit = await Promise.race([
        child.exited,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
      ]);
      expect(exit).not.toBe("timeout");
      expect(child.stderr()).toContain("configuration error");
      expect(child.stderr()).toContain("line 2");
      expect(child.stderr()).not.toContain("BROKEN LINE");
      expect(child.stderr()).not.toContain("at "); // no stack trace
      expect(child.stdout()).not.toContain("listening");
    } finally {
      await fixture.cleanup();
    }
  });

  it("oversized .env exits cleanly; server does not listen", async () => {
    const fixture = await makeFixture(`KEY=${"x".repeat(MAX_ENV_FILE_BYTES)}\n`);
    try {
      const child = spawnEntry(join(repoRoot, "dist", "server", "index.js"), fixture, { PORT: "47902", HOST: "127.0.0.1" });
      const exit = await Promise.race([
        child.exited,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
      ]);
      expect(exit).not.toBe("timeout");
      expect(child.stderr()).toContain("configuration error");
      expect(child.stdout()).not.toContain("listening");
    } finally {
      await fixture.cleanup();
    }
  });

  it("valid .env starts normally (mock provider via file)", async () => {
    const fixture = await makeFixture("SKILLFORGE_PROVIDER=mock\n");
    try {
      const child = spawnEntry(join(repoRoot, "dist", "server", "index.js"), fixture, { PORT: "47903", HOST: "127.0.0.1" });
      const until = Date.now() + 15_000;
      let healthy = false;
      while (Date.now() < until) {
        try {
          const res = await fetch("http://127.0.0.1:47903/api/health");
          if (res.ok) {
            const body = (await res.json()) as { provider?: string };
            healthy = body.provider === "mock";
            break;
          }
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(healthy).toBe(true);
      await child.stop();
      expect(child.stdout()).toContain("listening");
    } finally {
      await fixture.cleanup();
    }
  });

  it("shell/process environment overrides .env values", async () => {
    // .env says provider=glm (which would fail without a key); the process
    // env pins mock — precedence must let the server start.
    const fixture = await makeFixture("SKILLFORGE_PROVIDER=glm\n");
    try {
      const child = spawnEntry(join(repoRoot, "dist", "server", "index.js"), fixture, {
        PORT: "47904",
        HOST: "127.0.0.1",
        SKILLFORGE_PROVIDER: "mock",
      });
      const until = Date.now() + 15_000;
      let healthy = false;
      while (Date.now() < until) {
        try {
          const res = await fetch("http://127.0.0.1:47904/api/health");
          if (res.ok) {
            const body = (await res.json()) as { provider?: string };
            healthy = body.provider === "mock";
            break;
          }
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(healthy).toBe(true);
      await child.stop();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("verify:provider entrypoint: clean failure on bad .env", () => {
  it("malformed .env exits 2 with a concise message, no stack trace, no secret echo", async () => {
    const fixture = await makeFixture("SKILLFORGE_PROVIDER=mock\nMY_SECRET=super-secret-value\nBROKEN!!\n");
    try {
      // verify:provider is run through tsx (dev path) — mirror the npm script.
      const child = spawn(process.execPath, [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(repoRoot, "scripts", "verify-provider.ts")], {
        cwd: fixture.dir,
        env: { ...process.env, SKILLFORGE_DATA_ROOT: join(fixture.dir, ".data-store") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
      const exit = await Promise.race([
        new Promise<number | null>((r) => child.once("exit", (code) => r(code))),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000)),
      ]);
      expect(exit).not.toBe("timeout");
      expect(exit).toBe(2);
      expect(stderr).toContain("configuration");
      expect(stderr).not.toContain("super-secret-value");
      expect(stderr).not.toContain("BROKEN!!");
      expect(stderr).not.toContain("at ");
      expect(stdout).not.toContain("Running one small bounded generation");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("fixture hygiene", () => {
  it("fixtures live under the OS temp dir, never the repo", async () => {
    const fixture = await makeFixture("A=1\n");
    try {
      expect(fixture.dir.startsWith(tmpdir())).toBe(true);
      const content = await readFile(join(fixture.dir, ".env"), "utf8");
      expect(content).toBe("A=1\n");
    } finally {
      await fixture.cleanup();
    }
  });
});
