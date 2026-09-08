/**
 * IP reachability policy for SSRF protection — the single authority for the
 * question "may URL ingestion connect to this address?".
 *
 * Security property: an address is connectable only when it classifies as a
 * valid public Internet destination under the explicit, reviewable policy
 * below. Anything unrecognized, special-purpose, or malformed fails closed.
 *
 * The policy is an ordered CIDR rule table evaluated with LONGEST-PREFIX
 * match: a more-specific rule always wins over its parent. This models the
 * registries faithfully in both directions — a special-purpose parent can
 * contain more-specific globally reachable allocations (e.g. 192.0.0.9/32
 * inside 192.0.0.0/24), and a global-unicast parent can contain
 * more-specific non-routable reservations (e.g. 3fff::/20 inside 2000::/3).
 * A broad prefix plus hand-written exceptions is NOT the mechanism here;
 * precedence is generic and every rule carries a reason.
 *
 * Derived from a reviewed static snapshot of:
 * - IANA IPv4 Special-Purpose Address Registry
 * - IANA IPv6 Special-Purpose Address Registry
 * The snapshot is encoded in source and never fetched at runtime — URL
 * safety must not depend on external registry availability. To adopt
 * registry updates, edit the rule tables; the invariant test pins every
 * rule's precedence and canonical form.
 *
 * Embedded-IPv4 forms (IPv4-mapped ::ffff:0:0/96 in BOTH textual forms —
 * the WHATWG URL canonicalizer emits the hex form, NAT64 64:ff9b::/96,
 * 6to4 2002::/16, Teredo 2001::/32) are re-classified through the SAME
 * IPv4 policy: the embedded address decides. There is deliberately no
 * separate embedded-address allow/deny list.
 *
 * This module classifies parsed IP addresses only — no hostnames, no I/O.
 */
export type IpReachability =
  | { globallyReachable: true; family: 4 | 6 }
  | { globallyReachable: false; family: 4 | 6; reason: string };

export interface ParsedIpv4Rule {
  cidr: string;
  /** Canonical 32-bit network (host bits zero). */
  network: number;
  prefixLength: number;
  globallyReachable: boolean;
  reason: string;
}

