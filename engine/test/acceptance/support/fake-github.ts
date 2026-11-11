// A fake of the parts of GitHub the engine uses in milestone 1: the OAuth
// device flow, `GET /user`, `GET /repos/{owner}/{repo}`, and git smart HTTP
// (through `git http-backend`) so pushes can be observed. It records every
// request so tests can check what the engine sent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FakeClock } from "./clock";

export const VERIFICATION_URI = "https://github.com/login/device";

export interface DeviceRecord {
  clientId: string;
  scope: string | undefined;
  sentSecret: boolean;
  deviceCode: string;
  userCode: string;
  issuedAt: number;
  expiresIn: number;
  interval: number;
  state: "pending" | "approved" | "denied";
  userId?: number;
  polls: number[];
  slowDownNext: number;
}

export interface Push {
  repo: string;
  authorization: string | undefined;
  user?: string;
  password?: string;
}

type DeviceOverride = (d: Record<string, unknown>) => Record<string, unknown>;

export class FakeGitHub {
  private server!: Server;
  port = 0;
  readonly devices: DeviceRecord[] = [];
  readonly users = new Map<number, string>();
  /** Overrides `GET /user` for one id: return anything to test validation. */
  readonly userBody = new Map<number, unknown>();
  readonly tokens = new Map<string, number>();
  readonly repos = new Map<string, { ownerLogin: string; ownerId: number; private: boolean }>();
  readonly requests: Array<{ method: string; path: string; headers: Record<string, unknown>; body: string; at: number }> = [];
  readonly pushes: Push[] = [];
  factoryToken = "";
  /** Every access token ever issued, for the SR-1 sweep. */
  readonly issuedTokens: string[] = [];
  deviceOverride?: DeviceOverride;
  /** "down": every device-flow and user call fails with 503; "reset": sockets dropped. */
  outage: "none" | "down" | "reset" = "none";

  constructor(
    private clock: FakeClock,
    readonly gitRoot: string,
    private tls?: { key: string; cert: string },
  ) {}

  get webBaseUrl() {
    return `${this.tls ? "https" : "http"}://127.0.0.1:${this.port}`;
  }
  get apiBaseUrl() {
    return `${this.webBaseUrl}/api`;
  }
  gitUrl(owner: string, repo: string) {
    return `${this.webBaseUrl}/${owner}/${repo}.git`;
  }

