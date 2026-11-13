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
  /** Only the web reader, and only with WebSearch in its tools (owner decision 2026-11-12). */
  webSearch?: boolean;
  /**
   * The name of a configured endpoint (F-013). Absent means Anthropic. The
   * grant, not the agent, picks it: the gateway rewrites `model` to this name.
   */
  upstream?: string;
  /**
   * `router` marks the LiteLLM container's own grant (its HTTP(S)_PROXY
   * credential): it may reach the pinned endpoints and nothing else, and has
   * no gateway. Absent or `agent` is an agent session's grant.
   */
  kind?: "agent" | "router";
}

/**
 * A model endpoint as the engine resolved and pinned it before the session
 * (F-013 FR-4). `address` is the one the engine checked; the proxy connects
 * to it and never looks the name up again.
 */
export interface PinnedEndpoint {
  name: string;
  class: "private" | "public";
  scheme: "http" | "https";
  host: string;
  address: string;
  port: number;
  basePath: string;
}

/** The LiteLLM container on the internal network, and the per-run key that opens it. */
export interface RouterTarget {
  address: string;
  port: number;
  masterKey: string;
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
  /** A plain-HTTP request to `address`:`port`: the router, or a private endpoint. */
  httpRequest(address: string, port: number, opts: { method: string; path: string; headers: http.OutgoingHttpHeaders }): http.ClientRequest;
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
  // A local model can take minutes to the first token, so the idle limit is longer than for the API.
  httpRequest: (address, port, o) => http.request({ host: address, port, method: o.method, path: o.path, headers: o.headers, agent: false, timeout: 300_000 }),
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
  /** Where endpoint grants are forwarded. Without it, an endpoint grant's requests are refused. */
  router?: RouterTarget;
  /** Cap on request and response bodies through the gateway; defaults to 32 MiB. Tests lower it. */
  maxApiBody?: number;
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

/**
 * The `anthropic-beta` values the gateway passes on (Security Gate 2, M1;
 * owner decision of 2026-11-11, card 23:12Z: allow-list the header). A beta
 * can switch on a feature that runs on Anthropic's side, outside the
 * container's egress rules. These are what Claude Code 2.1.311 sends for a
 * session with the factory's flags (captured from the real binary by
 * test/claude-real.test.ts, which fails when the CLI sends one not listed),
 * plus the OAuth beta that subscription mode needs. Any other value is
 * dropped from the header and logged; the request still goes.
 */
export const ALLOWED_BETAS: ReadonlySet<string> = new Set([
  "claude-code-20250219",
  "context-management-2025-06-27",
  "effort-2025-11-24",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-tool-changes-2026-07-01",
  "oauth-2025-04-20",
  "per-turn-control-2026-07-01",
  "thinking-display-updates-2026-08-18",
  "thinking-token-count-2026-05-13",
]);

/**
 * Why a Messages API body must not go out, or null (Security Gate 2, M1;
 * owner decision: block them). A tool with a `type` other than `custom` is a
 * server-side tool (web_search_*, web_fetch_*, code_execution_*, computer_*,
 * the bash_* and text_editor_* variants, and any added later): Anthropic runs
 * it, so it reaches the web or runs code past SR-8 and SR-21. `mcp_servers`
 * makes Anthropic call an MCP server for the session. Fails closed: a body
 * that isn't a JSON object, or a tools list that isn't a list of objects, is
 * refused too.
 */
export function refusedBody(body: Buffer, opts: { webSearch?: boolean } = {}): string | null {
  let j: unknown;
  try {
    j = JSON.parse(body.toString("utf8"));
  } catch {
    return "the request body isn't JSON";
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return "the request body isn't a JSON object";
  const o = j as Record<string, unknown>;
  if ("mcp_servers" in o) return "the request asks for MCP servers on the API side";
  if (o.tools === undefined) return null;
  if (!Array.isArray(o.tools)) return "the request's tools aren't a list";
  for (const t of o.tools as unknown[]) {
    if (typeof t !== "object" || t === null || Array.isArray(t)) return "the request's tools aren't a list";
    const type = (t as Record<string, unknown>).type;
    if (type === undefined || type === "custom") continue;
    // The one exception (owner decision 2026-11-12): Anthropic's web search,
    // for the web reader's credential only, so research can find sources.
    if (opts.webSearch && typeof type === "string" && WEB_SEARCH_TYPE.test(type)) continue;
    return `the request has a server-side tool (${safeToken(type)})`;
  }
  return null;
}

const WEB_SEARCH_TYPE = /^web_search_\d{8}$/;

/** A value from the request, cut down so a log line can't carry content. */
function safeToken(v: unknown): string {
  return String(v).replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 64);
}

/**
 * The top-level Messages API fields the gateway passes to the router (SR-17).
 * An allow list, not a deny list: LiteLLM reads routing and credential
 * parameters (`api_base`, `api_key`, `user_config`, `vertex_*`, `aws_*`,
 * `litellm_*` and more, with new ones added each release) from the request
 * body, so any key not known to be Anthropic's is dropped.
 */
export const ENDPOINT_BODY_FIELDS: ReadonlySet<string> = new Set([
  "model", "messages", "system", "tools", "tool_choice", "max_tokens", "temperature", "top_p", "top_k",
  "stop_sequences", "stream", "thinking", "metadata", "context_management", "output_config",
]);

/**
 * Rewrites a Messages body for an endpoint session (SR-17, FR-5): keeps only
 * {@link ENDPOINT_BODY_FIELDS}, keeps only `user_id` inside `metadata`, and
 * sets `model` to the granted endpoint's name so the agent can't pick another.
 * Also folds every `messages[]` entry with role `system` into the top-level
 * `system` field (FR-16, {@link foldSystemMessages}); this is done only here,
 * so requests to api.anthropic.com are never changed.
 * Returns the new body and the names of what was dropped (names only, never
 * values). The body must already have passed {@link refusedBody}.
 *
 * @example
 * sanitizeEndpointBody(Buffer.from('{"model":"x","api_base":"http://evil","messages":[]}'), "local-qwen");
 * // { body: '{"model":"local-qwen","messages":[]}', dropped: ["api_base"] }
 *
 * @example
 * sanitizeEndpointBody(Buffer.from('{"messages":[{"role":"user","content":"a"},{"role":"system","content":"env"}]}'), "ep");
 * // { body: '{"messages":[{"role":"user","content":"a"}],"system":[{"type":"text","text":"env"}],"model":"ep"}', dropped: [] }
 */
export function sanitizeEndpointBody(body: Buffer, endpoint: string): { body: Buffer; dropped: string[] } {
  const o = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (!ENDPOINT_BODY_FIELDS.has(k)) dropped.push(k);
    else if (k === "metadata") {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const meta = v as Record<string, unknown>;
        const kept: Record<string, unknown> = {};
        if ("user_id" in meta) kept.user_id = meta.user_id;
        for (const mk of Object.keys(meta)) if (mk !== "user_id") dropped.push(`metadata.${mk}`);
        out.metadata = kept;
      } else dropped.push(k);
    } else out[k] = v;
  }
  foldSystemMessages(out, dropped);
  out.model = endpoint;
  return { body: Buffer.from(JSON.stringify(out)), dropped };
}