export interface ParsedIpv6Rule {
  cidr: string;
  /** Canonical 128-bit network as bigint (host bits zero). */
  network: bigint;
  prefixLength: number;
  globallyReachable: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Binary parsing (strict; fail closed)
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 address to a 32-bit number; null when invalid.
 * Shorthand, octal-like ("010"), hexadecimal, and incomplete forms are
 * rejected — an IPv4 literal must be exactly four decimal octets 0-255
 * without leading zeros. */
export function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
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
export function parseIPv6Hextets(input: string): number[] | null {
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

/** Pack 8 hextets into the 128-bit bigint representation. */
function hextetsToBigInt(h: number[]): bigint {
  let out = 0n;
  for (const hextet of h) out = (out << 16n) | BigInt(hextet);
  return out;
}

/** Format a 32-bit IPv4 value as dotted quad (for diagnostics). */
function ipv4ToString(v4: number): string {
  return [(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff].join(".");
}

// ---------------------------------------------------------------------------
// Generic CIDR matching
// ---------------------------------------------------------------------------

function ipv4Matches(value: number, network: number, prefixLength: number): boolean {
  if (prefixLength === 0) return true;
  const shift = 32 - prefixLength;
  return (value >>> shift) === (network >>> shift);
}

function ipv6Matches(value: bigint, network: bigint, prefixLength: number): boolean {
  const shift = BigInt(128 - prefixLength);
  return value >> shift === network >> shift;
}

// ---------------------------------------------------------------------------
// Policy tables (reviewed static snapshot; longest prefix wins)
// ---------------------------------------------------------------------------

function ipv4Rule(cidr: string, globallyReachable: boolean, reason: string): ParsedIpv4Rule {
  const [addr, prefixText] = cidr.split("/");
  const prefixLength = Number(prefixText);
  const parsed = parseIPv4(addr!);
  if (parsed === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`invalid IPv4 policy rule "${cidr}"`);
  }
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (parsed & mask) >>> 0;
  if (network !== parsed) throw new Error(`non-canonical IPv4 policy rule "${cidr}"`);
  return { cidr, network, prefixLength, globallyReachable, reason };
}

function ipv6Rule(cidr: string, globallyReachable: boolean, reason: string): ParsedIpv6Rule {
  const [addr, prefixText] = cidr.split("/");
  const prefixLength = Number(prefixText);
  const parsed = parseIPv6Hextets(addr!);
  if (parsed === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
    throw new Error(`invalid IPv6 policy rule "${cidr}"`);
  }
  const value = hextetsToBigInt(parsed);
  const shift = BigInt(128 - prefixLength);
  const network = prefixLength === 0 ? 0n : (value >> shift) << shift;
  if (network !== value) throw new Error(`non-canonical IPv6 policy rule "${cidr}"`);
  return { cidr, network, prefixLength, globallyReachable, reason };
}

/** Descending prefix length: the most-specific rule is evaluated first. */
function bySpecificityDesc(a: { prefixLength: number }, b: { prefixLength: number }): number {
  return b.prefixLength - a.prefixLength;
}

/**
 * IPv4 policy. Default for addresses matched by no rule: ordinary unicast
 * is globally reachable (the special-purpose ranges below are exhaustive
 * for non-global IPv4 per the IANA snapshot).
 */
export const IPV4_POLICY_RULES: ParsedIpv4Rule[] = [
  // More-specific global exceptions INSIDE the special parent below —
  // longest-prefix match gives these precedence over 192.0.0.0/24.
  ipv4Rule("192.0.0.9/32", true, "Port Control Protocol Anycast (globally reachable, RFC 8281)"),
  ipv4Rule("192.0.0.10/32", true, "Trusted Key Directory anycast (globally reachable, RFC 8281)"),
  // Special-purpose parents (all non-global for SSRF purposes).
  ipv4Rule("0.0.0.0/8", false, "this-network (RFC 791)"),
  ipv4Rule("10.0.0.0/8", false, "private (RFC 1918)"),
  ipv4Rule("100.64.0.0/10", false, "shared address space / CGNAT (RFC 6598)"),
  ipv4Rule("127.0.0.0/8", false, "loopback (RFC 1122)"),
  ipv4Rule("169.254.0.0/16", false, "link-local (RFC 3927)"),
  ipv4Rule("172.16.0.0/12", false, "private (RFC 1918)"),
  ipv4Rule("192.0.0.0/24", false, "IETF protocol assignments (RFC 6890)"),
  ipv4Rule("192.0.2.0/24", false, "TEST-NET-1 documentation (RFC 5737)"),
  ipv4Rule("192.88.99.0/24", false, "6to4 relay anycast, deprecated (RFC 7526)"),
  ipv4Rule("192.168.0.0/16", false, "private (RFC 1918)"),
  ipv4Rule("198.18.0.0/15", false, "benchmarking (RFC 2544)"),
  ipv4Rule("198.51.100.0/24", false, "TEST-NET-2 documentation (RFC 5737)"),
  ipv4Rule("203.0.113.0/24", false, "TEST-NET-3 documentation (RFC 5737)"),
  ipv4Rule("224.0.0.0/4", false, "multicast (RFC 1112)"),
  ipv4Rule("240.0.0.0/4", false, "reserved, incl. limited broadcast (RFC 1112)"),
].sort(bySpecificityDesc);

/**
 * IPv6 policy. Default for addresses matched by no rule: FAIL CLOSED —
 * only explicitly allowed allocations are connectable. The core global
 * unicast allocation (2000::/3) is an explicit rule; more-specific
 * non-routable reservations inside it (3fff::/20, 2001:db8::/32, …) and
 * more-specific reachable allocations inside special parents (2001:1::1/128,
 * 2001:3::/32, …) take precedence by prefix length.
 */
export const IPV6_POLICY_RULES: ParsedIpv6Rule[] = [
  // Reachable more-specifics INSIDE the special 2001::/23 parent below.
  ipv6Rule("2001:1::1/128", true, "Port Control Protocol Anycast (globally reachable, RFC 8281)"),
  ipv6Rule("2001:1::2/128", true, "Trusted Key Directory anycast (globally reachable, RFC 8281)"),
  ipv6Rule("2001:3::/32", true, "AMT global anycast (RFC 7450)"),
  ipv6Rule("2001:4::/32", true, "AS112-v6 anycast (RFC 7534)"),
  // Non-routable more-specifics INSIDE the global 2000::/3 parent below.
  ipv6Rule("3fff::/20", false, "documentation (RFC 9637)"),
  ipv6Rule("3ffe::/16", false, "6bone, deprecated and never globally routed (RFC 3701)"),
  ipv6Rule("2001:db8::/32", false, "documentation (RFC 3849)"),
  // Special-purpose allocations.
  ipv6Rule("::1/128", false, "loopback (RFC 4291)"),
  ipv6Rule("64:ff9b:1::/48", false, "local-use NAT64 prefix (RFC 8215)"),
  ipv6Rule("100::/64", false, "discard-only (RFC 6666)"),
  ipv6Rule("2001:2::/48", false, "benchmarking (RFC 5180)"),
  ipv6Rule("2001:10::/28", false, "ORCHID, deprecated (RFC 4843)"),
  ipv6Rule("2001:20::/28", false, "IETF protocol assignment, not a public destination"),
  ipv6Rule("2001:30::/28", false, "ORCHIDv2 (RFC 9022)"),
  ipv6Rule("2001::/23", false, "IETF protocol assignments parent (RFC 6890)"),
  ipv6Rule("fc00::/7", false, "unique-local (RFC 4193)"),
  ipv6Rule("fe80::/10", false, "link-local (RFC 4291)"),
  ipv6Rule("fec0::/10", false, "deprecated site-local (RFC 3879)"),
  ipv6Rule("ff00::/8", false, "multicast (RFC 4291)"),
  ipv6Rule("2000::/3", true, "allocated global unicast"),
].sort(bySpecificityDesc);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyIpv4(value: number): IpReachability {
  for (const rule of IPV4_POLICY_RULES) {
    if (ipv4Matches(value, rule.network, rule.prefixLength)) {
      return rule.globallyReachable
        ? { globallyReachable: true, family: 4 }
        : { globallyReachable: false, family: 4, reason: rule.reason };
    }
  }
  return { globallyReachable: true, family: 4 };
}

function classifyIpv6(value: bigint): IpReachability {
  for (const rule of IPV6_POLICY_RULES) {
    if (ipv6Matches(value, rule.network, rule.prefixLength)) {
      return rule.globallyReachable
        ? { globallyReachable: true, family: 6 }
        : { globallyReachable: false, family: 6, reason: rule.reason };
    }
  }
  return { globallyReachable: false, family: 6, reason: "outside the policy's globally reachable allocations" };
}

/** The embedded IPv4 decides; same IPv4 policy, no separate list. */
function embeddedVerdict(form: string, v4: number): IpReachability {
  const inner = classifyIpv4(v4);
  if (inner.globallyReachable) return { globallyReachable: true, family: 6 };
  return {
    globallyReachable: false,
    family: 6,
    reason: `${form} embedded IPv4 ${ipv4ToString(v4)}: ${inner.reason}`,
  };
}

export function classifyIpReachability(ip: string): IpReachability {
  const family: 4 | 6 = ip.includes(":") ? 6 : 4;
  if (family === 6) {
    const hextets = parseIPv6Hextets(ip);
    if (hextets === null) {
      return { globallyReachable: false, family: 6, reason: "malformed or ambiguous IPv6 address" };
    }
    // Embedded-IPv4 forms first — the embedded address decides.
    if (hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0xffff) {
      return embeddedVerdict("IPv4-mapped", ((hextets[6]! << 16) | hextets[7]!) >>> 0);
    }
    if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) {
      return embeddedVerdict("NAT64", ((hextets[6]! << 16) | hextets[7]!) >>> 0);
    }
    if (hextets[0] === 0x2001 && hextets[1] === 0x0000) {
      // Teredo: the client IPv4 is the obfuscated (bit-inverted) last 32 bits.
      return embeddedVerdict("Teredo", (((hextets[6]! ^ 0xffff) << 16) | (hextets[7]! ^ 0xffff)) >>> 0);
    }
    if (hextets[0] === 0x2002) {
      // 6to4: the embedded IPv4 rides in hextets 1-2.
      return embeddedVerdict("6to4", ((hextets[1]! << 16) | hextets[2]!) >>> 0);
    }
    return classifyIpv6(hextetsToBigInt(hextets));
  }
  const v4 = parseIPv4(ip);
  if (v4 === null) {
    return { globallyReachable: false, family: 4, reason: "malformed or ambiguous IPv4 address" };
  }
  return classifyIpv4(v4);
}

/** Boolean wrapper over classifyIpReachability for guard checks. */
export function isGloballyReachable(ip: string): boolean {
  return classifyIpReachability(ip).globallyReachable;
}
