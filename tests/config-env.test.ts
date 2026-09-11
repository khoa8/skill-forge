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
  parseAllowedHosts,
  ConfigError,
  MAX_ENV_FILE_BYTES,
} from "../src/config/env.js";

const touchedKeys = ["SKILLFORGE_PROVIDER", "SKILLFORGE_API_KEY", "SKILLFORGE_BASE_URL", "SKILLFORGE_MODEL", "PORT", "HOST", "SKILLFORGE_ALLOWED_HOSTS"];
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
    expect(resolveServerBind({})).toEqual({ port: 8787, host: "127.0.0.1", allowedHosts: [] });
    expect(
      resolveServerBind({ PORT: "3000", HOST: "0.0.0.0", SKILLFORGE_ALLOWED_HOSTS: "192.168.1.50" }),
    ).toEqual({ port: 3000, host: "0.0.0.0", allowedHosts: ["192.168.1.50"] });
    for (const bad of ["0", "-1", "70000", "abc", "8.5"]) {
      expect(() => resolveServerBind({ PORT: bad }), `PORT=${bad}`).toThrow(ConfigError);
    }
  });

  it("fails closed when bound to non-loopback address without explicit SKILLFORGE_ALLOWED_HOSTS", () => {
    for (const nonLoopback of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5"]) {
      try {
        resolveServerBind({ HOST: nonLoopback });
        expect.unreachable(`expected ConfigError for HOST=${nonLoopback}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("config_bind_exposed_without_allowed_hosts");
      }
    }
  });

  it("accepts non-loopback bind when SKILLFORGE_ALLOWED_HOSTS is provided", () => {
    const bind = resolveServerBind({
      HOST: "0.0.0.0",
      SKILLFORGE_ALLOWED_HOSTS: "192.168.1.50, my-server.lan",
    });
    expect(bind.host).toBe("0.0.0.0");
    expect(bind.allowedHosts).toEqual(["192.168.1.50", "my-server.lan"]);
  });
});

describe("parseAllowedHosts", () => {
  it("returns empty array for empty or undefined input", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
    expect(parseAllowedHosts("   ")).toEqual([]);
  });

  it("parses valid comma-separated hostnames and IPs", () => {
    expect(parseAllowedHosts("localhost, 127.0.0.1, [::1], my-host.example.com")).toEqual([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "my-host.example.com",
    ]);
  });

  it("rejects wildcard '*'", () => {
    expect(() => parseAllowedHosts("*")).toThrow(ConfigError);
    expect(() => parseAllowedHosts("localhost, *")).toThrow(ConfigError);
    try {
      parseAllowedHosts("*");
      expect.unreachable("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("config_allowed_hosts_invalid");
      expect((err as ConfigError).message).toContain("wildcard '*' is not permitted");
    }
  });

  it("rejects empty tokens (e.g. trailing comma, double comma)", () => {
    for (const bad of [",", "a,,b", "a,", ",b"]) {
      expect(() => parseAllowedHosts(bad), `bad: ${bad}`).toThrow(ConfigError);
    }
  });

  it("rejects schemes/URLs", () => {
    for (const bad of ["http://localhost", "https://example.com", "ftp://foo"]) {
      expect(() => parseAllowedHosts(bad), `scheme: ${bad}`).toThrow(ConfigError);
    }
  });

  it("rejects paths", () => {
    for (const bad of ["example.com/api", "localhost/"]) {
      expect(() => parseAllowedHosts(bad), `path: ${bad}`).toThrow(ConfigError);
    }
  });

  it("rejects ports", () => {
    for (const bad of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "example.com:3000"]) {
      expect(() => parseAllowedHosts(bad), `port: ${bad}`).toThrow(ConfigError);
    }
  });

  it("rejects invalid characters including underscores (F-02 parity)", () => {
    for (const bad of ["host name", "host$name", "host#name", "my_server", "sub_domain.lan"]) {
      expect(() => parseAllowedHosts(bad), `invalid char: ${bad}`).toThrow(ConfigError);
    }
  });

  it("F-02 parity: rejects invalid host tokens at config startup matching runtime host parser rules", () => {
    // Malformed domain labels
    for (const bad of ["bad..domain", ".leading", "trailing.", "..", "my_server"]) {
      expect(() => parseAllowedHosts(bad), `bad label: ${bad}`).toThrow(ConfigError);
      try {
        parseAllowedHosts(bad);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("config_allowed_hosts_invalid");
      }
    }

    // Ports rejected in allowlist
    for (const bad of ["hostname:3000", "my-server.lan:8787", "[::1]:8787"]) {
      expect(() => parseAllowedHosts(bad), `port forbidden: ${bad}`).toThrow(ConfigError);
    }

    // Schemes and paths rejected
    for (const bad of ["http://example.com", "https://example.com", "example.com/path"]) {
      expect(() => parseAllowedHosts(bad), `url/path forbidden: ${bad}`).toThrow(ConfigError);
    }

    // Malformed IPv6
    for (const bad of ["[::1", "[", "[]", "[invalid:ipv6!z]"]) {
      expect(() => parseAllowedHosts(bad), `malformed ipv6: ${bad}`).toThrow(ConfigError);
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
