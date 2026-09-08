/**
 * Regression tests for runtime configuration (src/config/env.ts).
 *
 * Tests NEVER read or mutate the developer's real `.env`: parsing/loading run
 * against temp files and plain objects, and nothing here touches
 * process.env beyond restoring every key it set.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnvText,
  loadEnvFile,
  resolveRuntimeConfig,
  resolveServerBind,
  ConfigError,
  MAX_ENV_FILE_BYTES,
} from "../src/config/env.js";

const touchedKeys = ["SKILLFORGE_PROVIDER", "SKILLFORGE_API_KEY", "SKILLFORGE_BASE_URL", "SKILLFORGE_MODEL", "PORT", "HOST"];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of touchedKeys) {
    if (saved.has(key)) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      saved.delete(key);
    }
  }
});

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Isolated .env fixture in a temp dir; never the developer's real file. */
async function withEnvFile(text: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "skillforge-env-test-"));
  const path = join(dir, ".env");
  await writeFile(path, text, "utf8");
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("parseEnvText", () => {
  it("parses KEY=VALUE with comments, blanks, quotes, CRLF, and export prefix", () => {
    const parsed = parseEnvText(
      "# comment\r\n\r\nSKILLFORGE_PROVIDER=glm\r\nexport SKILLFORGE_API_KEY='secret-value'\nQUOTED=\"double quoted\"\nEMPTY=\n",
    );
    expect(parsed).toEqual({
      SKILLFORGE_PROVIDER: "glm",
      SKILLFORGE_API_KEY: "secret-value",
      QUOTED: "double quoted",
      EMPTY: "",
    });
  });

  it("rejects malformed lines without echoing their content", () => {
    try {
      parseEnvText("GOOD=yes\nthis line has no equals sign\n");
      expect.unreachable("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("config_env_parse");
      expect((err as ConfigError).message).toContain("line 2");
      // The offending text must never be echoed — it may hold a secret.
      expect((err as ConfigError).message).not.toContain("this line has no equals");
    }
  });
});

describe("loadEnvFile", () => {
  it("loads values into process.env without overriding existing variables", async () => {
    setEnv("SKILLFORGE_PROVIDER", undefined);
    setEnv("SKILLFORGE_API_KEY", "shell-wins");
    const { path, cleanup } = await withEnvFile("SKILLFORGE_PROVIDER=glm\nSKILLFORGE_API_KEY=file-value\n");
    try {
      loadEnvFile(path);
      // Shell/process environment keeps precedence over .env.
      expect(process.env.SKILLFORGE_API_KEY).toBe("shell-wins");
      expect(process.env.SKILLFORGE_PROVIDER).toBe("glm");
    } finally {
      await cleanup();
    }
  });
});

describe("resolveRuntimeConfig", () => {
  it("defaults to the offline mock provider with no configuration at all", () => {
    for (const key of touchedKeys) setEnv(key, undefined);
    const config = resolveRuntimeConfig({});
    expect(config.provider).toBe("mock");
    expect(config.apiKey).toBeUndefined();
  });

  it("accepts each supported provider id (case-insensitive)", () => {
    expect(resolveRuntimeConfig({ SKILLFORGE_PROVIDER: "Mock" }).provider).toBe("mock");
    expect(resolveRuntimeConfig({ SKILLFORGE_PROVIDER: "glm", SKILLFORGE_API_KEY: "k" }).provider).toBe("glm");
    expect(resolveRuntimeConfig({ SKILLFORGE_PROVIDER: "openai", SKILLFORGE_API_KEY: "k" }).provider).toBe("openai");
  });

  it("refuses an unsupported provider id before anything starts", () => {
    try {
      resolveRuntimeConfig({ SKILLFORGE_PROVIDER: "anthropic", SKILLFORGE_API_KEY: "k" });
      expect.unreachable("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("config_provider_invalid");
      expect((err as ConfigError).message).toContain("mock, glm, openai");
    }
  });

  it("refuses a non-mock provider without an API key (fail fast, not a healthy-looking server)", () => {
    try {
      resolveRuntimeConfig({ SKILLFORGE_PROVIDER: "glm" });
      expect.unreachable("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("config_key_missing");
      expect((err as ConfigError).message).toContain("SKILLFORGE_API_KEY");
    }
  });

  it("keeps the mock path working with or without a key", () => {
    expect(resolveRuntimeConfig({ SKILLFORGE_PROVIDER: "mock" }).provider).toBe("mock");
    expect(resolveRuntimeConfig({ SKILLFORGE_PROVIDER: "mock", SKILLFORGE_API_KEY: "unused" }).provider).toBe("mock");
  });
});

describe("resolveServerBind", () => {
  it("defaults to loopback 8787 and validates explicit values", () => {
    expect(resolveServerBind({})).toEqual({ port: 8787, host: "127.0.0.1" });
    expect(resolveServerBind({ PORT: "3000", HOST: "0.0.0.0" })).toEqual({ port: 3000, host: "0.0.0.0" });
    for (const bad of ["0", "-1", "70000", "abc", "8.5"]) {
      expect(() => resolveServerBind({ PORT: bad }), `PORT=${bad}`).toThrow(ConfigError);
    }
  });
});

describe("loadEnvFile size bound", () => {
  it("refuses oversized environment files", async () => {
    const big = `KEY=${"x".repeat(MAX_ENV_FILE_BYTES)}\n`;
    const { path, cleanup } = await withEnvFile(big);
    try {
      expect(() => loadEnvFile(path)).toThrow(ConfigError);
    } finally {
      await cleanup();
    }
  });
});
