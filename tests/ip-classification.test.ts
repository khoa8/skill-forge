/**
 * Regression tests for the globally-reachable SSRF classification
 * (src/core/sources/safe-fetch.ts).
 *
 * Security contract: URL ingestion may connect only to addresses that are
 * actually globally reachable for ordinary public Internet traffic. The
 * decision is an ALLOWLIST ("not blocklisted" ≠ "safe"); unparseable or
 * ambiguous input fails closed. Embedded-IPv4 forms (mapped, NAT64, 6to4,
 * Teredo) are re-classified as IPv4 in both textual representations.
 *
 * Tests are deterministic: classifier matrix + WHATWG URL canonicalization
 * + the production fetchUrlSource path with a lookup stub that throws if
 * reached (proving refusal happens before any DNS/connection).
 */
import { describe, expect, it } from "vitest";
import { isGloballyReachable, assertPublicDns } from "../src/core/sources/safe-fetch.js";
import { isRefusedHost, fetchUrlSource, assertSafeUrl, type LookupAllFn } from "../src/core/sources/url.js";

/** Task-required IPv4 rejections + fail-closed inputs. */
const IPV4_MUST_REJECT = [
  "0.0.0.0",
  "0.1.2.3",
  "10.0.0.1",
  "100.64.0.1",
  "100.127.255.254",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "198.18.0.1",
  "198.19.255.254",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
];

/** Task-required IPv6 rejections + special/translated forms. */
const IPV6_MUST_REJECT = [
  "::",
  "::1",
  "fc00::1",
  "fd00::1",
  "fe80::1",
  "fe90::1",
  "fea0::1",
  "febf::1",
  "fec0::1",
  "feff::1",
  "ff02::1",
  "2001:db8::1",
  "100::1",
  "2001:2::48",
  "2001:10::1",
  "2001:30::1",
  "64:ff9b:1::1",
  // IPv4-mapped, dotted textual form
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "::ffff:192.168.1.1",
  "::ffff:169.254.169.254",
  // IPv4-mapped, hex textual form (WHATWG canonicalizer output)
  "::ffff:7f00:1",
  "::ffff:a00:1",
  "::ffff:c0a8:101",
  "::ffff:a9fe:a9fe",
  "::ffff:c000:201", // embedded TEST-NET-1
  "::ffff:c633:6401", // embedded TEST-NET-3
  // NAT64 well-known prefix with embedded loopback / TEST-NET
  "64:ff9b::7f00:1",
  "64:ff9b::c000:201",
  // 6to4 with embedded private/special IPv4
  "2002:7f00:1::",
  "2002:c000:201::",
  // Teredo with embedded loopback (f-ff obfuscation XOR → 127.0.0.1)
  "2001:0:9c38:953c:0:0:0000:0002",
  // fail closed on malformed / ambiguous input
  "not-an-ip",
  "1.2.3",
  "1.2.3.256",
  "1:2:3:4:5:6:7:8:9",
  "12345::",
  "fe80::1%eth0",
];

/** Representative REAL globally reachable addresses (no network needed —
 * these are stable well-known anycast/resolver addresses). */
const MUST_ALLOW_V4 = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "151.101.1.69"];
const MUST_ALLOW_V6 = ["2606:4700::1111", "2001:4860:4860::8888", "2620:fe::fe", "2a00:1450:4001:81b::200e"];

describe("isGloballyReachable: IPv4 allowlist", () => {
  it("rejects every special-purpose / non-global IPv4 range", () => {
    for (const ip of IPV4_MUST_REJECT) {
      expect(isGloballyReachable(ip), ip).toBe(false);
    }
  });

  it("allows representative globally reachable IPv4 addresses", () => {
    for (const ip of MUST_ALLOW_V4) {
      expect(isGloballyReachable(ip), ip).toBe(true);
    }
  });

  it("classifies range boundaries exactly", () => {
    expect(isGloballyReachable("100.63.255.255")).toBe(true); // below CGNAT
    expect(isGloballyReachable("100.128.0.0")).toBe(true); // above CGNAT
    expect(isGloballyReachable("192.0.1.255")).toBe(true); // below 192.0.0.0/24
    expect(isGloballyReachable("192.0.3.0")).toBe(true); // above TEST-NET-1
    expect(isGloballyReachable("198.20.0.0")).toBe(true); // above 198.18/15
    expect(isGloballyReachable("203.0.114.0")).toBe(true); // above TEST-NET-3
    expect(isGloballyReachable("223.255.255.255")).toBe(true); // last before multicast
  });
});

