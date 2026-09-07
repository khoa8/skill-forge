/**
 * URL source adapter — documentation ingestion with safe limits.
 *
 * Design constraints (AGENTS.md §12 web safety):
 * - http/https only; no other protocols;
 * - SSRF protection: block localhost, link-local, loopback, private, and
 *   unique-local addresses by name before any request (DNS re-resolution
 *   TOCTOU is accepted and documented — the fetch layer also re-checks);
 * - redirects followed at most 3 times, re-validated each hop;
 * - hard size limit and time limit;
 * - single-page fetch only — no crawling by default;
 * - HTML is converted to markdown-ish text client-side (no JS execution).
 *
 * The fetcher is injectable for deterministic tests.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SourceInput } from "../types.js";
import { readBodyCapped, decodeUtf8, BodyTooLargeError } from "./body.js";

export const MAX_URL_BYTES = 1_000_000; // 1 MB of payload
export const URL_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;
export const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export class UrlSourceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "UrlSourceError";
  }
}

/** Hosts and IP ranges refused to prevent SSRF. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  const ip = isIP(h) ? h : null;
  if (ip) return isPrivateIp(ip);
  // IPv6 literal in brackets
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    return isIP(inner) ? isPrivateIp(inner) : false;
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    if (v6.startsWith("::ffff:")) {
      const v4 = v6.slice(7);
      return isIP(v4) === 4 ? isPrivateIp(v4) : false;
    }
    return false;
  }
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Resolve a hostname and refuse private addresses (SSRF guard). */
async function assertPublicHost(hostname: string, lookupImpl: LookupAllFn): Promise<void> {
  if (isPrivateHost(hostname)) {
    throw new UrlSourceError(
      `Refusing to fetch "${hostname}": private, loopback, or local addresses are not allowed.`,
      "url_private_host",
    );
  }
  if (isIP(hostname)) return; // literal public IP already checked
  let addresses: { address: string }[];
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new UrlSourceError(`DNS lookup failed for "${hostname}".`, "url_dns_failure");
  }
  if (addresses.length === 0) {
    throw new UrlSourceError(`No DNS records for "${hostname}".`, "url_dns_failure");
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new UrlSourceError(
        `Refusing to fetch "${hostname}": it resolves to a private address (${address}).`,
        "url_private_host",
      );
    }
  }
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlSourceError(`"${raw}" is not a valid URL.`, "url_invalid");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlSourceError(
      `Only http and https URLs are supported (got "${url.protocol}").`,
      "url_bad_protocol",
    );
  }
  if (url.username || url.password) {
    throw new UrlSourceError("URLs with embedded credentials are not supported.", "url_credentials");
  }
  return url;
}

/** Minimal, dependency-free HTML → text for documentation pages. */
export function htmlToText(html: string): { text: string; title: string | null } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.trim()) : null;
  let text = html;
  // Drop non-content blocks entirely.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Structural conversions that help the analyzer.
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const hashes = "#".repeat(Number(level));
    return `\n\n${hashes} ${stripTags(inner).trim()}\n\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner).trim()}`);
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\`\`\`\n${decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, "")}\n\`\`\`\n`);
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|tr|table|ul|ol)>/gi, "\n\n");
  text = stripTags(text);
  text = decodeEntities(text);
  text = text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { text: text.trim() + "\n", title };
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export interface LookupAllFn {
  (hostname: string, options: { all: true; verbatim: true }): Promise<{ address: string; family: number }[]>;
}

export interface FetchUrlOptions {
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupAllFn;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Fetch a documentation URL and turn it into a SourceInput.
 * Single page only — deliberately not a crawler.
 */
export async function fetchUrlSource(
  rawUrl: string,
  opts: FetchUrlOptions = {},
): Promise<{ input: SourceInput; finalUrl: string; notes: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookupImpl: LookupAllFn = (opts.lookupImpl ?? lookup) as LookupAllFn;
  const maxBytes = opts.maxBytes ?? MAX_URL_BYTES;
  const timeoutMs = opts.timeoutMs ?? URL_TIMEOUT_MS;

  let current = assertSafeUrl(rawUrl);
  await assertPublicHost(current.hostname, lookupImpl);

  const notes: string[] = [];
  let response: Response | null = null;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        headers: { "user-agent": "SkillForge/0.1 (documentation-to-skill; +https://github.com/skillforge)" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new UrlSourceError(
        `Fetch failed for ${current}: ${cause}. The site may be unreachable or blocking automated requests.`,
        "url_fetch_failed",
      );
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new UrlSourceError(`Redirect from ${current} has no Location header.`, "url_redirect_no_location");
      }
      const next = new URL(location, current);
      assertSafeUrl(next.toString());
      await assertPublicHost(next.hostname, lookupImpl);
      current = next;
      continue;
    }
    response = res;
    break;
  }
  if (response === null) {
    throw new UrlSourceError(`Too many redirects (more than ${MAX_REDIRECTS}) fetching ${rawUrl}.`, "url_too_many_redirects");
  }
  if (current.toString() !== new URL(rawUrl).toString()) notes.push(`Followed redirect to ${current}.`);
  if (!response.ok) {
    throw new UrlSourceError(
      `The server responded ${response.status} ${response.statusText} for ${current}.`,
      "url_http_error",
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/|html|markdown|json|xml/i.test(contentType)) {
    throw new UrlSourceError(
      `Unsupported content type "${contentType}". SkillForge fetches text/HTML documentation pages.`,
      "url_bad_content_type",
    );
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number.parseInt(declaredLength, 10) > maxBytes) {
    throw new UrlSourceError(
      `The page is ${declaredLength} bytes; the limit is ${maxBytes}. Fetch a more specific page.`,
      "url_too_large",
    );
  }
  // Enforce the byte cap WHILE streaming the body (content-length is
  // advisory); an oversized connection is torn down mid-read instead of being
  // buffered to completion first.
  let rawBody: Uint8Array;
  try {
    rawBody = await readBodyCapped(response, maxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new UrlSourceError(
        `The page exceeds ${maxBytes} bytes. Fetch a more specific page.`,
        "url_too_large",
      );
    }
    throw new UrlSourceError(
      `Reading the response body failed: ${err instanceof Error ? err.message : String(err)}.`,
      "url_fetch_failed",
    );
  }
  const body = decodeUtf8(rawBody);

  const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  let text: string;
  let name: string;
  if (isHtml) {
    const converted = htmlToText(body);
    text = converted.text;
    name = converted.title || current.hostname + current.pathname;
    notes.push("HTML converted to markdown-ish text; scripts/styles/nav/footer removed. No page JavaScript was executed.");
  } else {
    text = body;
    name = decodeURIComponent(current.pathname.split("/").filter(Boolean).pop() ?? current.hostname);
  }
  if (text.trim().length < 40) {
    throw new UrlSourceError(
      "The fetched page has almost no extractable text (it may be JavaScript-rendered). SkillForge does not execute page scripts; try a page with server-rendered content.",
      "url_no_content",
    );
  }

  return {
    input: { type: "text", name: name.slice(0, 200) || "fetched-page", content: text },
    finalUrl: current.toString(),
    notes,
  };
}
