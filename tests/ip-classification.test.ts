/**
 * Regression tests for the destination safety policy (src/core/sources/ip-policy.ts).
 *
 * Contract: URL ingestion permits ordinary public Internet destinations and
 * conservatively rejects local, private, link-local, documentation, test,
 * benchmark, reserved, multicast, transitional, and protocol-special
 * destination ranges — including ALL transitional/tunneled forms
 * (IPv4-mapped, NAT64, 6to4, Teredo) outright, and malformed or ambiguous
 * input (fail closed).
 *
 * Tests are deterministic: classifier matrix + WHATWG URL canonicalization
 * + the production fetchUrlSource path with a lookup stub that throws if
 * reached (proving refusal happens before any DNS/connection). No live
 * network access.
 */
import { describe, expect, it } from "vitest";
import { isAllowedUrlDestinationIp } from "../src/core/sources/ip-policy.js";
import { assertPublicDns } from "../src/core/sources/safe-fetch.js";
import { isRefusedHost, fetchUrlSource, assertSafeUrl, type LookupAllFn } from "../src/core/sources/url.js";

const IPV4_MUST_REJECT = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.19.255.254",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  // malformed / ambiguous forms fail closed
  "1.2.3",
  "1.2.3.256",
  "010.0.0.1", // octal-like shorthand
  "0x7f.0.0.1", // hexadecimal
  "127.000.0.1", // leading-zero octets
  "",
];

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
  "100::1",
  "2001:db8::1",
  "2001:2::1", // benchmarking
  "2001:5::1", // IETF protocol assignment parent
  "2001:20::1", // special assignment /28
  "2001:30::1", // ORCHIDv2
  "2001:10::1", // ORCHID, deprecated
  "3ffe::1", // 6bone, deprecated
  "3fff::1",
  "3fff:db8::1",
  "4000::1", // outside global unicast — fail closed
  "64:ff9b:1::1", // local-use NAT64
  // Transitional/tunneled forms are rejected OUTRIGHT — even with a public
  // embedded IPv4 (no decoding to allow them).
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:8.8.8.8",
  "::ffff:808:808",
  "64:ff9b::7f00:1",
  "64:ff9b::808:808",
  "2002:7f00:1::",
  "2002:808:808::",
  "2001:0:9c38:953c:ffff:ffff:80fe:fffe", // Teredo, loopback client
  "2001:0:9c38:953c:ffff:ffff:f7f7:f7f7", // Teredo, public client
  // malformed / ambiguous forms fail closed
  "not-an-ip",
  "1:2:3:4:5:6:7:8:9",
  "12345::",
  "fe80::1%eth0",
  "::ffff:1.2.3.256",
];

/** Representative REAL public addresses (no network needed). */
const MUST_ALLOW_V4 = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "151.101.1.69"];
const MUST_ALLOW_V6 = ["2606:4700::1111", "2001:4860:4860::8888", "2620:fe::fe", "2a00:1450:4001:81b::200e"];

describe("isAllowedUrlDestinationIp: IPv4 matrix", () => {
  it("rejects every blocked IPv4 range and malformed form", () => {
    for (const ip of IPV4_MUST_REJECT) {
      expect(isAllowedUrlDestinationIp(ip), ip).toBe(false);
    }
  });

  it("allows representative public IPv4 addresses", () => {
    for (const ip of MUST_ALLOW_V4) {
      expect(isAllowedUrlDestinationIp(ip), ip).toBe(true);
    }
  });
});

describe("isAllowedUrlDestinationIp: IPv6 matrix", () => {
  it("rejects every non-global and transitional IPv6 form", () => {
    for (const ip of IPV6_MUST_REJECT) {
      expect(isAllowedUrlDestinationIp(ip), ip).toBe(false);
    }
  });

  it("allows representative public IPv6 addresses", () => {
    for (const ip of MUST_ALLOW_V6) {
      expect(isAllowedUrlDestinationIp(ip), ip).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// URL canonicalization guards
// ---------------------------------------------------------------------------

describe("isRefusedHost over URL-canonicalized hosts", () => {
  it("refuses mapped/local/document literal hosts after WHATWG canonicalization", () => {
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
    expect(isRefusedHost(assertSafeUrl("http://[3fff::1]/").hostname)).toBe(true);
    expect(isRefusedHost(assertSafeUrl("http://192.0.2.1/").hostname)).toBe(true);
    expect(isRefusedHost(assertSafeUrl("http://203.0.113.1/").hostname)).toBe(true);
  });

  it("keeps public literal hosts usable", () => {
    expect(isRefusedHost(assertSafeUrl("http://[2606:4700::1111]/").hostname)).toBe(false);
    expect(isRefusedHost(assertSafeUrl("http://1.1.1.1/").hostname)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Production URL ingestion path (refusal must precede DNS/connect)
// ---------------------------------------------------------------------------

describe("production URL ingestion path rejects unsafe destinations before connecting", () => {
  /** Any DNS touch means the name-based guard failed to catch a literal. */
  function lookupNever(host: string): ReturnType<LookupAllFn> {
    throw new Error(`DNS lookup must not be reached for ${host}`);
  }

  it("rejects the required mapped-IPv6 URLs before any DNS/connect", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[::ffff:c0a8:101]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      await expect(fetchUrlSource(url, { lookupImpl: lookupNever })).rejects.toMatchObject(
        { code: "url_private_host" },
      );
    }
  });

  it("rejects literal TEST-NET / benchmark / documentation URLs before any DNS/connect", async () => {
    for (const url of [
      "http://192.0.2.1/",
      "http://198.18.0.1/",
      "http://203.0.113.1/",
      "http://[3fff::1]/",
      "http://[100::1]/",
      "http://[2001:db8::1]/",
    ]) {
      await expect(fetchUrlSource(url, { lookupImpl: lookupNever })).rejects.toMatchObject(
        { code: "url_private_host" },
      );
    }
  });

  it("rejects mixed safe+unsafe DNS record sets (fail closed)", async () => {
    const mixedV4 = (async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]) as unknown as LookupAllFn;
    await expect(
      fetchUrlSource("https://mixed-v4.example.test/doc", {
        fetchImpl: (async () => new Response("<p>x</p>", { headers: { "content-type": "text/html" } })) as typeof fetch,
        lookupImpl: mixedV4,
      }),
    ).rejects.toMatchObject({ code: "url_private_host" });
    await expect(assertPublicDns("mixed-v4.example.test", mixedV4)).rejects.toMatchObject({
      code: "url_private_host",
    });

    const mixedV6 = (async () => [
      { address: "2606:4700::1111", family: 6 },
      { address: "3fff::1", family: 6 },
    ]) as unknown as LookupAllFn;
    await expect(
      fetchUrlSource("https://mixed-v6.example.test/doc", {
        fetchImpl: (async () => new Response("<p>x</p>", { headers: { "content-type": "text/html" } })) as typeof fetch,
        lookupImpl: mixedV6,
      }),
    ).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("hands only validated public addresses to the pinned connection (DNS names)", async () => {
    const globalV4 = (async () => [{ address: "1.1.1.1", family: 4 }]) as unknown as LookupAllFn;
    const pinned = await assertPublicDns("public-v4.example.test", globalV4);
    expect(pinned).toEqual([{ address: "1.1.1.1", family: 4 }]);
    const unsafe = (async () => [{ address: "10.0.0.1", family: 4 }]) as unknown as LookupAllFn;
    await expect(assertPublicDns("unsafe.example.test", unsafe)).rejects.toMatchObject({
      code: "url_private_host",
    });
  });
});
