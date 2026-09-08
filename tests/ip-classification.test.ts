/**
 * Regression tests for the IP reachability policy (src/core/sources/ip-policy.ts).
 *
 * Security property: URL ingestion may connect only to addresses the
 * explicit CIDR policy classifies as globally reachable; unrecognized,
 * special-purpose, and malformed input fails closed. The policy is an
 * ordered rule table with longest-prefix precedence, derived from a static
 * snapshot of the IANA IPv4/IPv6 Special-Purpose Address Registries —
 * more-specific rules (e.g. 192.0.0.9/32 inside 192.0.0.0/24, or the AMT /
 * AS112-v6 allocations inside 2001::/23) override their parents, and
 * non-routable reservations inside global parents (3fff::/20 inside
 * 2000::/3) are refused.
 *
 * Tests are deterministic: classifier matrix + rule-table invariants +
 * WHATWG URL canonicalization + the production fetchUrlSource path with a
 * lookup stub that throws if reached (proving refusal happens before any
 * DNS/connection). No live network access.
 */
import { describe, expect, it } from "vitest";
import {
  classifyIpReachability,
  isGloballyReachable,
  IPV4_POLICY_RULES,
  IPV6_POLICY_RULES,
} from "../src/core/sources/ip-policy.js";
import { assertPublicDns } from "../src/core/sources/safe-fetch.js";
import { isRefusedHost, fetchUrlSource, assertSafeUrl, type LookupAllFn } from "../src/core/sources/url.js";

// ---------------------------------------------------------------------------
// Required IPv4 rejection matrix
// ---------------------------------------------------------------------------

const IPV4_MUST_REJECT = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "192.0.0.8", // parent 192.0.0.0/24 (only .9 and .10 are global)
  "192.0.0.11",
  "192.0.2.1",
  "192.88.99.1",
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

// ---------------------------------------------------------------------------
// Required IPv6 rejection matrix
// ---------------------------------------------------------------------------

const IPV6_MUST_REJECT = [
  "::",
  "::1",
  "100::1",
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
  "3fff::1",
  "3fff:db8::1", // inside 3fff::/20 documentation block
  "4000::1", // outside every allocation — fail closed
  "64:ff9b:1::1", // local-use NAT64 (RFC 8215)
  "2001:2::1", // benchmarking
  "2001:5::1", // IETF protocol assignment parent
  "2001:20::1", // special assignment /28
  "2001:30::1", // ORCHIDv2
  "2001:10::1", // ORCHID, deprecated
  // IPv4-mapped, dotted textual form
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "::ffff:192.168.1.1",
  "::ffff:169.254.169.254",
  // IPv4-mapped, hex textual form (WHATWG canonicalizer output)
  "::ffff:7f00:1",
  "::ffff:a00:1",
  "::ffff:c0a8:101",
  // NAT64 well-known prefix embedding non-global IPv4
  "64:ff9b::7f00:1",
  "64:ff9b::c000:201",
  // 6to4 embedding non-global IPv4
  "2002:7f00:1::",
  // Teredo embedding loopback (client bits bit-inverted)
  "2001:0:9c38:953c:ffff:ffff:80fe:fffe",
  // malformed / ambiguous forms fail closed
  "not-an-ip",
  "1:2:3:4:5:6:7:8:9",
  "12345::",
  "fe80::1%eth0",
  "::ffff:1.2.3.256",
];

/** Representative REAL globally reachable addresses (no network needed). */
const MUST_ALLOW_V4 = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "151.101.1.69"];
const MUST_ALLOW_V6 = ["2606:4700::1111", "2001:4860:4860::8888", "2620:fe::fe", "2a00:1450:4001:81b::200e"];

describe("classifyIpReachability: IPv4 matrix", () => {
  it("rejects every required non-global IPv4 address", () => {
    for (const ip of IPV4_MUST_REJECT) {
      expect(isGloballyReachable(ip), ip).toBe(false);
    }
  });

  it("allows representative globally reachable IPv4 addresses", () => {
    for (const ip of MUST_ALLOW_V4) {
      expect(isGloballyReachable(ip), ip).toBe(true);
    }
  });

  it("classifies registry precedence: parent /24 false, global anycast /32s inside it true", () => {
    // The named precedence family: longest-prefix policy, not a coarse
    // parent block.
    expect(isGloballyReachable("192.0.0.8")).toBe(false);
    expect(isGloballyReachable("192.0.0.9")).toBe(true);
    expect(isGloballyReachable("192.0.0.10")).toBe(true);
    expect(isGloballyReachable("192.0.0.11")).toBe(false);
    // Reason strings come from the winning rule.
    const parent = classifyIpReachability("192.0.0.11");
    expect(parent.globallyReachable).toBe(false);
    if (!parent.globallyReachable) expect(parent.reason).toContain("IETF protocol assignments");
    const testnet = classifyIpReachability("192.0.2.1");
    expect(testnet.globallyReachable).toBe(false);
    if (!testnet.globallyReachable) expect(testnet.reason).toContain("TEST-NET-1");
  });
});