type TextBlock = { type: "text"; text: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The text of a block list or string, in order, plus how many blocks weren't text. */
function textBlocksOf(content: unknown): { texts: TextBlock[]; nonText: number } {
  if (typeof content === "string") return { texts: content === "" ? [] : [{ type: "text", text: content }], nonText: 0 };
  const texts: TextBlock[] = [];
  let nonText = 0;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (isRecord(b) && b.type === "text" && typeof b.text === "string") {
        if (b.text !== "") texts.push({ type: "text", text: b.text });
      } else nonText++;
    }
  }
  return { texts, nonText };
}

/**
 * Moves the text of every `system`-role entry of `out.messages` into
 * `out.system` and removes those entries (FR-16). Claude Code adds a system
 * message mid-conversation, and the local servers' chat templates reject one
 * anywhere but first, so the gateway folds it into the top-level field they
 * accept (spike A-1: the task passes and the server's prefix cache holds).
 * Non-text blocks are dropped and counted in `dropped`, never their content.
 * Blocks are rebuilt as bare text blocks, so a `cache_control` marker is not
 * carried over: markers on moved text could push the request past the
 * provider's marker limit, and the server's prefix cache works without them.
 * Changes nothing when there is no system message.
 */
function foldSystemMessages(out: Record<string, unknown>, dropped: string[]): void {
  const messages = out.messages;
  if (!Array.isArray(messages)) return;
  const isSystem = (m: unknown): boolean => isRecord(m) && m.role === "system";
  if (!messages.some(isSystem)) return;
  const moved: TextBlock[] = [];
  let nonText = 0;
  for (const m of messages) {
    if (!isSystem(m)) continue;
    const t = textBlocksOf((m as Record<string, unknown>).content);
    moved.push(...t.texts);
    nonText += t.nonText;
  }
  if (nonText > 0) dropped.push(`messages.system.non_text.x${nonText}`);
  const existing = out.system;
  const base: unknown[] = typeof existing === "string" ? textBlocksOf(existing).texts : Array.isArray(existing) ? existing : [];
  out.system = [...base, ...moved];
  out.messages = messages.filter((m) => !isSystem(m));
}

