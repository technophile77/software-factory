// Entry point of the sidecar proxy (bundled to dist/proxy.js). One JSON
// message per line on stdin from the engine, one per line on stdout back.
import * as net from "node:net";
import * as os from "node:os";
import * as readline from "node:readline";
import { EgressProxy, GrantDeadline, PinnedEndpoint, ProxyLog, Refused, RouterTarget } from "./server";
import { blockedAddress, parseCidr, toBits } from "./rules";

export const PROXY_PORT = 3128;

export interface ProxyStart {
  t: "start";
  credential: { kind: "api_key" | "subscription"; value: string };
  dummyKey: string;
  /** The agents' internal network: the proxy listens only on its address there (SR-7). */
  internalSubnet: string;
  blockedSubnets: string[];
  maxPageBytes: number;
  /**
   * The router's own network, shared with the proxy only (F-013 M1). The proxy
   * also listens there so the router can use it as its egress proxy; required
   * whenever `router` is given.
   */
  routerSubnet?: string;
  /**
   * The LiteLLM container (F-013): endpoint grants are forwarded to it. Its
   * address must be on `routerSubnet`, or the proxy refuses to start.
   */
  router?: RouterTarget;
}

export type ToProxy =
  | ProxyStart
  | { t: "grant"; cred: string; session: string; role: string; allow: string[]; webSearch?: boolean; upstream?: string; deadline?: GrantDeadline; kind?: "agent" | "router" }
  | { t: "revoke"; cred: string }
  | { t: "endpoints"; list: PinnedEndpoint[] }
  | { t: "fetch"; id: number; cred: string; url: string };

export type FromProxy =
  | { t: "ready"; address: string; port: number }
  | { t: "fetched"; id: number; ok: true; url: string; status: number; contentType: string; body: string; truncated: boolean }
  | { t: "fetched"; id: number; ok: false; status: number; reason: string }
  | { t: "error"; reason: string }
  | ProxyLog;

/**
 * Whether `addr` lies in `subnet` (CIDR). The router must be on its own
 * network, so a bad `start` can't point the gateway at some other host.
 *
 * @example
 * inSubnet("172.19.0.5", "172.19.0.0/16"); // true
 */
export function inSubnet(addr: string, subnet: string): boolean {
  const c = parseCidr(subnet);
  const b = toBits(addr);
  if (!c || b === null) return false;
  const shift = BigInt(128 - c.prefix);
  return b >> shift === c.bits >> shift;
}

/** This container's address on `subnet`, from its own interfaces. */
export function addressOn(subnet: string, ifaces = os.networkInterfaces()): string | null {
  const c = parseCidr(subnet);
  if (!c) return null;
  const shift = BigInt(128 - c.prefix);
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      const b = toBits(i.address);
      if (b !== null && b >> shift === c.bits >> shift) return i.address;
    }
  }
  return null;
}

function main(): void {
  const send = (m: FromProxy) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let proxy: EgressProxy | null = null;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let m: ToProxy;
    try {
      m = JSON.parse(line) as ToProxy;
    } catch {
      return send({ t: "error", reason: "bad message" });
    }
    if (m.t === "start") {
      if (proxy) return send({ t: "error", reason: "already started" });
      const address = addressOn(m.internalSubnet);
      // Fail closed: without a private address on the internal network there is nowhere safe to listen.
      if (!address || !blockedAddress(address)) {
        send({ t: "error", reason: "no address on the internal network" });
        process.exit(2);
      }
      const routerAddress = m.router && m.routerSubnet ? addressOn(m.routerSubnet) : null;
      if (m.router && !(m.routerSubnet !== undefined && routerAddress !== null && inSubnet(m.router.address, m.routerSubnet) && Number.isInteger(m.router.port) && m.router.port > 0 && m.router.port < 65536 && typeof m.router.masterKey === "string" && m.router.masterKey !== "")) {
        send({ t: "error", reason: "the router isn't on its network" });
        process.exit(2);
      }
      proxy = new EgressProxy({ credential: m.credential, dummyKey: m.dummyKey, blockedSubnets: m.blockedSubnets, maxPageBytes: m.maxPageBytes, log: send, router: m.router });
      const started = proxy;
      started.server.listen(PROXY_PORT, address!, () => send({ t: "ready", address: address!, port: PROXY_PORT }));
      started.server.on("error", () => process.exit(3));
      if (routerAddress) {
        // The router's way out. Agents have no interface on this network, so only the router can reach this listener.
        const routerSide = net.createServer((sock) => started.server.emit("connection", sock));
        routerSide.listen(PROXY_PORT, routerAddress);
        routerSide.on("error", () => process.exit(3));
      }
      return;
    }
    if (!proxy) return send({ t: "error", reason: "not started" });
    try {
      if (m.t === "grant") proxy.grant(m.cred, { session: m.session, role: m.role, allow: m.allow, webSearch: m.webSearch === true, upstream: m.upstream, kind: m.kind, ...(m.deadline ? { deadline: m.deadline } : {}) });
      else if (m.t === "revoke") proxy.revoke(m.cred);
      else if (m.t === "endpoints") proxy.setEndpoints(m.list);
      else if (m.t === "fetch") {
        const id = m.id;
        proxy.fetchPage(m.cred, m.url).then(
          (r) => send({ t: "fetched", id, ok: true, url: r.url, status: r.status, contentType: r.contentType, body: r.body.toString("base64"), truncated: r.truncated }),
          (e) => send({ t: "fetched", id, ok: false, status: e instanceof Refused ? e.status : 502, reason: e instanceof Refused ? e.reason : "fetch failed" }),
        );
      }
    } catch {
      send({ t: "error", reason: "bad message" });
    }
  });
  // The engine closing stdin ends the session group: stop at once.
  rl.on("close", () => process.exit(0));
}

if (require.main === module) main();
