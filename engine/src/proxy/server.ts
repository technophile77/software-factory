// The egress proxy and credential gateway (SR-6 to SR-9, SR-21). It runs in
// the sidecar container on Node's built-in modules only (OQ-5) and talks to
// the engine over stdio, so the model credential arrives on stdin and never
// in an argument, a variable or a file.
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { Cidr, blockedAddress, hostAllowed, normalHost, parseCidr } from "./rules";

export const API_HOST = "api.anthropic.com";
/** The model API paths Claude Code calls through the gateway (SR-9). */
export const API_PATHS = ["/v1/messages", "/v1/messages/count_tokens"];
export const GATEWAY_PREFIX = "/gw/";
const MAX_API_BODY = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CRED_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface Grant {
  session: string;
  role: string;
  /** The role's `network.allow`: host names, or ["*"]. */
  allow: string[];
}

export interface ModelCredential {
  kind: "api_key" | "subscription";
  value: string;
}

export interface ProxyLog {
  t: "log";
  kind: "connect" | "gateway" | "fetch" | "refused";
  session?: string;
  role?: string;
  host?: string;
  port?: number;
  path?: string;
  status?: number;
  reason?: string;
}

export interface Resolved {
  address: string;
  family: number;
}

export interface ProxyDeps {
  lookup(host: string): Promise<Resolved[]>;
  connect(address: string, port: number): net.Socket;
  /** An HTTPS request to `address`, with TLS checked against `host`. */
  request(address: string, host: string, opts: { method: string; path: string; headers: http.OutgoingHttpHeaders }): http.ClientRequest;
}

export const realDeps: ProxyDeps = {
  lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  connect: (address, port) => net.connect({ host: address, port }),
  request: (address, host, o) =>
    https.request({
      host,
      servername: host,
      port: 443,
      method: o.method,
      path: o.path,
      headers: o.headers,
      // Connect only to the address that was checked (SR-8), whatever DNS says now.
      lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        const family = net.isIP(address);
        if (opts && opts.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      }) as never,
      agent: false,
      timeout: 60_000,
    }),
};

export class Refused extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

export interface ProxyOptions {
  credential: ModelCredential;
  dummyKey: string;
  /** Subnets of the Docker networks, refused as destinations along with SR-8's ranges. */
  blockedSubnets: string[];
  maxPageBytes: number;
  log(entry: ProxyLog): void;
  deps?: ProxyDeps;
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

export class EgressProxy {
  private readonly grants = new Map<string, Grant>();
  private readonly extra: Cidr[];
  private readonly deps: ProxyDeps;
  readonly server: http.Server;

