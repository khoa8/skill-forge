/**
 * Inbound HTTP Host header validation.
 *
 * Protects SkillForge against DNS rebinding attacks on loopback and local
 * interfaces. The default server is unauthenticated and loopback-bound, so
 * browser requests with arbitrary Host headers (e.g. Host: attacker.example:8787)
 * must be rejected before static files or API routes are served.
 */
import type { Request, Response, NextFunction } from "express";

export interface HostParseResult {
  ok: boolean;
  host: string;
  port?: number;
  reason?: string;
}

const CANONICAL_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "[::ffff:127.0.0.1]",
  "::ffff:127.0.0.1",
]);

/**
 * Strictly parse the inbound HTTP Host header into a lowercase host and optional port.
 * Inspects only the actual Host header (never proxy-forwarded headers).
 */
export function parseHostHeader(raw: string | undefined): HostParseResult {
  if (raw === undefined || typeof raw !== "string") {
    return { ok: false, host: "", reason: "Host header is missing or not a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, host: "", reason: "Host header is empty" };
  }
  // Multiple Host headers or comma-separated values are invalid in HTTP/1.1
  if (trimmed.includes(",")) {
    return { ok: false, host: "", reason: "Multiple or comma-separated Host headers" };
  }
  // Disallow characters that have no place in a valid Host header
  if (/[\s/\\<>'"@\x00-\x1F\x7F]/.test(trimmed)) {
    return { ok: false, host: "", reason: "Host header contains invalid characters" };
  }

  // Bracketed IPv6 reference (RFC 3986 / RFC 7230): [::1] or [::1]:8787
  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    if (closeBracket === -1) {
      return { ok: false, host: "", reason: "Unclosed IPv6 bracket in Host header" };
    }
    const ipv6Content = trimmed.slice(1, closeBracket);
    if (ipv6Content.length === 0 || !/^[0-9a-fA-F:.]+$/.test(ipv6Content)) {
      return { ok: false, host: "", reason: "Invalid IPv6 address inside brackets" };
    }
    const host = `[${ipv6Content.toLowerCase()}]`;
    const rest = trimmed.slice(closeBracket + 1);
    if (rest.length === 0) {
      return { ok: true, host };
    }
    if (!rest.startsWith(":")) {
      return { ok: false, host: "", reason: "Invalid syntax after IPv6 closing bracket" };
    }
    const portStr = rest.slice(1);
    if (!/^[0-9]+$/.test(portStr)) {
      return { ok: false, host: "", reason: "Invalid port in Host header" };
    }
    const port = Number(portStr);
    if (port < 1 || port > 65535) {
      return { ok: false, host: "", reason: "Port out of range in Host header" };
    }
    return { ok: true, host, port };
  }

  // Non-bracketed host (hostname, IPv4, or bare unbracketed IPv6)
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount === 0) {
    const host = trimmed.toLowerCase();
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
      return { ok: false, host: "", reason: "Invalid hostname or IPv4 syntax" };
    }
    return { ok: true, host };
  }

  if (colonCount === 1) {
    const [h, portStr] = trimmed.split(":");
    if (!h || !portStr || !/^[0-9]+$/.test(portStr)) {
      return { ok: false, host: "", reason: "Invalid host or port syntax" };
    }
    const port = Number(portStr);
    if (port < 1 || port > 65535) {
      return { ok: false, host: "", reason: "Port out of range in Host header" };
    }
    const host = h.toLowerCase();
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
      return { ok: false, host: "", reason: "Invalid hostname or IPv4 syntax" };
    }
    return { ok: true, host, port };
  }

  // Multiple colons without brackets: bare unbracketed IPv6 like ::1 is accepted if it has no port
  if (trimmed === "::1" || trimmed === "::ffff:127.0.0.1") {
    return { ok: true, host: trimmed.toLowerCase() };
  }

  return { ok: false, host: "", reason: "IPv6 literals with ports must use bracketed syntax [host]:port" };
}

export interface HostGuardOptions {
  bindHost?: string;
  allowedHosts?: string[];
}

/** Check if host is loopback. */
function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1" || h === "[::1]";
}

/**
 * Check if the parsed host is permitted according to bindHost and allowedHosts.
 */
export function isAllowedHost(host: string, opts: HostGuardOptions = {}): boolean {
  const allowed = opts.allowedHosts ?? [];
  const normalizedHost = host.toLowerCase();

  // Check explicit allowed hosts
  for (const a of allowed) {
    const normA = a.toLowerCase();
    if (normA === normalizedHost) return true;
    // Match bracketed and unbracketed forms of IPv6
    if (normA.startsWith("[") && normA.endsWith("]") && normA.slice(1, -1) === normalizedHost) return true;
    if (normalizedHost.startsWith("[") && normalizedHost.endsWith("]") && normalizedHost.slice(1, -1) === normA) return true;
  }

  const bindHost = opts.bindHost?.trim() || "127.0.0.1";
  const boundToLoopback = isLoopback(bindHost);

  if (boundToLoopback) {
    return CANONICAL_LOOPBACK_HOSTS.has(normalizedHost);
  }

  // Non-loopback mode
  if (CANONICAL_LOOPBACK_HOSTS.has(normalizedHost)) {
    return true;
  }
  if (bindHost !== "0.0.0.0" && bindHost !== "::") {
    const normBind = bindHost.toLowerCase();
    if (normalizedHost === normBind || normalizedHost === `[${normBind}]`) {
      return true;
    }
  }

  return false;
}

/**
 * Centralized Express middleware that enforces inbound Host validation.
 * Must be mounted before static files and API routes.
 */
export function createHostValidationMiddleware(opts: HostGuardOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawHost = req.headers["host"] || req.headers.host;
    const parsed = parseHostHeader(rawHost);

    if (!parsed.ok) {
      res.status(400).json({
        error: "Invalid Host header.",
        code: "invalid_host",
      });
      return;
    }

    if (!isAllowedHost(parsed.host, opts)) {
      res.status(403).json({
        error: "Disallowed Host header.",
        code: "disallowed_host",
      });
      return;
    }

    next();
  };
}
