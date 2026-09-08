/**
 * Destination safety policy for SSRF protection — the single authority for
 * the question "may URL ingestion connect to this address?".
 *
 * Contract: URL ingestion permits ordinary public Internet destinations and
 * conservatively rejects local, private, link-local, documentation, test,
 * benchmark, reserved, multicast, transitional, and protocol-special
 * destination ranges. Rare special-use anycast allocations are rejected
 * too — conservative overblocking is acceptable for this product. This is
 * deliberately NOT an exact IANA-registry reachability implementation.
 *
 * The blocked ranges are a static reviewed snapshot of the special-purpose
 * ranges that matter for SSRF (IANA special-purpose registries plus
 * deprecated allocations), encoded in source and never fetched at runtime.
 *
 * Parsing is strict and fails closed: shorthand, octal-like ("010"),
 * hexadecimal, and leading-zero IPv4 forms, zone IDs, overlong groups, and
 * ambiguous input are malformed → not allowed.
 *
 * IPv6: global unicast is exactly 2000::/3 (RFC 4291), so anything outside
 * it — including every transitional/tunneled form (IPv4-mapped, NAT64,
 * 6to4, Teredo) — is not allowed, and a small blocked list removes the
 * special/deprecated allocations inside it (2001::/23, 2001:db8::/32,
 * 2002::/16, 3ffe::/16, 3fff::/20).
 *
 * This module classifies parsed IP addresses only — no hostnames, no I/O.
 */

export interface BlockedCidr {
  cidr: string;
  /** Canonical blocked network (IPv4: uint32; IPv6: 128-bit bigint). */
  network: number | bigint;
  prefixLength: number;
}

/** Parse a dotted-quad IPv4 address to a 32-bit number; null when invalid. */
function parseIPv4(ip: string): number | null {
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
 * tail. Head groups anchor the start, tail groups anchor the end; :: fills
 * the middle with zeros.
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

function hextetsToBigInt(h: number[]): bigint {
  let out = 0n;
  for (const hextet of h) out = (out << 16n) | BigInt(hextet);
  return out;
}

// ---------------------------------------------------------------------------
// Blocked ranges (conservative snapshot; static in source, no runtime fetch)
// ---------------------------------------------------------------------------

const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8", // this-network
  "10.0.0.0/8", // private
  "100.64.0.0/10", // shared address space / CGNAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1 documentation
  "192.88.99.0/24", // 6to4 relay anycast, deprecated
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2 documentation
  "203.0.113.0/24", // TEST-NET-3 documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, incl. limited broadcast
];

const BLOCKED_IPV6_CIDRS = [
  "2001::/23", // IETF protocol assignments (incl. Teredo)
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4 (transitional)
  "3ffe::/16", // 6bone, deprecated and never globally routed
  "3fff::/20", // documentation
];

/** Descending prefix length: the most-specific block is evaluated first. */
function bySpecificityDesc(a: BlockedCidr, b: BlockedCidr): number {
  return b.prefixLength - a.prefixLength;
}

function parseBlockedCidr4(cidr: string): BlockedCidr {
  const [addr, prefixText] = cidr.split("/");
  const prefixLength = Number(prefixText);
  const parsed = parseIPv4(addr!);
  if (parsed === null || !Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) {
    throw new Error(`invalid IPv4 policy rule "${cidr}"`);
  }
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (parsed & mask) >>> 0;
  if (network !== parsed) throw new Error(`non-canonical IPv4 policy rule "${cidr}"`);
  return { cidr, network, prefixLength };
}

function parseBlockedCidr6(cidr: string): BlockedCidr {
  const [addr, prefixText] = cidr.split("/");
  const prefixLength = Number(prefixText);
  const hextets = parseIPv6Hextets(addr!);
  if (hextets === null || !Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 128) {
    throw new Error(`invalid IPv6 policy rule "${cidr}"`);
  }
  const value = hextetsToBigInt(hextets);
  const shift = BigInt(128 - prefixLength);
  const network = (value >> shift) << shift;
  if (network !== value) throw new Error(`non-canonical IPv6 policy rule "${cidr}"`);
  return { cidr, network, prefixLength };
}

const BLOCKED_IPV4 = BLOCKED_IPV4_CIDRS.map(parseBlockedCidr4).sort(bySpecificityDesc);
const BLOCKED_IPV6 = BLOCKED_IPV6_CIDRS.map(parseBlockedCidr6).sort(bySpecificityDesc);

/** Allocated global unicast for IPv6 (RFC 4291) — the only allowed region. */
const IPV6_GLOBAL_UNICAST = parseBlockedCidr6("2000::/3");

function ipv4Blocked(value: number): boolean {
  for (const rule of BLOCKED_IPV4) {
    const shift = 32 - rule.prefixLength;
    if ((value >>> shift) === ((rule.network as number) >>> shift)) return true;
  }
  return false;
}

function ipv6Allowed(value: bigint): boolean {
  // Everything outside the global unicast allocation is not allowed —
  // including all transitional/tunneled forms.
  const coreShift = BigInt(128 - IPV6_GLOBAL_UNICAST.prefixLength);
  if (value >> coreShift !== (IPV6_GLOBAL_UNICAST.network as bigint) >> coreShift) return false;
  for (const rule of BLOCKED_IPV6) {
    const shift = BigInt(128 - rule.prefixLength);
    if (value >> shift === (rule.network as bigint) >> shift) return false;
  }
  return true;
}

/**
 * May URL ingestion connect to this address? Conservative public-destination
 * policy: false for every local/private/special/transitional range above and
 * for malformed or ambiguous input.
 */
export function isAllowedUrlDestinationIp(ip: string): boolean {
  if (ip.includes(":")) {
    const hextets = parseIPv6Hextets(ip);
    return hextets === null ? false : ipv6Allowed(hextetsToBigInt(hextets));
  }
  const v4 = parseIPv4(ip);
  return v4 === null ? false : !ipv4Blocked(v4);
}