  constructor(private readonly o: ProxyOptions) {
    this.deps = o.deps ?? realDeps;
    this.extra = o.blockedSubnets.map((s) => {
      const c = parseCidr(s);
      if (!c) throw new Error("bad subnet");
      return c;
    });
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on("connect", (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => void this.onConnect(req, sock, head));
    this.server.on("clientError", (_e, sock) => sock.destroy());
  }

  grant(cred: string, g: Grant): void {
    if (!CRED_RE.test(cred)) throw new Error("bad credential");
    this.grants.set(cred, { ...g, allow: [...g.allow] });
  }

  revoke(cred: string): void {
    this.grants.delete(cred);
  }

  /** Resolves `host` and returns one address, refusing if any answer is in a blocked range (SR-8). */
  async checkedAddress(host: string): Promise<string> {
    const h = normalHost(host);
    if (!h) throw new Refused(403, "not a host name");
    let answers: Resolved[];
    try {
      answers = await this.deps.lookup(h);
    } catch {
      throw new Refused(502, "the name didn't resolve");
    }
    if (answers.length === 0) throw new Refused(502, "the name didn't resolve");
    if (answers.some((a) => blockedAddress(a.address, this.extra))) throw new Refused(403, "the name resolves to a refused address");
    return answers[0]!.address;
  }

  private grantFrom(header: string | undefined): [string, Grant] | null {
    const m = /^Basic ([A-Za-z0-9+/=]{1,400})$/.exec(header ?? "");
    if (!m) return null;
    const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
    const cred = decoded.slice(decoded.indexOf(":") + 1);
    const g = this.grants.get(cred);
    return g ? [cred, g] : null;
  }

  private async onConnect(req: http.IncomingMessage, sock: net.Socket, head: Buffer): Promise<void> {
    sock.on("error", () => sock.destroy());
    const deny = (status: number, reason: string, g?: Grant, host?: string) => {
      this.o.log({ t: "log", kind: "refused", session: g?.session, role: g?.role, host, reason });
      sock.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Forbidden"}\r\nConnection: close\r\n\r\n`);
    };
    const found = this.grantFrom(req.headers["proxy-authorization"]);
    if (!found) return deny(407, "no or unknown proxy credential");
    const g = found[1];
    const m = /^([^:\s]+|\[[0-9a-fA-F:.]+\]):(\d{1,5})$/.exec(req.url ?? "");
    if (!m) return deny(403, "bad target", g);
    const host = m[1]!;
    if (m[2] !== "443") return deny(403, "only port 443", g, host);
    if (!hostAllowed(g.allow, host)) return deny(403, "host not on the role's allow list", g, host);
    let address: string;
    try {
      address = await this.checkedAddress(host);
    } catch (e) {
      return deny(e instanceof Refused ? e.status : 502, (e as Error).message, g, host);
    }
    if (this.grants.get(found[0]) !== g) return deny(407, "credential revoked", g, host);
    const up = this.deps.connect(address, 443);
    up.on("error", () => {
      sock.destroy();
      up.destroy();
    });
    up.once("connect", () => {
      this.o.log({ t: "log", kind: "connect", session: g.session, role: g.role, host: normalHost(host)!, port: 443 });
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      sock.pipe(up);
      up.pipe(sock);
    });
    sock.on("close", () => up.destroy());
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const refuse = (status: number, reason: string, g?: Grant) => {
      this.o.log({ t: "log", kind: "refused", session: g?.session, role: g?.role, host: API_HOST, reason });
      if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain", connection: "close" });
      res.end(`${reason}\n`);
      req.resume();
    };
    if (!url.startsWith(GATEWAY_PREFIX)) return refuse(405, "only CONNECT and the model gateway");
    const rest = url.slice(GATEWAY_PREFIX.length);
    const slash = rest.indexOf("/");
    const cred = slash > 0 ? rest.slice(0, slash) : "";
    const g = this.grants.get(cred);
    if (!g) return refuse(407, "no or unknown proxy credential");
    const target = rest.slice(slash);
    const q = target.indexOf("?");
    const p = q >= 0 ? target.slice(0, q) : target;
    const query = q >= 0 ? target.slice(q) : "";
    if (req.method !== "POST" || !API_PATHS.includes(p) || !/^(\?beta=true)?$/.test(query)) return refuse(403, "not a model API path", g);
    // SR-9: a request carrying a credential of its own could bill or leak to another account.
    const key = req.headers["x-api-key"];
    const auth = req.headers.authorization;
    if ((key !== undefined && key !== this.o.dummyKey) || (auth !== undefined && auth !== `Bearer ${this.o.dummyKey}`)) {
      return refuse(403, "the request carries its own credential", g);
    }
    const len = Number(req.headers["content-length"] ?? "0");
    if (!Number.isFinite(len) || len > MAX_API_BODY) return refuse(413, "request too large", g);
    let address: string;
    try {
      address = await this.checkedAddress(API_HOST);
    } catch (e) {
      return refuse(502, (e as Error).message, g);
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k) || k === "x-api-key" || k === "authorization" || k.startsWith("x-forwarded")) continue;
      headers[k] = v;
    }
    headers.host = API_HOST;
    if (this.o.credential.kind === "api_key") headers["x-api-key"] = this.o.credential.value;
    else {
      headers.authorization = `Bearer ${this.o.credential.value}`;
      const beta = String(headers["anthropic-beta"] ?? "");
      if (!beta.split(",").map((s) => s.trim()).includes("oauth-2025-04-20")) headers["anthropic-beta"] = beta ? `${beta},oauth-2025-04-20` : "oauth-2025-04-20";
    }
    let seen = 0;
    const up = this.deps.request(address, API_HOST, { method: "POST", path: target, headers });
    up.on("response", (ur) => {
      this.o.log({ t: "log", kind: "gateway", session: g.session, role: g.role, host: API_HOST, path: p, status: ur.statusCode });
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
      res.writeHead(ur.statusCode ?? 502, out);
      ur.pipe(res);
    });
    up.on("error", () => refuse(502, "the model API is unreachable", g));
    up.on("timeout", () => up.destroy(new Error("timeout")));
    req.on("data", (d: Buffer) => {
      seen += d.length;
      if (seen > MAX_API_BODY) {
        up.destroy();
        refuse(413, "request too large", g);
      }
    });
    req.pipe(up);
  }

  /**
   * fetch_page's network half (SR-21): an https GET for the web reader's
   * session under its role's rules and SR-8, following at most five
   * redirects, each checked again, and stopping at the size cap.
   */
  async fetchPage(cred: string, url: string): Promise<FetchResult> {
    const g = this.grants.get(cred);
    if (!g) throw new Refused(407, "no or unknown proxy credential");
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let u: URL;
      try {
        u = new URL(current);
      } catch {
        throw new Refused(400, "not a URL");
      }
      if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443") || u.username || u.password) throw new Refused(403, "only https on port 443, without credentials");
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (!hostAllowed(g.allow, host)) {
        this.o.log({ t: "log", kind: "refused", session: g.session, role: g.role, host, reason: "host refused" });
        throw new Refused(403, "host refused");
      }
      const address = await this.checkedAddress(host);
      const r = await this.get(address, normalHost(host)!, `${u.pathname}${u.search}`);
      this.o.log({ t: "log", kind: "fetch", session: g.session, role: g.role, host: normalHost(host)!, path: u.pathname.slice(0, 200), status: r.status });
      if (r.status >= 300 && r.status < 400 && r.location) {
        current = new URL(r.location, u).toString();
        continue;
      }
      return { url: u.toString(), status: r.status, contentType: r.contentType, body: r.body, truncated: r.truncated };
    }
    throw new Refused(508, "too many redirects");
  }

  private get(address: string, host: string, path: string): Promise<{ status: number; location?: string; contentType: string; body: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const req = this.deps.request(address, host, {
        method: "GET",
        path: path || "/",
        headers: { host, accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "accept-encoding": "identity", "user-agent": "software-factory-web-reader" },
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => reject(new Refused(502, "the page couldn't be fetched")));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
            truncated,
          });
        res.on("data", (d: Buffer) => {
          if (truncated) return;
          const room = this.o.maxPageBytes - size;
          if (d.length > room) {
            chunks.push(d.subarray(0, room));
            size += room;
            truncated = true;
            res.destroy();
            done();
            return;
          }
          chunks.push(d);
          size += d.length;
        });
        res.on("end", () => !truncated && done());
        res.on("error", () => !truncated && reject(new Refused(502, "the page couldn't be fetched")));
      });
      req.end();
    });
  }
}
