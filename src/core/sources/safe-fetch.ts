/**
 * Connection-safe HTTP(S) transport for URL ingestion.
 *
 * The DNS check-then-use gap: validating a hostname's DNS records and then
 * delegating to fetch() lets a hostile resolver return a DIFFERENT address
 * at connection time (TOCTOU / DNS rebinding), bypassing the private-address
 * check between validation and use.
 *
 * This transport closes that gap:
 * - the hostname is resolved (dns.lookup, all records) and EVERY record is
 *   validated as public BEFORE any connection is attempted;
 * - the agent's `lookup` hook returns ONLY addresses from that validated
 *   set, so the address Node actually connects to can never be a fresh,
 *   unvalidated resolution;
 * - the Host header and TLS servername keep the URL's real hostname, so
 *   virtual hosting and certificate verification are unaffected;
 * - the caller's deadline signal aborts DNS, connection, headers, and the
 *   streamed body alike (one end-to-end budget).
 *
 * Redirects are NOT followed here — the caller owns redirect policy and
 * re-validates every hop.
 */
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupAllFn } from "./url.js";

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/**
 * IP ranges refused to prevent SSRF. Binary/CIDR classification (no string
 * prefixes): IPv4 is checked as a 32-bit number against the refused ranges;
 * IPv6 is parsed into its 8 hextets and checked by prefix bits, including
 * IPv4-mapped (::ffff:0:0/96, in BOTH dotted and hex textual forms — the URL
 * canonicalizer emits the hex form), NAT64 (64:ff9b::/96), deprecated
 * IPv4-compatible (::/96), 6to4 (2002::/16), and Teredo (2001::/32) embedded
 * IPv4 addresses, which are re-classified as IPv4. Refused IPv6 ranges:
 * loopback (::1), unspecified (::), link-local fe80::/10, unique-local
 * fc00::/7, multicast ff00::/8, documentation 2001:db8::/32. Globally
 * routable unicast (2000::/3 outside the refused ranges) stays usable.
 * Unparseable input fails CLOSED (refused).
 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const hextets = parseIPv6Hextets(ip);
    return hextets === null ? true : isPrivateIPv6(hextets);
  }
  const v4 = parseIPv4(ip);
  return v4 === null ? true : isPrivateIPv4(v4);
}

/** Refused IPv4 ranges, as bit checks. */
function isPrivateIPv4(v4: number): boolean {
  const first = v4 >>> 24; // /8 prefix
  const firstTwo = v4 >>> 16; // /16 prefix value
  if (first === 0 || first === 10 || first === 127) return true; // this-network, private, loopback
  if (firstTwo === 0xa9fe) return true; // 169.254.0.0/16 link-local
  if (firstTwo >= 0xac10 && firstTwo <= 0xac1f) return true; // 172.16.0.0/12 private
  if (firstTwo === 0xc0a8) return true; // 192.168.0.0/16 private
  if (firstTwo >= 0x6440 && firstTwo <= 0x647f) return true; // 100.64.0.0/10 CGNAT
  if (first >= 224) return true; // multicast (224/4) + reserved/broadcast (240/4, 255.255.255.255)
  return false;
}

/** Refused IPv6 ranges, as hextet-prefix checks. */
function isPrivateIPv6(h: number[]): boolean {
  // IPv4-mapped ::ffff:0:0/96 — re-classify the embedded IPv4 (covers both
  // textual forms: the URL canonicalizer emits hex, resolvers may emit either).
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPrivateIPv4(((h[6]! << 16) | h[7]!) >>> 0);
  }
  // NAT64 well-known prefix 64:ff9b::/96 — same embedded-IPv4 treatment.
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isPrivateIPv4(((h[6]! << 16) | h[7]!) >>> 0);
  }
  // 6to4 2002::/16 — embedded IPv4 rides in hextets 1-2.
  if (h[0] === 0x2002) {
    return isPrivateIPv4(((h[1]! << 16) | h[2]!) >>> 0);
  }
  // Teredo 2001::/32 — client IPv4 is the obfuscated last 32 bits.
  if (h[0] === 0x2001 && h[1] === 0) {
    return isPrivateIPv4((((h[6]! ^ 0xffff) << 16) | (h[7]! ^ 0xffff)) >>> 0);
  }
  // Link-local fe80::/10 (full range, not just the fe80 prefix).
  if (h[0]! >= 0xfe80 && h[0]! <= 0xfebf) return true;
  // Deprecated site-local fec0::/10 (RFC 3879: never globally routed).
  if (h[0]! >= 0xfec0 && h[0]! <= 0xfeff) return true;
  // Unique-local fc00::/7.
  if (h[0]! >= 0xfc00 && h[0]! <= 0xfdff) return true;
  // Multicast ff00::/8.
  if (h[0]! >= 0xff00) return true;
  // Documentation-only 2001:db8::/32 (non-routable).
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  // :: (unspecified), ::1 (loopback), and the deprecated IPv4-compatible
  // ::/96 (first six hextets zero) are all refused.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return true;
  return false;
}

