/**
 * URL source adapter — documentation ingestion with safe limits.
 *
 * Design constraints (AGENTS.md §12 web safety):
 * - http/https only; no other protocols;
 * - SSRF protection: hosts that are private/loopback/link-local by NAME are
 *   refused, and the connection can only use addresses that were resolved
 *   and validated as public AT CONNECTION TIME (safe-fetch pins the socket
 *   to the validated records — the DNS check/use / rebinding gap is closed
 *   by construction, not by re-checking after an unvalidated resolution);
 * - one END-TO-END deadline covers DNS, redirects, connection/headers, and
 *   the full response-body stream (the deadline is NOT restarted per hop or
 *   per phase);
 * - redirects followed at most 3 times, re-validated (URL + DNS) each hop;
 * - hard byte cap enforced while the body streams;
 * - single-page fetch only — no crawling by default;
 * - HTML is converted to markdown-ish text client-side (no JS execution).
 *
 * The network layer is injectable for deterministic tests: `fetchImpl`
 * (WHATWG fetch shape, existing tests) or `safeFetchImpl` (the production
 * transport signature, used for deadline/rebinding regression tests). When
 * neither is given the production safe-fetch transport is used.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SourceInput } from "../types.js";
import { readBodyCapped, decodeUtf8, BodyTooLargeError } from "./body.js";
import { safeFetch, isPrivateIp, type SafeResponse } from "./safe-fetch.js";

/** DNS lookup shape used for SSRF validation and injection. */
export interface LookupAllFn {
  (hostname: string, options: { all: true; verbatim: true }): Promise<{ address: string; family: number }[]>;
}

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

/** Typed error for the shared end-to-end deadline. */
function deadlineError(timeoutMs: number): UrlSourceError {
  return new UrlSourceError(
    `The page did not finish loading within ${Math.round(timeoutMs / 1000)} s (overall deadline covering DNS, redirects, connection, and body streaming).`,
    "url_deadline_exceeded",
  );
}

/** Race a promise against the shared deadline so a stalled DNS resolution
 * cannot outlive the overall ingestion budget. */
