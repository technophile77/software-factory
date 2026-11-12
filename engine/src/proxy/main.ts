// Entry point of the sidecar proxy (bundled to dist/proxy.js). One JSON
// message per line on stdin from the engine, one per line on stdout back.
import * as os from "node:os";
import * as readline from "node:readline";
import { EgressProxy, ProxyLog, Refused } from "./server";
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
}

export type ToProxy =
  | ProxyStart
  | { t: "grant"; cred: string; session: string; role: string; allow: string[]; webSearch?: boolean }
  | { t: "revoke"; cred: string }
  | { t: "fetch"; id: number; cred: string; url: string };

export type FromProxy =
  | { t: "ready"; address: string; port: number }
  | { t: "fetched"; id: number; ok: true; url: string; status: number; contentType: string; body: string; truncated: boolean }
  | { t: "fetched"; id: number; ok: false; status: number; reason: string }
  | { t: "error"; reason: string }
  | ProxyLog;

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
      proxy = new EgressProxy({ credential: m.credential, dummyKey: m.dummyKey, blockedSubnets: m.blockedSubnets, maxPageBytes: m.maxPageBytes, log: send });
      proxy.server.listen(PROXY_PORT, address!, () => send({ t: "ready", address: address!, port: PROXY_PORT }));
      proxy.server.on("error", () => process.exit(3));
      return;
    }
    if (!proxy) return send({ t: "error", reason: "not started" });
    try {
      if (m.t === "grant") proxy.grant(m.cred, { session: m.session, role: m.role, allow: m.allow, webSearch: m.webSearch === true });
      else if (m.t === "revoke") proxy.revoke(m.cred);
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
