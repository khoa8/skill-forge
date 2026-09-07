/**
 * Regression tests for binary/CIDR IP classification (src/core/sources/safe-fetch.ts).
 *
 * Contract (AGENTS.md §12 web safety): the classifier must match its claimed
 * coverage — IPv4 specials, IPv6 loopback/unspecified, link-local fe80::/10
 * (full range, not string prefixes), site-local fec0::/10, unique-local
 * fc00::/7, multicast, documentation ranges, and IPv4-mapped forms in BOTH
 * textual representations (dotted ::ffff:127.0.0.1 AND hex ::ffff:7f00:1 —
 * the WHATWG URL canonicalizer emits the hex form, so the hex case is the
 * realistic attack). Unparseable input fails CLOSED (refused).
 */
import { describe, expect, it } from "vitest";
import { isPrivateIp, assertPublicDns } from "../src/core/sources/safe-fetch.js";
import { isPrivateHost, fetchUrlSource, assertSafeUrl, type LookupAllFn } from "../src/core/sources/url.js";

const MUST_BLOCK = [
  // IPv4 specials
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "172.31.255.255",
  "100.127.255.255",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  // IPv6 loopback / unspecified
  "::1",
  "::",
  // IPv6 link-local fe80::/10 — full range (the old prefix check missed these)
  "fe80::1",
  "fe90::1",
  "fea0::1",
  "febf::1",
  "fe80:0000:0000:0000:0000:0000:0000:0001",
  // IPv6 unique-local fc00::/7
  "fd00::1",
  "fc00::1",
  "fdff::1",
  // IPv6 multicast / documentation
  "ff02::1",
  "2001:db8::1",
  // IPv4-mapped, dotted textual form
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "::ffff:192.168.1.1",
  "::ffff:169.254.169.254",
  // IPv4-mapped, hex textual form (URL canonicalizer output)
  "::ffff:7f00:1",
  "::ffff:a00:1",
  "::ffff:c0a8:101",
  "::ffff:a9fe:a9fe",
  "::ffff:6440:1",
  // NAT64 well-known prefix with embedded loopback
  "64:ff9b::7f00:1",
  // 6to4 with embedded private IPv4
  "2002:7f00:1::",
  // unparseable input fails closed
  "not-an-ip",
  "1.2.3",
  "1.2.3.256",
  "1:2:3:4:5:6:7:8:9",
  "12345::",
  "fe80::1%eth0",
];

const MUST_ALLOW = [
  "8.8.8.8",
  "1.1.1.1",
  "203.0.113.10", // TEST-NET-3: public range, refused by name only
  "2606:4700::1111",
  "2620:fe::fe",
  "2001:4860:4860::8888",
];

describe("isPrivateIp classification (SSRF contract)", () => {
  it("refuses every required blocked form", () => {
    for (const ip of MUST_BLOCK) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("keeps globally routable IPv4 and IPv6 usable", () => {
    for (const ip of MUST_ALLOW) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("classifies fe80::/10, fec0::/10, and fc00::/7 boundaries exactly", () => {
    expect(isPrivateIp("fe7f::1")).toBe(false); // below link-local
    expect(isPrivateIp("fe80::1")).toBe(true); // link-local start
    expect(isPrivateIp("febf::1")).toBe(true); // link-local end
    expect(isPrivateIp("fec0::1")).toBe(true); // deprecated site-local
    expect(isPrivateIp("feff::1")).toBe(true); // site-local end
    expect(isPrivateIp("fbff::1")).toBe(false); // below unique-local
    expect(isPrivateIp("fd00::1")).toBe(true); // unique-local
  });
});

describe("isPrivateHost over URL-canonicalized hosts", () => {
  it("refuses mapped/link-local literal hosts after WHATWG canonicalization", () => {
    // Node canonicalizes [::ffff:127.0.0.1] INTO [::ffff:7f00:1] — the hex
    // form — so the dotted-mapped URL is a distinct, realistic attack input.
    const mappedDotted = assertSafeUrl("http://[::ffff:127.0.0.1]/").hostname;
    const mappedHex = assertSafeUrl("http://[::ffff:7f00:1]/").hostname;
    expect(mappedDotted).toBe("[::ffff:7f00:1]");
    expect(isPrivateHost(mappedDotted)).toBe(true);
    expect(isPrivateHost(mappedHex)).toBe(true);
    expect(isPrivateHost(assertSafeUrl("http://[fe90::1]/").hostname)).toBe(true);
    expect(isPrivateHost(assertSafeUrl("http://[::1]/").hostname)).toBe(true);
  });

  it("keeps globally routable IPv6 literal hosts usable", () => {
    expect(isPrivateHost(assertSafeUrl("http://[2606:4700::1111]/").hostname)).toBe(false);
  });
});

describe("production URL ingestion path rejects mapped-IPv6 SSRF before connecting", () => {
  /** Any DNS touch means the name-based guard failed to catch a literal. */
  function lookupNever(host: string): ReturnType<LookupAllFn> {
    throw new Error(`DNS lookup must not be reached for ${host}`);
  }

  it("rejects http://[::ffff:127.0.0.1]/ (canonicalizes to hex form)", async () => {
    await expect(
      fetchUrlSource("http://[::ffff:127.0.0.1]/", { lookupImpl: lookupNever }),
    ).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("rejects http://[::ffff:7f00:1]/ (hex mapped loopback)", async () => {
    await expect(
      fetchUrlSource("http://[::ffff:7f00:1]/", { lookupImpl: lookupNever }),
    ).rejects.toMatchObject({ code: "url_private_host" });
  });

  it("rejects mapped private ranges and fe80::/10 literals through the same path", async () => {
    for (const url of [
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:a00:1]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[::ffff:c0a8:101]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[fe90::1]/",
    ]) {
      await expect(fetchUrlSource(url, { lookupImpl: lookupNever })).rejects.toMatchObject(
        { code: "url_private_host" },
      );
    }
  });

  it("rejects mapped addresses that only surface at DNS resolution time", async () => {
    // A hostile resolver answering the name with an IPv4-mapped record set:
    // the connection-time validation must refuse it.
    const lookup = (async () => [{ address: "::ffff:7f00:1", family: 6 }]) as unknown as LookupAllFn;
    await expect(
      assertPublicDns("rebind.example.test", lookup),
    ).rejects.toMatchObject({ code: "url_private_host" });
  });
});