/** A host as compared against a pinned endpoint's: lower case, no brackets, no trailing dot. */
function sameHost(a: string): string {
  return a.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export class EgressProxy {
  private readonly grants = new Map<string, Grant>();
  private endpoints = new Map<string, PinnedEndpoint>();
  private readonly maxBody: number;
  private readonly extra: Cidr[];
  private readonly deps: ProxyDeps;
  readonly server: http.Server;

  constructor(private readonly o: ProxyOptions) {
    this.deps = o.deps ?? realDeps;
    this.maxBody = o.maxApiBody ?? MAX_API_BODY;
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
    if (g.kind === "router" && g.upstream !== undefined) throw new Error("a router grant has no upstream");
    this.grants.set(cred, { ...g, allow: [...g.allow] });
  }

  /**
   * Replaces the pinned endpoints (F-013 FR-4). Fails closed on a pin that
   * contradicts its class, since the engine's check is the only DNS check:
   * a public endpoint must pin a public address (SR-8), a private one a
   * non-public address.
   * @throws Error when an entry is malformed or its address doesn't fit its class.
   */
  setEndpoints(list: PinnedEndpoint[]): void {
    const next = new Map<string, PinnedEndpoint>();
    for (const e of list) {
      const okShape = typeof e.name === "string" && e.name !== "" && typeof e.host === "string" && e.host !== "" && (e.class === "private" || e.class === "public") &&
        (e.scheme === "http" || e.scheme === "https") && Number.isInteger(e.port) && e.port > 0 && e.port < 65536 && net.isIP(e.address) !== 0 && typeof e.basePath === "string";
      if (!okShape) throw new Error("bad endpoint");
      const blocked = blockedAddress(e.address, this.extra);
      if ((e.class === "public") === blocked) throw new Error("endpoint address doesn't fit its class");
      next.set(e.name, { ...e });
    }
    this.endpoints = next;
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
    if (g.kind === "router") {
      // The router reaches a public endpoint's pinned address only: no DNS, so a
      // changed answer can't move it, and nothing else is reachable (FR-5).
      const port = Number(m[2]);
      const ep = [...this.endpoints.values()].find((e) => e.class === "public" && e.scheme === "https" && sameHost(e.host) === sameHost(host) && e.port === port);
      if (!ep) return deny(403, "not a pinned public endpoint", g, host);
      return this.tunnel(sock, head, found[0], g, ep.address, ep.port, ep.host, deny);
    }
    if (m[2] !== "443") return deny(403, "only port 443", g, host);
    if (!hostAllowed(g.allow, host)) return deny(403, "host not on the role's allow list", g, host);
    let address: string;
    try {
      address = await this.checkedAddress(host);
    } catch (e) {
      return deny(e instanceof Refused ? e.status : 502, (e as Error).message, g, host);
    }
    this.tunnel(sock, head, found[0], g, address, 443, normalHost(host)!, deny);
  }

  private tunnel(sock: net.Socket, head: Buffer, cred: string, g: Grant, address: string, port: number, logHost: string, deny: (status: number, reason: string, g?: Grant, host?: string) => void): void {
    if (this.grants.get(cred) !== g) return deny(407, "credential revoked", g, logHost);
    const up = this.deps.connect(address, port);
    up.on("error", () => {
      sock.destroy();
      up.destroy();
    });
    up.once("connect", () => {
      this.o.log({ t: "log", kind: "connect", session: g.session, role: g.role, host: logHost, port });
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      sock.pipe(up);
      up.pipe(sock);
    });
    sock.on("close", () => up.destroy());
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const refuse = (status: number, reason: string, g?: Grant, host = API_HOST) => this.refuseRequest(req, res, status, reason, g, host);
    if (/^http:\/\//i.test(url)) return this.onForward(req, res);
    if (!url.startsWith(GATEWAY_PREFIX)) return refuse(405, "only CONNECT and the model gateway");
    const rest = url.slice(GATEWAY_PREFIX.length);
    const slash = rest.indexOf("/");
    const cred = slash > 0 ? rest.slice(0, slash) : "";
    const g = this.grants.get(cred);
    if (!g) return refuse(407, "no or unknown proxy credential");
    if (g.kind === "router") return refuse(403, "a router grant has no model gateway", g);
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
    if (!Number.isFinite(len) || len > this.maxBody) return refuse(413, "request too large", g);
    // The body is read whole and checked (M1), so it must be plain JSON.
    const encoding = req.headers["content-encoding"];
    if (encoding !== undefined && encoding.toLowerCase() !== "identity") return refuse(415, "a compressed request body can't be checked", g);
    const body = await this.readBody(req);
    if (body === null) return refuse(413, "request too large", g);
    const bad = refusedBody(body, { webSearch: g.webSearch === true });
    if (bad) return refuse(403, bad, g);
    if (g.upstream !== undefined) return this.toRouter(req, res, g, p, target, body);
    let address: string;
    try {
      address = await this.checkedAddress(API_HOST);
    } catch (e) {
      return refuse(502, (e as Error).message, g);
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k) || k === "x-api-key" || k === "authorization" || k === "anthropic-beta" || k === "content-length" || k.startsWith("x-forwarded")) continue;
      headers[k] = v;
    }
    headers.host = API_HOST;
    headers["content-length"] = String(body.length);
    const betas = this.allowedBetas(req, g, p, API_HOST);
    if (this.o.credential.kind === "api_key") headers["x-api-key"] = this.o.credential.value;
    else {
      headers.authorization = `Bearer ${this.o.credential.value}`;
      if (!betas.includes("oauth-2025-04-20")) betas.push("oauth-2025-04-20");
    }
    if (betas.length > 0) headers["anthropic-beta"] = betas.join(",");
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
    up.end(body);
  }

  private refuseRequest(req: http.IncomingMessage, res: http.ServerResponse, status: number, reason: string, g?: Grant, host = API_HOST): void {
    this.o.log({ t: "log", kind: "refused", session: g?.session, role: g?.role, host, reason });
    if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain", connection: "close" });
    res.end(`${reason}\n`);
    req.resume();
  }

  /** The request body, or null if it passes the size cap or the connection fails. */
  private readBody(req: http.IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let seen = 0;
    return new Promise((resolve) => {
      req.on("data", (d: Buffer) => {
        seen += d.length;
        if (seen > this.maxBody) {
          req.removeAllListeners("data");
          resolve(null);
        } else chunks.push(d);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }

  /** The request's `anthropic-beta` values that are on {@link ALLOWED_BETAS}; the others are logged by name and dropped. */
  private allowedBetas(req: http.IncomingMessage, g: Grant, path: string, host: string): string[] {
    const asked = [req.headers["anthropic-beta"] ?? []].flat().flatMap((h) => h.split(",")).map((s) => s.trim()).filter((s) => s !== "");
    const dropped = [...new Set(asked.filter((b) => !ALLOWED_BETAS.has(b)))];
    if (dropped.length > 0) {
      this.o.log({ t: "log", kind: "gateway", session: g.session, role: g.role, host, path, reason: `dropped anthropic-beta: ${dropped.slice(0, 10).map(safeToken).join(", ")}` });
    }
    return [...new Set(asked.filter((b) => ALLOWED_BETAS.has(b)))];
  }

  /**
   * Relays an untrusted reply (the router's or a private endpoint's) to the
   * client: a redirect is refused and never followed (SR-13), and the body
   * is cut at the size cap (SR-16) by closing the connection, so the client
   * sees a failed reply rather than a silently short one.
   */
  private relayCapped(req: http.IncomingMessage, res: http.ServerResponse, ur: http.IncomingMessage, g: Grant, host: string, path: string): void {
    const status = ur.statusCode ?? 502;
    this.o.log({ t: "log", kind: "gateway", session: g.session, role: g.role, host, path, status });
    if (status >= 300 && status < 400) {
      ur.destroy();
      return this.refuseRequest(req, res, 502, "the endpoint answered with a redirect", g, host);
    }
    if (Number(ur.headers["content-length"] ?? "0") > this.maxBody) {
      ur.destroy();
      return this.refuseRequest(req, res, 502, "the endpoint's reply is too large", g, host);
    }
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
    res.writeHead(status, out);
    let size = 0;
    ur.on("data", (d: Buffer) => {
      size += d.length;
      if (size > this.maxBody) {
        ur.destroy();
        res.destroy();
        return;
      }
      if (!res.write(d)) {
        ur.pause();
        res.once("drain", () => ur.resume());
      }
    });
    ur.on("end", () => res.end());
    ur.on("error", () => res.destroy());
  }

  /** An endpoint session's model request: filtered per SR-17, then sent to the router with the master key (FR-5). */
  private async toRouter(req: http.IncomingMessage, res: http.ServerResponse, g: Grant, p: string, target: string, body: Buffer): Promise<void> {
    const ep = this.endpoints.get(g.upstream!);
    const router = this.o.router;
    if (!ep) return this.refuseRequest(req, res, 502, "the granted endpoint isn't configured", g, g.upstream);
    if (!router) return this.refuseRequest(req, res, 502, "no model router", g, ep.host);
    const clean = sanitizeEndpointBody(body, ep.name);
    if (clean.dropped.length > 0) {
      this.o.log({ t: "log", kind: "gateway", session: g.session, role: g.role, host: ep.host, path: p, reason: `dropped fields: ${clean.dropped.slice(0, 20).map(safeToken).join(", ")}` });
    }
    // Built from nothing, not copied from the agent: its headers carry the
    // dummy key, and the Claude credential never goes near the router (AC-4).
    const headers: http.OutgoingHttpHeaders = {
      host: `${router.address}:${router.port}`,
      "content-type": "application/json",
      "content-length": String(clean.body.length),
      authorization: `Bearer ${router.masterKey}`,
    };
    for (const k of ["anthropic-version", "accept"]) {
      const v = req.headers[k];
      if (typeof v === "string") headers[k] = v;
    }
    const betas = this.allowedBetas(req, g, p, ep.host);
    if (betas.length > 0) headers["anthropic-beta"] = betas.join(",");
    const up = this.deps.httpRequest(router.address, router.port, { method: "POST", path: target, headers });
    up.on("response", (ur) => this.relayCapped(req, res, ur, g, ep.host, p));
    up.on("error", () => this.refuseRequest(req, res, 502, "the model router is unreachable", g, ep.host));
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.end(clean.body);
  }

  /**
   * The router's plain-HTTP forward proxy: GET or POST to a private endpoint
   * only, matched on host and port and sent to its pinned address with the
   * request's own Host header (FR-5). Private endpoints have no other way in.
   */
  private async onForward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const found = this.grantFrom(req.headers["proxy-authorization"]);
    if (!found) return this.refuseRequest(req, res, 407, "no or unknown proxy credential", undefined, "");
    const g = found[1];
    const refuse = (status: number, reason: string, host = "") => this.refuseRequest(req, res, status, reason, g, host);
    if (g.kind !== "router") return refuse(403, "plain HTTP forwarding is for the model router only");
    if (req.method !== "GET" && req.method !== "POST") return refuse(405, "only GET and POST");
    let u: URL;
    try {
      u = new URL(req.url ?? "");
    } catch {
      return refuse(400, "not a URL");
    }
    const host = sameHost(u.hostname);
    if (u.protocol !== "http:" || u.username || u.password) return refuse(403, "only plain http without credentials", host);
    const port = u.port === "" ? 80 : Number(u.port);
    const ep = [...this.endpoints.values()].find((e) => e.class === "private" && e.scheme === "http" && sameHost(e.host) === host && e.port === port);
    if (!ep) return refuse(403, "not a pinned private endpoint", host);
    const body = await this.readBody(req);
    if (body === null) return refuse(413, "request too large", host);
    if (this.grants.get(found[0]) !== g) return refuse(407, "credential revoked", host);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k) || k === "content-length" || k.startsWith("x-forwarded")) continue;
      headers[k] = v;
    }
    headers.host = req.headers.host ?? u.host;
    if (body.length > 0 || req.method === "POST") headers["content-length"] = String(body.length);
    const path = `${u.pathname}${u.search}`;
    const up = this.deps.httpRequest(ep.address, ep.port, { method: req.method, path, headers });
    up.on("response", (ur) => this.relayCapped(req, res, ur, g, ep.host, u.pathname.slice(0, 200)));
    up.on("error", () => this.refuseRequest(req, res, 502, "the endpoint is unreachable", g, ep.host));
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.end(body);
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