describe("isGloballyReachable: IPv6 allowlist", () => {
  it("rejects every required non-global IPv6 form", () => {
    for (const ip of IPV6_MUST_REJECT) {
      expect(isGloballyReachable(ip), ip).toBe(false);
    }
  });

  it("allows representative globally reachable IPv6 addresses", () => {
    for (const ip of MUST_ALLOW_V6) {
      expect(isGloballyReachable(ip), ip).toBe(true);
    }
  });

  it("classifies the 2000::/3 core and its internal exceptions exactly", () => {
    expect(isGloballyReachable("1fff::1")).toBe(false); // below 2000::/3
    expect(isGloballyReachable("2001:db7::1")).toBe(true); // next to documentation range
    expect(isGloballyReachable("2001:db8:ffff::1")).toBe(false); // inside documentation
    expect(isGloballyReachable("2001:db9::1")).toBe(true); // past documentation range
    expect(isGloballyReachable("3fff:ffff::1")).toBe(true); // top of 2000::/3
    expect(isGloballyReachable("4000::1")).toBe(false); // outside 2000::/3
  });
});

describe("isRefusedHost over URL-canonicalized hosts", () => {
  it("refuses mapped/link-local literal hosts after WHATWG canonicalization", () => {
    // Node canonicalizes [::ffff:127.0.0.1] INTO [::ffff:7f00:1] — the hex
    // form — so the dotted-mapped URL is a distinct, realistic attack input.
    const mappedDotted = assertSafeUrl("http://[::ffff:127.0.0.1]/").hostname;
    const mappedHex = assertSafeUrl("http://[::ffff:7f00:1]/").hostname;
    expect(mappedDotted).toBe("[::ffff:7f00:1]");
    expect(isRefusedHost(mappedDotted)).toBe(true);
    expect(isRefusedHost(mappedHex)).toBe(true);
    expect(isRefusedHost(assertSafeUrl("http://[fe90::1]/").hostname)).toBe(true);
    expect(isRefusedHost(assertSafeUrl("http://[::1]/").hostname)).toBe(true);
    expect(isRefusedHost(assertSafeUrl("http://[100::1]/").hostname)).toBe(true);
    expect(isRefusedHost(assertSafeUrl("http://192.0.2.1/").hostname)).toBe(true);
    expect(isRefusedHost(assertSafeUrl("http://203.0.113.1/").hostname)).toBe(true);
  });

  it("keeps globally routable literal hosts usable", () => {
    expect(isRefusedHost(assertSafeUrl("http://[2606:4700::1111]/").hostname)).toBe(false);
    expect(isRefusedHost(assertSafeUrl("http://1.1.1.1/").hostname)).toBe(false);
  });
});

describe("production URL ingestion path rejects non-global targets before connecting", () => {
  /** Any DNS touch means the name-based guard failed to catch a literal. */
  function lookupNever(host: string): ReturnType<LookupAllFn> {
    throw new Error(`DNS lookup must not be reached for ${host}`);
  }

  it("rejects the required mapped-IPv6 URLs before any DNS/connect", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:a00:1]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[::ffff:c0a8:101]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      await expect(fetchUrlSource(url, { lookupImpl: lookupNever })).rejects.toMatchObject(
        { code: "url_private_host" },
      );
    }
  });

  it("rejects literal TEST-NET and discard-only URLs before any DNS/connect", async () => {
    for (const url of [
      "http://192.0.2.1/",
      "http://198.18.0.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://[100::1]/",
      "http://[2001:db8::1]/",
    ]) {
      await expect(fetchUrlSource(url, { lookupImpl: lookupNever })).rejects.toMatchObject(
        { code: "url_private_host" },
      );
    }
  });

  it("rejects mixed safe+unsafe DNS record sets (fail closed)", async () => {
    const lookup = (async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]) as unknown as LookupAllFn;
    await expect(
      fetchUrlSource("https://mixed.example.test/doc", { fetchImpl: (async () => new Response("<p>x</p>", { headers: { "content-type": "text/html" } })) as typeof fetch, lookupImpl: lookup }),
    ).rejects.toMatchObject({ code: "url_private_host" });
    // Connection-time validation in the transport refuses the same set.
    await expect(assertPublicDns("mixed.example.test", lookup)).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("refuses hex-mapped records surfacing only at DNS resolution time", async () => {
    const lookup = (async () => [{ address: "::ffff:7f00:1", family: 6 }]) as unknown as LookupAllFn;
    await expect(assertPublicDns("rebind.example.test", lookup)).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("hands only validated global addresses to the pinned connection (DNS names)", async () => {
    const lookup = (async () => [{ address: "1.1.1.1", family: 4 }]) as unknown as LookupAllFn;
    const pinned = await assertPublicDns("public.example.test", lookup);
    expect(pinned).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });
});
