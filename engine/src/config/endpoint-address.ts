import { isIP } from "node:net";
import { parseCidr, toBits, type Cidr } from "../proxy/rules";

/** Where an endpoint's address sits: on the owner's own network, or on the public internet. */
export type AddressClass = "private" | "public";

/** An endpoint whose address was checked and fixed for one session (FR-4). */
export interface PinnedEndpoint {
  name: string;
  class: AddressClass;
  scheme: "http" | "https";
  /** The host as written in the URL, kept for the Host header and TLS server name. */
  host: string;
  /** The address that was checked; connect here, never re-resolve (SR-3). */
  address: string;
  port: number;
  /** Path prefix of the base URL with no trailing slash; empty when the URL has none. */
  basePath: string;
}

/** What `resolveEndpoint` needs to know about a configured endpoint. */
export interface EndpointInput {
  name: string;
  baseUrl: string;
  /** Whether an API key is configured for the endpoint. */
  hasKey: boolean;
  billing: "local" | "per_token" | "subscription";
  /** Whether a loopback address counts as private (the `allow_loopback` setting). */
  allowLoopback: boolean;
}

/** Resolves a host name to every address it answers with (injected so tests and the engine choose the resolver). */
export type EndpointLookup = (host: string) => Promise<{ address: string; family: number }[]>;

/** Raised when an endpoint's address or settings break FR-4, SR-12 or SR-15; the message is safe to show the owner. */
export class EndpointAddressError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EndpointAddressError";
  }
}

const cidrs = (list: string[]): Cidr[] => list.map((c) => parseCidr(c)!);

const V4_PRIVATE = cidrs(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]);
const V4_LOOPBACK = cidrs(["127.0.0.0/8"]);
/** Not routable to a unique public host and not the owner's LAN: refused outright. */
const V4_REFUSED = cidrs(["0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"]);
const V6_PRIVATE = cidrs(["fc00::/7", "fe80::/10"]);
const V6_GLOBAL = cidrs(["2000::/3"]);
/** Inside 2000::/3 but special-purpose: IETF assignments (incl. Teredo), documentation, 6to4, ORCHIDv2 and the like. */
const V6_REFUSED = cidrs(["2001::/23", "2001:10::/28", "2001:20::/28", "2001:db8::/32", "2002::/16", "3fff::/20"]);
/** IPv6 ranges that carry an IPv4 address; only the IPv4-mapped form is read as that address, the rest are refused. */
const V6_EMBEDDING = cidrs(["::/96", "64:ff9b::/96", "64:ff9b:1::/48"]);

const MAPPED_PREFIX = 0xffffn;
const V6_LOOPBACK_BITS = 1n;

function inAny(bits: bigint, list: Cidr[]): boolean {
  return list.some((c) => {
    const shift = BigInt(128 - c.prefix);
    return bits >> shift === c.bits >> shift;
  });
}

function classifyV4(bits: bigint, allowLoopback: boolean): AddressClass | null {
  if (inAny(bits, V4_LOOPBACK)) return allowLoopback ? "private" : null;
  if (inAny(bits, V4_PRIVATE)) return "private";
  if (inAny(bits, V4_REFUSED)) return null;
  return "public";
}

/**
 * Classifies one IP address for the endpoint check (FR-4): private (RFC 1918,
 * RFC 4193, link-local, and loopback only when allowed), public (globally
 * routable), or null for anything an endpoint must never use (unspecified,
 * multicast, CGNAT, documentation, benchmarking, 6to4, Teredo, NAT64 and other
 * IPv4-embedding forms, unparsable text). An IPv4-mapped IPv6 address takes the
 * class of the IPv4 address inside it, so `::ffff:10.0.0.1` cannot pass as public.
 *
 * @param addr An IPv4 or IPv6 literal, with or without an IPv6 zone id.
 * @param allowLoopback Whether 127.0.0.0/8 and ::1 count as private instead of refused.
 * @example
 * classifyAddress("192.168.1.20", false); // "private"
 * classifyAddress("8.8.8.8", false); // "public"
 * classifyAddress("127.0.0.1", false); // null
 * classifyAddress("::ffff:10.0.0.1", false); // "private"
 * @see resolveEndpoint
 */
