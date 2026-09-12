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
import { isAllowedUrlDestinationIp, normalizeUrlHostname } from "./ip-policy.js";
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
 * Resolve `hostname` and connect ONLY to addresses the centralized IP
 * policy (ip-policy.ts) classifies as globally reachable — for the whole
 * record set, at connection time. Returns the validated records — the ONLY
 * addresses the connection may use. Bracketed IPv6 literals ([…]) are
 * validated directly; names are resolved through `lookupImpl`. When
 * `signal` is provided, a stalled DNS resolution is aborted by it (one
 * end-to-end deadline covers DNS too). Throws SafeFetchError with
 * `url_dns_failure`, `url_private_host`, or `url_deadline_exceeded`.
 */
export async function assertPublicDns(
  hostname: string,
  lookupImpl: LookupAllFn,
  signal?: AbortSignal,
): Promise<PinnedAddress[]> {
  const literal = normalizeUrlHostname(hostname);
  const family = isIP(literal);
  if (family) {
    if (!isAllowedUrlDestinationIp(literal)) {
      throw new SafeFetchError(
        `Refusing to fetch "${hostname}": not a permitted public destination.`,
        "url_private_host",
      );
    }
    return [{ address: literal, family }];
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
    if (!isAllowedUrlDestinationIp(address)) {
      throw new SafeFetchError(
        `Refusing to fetch "${hostname}": it resolves to a non-public destination (${address}).`,
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

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Test seam allowing unit tests to intercept the low-level HTTP(S) request. */
  requestFnOverride?: typeof http.request;
}

/**
 * Issue ONE request to `url`, connecting only to addresses validated as
 * public by `lookupImpl` (resolved at connection time — the check/use gap
 * is closed here). The deadline signal aborts the whole request lifecycle.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
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
    const requestFn = opts.requestFnOverride ?? (isHttps ? https.request : http.request);
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