function raceDeadline<T>(promise: Promise<T>, deadline: AbortSignal, timeoutMs: number): Promise<T> {
  if (deadline.aborted) return Promise.reject(deadlineError(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(deadlineError(timeoutMs));
    deadline.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        deadline.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        deadline.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Uniform view over Response | SafeResponse for the fields the adapter uses. */
interface FetchedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  getHeader(name: string): string | null;
  body: ReadableStream<Uint8Array> | null;
  cancel(): void;
}

function adapt(res: Response | SafeResponse): FetchedResponse {
  if ("getHeader" in res) {
    const safe = res as SafeResponse;
    return { ok: safe.ok, status: safe.status, statusText: safe.statusText, getHeader: safe.getHeader, body: safe.body, cancel: safe.cancel };
  }
  const r = res as Response;
  return {
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    getHeader: (name) => r.headers.get(name),
    body: r.body,
    cancel: () => void r.body?.cancel().catch(() => {}),
  };
}

export interface FetchUrlOptions {
  /** WHATWG-fetch-shaped transport (tests). DNS validation then relies on
   * the injected lookup for the check, and the fetch for the use. */
  fetchImpl?: typeof fetch;
  /** Production-transport-shaped injection (tests): used as-is. */
  safeFetchImpl?: typeof safeFetch;
  lookupImpl?: LookupAllFn;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Fetch a documentation URL and turn it into a SourceInput.
 * Single page only — deliberately not a crawler.
 *
 * The deadline is ONE AbortSignal.timer over the whole operation: DNS
 * validation, every redirect hop, connection/headers, and the streamed body
 * all share the same budget. A server that sends headers and then stalls
 * cannot outlive it, and redirect chains cannot reset it.
 */
export async function fetchUrlSource(
  rawUrl: string,
  opts: FetchUrlOptions = {},
): Promise<{ input: SourceInput; finalUrl: string; notes: string[] }> {
  const lookupImpl: LookupAllFn = (opts.lookupImpl ?? lookup) as LookupAllFn;
  const maxBytes = opts.maxBytes ?? MAX_URL_BYTES;
  const timeoutMs = opts.timeoutMs ?? URL_TIMEOUT_MS;

  // ONE deadline for the entire ingestion (DNS + redirects + headers + body).
  const deadline = AbortSignal.timeout(timeoutMs);

  async function request(url: URL): Promise<Response | SafeResponse> {
    const init = {
      redirect: "manual" as const,
      headers: { "user-agent": "SkillForge/0.1 (documentation-to-skill; +https://github.com/skillforge)" },
      signal: deadline,
    };
    if (opts.fetchImpl) return opts.fetchImpl(url.toString(), init);
    if (opts.safeFetchImpl) return opts.safeFetchImpl(url.toString(), init, lookupImpl);
    return safeFetch(url.toString(), init, lookupImpl);
  }

  async function assertHopSafe(url: URL): Promise<void> {
    if (isPrivateHost(url.hostname)) {
      throw new UrlSourceError(
        `Refusing to fetch "${url.hostname}": private, loopback, or local addresses are not allowed.`,
        "url_private_host",
      );
    }
    if (isIP(url.hostname)) return; // literal public IP already checked
    let addresses: { address: string }[];
    try {
      addresses = await lookupImpl(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new UrlSourceError(`DNS lookup failed for "${url.hostname}".`, "url_dns_failure");
    }
    if (addresses.length === 0) {
      throw new UrlSourceError(`No DNS records for "${url.hostname}".`, "url_dns_failure");
    }
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        throw new UrlSourceError(
          `Refusing to fetch "${url.hostname}": it resolves to a private address (${address}).`,
          "url_private_host",
        );
      }
    }
  }

  let current = assertSafeUrl(rawUrl);
  await raceDeadline(assertHopSafe(current), deadline, timeoutMs);

  const notes: string[] = [];
  let response: FetchedResponse | null = null;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let res: FetchedResponse;
    try {
      res = adapt(await request(current));
    } catch (err) {
      if (err instanceof UrlSourceError) throw err;
      if (deadline.aborted) throw deadlineError(timeoutMs);
      const cause = err instanceof Error ? err.message : String(err);
      throw new UrlSourceError(
        `Fetch failed for ${current}: ${cause}. The site may be unreachable or blocking automated requests.`,
        "url_fetch_failed",
      );
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.getHeader("location");
      res.cancel();
      if (!location) {
        throw new UrlSourceError(`Redirect from ${current} has no Location header.`, "url_redirect_no_location");
      }
      const next = new URL(location, current);
      assertSafeUrl(next.toString());
      await raceDeadline(assertHopSafe(next), deadline, timeoutMs);
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
    response.cancel();
    throw new UrlSourceError(
      `The server responded ${response.status} ${response.statusText} for ${current}.`,
      "url_http_error",
    );
  }

  const contentType = response.getHeader("content-type") ?? "";
  if (!/text\/|html|markdown|json|xml/i.test(contentType)) {
    response.cancel();
    throw new UrlSourceError(
      `Unsupported content type "${contentType}". SkillForge fetches text/HTML documentation pages.`,
      "url_bad_content_type",
    );
  }

  const declaredLength = response.getHeader("content-length");
  if (declaredLength && Number.parseInt(declaredLength, 10) > maxBytes) {
    response.cancel();
    throw new UrlSourceError(
      `The page is ${declaredLength} bytes; the limit is ${maxBytes}. Fetch a more specific page.`,
      "url_too_large",
    );
  }
  // Enforce the byte cap WHILE streaming the body (content-length is
  // advisory); an oversized connection is torn down mid-read instead of being
  // buffered to completion first. The same end-to-end deadline bounds the
  // read: headers arriving quickly do not exempt a stalled body.
  let rawBody: Uint8Array;
  try {
    rawBody = response.body
      ? await readBodyCapped({ body: response.body }, maxBytes, deadline)
      : await readBodyCapped({ text: () => Promise.resolve("") }, maxBytes, deadline);
  } catch (err) {
    response.cancel();
    if (err instanceof BodyTooLargeError) {
      throw new UrlSourceError(
        `The page exceeds ${maxBytes} bytes. Fetch a more specific page.`,
        "url_too_large",
      );
    }
    if (deadline.aborted) {
      throw new UrlSourceError(
        `The page did not finish loading within ${Math.round(timeoutMs / 1000)} s (overall deadline). The server may have stalled mid-response.`,
        "url_deadline_exceeded",
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