export function classifyAddress(addr: string, allowLoopback: boolean): AddressClass | null {
  const bits = toBits(addr);
  if (bits === null) return null;
  if (bits >> 32n === MAPPED_PREFIX) return classifyV4(bits, allowLoopback);
  if (bits === V6_LOOPBACK_BITS) return allowLoopback ? "private" : null;
  if (inAny(bits, V6_EMBEDDING)) return null;
  if (inAny(bits, V6_PRIVATE)) return "private";
  if (!inAny(bits, V6_GLOBAL) || inAny(bits, V6_REFUSED)) return null;
  return "public";
}

function parseBaseUrl(name: string, baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new EndpointAddressError(`endpoint ${name}: the base URL is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointAddressError(`endpoint ${name}: the base URL must use http or https`);
  }
  if (url.username || url.password) {
    throw new EndpointAddressError(`endpoint ${name}: the base URL must not contain a user name or password`);
  }
  return url;
}

async function addressesOf(name: string, host: string, lookup: EndpointLookup): Promise<string[]> {
  if (isIP(host)) return [host];
  let answers: { address: string }[];
  try {
    answers = await lookup(host);
  } catch {
    throw new EndpointAddressError(`endpoint ${name}: host ${host} did not resolve`);
  }
  if (answers.length === 0) throw new EndpointAddressError(`endpoint ${name}: host ${host} resolved to no addresses`);
  return answers.map((a) => a.address);
}

function classOfAll(name: string, addresses: string[], allowLoopback: boolean): AddressClass {
  const classes = addresses.map((a) => classifyAddress(a, allowLoopback));
  if (classes.includes(null)) {
    throw new EndpointAddressError(`endpoint ${name}: an address of the host is not one an endpoint may use (loopback, reserved, special-purpose or unparsable)`);
  }
  const first = classes[0]!;
  if (classes.some((c) => c !== first)) {
    throw new EndpointAddressError(`endpoint ${name}: the host resolves to both private and public addresses`);
  }
  return first;
}

/**
 * Resolves an endpoint's host on this PC, classes every answer and pins the
 * first one, so the session connects to the address that was checked (FR-4,
 * SR-3). Refuses a public endpoint without HTTPS and an API key (SR-12) and
 * billing `local` on a public endpoint (SR-15). Called before each session
 * because a name can move between sessions.
 *
 * @param input The configured endpoint; `baseUrl` is an absolute http(s) URL.
 * @param lookup Resolver returning all answers for a host name; not called for IP literals.
 * @returns The endpoint with its checked address; `host` stays the name from the URL.
 * @throws EndpointAddressError On a bad URL, failed or empty resolution, a refused address, mixed classes, public without https or key, or public with billing `local`.
 * @example
 * await resolveEndpoint(
 *   { name: "lan", baseUrl: "http://llm.local:8080/v1", hasKey: false, billing: "local", allowLoopback: false },
 *   async () => [{ address: "192.168.1.20", family: 4 }],
 * ); // { name: "lan", class: "private", scheme: "http", host: "llm.local", address: "192.168.1.20", port: 8080, basePath: "/v1" }
 * @see classifyAddress
 */
export async function resolveEndpoint(input: EndpointInput, lookup: EndpointLookup): Promise<PinnedEndpoint> {
  const { name } = input;
  const url = parseBaseUrl(name, input.baseUrl);
  const scheme = url.protocol === "https:" ? "https" : "http";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await addressesOf(name, host, lookup);
  const cls = classOfAll(name, addresses, input.allowLoopback);
  if (cls === "public") {
    if (scheme !== "https") throw new EndpointAddressError(`endpoint ${name}: a public endpoint must use https`);
    if (!input.hasKey) throw new EndpointAddressError(`endpoint ${name}: a public endpoint needs an API key`);
    if (input.billing === "local") throw new EndpointAddressError(`endpoint ${name}: billing "local" is only for a private endpoint`);
  }
  return {
    name,
    class: cls,
    scheme,
    host,
    address: addresses[0]!,
    port: url.port ? Number(url.port) : scheme === "https" ? 443 : 80,
    basePath: url.pathname.replace(/\/+$/, ""),
  };
}