/** Parse a dotted-quad IPv4 address to a 32-bit number; null when invalid. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * Parse an IPv6 address into its 8 hextets; null when invalid (including
 * zone IDs). Handles :: compression and a trailing embedded dotted-quad IPv4
 * (::ffff:192.168.1.1 style). Head groups anchor the start, tail groups
 * anchor the end; :: fills the middle with zeros.
 */
function parseIPv6Hextets(input: string): number[] | null {
  if (input.includes("%")) return null; // zone IDs never appear on our dials; fail closed
  let text = input;
  let embeddedTail: number[] | null = null;
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    embeddedTail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = text.slice(0, lastColon);
    if (text.endsWith(":")) text = text.slice(0, -1);
  }
  const parseGroup = (raw: string): number | null =>
    /^[0-9a-f]{1,4}$/.test(raw) ? Number.parseInt(raw, 16) : null;
  const headGroups: number[] = [];
  const tailGroups: number[] = [];
  const doubleColon = text.indexOf("::");
  if (doubleColon !== -1) {
    if (text.indexOf("::", doubleColon + 1) !== -1) return null; // more than one "::"
    const headText = text.slice(0, doubleColon);
    const tailText = text.slice(doubleColon + 2);
    if (headText.length > 0) {
      for (const raw of headText.split(":")) {
        const g = parseGroup(raw);
        if (g === null) return null;
        headGroups.push(g);
      }
    }
    if (tailText.length > 0) {
      for (const raw of tailText.split(":")) {
        const g = parseGroup(raw);
        if (g === null) return null;
        tailGroups.push(g);
      }
    }
  } else {
    for (const raw of text.split(":")) {
      const g = parseGroup(raw);
      if (g === null) return null;
      tailGroups.push(g);
    }
  }
  if (embeddedTail) tailGroups.push(...embeddedTail);
  const explicit = headGroups.length + tailGroups.length;
  if (explicit > 8) return null;
  if (doubleColon !== -1) {
    // :: must replace at least one group and the total must fit 8.
    const fill = 8 - explicit;
    if (fill < 1) return null;
    return [...headGroups, ...new Array<number>(fill).fill(0), ...tailGroups];
  }
  if (explicit !== 8) return null;
  return [...headGroups, ...tailGroups];
}

export interface SafeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Lower-cased header names; repeated headers are comma-joined. */
  getHeader(name: string): string | null;
  /** Body stream (always present; an empty body is a closed stream). */
  body: ReadableStream<Uint8Array>;
  /** Release the underlying connection (redirects / early error exits). */
  cancel(): void;
}

/** Validated, connection-ready address record. */
export interface PinnedAddress {
  address: string;
  family: number;
}

/**
 * Resolve `hostname` and refuse ANY private/loopback/link-local record.
 * Returns the validated public records — the ONLY addresses the connection
 * may use. Bracketed IPv6 literals ([…]) are validated directly; names are
 * resolved through `lookupImpl`. When `signal` is provided, a stalled DNS
 * resolution is aborted by it (one end-to-end deadline covers DNS too).
 * Throws SafeFetchError with `url_dns_failure`, `url_private_host`, or
 * `url_deadline_exceeded`.
 */
export async function assertPublicDns(
  hostname: string,
  lookupImpl: LookupAllFn,
  signal?: AbortSignal,
): Promise<PinnedAddress[]> {
  if (isIP(hostname) === 0 && hostname.startsWith("[") && hostname.endsWith("]")) {
    const literal = hostname.slice(1, -1);
    if (isIP(literal)) {
      if (isPrivateIp(literal)) {
        throw new SafeFetchError(
          `Refusing to fetch "${hostname}": private, loopback, or local addresses are not allowed.`,
          "url_private_host",
        );
      }
      return [{ address: literal, family: isIP(literal) }];
    }
  }
  const resolve = lookupImpl(hostname, { all: true, verbatim: true }).then(
    (records) => records,
    () => null, // lookup failure handled below (url_dns_failure)
  );
  let records: { address: string; family: number }[] | null;
  if (signal) {
    if (signal.aborted) {
      throw new SafeFetchError("The request was aborted (deadline exceeded).", "url_deadline_exceeded");
    }
    records = await Promise.race([
      resolve,
      new Promise<null>((_, reject) =>
        signal.addEventListener("abort", () => reject(new SafeFetchError("The request was aborted (deadline exceeded).", "url_deadline_exceeded")), { once: true }),
      ),
    ]);
  } else {
    records = await resolve;
  }
  if (!records || records.length === 0) {
    throw new SafeFetchError(`DNS lookup failed for "${hostname}".`, "url_dns_failure");
  }
  for (const { address } of records) {
    if (isPrivateIp(address)) {
      throw new SafeFetchError(
        `Refusing to fetch "${hostname}": it resolves to a private address (${address}).`,
        "url_private_host",
      );
    }
  }
  return records.map((r) => ({ address: r.address, family: r.family }));
}

