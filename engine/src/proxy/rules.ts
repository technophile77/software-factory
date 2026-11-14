// Shared by the engine and the proxy bundle, which runs in the sidecar with
// Node's built-in modules only (OQ-5): nothing here may import a library.
import { isIP } from "node:net";

/** An address as 128 bits; IPv4 is held as its IPv4-mapped IPv6 form so one table covers both. */
export function toBits(addr: string): bigint | null {
  const v = isIP(addr);
  if (v === 4) return 0xffff00000000n | v4Bits(addr);
  if (v !== 6) return null;
  let s = addr.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    if (isIP(last) !== 4) return null;
    const v4 = v4Bits(last);
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x === "" ? [] : x.split(":"));
  const h = part(halves[0]!);
  const r = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - h.length - r.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...h, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...r];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(`0x${g}`), 0n);
}

function v4Bits(a: string): bigint {
  return a.split(".").reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n);
}

export interface Cidr {
  bits: bigint;
  prefix: number;
}

export function parseCidr(cidr: string): Cidr | null {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr);
  if (!m) return null;
  const v = isIP(m[1]!);
  const bits = toBits(m[1]!);
  let prefix = Number(m[2]);
  if (bits === null || (v === 4 && prefix > 32) || prefix > 128) return null;
  if (v === 4) prefix += 96;
  return { bits, prefix };
}

function inCidr(bits: bigint, c: Cidr): boolean {
  const shift = BigInt(128 - c.prefix);
  return bits >> shift === c.bits >> shift;
}

/**
 * SR-8: loopback, private, CGNAT, link-local, unique-local, multicast and
 * unspecified addresses, in IPv4, IPv6 and the IPv6 forms that carry an
 * IPv4 address. Reserved and broadcast IPv4 are refused too: nothing public
 * lives there. So are the other special-purpose ranges (Code Review,
 * L6): IETF protocol assignments, documentation, benchmarking and discard
 * space, and the 6to4 and Teredo tunnel prefixes, which carry an IPv4
 * address (Teredo's obfuscated) a plain low-32-bit check wouldn't see.
 */
const BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
const BLOCKED_V6 = ["::/128", "::1/128", "100::/64", "2001::/32", "2001:10::/28", "2001:20::/28", "2001:db8::/32", "2002::/16", "3fff::/20",
  "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"];
const BLOCKED: Cidr[] = [...BLOCKED_V4, ...BLOCKED_V6].map((c) => parseCidr(c)!);
/** IPv6 ranges that embed an IPv4 address in their low 32 bits: compatible (::a.b.c.d), NAT64 and 6to4-style translation. */
const EMBEDS_V4: Cidr[] = ["::/96", "64:ff9b::/96", "64:ff9b:1::/48"].map((c) => parseCidr(c)!);

export function blockedAddress(addr: string, extra: Cidr[] = []): boolean {
  const bits = toBits(addr);
  if (bits === null) return true;
  const check = (b: bigint) => BLOCKED.some((c) => inCidr(b, c)) || extra.some((c) => inCidr(b, c));
  if (check(bits)) return true;
  if (EMBEDS_V4.some((c) => inCidr(bits, c))) return check(0xffff00000000n | (bits & 0xffffffffn));
  return false;
}

/** A host name as the proxy compares it: lower case, no trailing dot. Null if it isn't a plain DNS name. */
export function normalHost(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.length === 0 || h.length > 253) return null;
  if (!/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(h)) return null;
  // A numeric last label lets a resolver read the name as an address
  // (inet_aton forms: 0x7f.1, 2130706433); no real top-level domain is numeric.
  if (/^(0x[0-9a-f]*|[0-9]+)$/i.test(h.split(".").pop()!)) return null;
  return h;
}

/**
 * Whether a role may reach `host`. IP literals are always refused: an
 * open-web role may not use them (SR-8), and a listed role's allow list holds
 * only names. `*` means any host name.
 */
export function hostAllowed(allow: readonly string[], host: string): boolean {
  if (isIP(host.replace(/^\[|\]$/g, ""))) return false;
  const h = normalHost(host);
  if (!h) return false;
  return allow.includes("*") || allow.includes(h);
}