describe("classifyIpReachability: IPv6 matrix", () => {
  it("rejects every required non-global IPv6 address", () => {
    for (const ip of IPV6_MUST_REJECT) {
      expect(isGloballyReachable(ip), ip).toBe(false);
    }
  });

  it("allows representative globally reachable IPv6 addresses", () => {
    for (const ip of MUST_ALLOW_V6) {
      expect(isGloballyReachable(ip), ip).toBe(true);
    }
  });

  it("classifies registry precedence inside 2001::/23 (parent false, global children true)", () => {
    // More-specific global anycast allocations inside the special parent.
    expect(isGloballyReachable("2001:1::1")).toBe(true);
    expect(isGloballyReachable("2001:1::2")).toBe(true);
    expect(isGloballyReachable("2001:3::1")).toBe(true);
    expect(isGloballyReachable("2001:4:112::1")).toBe(true);
    // The parent and its other children stay refused.
    expect(isGloballyReachable("2001:5::1")).toBe(false);
    expect(isGloballyReachable("2001:4:ffff::1")).toBe(true); // whole 2001:4::/32 is registry-global
    expect(isGloballyReachable("2001:ff::1")).toBe(false); // bare parent range, no more-specific child
    // Non-routable reservations inside global 2000::/3 lose to their /20+/32 rules.
    expect(isGloballyReachable("3fff::1")).toBe(false);
    expect(isGloballyReachable("2001:db8::1")).toBe(false);
    // 3fff::/20 does NOT swallow neighboring unallocated space — fail closed.
    expect(isGloballyReachable("3ffe::1")).toBe(false);
  });

  it("carries the winning rule's reason for diagnostics", () => {
    const doc = classifyIpReachability("3fff::1");
    expect(doc.globallyReachable).toBe(false);
    if (!doc.globallyReachable) expect(doc.reason).toContain("documentation");
    const mapped = classifyIpReachability("::ffff:7f00:1");
    expect(mapped.globallyReachable).toBe(false);
    if (!mapped.globallyReachable) expect(mapped.reason).toContain("IPv4-mapped embedded IPv4 127.0.0.1");
    const malformed = classifyIpReachability("not-an-ip");
    expect(malformed.globallyReachable).toBe(false);
    if (!malformed.globallyReachable) expect(malformed.reason).toContain("malformed");
  });

  it("classifies embedded forms through the IPv4 engine in BOTH directions", () => {
    // Mapped public embedded IPv4 → reachable (same engine, no separate list).
    expect(isGloballyReachable("::ffff:8.8.8.8")).toBe(true);
    expect(isGloballyReachable("::ffff:808:808")).toBe(true);
    // NAT64 WKP with public embedded IPv4 → reachable.
    expect(isGloballyReachable("64:ff9b::808:808")).toBe(true);
    // 6to4 with public embedded IPv4 → reachable.
    expect(isGloballyReachable("2002:808:808::")).toBe(true);
    // Teredo with public client IPv4 (bit-inverted) → reachable.
    expect(isGloballyReachable("2001:0:9c38:953c:ffff:ffff:f7f7:f7f7")).toBe(true);
    // ...and the same forms embedding private/special IPv4 → refused.
    expect(isGloballyReachable("2001:0:9c38:953c:ffff:ffff:80fe:fffe")).toBe(false);
    expect(isGloballyReachable("2002:c000:201::")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule-table invariants (the precedence model must stay unambiguous)
// ---------------------------------------------------------------------------

describe("policy table invariants", () => {
  it("rules are sorted by descending prefix length (longest prefix wins)", () => {
    for (const rules of [IPV4_POLICY_RULES, IPV6_POLICY_RULES]) {
      for (let i = 1; i < rules.length; i++) {
        expect(rules[i]!.prefixLength, `rule ${rules[i]!.cidr} out of order`).toBeLessThanOrEqual(
          rules[i - 1]!.prefixLength,
        );
      }
    }
  });

  it("rule networks are canonical and unambiguous under longest-prefix match", () => {
    for (const rules of [IPV4_POLICY_RULES, IPV6_POLICY_RULES]) {
      const keys = new Set<string>();
      for (const rule of rules) {
        // No duplicate (prefix, network) pairs — equal-length overlapping
        // networks would be ambiguous under first-match semantics.
        const key = `${rule.prefixLength}:${rule.network.toString()}`;
        expect(keys.has(key), `duplicate rule key ${key}`).toBe(false);
        keys.add(key);
        // The rule wins on its own network address: classify(rule.network)
        // must produce THIS rule's flag (proves canonical networks and no
        // accidental shadowing by a more-specific sibling rule).
        const networkText = rule.cidr.split("/")[0]!;
        const verdict = classifyIpReachability(networkText);
        expect(verdict.globallyReachable, `${rule.cidr} is shadowed by another rule`).toBe(
          rule.globallyReachable,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// URL canonicalization guards
// ---------------------------------------------------------------------------

describe("isRefusedHost over URL-canonicalized hosts", () => {
  it("refuses mapped/link-local/document literal hosts after WHATWG canonicalization", () => {
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

  it("keeps globally routable literal hosts usable", () => {
    expect(isRefusedHost(assertSafeUrl("http://[2606:4700::1111]/").hostname)).toBe(false);
    expect(isRefusedHost(assertSafeUrl("http://1.1.1.1/").hostname)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Production URL ingestion path (refusal must precede DNS/connect)
// ---------------------------------------------------------------------------

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

  it("hands only validated global addresses to the pinned connection (DNS names)", async () => {
    const globalV4 = (async () => [{ address: "1.1.1.1", family: 4 }]) as unknown as LookupAllFn;
    const pinned = await assertPublicDns("public-v4.example.test", globalV4);
    expect(pinned).toEqual([{ address: "1.1.1.1", family: 4 }]);

    // Registry precedence through the production path: a globally reachable
    // anycast /32 inside a special parent passes; its non-global siblings do not.
    const pcp = (async () => [{ address: "192.0.0.9", family: 4 }]) as unknown as LookupAllFn;
    expect(await assertPublicDns("pcp.example.test", pcp)).toEqual([{ address: "192.0.0.9", family: 4 }]);
    const parent = (async () => [{ address: "192.0.0.8", family: 4 }]) as unknown as LookupAllFn;
    await expect(assertPublicDns("parent.example.test", parent)).rejects.toMatchObject({
      code: "url_private_host",
    });
  });
});