type LookupCallback = (err: Error | null, address: string, family: number) => void;
type LookupFn = (hostname: string, options: LookupOptions, callback: (err: Error | null, address: string, family: number) => void) => void;
interface LookupOptions {
  all?: boolean;
  family?: number;
}

/**
 * The connection-time lookup hook: whatever hostname the socket layer asks
 * for, it may only connect to records from the pre-validated public set.
 * Single-address mode picks round-robin (autoSelectFamily retries the next
 * record on the following call); `all` mode (happy eyeballs) exposes the
 * whole set verbatim.
 */
export function pinnedLookup(validated: PinnedAddress[]): LookupFn {
  let index = 0;
  const hook: LookupFn = (_hostname, options, callback) => {
    void _hostname;
    if (options?.all) {
      const all = callback as unknown as (err: Error | null, addresses: { address: string; family: number }[]) => void;
      all(null, validated.map((a) => ({ address: a.address, family: a.family })));
      return;
    }
    const pick = validated[index % validated.length]!;
    index += 1;
    (callback as LookupCallback)(null, pick.address, pick.family);
  };
  return hook as unknown as LookupFn;
}

function headerGet(res: http.IncomingMessage): (name: string) => string | null {
  const headers: Record<string, string[]> = {};
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const key = res.rawHeaders[i]!.toLowerCase();
    (headers[key] ??= []).push(res.rawHeaders[i + 1] ?? "");
  }
  return (name) => {
    const values = headers[name.toLowerCase()];
    return values ? values.join(", ") : null;
  };
}

/** Wrap an IncomingMessage into a web stream that tears down on deadline abort. */
function bodyStream(res: http.IncomingMessage, signal?: AbortSignal): ReadableStream<Uint8Array> {
  let onAbort: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        res.destroy();
        try {
          controller.error(signal!.reason ?? new DOMException("aborted", "AbortError"));
        } catch {
          /* already closed */
        }
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      res.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          /* controller closed by abort — the destroy above ends the source */
        }
      });
      res.on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      res.on("error", (err: Error) => {
        signal?.removeEventListener("abort", onAbort);
        try {
          controller.error(err);
        } catch {
          /* already errored by abort */
        }
      });
    },
    cancel() {
      res.destroy();
    },
  });
  return stream;
}

/**
 * Issue ONE request to `url`, connecting only to addresses validated as
 * public by `lookupImpl` (resolved at connection time — the check/use gap
 * is closed here). The deadline signal aborts the whole request lifecycle.
 */
export async function safeFetch(
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal },
  lookupImpl: LookupAllFn = lookup as unknown as LookupAllFn,
): Promise<SafeResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeFetchError(`"${url}" is not a valid URL.`, "url_invalid");
  }
  const isHttps = parsed.protocol === "https:";
  if (!isHttps && parsed.protocol !== "http:") {
    throw new SafeFetchError(
      `Only http and https URLs are supported (got "${parsed.protocol}").`,
      "url_bad_protocol",
    );
  }
  if (parsed.username || parsed.password) {
    throw new SafeFetchError("URLs with embedded credentials are not supported.", "url_credentials");
  }

  // Connection-time validation: resolve NOW and pin the connection to the
  // validated public records. No second, unvalidated resolution can occur.
  const validated = await assertPublicDns(parsed.hostname, lookupImpl, opts.signal);
  const lookupHook = pinnedLookup(validated);

  return new Promise<SafeResponse>((resolveRes, rejectReq) => {
    const agentOptions = { keepAlive: false, lookup: lookupHook } as http.AgentOptions;
    const agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn(
      url,
      {
        method: "GET",
        headers: { ...(opts.headers ?? {}) },
        agent,
      } as http.RequestOptions,
      (res) => {
        const status = res.statusCode ?? 0;
        const getHeader = headerGet(res);
        const stream = bodyStream(res, opts.signal);
        resolveRes({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? "",
          getHeader,
          body: stream,
          cancel: () => res.destroy(),
        });
      },
    );
    req.on("error", (err: Error) => {
      rejectReq(
        new SafeFetchError(
          `Fetch failed for ${url}: ${err.message}. The site may be unreachable or blocking automated requests.`,
          "url_fetch_failed",
        ),
      );
    });
    if (opts.signal) {
      const onAbort = () => {
        req.destroy();
        rejectReq(new SafeFetchError("The request was aborted (deadline exceeded).", "url_deadline_exceeded"));
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end();
  });
}