  async start(): Promise<void> {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.handle(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    };
    this.server = this.tls ? createHttpsServer(this.tls, handler) : createServer(handler);
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  addUser(id: number, login: string) {
    this.users.set(id, login);
  }

  addRepo(owner: string, repo: string, ownerId: number, isPrivate = true) {
    this.repos.set(`${owner}/${repo}`.toLowerCase(), { ownerLogin: owner, ownerId, private: isPrivate });
  }

  device(userCode: string): DeviceRecord {
    const d = this.devices.find((x) => x.userCode === userCode);
    if (!d) throw new Error(`no device code issued with user_code ${userCode}`);
    return d;
  }

  /** The owner (or someone else) approves the code on their phone. */
  approve(userCode: string, userId: number) {
    const d = this.device(userCode);
    d.state = "approved";
    d.userId = userId;
  }

  deny(userCode: string) {
    this.device(userCode).state = "denied";
  }

  lastDevice(): DeviceRecord | undefined {
    return this.devices[this.devices.length - 1];
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const isGit = /\.git\//.test(path);
    const body = isGit ? Buffer.alloc(0) : await readBody(req);
    this.requests.push({
      method: req.method ?? "",
      path: path + url.search,
      headers: { ...req.headers },
      body: body.toString("utf8"),
      at: this.clock.now(),
    });
    if (isGit) return this.git(req, res, url);

    if (this.outage === "reset") {
      req.socket.destroy();
      return;
    }
    if (this.outage === "down") return json(res, 503, { message: "Service Unavailable" });

    const form = parseForm(req.headers["content-type"], body.toString("utf8"));

    if (req.method === "POST" && path === "/login/device/code") {
      const d: DeviceRecord = {
        clientId: String(form.client_id ?? ""),
        scope: form.scope === undefined ? undefined : String(form.scope),
        sentSecret: form.client_secret !== undefined,
        deviceCode: randomBytes(20).toString("hex"),
        userCode: userCode(),
        issuedAt: this.clock.now(),
        expiresIn: 900,
        interval: 5,
        state: "pending",
        polls: [],
        slowDownNext: 0,
      };
      let out: Record<string, unknown> = {
        device_code: d.deviceCode,
        user_code: d.userCode,
        verification_uri: VERIFICATION_URI,
        expires_in: d.expiresIn,
        interval: d.interval,
      };
      if (this.deviceOverride) {
        out = this.deviceOverride(out);
        if (typeof out.user_code === "string") d.userCode = out.user_code;
        if (typeof out.device_code === "string") d.deviceCode = out.device_code;
        if (typeof out.expires_in === "number") d.expiresIn = out.expires_in;
        if (typeof out.interval === "number") d.interval = out.interval;
      }
      this.devices.push(d);
      return json(res, 200, out);
    }

    if (req.method === "POST" && path === "/login/oauth/access_token") {
      const d = this.devices.find((x) => x.deviceCode === form.device_code);
      if (!d || form.grant_type !== "urn:ietf:params:oauth:grant-type:device_code" || form.client_id !== d.clientId) {
        return json(res, 200, { error: "incorrect_device_code" });
      }
      d.polls.push(this.clock.now());
      if (this.clock.now() > d.issuedAt + d.expiresIn * 1000) return json(res, 200, { error: "expired_token" });
      if (d.slowDownNext > 0) {
        d.slowDownNext--;
        d.interval += 5;
        return json(res, 200, { error: "slow_down", interval: d.interval });
      }
      if (d.state === "denied") return json(res, 200, { error: "access_denied" });
      if (d.state === "pending") return json(res, 200, { error: "authorization_pending" });
      const token = "gho_" + randomBytes(18).toString("hex");
      this.tokens.set(token, d.userId!);
      this.issuedTokens.push(token);
      return json(res, 200, { access_token: token, token_type: "bearer", scope: "" });
    }

    if (req.method === "GET" && path === "/api/user") {
      const tok = bearer(req.headers.authorization);
      const id = tok ? this.tokens.get(tok) : undefined;
      if (id === undefined) return json(res, 401, { message: "Bad credentials" });
      if (this.userBody.has(id)) return json(res, 200, this.userBody.get(id));
      return json(res, 200, { id, login: this.users.get(id) ?? `user${id}`, type: "User" });
    }

    const m = /^\/api\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (req.method === "GET" && m) {
      if (bearer(req.headers.authorization) !== this.factoryToken) return json(res, 401, { message: "Bad credentials" });
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!r) return json(res, 404, { message: "Not Found" });
      return json(res, 200, {
        name: m[2],
        full_name: `${r.ownerLogin}/${m[2]}`,
        private: r.private,
        visibility: r.private ? "private" : "public",
        owner: { login: r.ownerLogin, id: r.ownerId, type: "User" },
      });
    }

    return json(res, 404, { message: "Not Found" });
  }

  private async git(req: IncomingMessage, res: ServerResponse, url: URL) {
    const isPush =
      url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
    const auth = req.headers.authorization;
    let user: string | undefined;
    let password: string | undefined;
    if (auth?.startsWith("Basic ")) {
      const [u, ...p] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
      user = u;
      password = p.join(":");
    }
    const authed = this.factoryToken !== "" && (password === this.factoryToken || user === this.factoryToken);
    if (isPush && !authed) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' });
      res.end();
      return;
    }
    if (isPush && url.pathname.endsWith("/git-receive-pack")) {
      this.pushes.push({ repo: url.pathname.replace(/\/git-receive-pack$/, ""), authorization: auth, user, password });
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: this.gitRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(url.pathname),
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
      REMOTE_ADDR: "127.0.0.1",
    };
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
    if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);
    if (authed) env.REMOTE_USER = "factory";
    const cgi = spawn("git", ["http-backend"], { env });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      let sep = head.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (sep < 0) {
        sep = head.indexOf("\n\n");
        sepLen = 2;
      }
      if (sep < 0) return;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, sep).toString("utf8").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else res.setHeader(k, v);
      }
      res.statusCode = status;
      res.write(head.subarray(sep + sepLen));
    });
    await new Promise<void>((resolve) => cgi.on("close", () => resolve()));
    res.end();
  }
}

function userCode(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  const pick = () => a[randomBytes(1)[0] % a.length];
  let s = "";
  for (let i = 0; i < 8; i++) s += (i === 4 ? "-" : "") + pick();
  return s;
}

function bearer(h: string | undefined): string | undefined {
  if (!h) return undefined;
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(h);
  return m?.[1];
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function parseForm(ct: string | undefined, body: string): Record<string, unknown> {
  if (!body) return {};
  if (ct?.includes("application/json")) {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}
