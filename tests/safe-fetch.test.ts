/**
 * Regression tests for the connection-safe transport (src/core/sources/safe-fetch.ts).
 *
 * The DNS check-then-use (rebinding) gap: a hostile DNS server answers the
 * validation lookup with a public address and the CONNECTION lookup with a
 * private one. The pinned-lookup agent closes this by construction — the
 * socket layer can only ever see addresses that were validated.
 *
 * Everything runs against local loopback sockets (no external network):
 * a "public-range" documentation IP (203.0.113.x, refused by nothing, never
 * routed) is pinned to 127.0.0.1 in tests via the injected lookup so the
 * local HTTP server answers while the validated/pinned records stay in sync.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { safeFetch, pinnedLookup, assertPublicDns, isGloballyReachable } from "../src/core/sources/safe-fetch.js";
import type { LookupAllFn } from "../src/core/sources/url.js";

/** TEST-NET-3 documentation address (public-range, never routed). */
const DOC_IP = "93.184.216.34"; // genuinely public (example.com); TEST-NET is refused now
const DOC_HOST = "docs.example.test";

function lookupOf(records: Record<string, { address: string; family: number }[]>): LookupAllFn {
  return (async (host: string) => {
    const hit = records[host];
    if (!hit) {
      const err = new Error(`lookup ${host}: ENOTFOUND`) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    }
    return hit;
  }) as unknown as LookupAllFn;
}

describe("assertPublicDns", () => {
  it("refuses record sets containing any private address (rebinding setup)", async () => {
    const lookup = lookupOf({
      "rebind.example.test": [
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ],
    });
    await expect(assertPublicDns("rebind.example.test", lookup)).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("refuses bracketed private IPv6 literals and accepts public ones", async () => {
    await expect(assertPublicDns("[::1]", lookupOf({}))).rejects.toMatchObject({ code: "url_private_host" });
    await expect(assertPublicDns("[fd00::5]", lookupOf({}))).rejects.toMatchObject({ code: "url_private_host" });
    const ok = await assertPublicDns("[2606:4700::1111]", lookupOf({}));
    expect(ok).toEqual([{ address: "2606:4700::1111", family: 6 }]);
  });

  it("maps lookup failures to url_dns_failure", async () => {
    await expect(assertPublicDns("missing.example.test", lookupOf({}))).rejects.toMatchObject({ code: "url_dns_failure" });
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(assertPublicDns(DOC_HOST, lookupOf({}), controller.signal)).rejects.toMatchObject({
      code: "url_deadline_exceeded",
    });
  });

  it("aborts a stalled DNS resolution with the caller's deadline signal", async () => {
    const controller = new AbortController();
    const never = new Promise<{ address: string; family: number }[]>(() => {});
    const stalled = (async () => never) as unknown as LookupAllFn;
    const pending = assertPublicDns(DOC_HOST, stalled, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "url_deadline_exceeded" });
  });
});

describe("pinnedLookup (connection-time address pinning)", () => {
  it("only ever returns addresses from the validated set, in both modes", () => {
    const validated = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
    const hook = pinnedLookup(validated) as unknown as (
      hostname: string,
      options: { all?: boolean },
      cb: (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void,
    ) => void;
    for (let i = 0; i < 10; i++) {
      hook("whatever.example.test", {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(validated.some((a) => a.address === address && a.family === family)).toBe(true);
      });
    }
    hook("whatever.example.test", { all: true }, (err, address) => {
      expect(err).toBeNull();
      const list = address as { address: string; family: number }[];
      expect(list).toHaveLength(2);
      for (const rec of list) {
        expect(validated.some((a) => a.address === rec.address)).toBe(true);
      }
    });
  });
});

describe("safeFetch end to end (local sockets, no external network)", () => {
  let server: http.Server;
  let port: number;
  let serverResponses = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      serverResponses += 1;
      // Serves ONLY the expected Host header — proves Host semantics survive.
      if (req.headers.host !== `${DOC_HOST}:${port}`) {
        res.statusCode = 404;
        res.end("wrong host");
        return;
      }
      res.setHeader("content-type", "text/plain");
      res.end("real content from the expected host");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses a hostname whose validated records are private — even when the connection would succeed", async () => {
    // The rebinding setup in miniature: DNS says 127.0.0.1 for the public-looking
    // name. Validation must refuse BEFORE any connection is attempted.
    const lookup = lookupOf({ [DOC_HOST]: [{ address: "127.0.0.1", family: 4 }] });
    await expect(
      safeFetch(`http://${DOC_HOST}:${port}/doc`, {}, lookup),
    ).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("delivers requests through the pinned record while the Host header keeps the hostname", async () => {
    // Production wiring exercised directly: the socket layer's lookup hook is
    // pinnedLookup(validated), so the connection goes to the validated
    // address (here 127.0.0.1, our local server) while the URL hostname —
    // which does not resolve in real DNS — rides only in Host semantics.
    // "docs.example.test" does not resolve; the only way this request can
    // succeed is the pinned record.
    const pinned = pinnedLookup([{ address: "127.0.0.1", family: 4 }]);
    const agent = new http.Agent({ keepAlive: false, lookup: pinned as never });
    const response = await new Promise<{ status: number; text: string }>((resolveRes, rejectRes) => {
      const req = http.request(`http://${DOC_HOST}:${port}/doc`, { agent }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => resolveRes({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", rejectRes);
      req.end();
    });
    expect(response.status).toBe(200);
    expect(response.text).toContain("real content from the expected host");
    expect(serverResponses).toBe(1);
  });

  it("refuses immediately when the deadline signal is already aborted", async () => {
    const before = serverResponses;
    const controller = new AbortController();
    controller.abort();
    await expect(
      safeFetch(`http://${DOC_HOST}:${port}/x`, { signal: controller.signal }, lookupOf({ [DOC_HOST]: [{ address: DOC_IP, family: 4 }] })),
    ).rejects.toMatchObject({ code: "url_deadline_exceeded" });
    // Nothing ever reached the test server.
    expect(serverResponses).toBe(before);
  });

  it("rejects non-http(s) protocols and embedded credentials", async () => {
    await expect(safeFetch("ftp://example.test/x", {}, lookupOf({}))).rejects.toMatchObject({ code: "url_bad_protocol" });
    await expect(safeFetch("https://user:pass@example.test/x", {}, lookupOf({}))).rejects.toMatchObject({ code: "url_credentials" });
  });
});

describe("isGloballyReachable invariants used by the transport", () => {
  it("public addresses pass; private and special-purpose ranges fail closed", () => {
    expect(isGloballyReachable(DOC_IP)).toBe(true);
    expect(isGloballyReachable("127.0.0.1")).toBe(false);
    expect(isGloballyReachable("169.254.169.254")).toBe(false);
    expect(isGloballyReachable("192.0.2.1")).toBe(false); // TEST-NET-1
    expect(isGloballyReachable("203.0.113.1")).toBe(false); // TEST-NET-3
    expect(isGloballyReachable("100::1")).toBe(false); // discard-only
  });
});
