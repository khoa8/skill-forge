/**
 * Runtime configuration: `.env` loading and provider validation.
 *
 * The documented workflow is "copy .env.example to .env" — this module makes
 * that real for every entry point that relies on runtime configuration
 * (`npm start`, `npm run dev`, `npm run verify:provider`):
 *
 * - `.env` values populate `process.env` WITHOUT overriding variables the
 *   shell or parent process already set (the process environment keeps
 *   precedence);
 * - parsing never echoes values — errors name the file and line number only,
 *   because `.env` values are typically secrets;
 * - provider configuration is validated BEFORE traffic is served: an
 *   unsupported `SKILLFORGE_PROVIDER`, or a non-mock provider without
 *   `SKILLFORGE_API_KEY`, fails startup with an actionable message instead
 *   of running a server whose health response looks healthy while every
 *   generation is guaranteed to fail;
 * - the zero-config mock/offline path keeps working: with no `.env` and no
 *   variables set, the provider resolves to `mock` and no key is required.
 *
 * Deliberately no configuration framework: a small deterministic parser is
 * enough for the flat KEY=VALUE contract documented in `.env.example`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_IDS, type ProviderId } from "../core/providers/index.js";
import { parseHostToken } from "../server/host-guard.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Upper bound for an environment file SkillForge will parse. */
export const MAX_ENV_FILE_BYTES = 256 * 1024;

/**
 * Parse `.env` text into a record. Deterministic and dependency-free:
 * - blank lines and full-line `#` comments are skipped;
 * - keys match `[A-Za-z_][A-Za-z0-9_]*`; an optional `export ` prefix is
 *   tolerated; values may be wrapped in single or double quotes;
 * - CRLF line endings are tolerated; surrounding whitespace is trimmed;
 * - anything else is a parse error naming the line number — the offending
 *   text is never echoed (values may hold secrets).
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq).trim();
    if (eq === -1 || key.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigError(
        `Invalid line ${i + 1} in environment file: expected KEY=VALUE (line content not echoed).`,
        "config_env_parse",
      );
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load one `.env` file into `target` (process.env by default) WITHOUT
 * overriding variables that are already present — existing process/shell
 * environment values keep precedence. Values are applied verbatim; callers
 * must never log them.
 */
export function loadEnvFile(
  path: string,
  target: Record<string, string | undefined> = process.env,
): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // Unreadable environment file is a clean configuration failure too —
    // never a raw filesystem stack trace at startup.
    throw new ConfigError(
      `The environment file at "${path}" could not be read: ${err instanceof Error ? err.message : String(err)}.`,
      "config_env_unreadable",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new ConfigError(
      `Environment file at "${path}" exceeds the ${MAX_ENV_FILE_BYTES} byte limit.`,
      "config_env_too_large",
    );
  }
  const parsed = parseEnvText(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
  return parsed;
}

/**
 * Locate the documented `.env` file: the working directory first, then
 * walking up from this module (so `node dist/server/index.js` and `npm start`
 * resolve the same file as `tsx src/server/index.ts`). Returns null when no
 * `.env` exists anywhere along the way.
 */
export function findEnvFile(): string | null {
  if (existsSync(join(process.cwd(), ".env"))) return join(process.cwd(), ".env");
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the documented `.env` file if one exists. No-op (returns null) when
 * absent. Parse/size/read failures are configuration failures: by default
 * they are rethrown, but an entry point can pass `onError` to route them
 * into its own clean startup-failure path. Never logs or echoes values.
 * Returns the file path that was loaded.
 */
export function loadDotEnv(onError?: (err: ConfigError) => void): string | null {
  const path = findEnvFile();
  if (!path) return null;
  try {
    loadEnvFile(path);
  } catch (err) {
    const configError =
      err instanceof ConfigError
        ? err
        : new ConfigError(
            `The environment file at "${path}" could not be loaded.`,
            "config_env_unreadable",
          );
    if (onError) {
      onError(configError);
      return null;
    }
    throw configError;
  }
  return path;
}

export interface RuntimeConfig {
  provider: ProviderId;
  /** Present only for remote providers. Never log this value. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * Validate provider configuration from an environment (process.env by
 * default). Throws ConfigError on any problem; entry points must call this
 * BEFORE serving traffic or running generation.
 */
export function resolveRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const rawProvider = env.SKILLFORGE_PROVIDER?.trim() || "mock";
  const provider = rawProvider.toLowerCase();
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new ConfigError(
      `Unsupported SKILLFORGE_PROVIDER "${rawProvider}". Supported providers: ${PROVIDER_IDS.join(", ")}.`,
      "config_provider_invalid",
    );
  }
  const apiKey = env.SKILLFORGE_API_KEY?.trim() || undefined;
  if (provider !== "mock" && !apiKey) {
    throw new ConfigError(
      `Provider "${provider}" requires SKILLFORGE_API_KEY. Set it in .env or the environment (never commit it), or run the offline demo provider with SKILLFORGE_PROVIDER=mock.`,
      "config_key_missing",
    );
  }
  return {
    provider: provider as ProviderId,
    apiKey,
    baseUrl: env.SKILLFORGE_BASE_URL?.trim() || undefined,
    model: env.SKILLFORGE_MODEL?.trim() || undefined,
  };
}

export interface ServerBind {
  port: number;
  host: string;
  allowedHosts: string[];
}

/** True when the bind host only exposes the server to the local machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1" || h === "[::1]";
}

/**
 * Parse and validate SKILLFORGE_ALLOWED_HOSTS.
 *
 * Contract:
 * - comma-separated hostnames or IP addresses (no schemes, no paths, no ports);
 * - empty tokens (e.g. leading/trailing comma or ,,) throw ConfigError;
 * - schemes (http://, https://, ://) and paths (/) throw ConfigError;
 * - ports (e.g. :8787 in a non-IPv6 token) throw ConfigError;
 * - wildcard '*' is not permitted (throws ConfigError);
 * - entries are trimmed and lowercased.
 */
export function parseAllowedHosts(raw?: string): string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  const parts = raw.split(",");
  const out: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (token.length === 0) {
      throw new ConfigError(
        `Invalid SKILLFORGE_ALLOWED_HOSTS: empty host entry in "${raw}".`,
        "config_allowed_hosts_invalid",
      );
    }
    const result = parseHostToken(token, { allowPort: false });
    if (!result.ok) {
      throw new ConfigError(
        `Invalid SKILLFORGE_ALLOWED_HOSTS entry "${token}": ${result.reason}.`,
        "config_allowed_hosts_invalid",
      );
    }
    out.push(result.host);
  }
  return out;
}

/** Validate and resolve the server bind address (PORT / HOST / SKILLFORGE_ALLOWED_HOSTS). */
export function resolveServerBind(
  env: Record<string, string | undefined> = process.env,
): ServerBind {
  const rawPort = env.PORT?.trim() || "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `Invalid PORT "${rawPort}": expected an integer between 1 and 65535.`,
      "config_port_invalid",
    );
  }
  const host = env.HOST?.trim() || "127.0.0.1";
  const allowedHosts = parseAllowedHosts(env.SKILLFORGE_ALLOWED_HOSTS);
  if (!isLoopbackHost(host) && allowedHosts.length === 0) {
    throw new ConfigError(
      `Binding to non-loopback host "${host}" requires an explicit SKILLFORGE_ALLOWED_HOSTS configuration (e.g. SKILLFORGE_ALLOWED_HOSTS=${host}). For local loopback use, leave HOST=127.0.0.1.`,
      "config_bind_exposed_without_allowed_hosts",
    );
  }
  return { port, host, allowedHosts };
}
