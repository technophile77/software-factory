// A fake engine for the MCP mode's acceptance tests (F-005 AC-17), built by
// the test engineer from Engine control channel v1.1 to v1.4
// (docs/interface-contracts.md) alone: line framing, JSON-RPC 2.0, sessions by
// token with the per-feature lock and takeover, the v1.2 approval step,
// deferred-first per session, revisions, reply ids recorded once, the error
// codes, v1.3 advisor items and calls, v1.4 documents and source
// confirmations. It is a port of the Python suites' FakeEngine and
// AdvisorEngine.
//
// It listens on a Unix socket, mode 0600 in an owner-only folder, in the test
// process, so engine.json's `pid` is this process's pid. `hooks[method]` may
// take over a request: hook(conn, msg) returns true when it answered (or
// deliberately didn't answer) itself.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const MIB = 1024 * 1024;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type Json = any;
export type Msg = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Json };
export type Outcome = ["result", Json] | ["error", number, string, Json?];
export type Hook = (conn: FakeConn, msg: Msg) => boolean | Promise<boolean>;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Json) {
    super(message);
  }
}

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const sha256Hex = (t: string) => createHash("sha256").update(Buffer.from(t, "utf8")).digest("hex");
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function question(id: string, status = "open", extra: Record<string, Json> = {}): Json {
  return { id, revision: 0, kind: "question", text: `What should ${id} be?`, why: `${id} decides the scope.`, status, ...extra };
}
export function assumption(id: string, status = "open", extra: Record<string, Json> = {}): Json {
  return { id, revision: 0, kind: "assumption", text: `Assume ${id} holds.`, why: "Saves a question.", status, ...extra };
}
export function proposal(id: string, about: string, extra: Record<string, Json> = {}): Json {
  return { id, revision: 0, kind: "advisor_proposal", text: `Ask the advisor about ${about}?`,
    why: "The question cross-cuts budgets and sandboxing.", about, status: "open", ...extra };
}
export function sourceConfirmation(id = "S-1", sources?: Json[], status = "open"): Json {
  return { id, revision: 1, kind: "source_confirmation", text: "The spec takes these lines from your document.",
    why: "Confirm before the readiness check.", status,
    sources: sources ?? [{ spec_ref: "FR-1", section: "Behaviour", quote: "A button downloads a CSV file.",
      spec_line: "| FR-1 | A button downloads the CSV. |" }] };
}

// Advisor output in F-006 FR-8's shape, as the engine stored it.
export const VALID_ADVICE = "## Findings\n"
  + "- SQLite handles one writer at a time. Source: repo:docs/adr/0002.md\n"
  + "- Postgres needs a server. Source: web:https://www.postgresql.org/docs/ (untrusted)\n"
  + "## Options\n"
  + "1. SQLite: no server; one writer.\n"
  + "2. Postgres: many writers; a server to run.\n"
  + "## Recommendation\n"
  + "Option 1, because the factory has one writer. Confidence: medium\n"
  + "## Risks and unknowns\n"
  + "- Writer count may grow.";

const KINDS: Record<string, string[]> = {
  question: ["answer", "more_info", "defer", "ask_advisor"],
  assumption: ["approve_assumption", "reject_assumption"],
  advisor_proposal: ["approve_advisor", "decline_advisor"],
  source_confirmation: ["confirm_sources", "reopen_sources"],
};
const NEW_STATUS: Record<string, string> = {
  answer: "answered", defer: "deferred", more_info: "researching", approve_assumption: "approved",
  reject_assumption: "rejected", approve_advisor: "approved", decline_advisor: "rejected",
  confirm_sources: "approved", reopen_sources: "rejected",
};

export class FakeConn {
  closed = false;
  constructor(readonly engine: FakeEngine, readonly sock: net.Socket, readonly no: number) {}
  sendRaw(data: Buffer | string): void {
    if (!this.closed && !this.sock.destroyed) this.sock.write(data);
  }
  send(obj: Json): void {
    this.sendRaw(JSON.stringify(obj) + "\n");
  }
  respond(msg: Msg, outcome: Outcome): void {
    if (outcome[0] === "result") this.send({ jsonrpc: "2.0", id: msg.id, result: outcome[1] });
    else {
      const [, code, message, data] = outcome;
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code, message, ...(data !== undefined && data !== null ? { data } : {}) } });
    }
  }
  close(): void {
    this.closed = true;
    this.sock.destroy();
  }
}

interface Session { feature: string; started_at: string; shown: Set<string>; approved: boolean }

export class FakeEngine {
  readonly dir: string;
  readonly path: string;
  requests: Array<{ conn: number; msg: Msg }> = [];
  rawLines: Array<{ conn: number; line: Buffer }> = [];
  connections = 0;
  conns: FakeConn[] = [];
  hooks: Record<string, Hook> = {};
  researchS = 0.2;
  findings: Json[] = [{ text: "The README says the API is internal.", source: "repo:README.md" }];
  started = Date.now();
  sessions = new Map<string, Session>();
  locks = new Map<string, string>();
  features = new Map<string, { title: string; items: Json[] }>();
  replies = new Map<string, Json>();
  transcript: Json[] = [];
  nextFeature = 100;
  startedRequests: string[] = [];
  documents: Json[] = [];
  startError: [number, string, Json?] | null = null;
  noDocuments = false;
  /** v1.2: `open` returns a GitHub approval and the session takes replies only once awaitApproval says so. */
  approval: Json | null = { user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_at: "2026-11-13T10:15:00Z" };
  approvalResult: true | number = true;
  // v1.3 advisor
  advisorCalls: Array<{ call: string; question: string; via: string; reply_id: string }> = [];
  advisorS = 0.2;
  adviceText = VALID_ADVICE;
  adviceQueries: string[] | null = ["sqlite concurrent writers"];
  adviceFails = false;
  version = "1.4";
  /** Merged into each feature's `engine.status` entry (F-016 FR-14). */
  statusExtra: Json = {};
  capabilities: string[] = ["document"];
  private server: net.Server;

  private constructor() {
    // Unix socket paths are limited to about 104 bytes: a short folder.
    const base = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
    this.dir = fs.realpathSync(fs.mkdtempSync(path.join(base, "sfm")));
    fs.chmodSync(this.dir, 0o700);
    this.path = path.join(this.dir, "engine.sock");
    this.server = net.createServer((sock) => this.accept(sock));
  }

  static async start(state?: FakeEngine): Promise<FakeEngine> {
    const e = new FakeEngine();
    if (state) {
      // A restart keeps what the transcript on factory/state holds, and no sessions.
      e.features = new Map([...state.features].map(([k, v]) => [k, clone(v)]));
      e.replies = new Map([...state.replies].map(([k, v]) => [k, clone(v)]));
      e.transcript = clone(state.transcript);
      e.nextFeature = state.nextFeature;
      e.version = state.version;
      e.capabilities = state.capabilities;
      e.approval = state.approval;
    }
    await new Promise<void>((res, rej) => {
      e.server.once("error", rej);
      e.server.listen(e.path, () => res());
    });
    fs.chmodSync(e.path, 0o600);
    return e;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.close();
    await new Promise<void>((r) => this.server.close(() => r()));
    try {
      fs.unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }

  async cleanup(): Promise<void> {
    if (this.server.listening) await this.stop();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private accept(sock: net.Socket): void {
    const conn = new FakeConn(this, sock, ++this.connections);
    this.conns.push(conn);
    sock.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve();
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        chain = chain.then(() => (conn.closed ? undefined : this.line(conn, Buffer.from(line))));
      }
    });
  }

  private async line(conn: FakeConn, line: Buffer): Promise<void> {
    this.rawLines.push({ conn: conn.no, line });
    if (line.length > MIB) {
      conn.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message over 1 MiB" } });
      return;
    }
    let msg: Msg;
    try {
      msg = JSON.parse(line.toString("utf8"));
    } catch {
      conn.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    this.requests.push({ conn: conn.no, msg });
    const hook = msg.method !== undefined ? this.hooks[msg.method] : undefined;
    if (hook && (await hook(conn, msg))) return;
    conn.respond(msg, await this.handle(msg));
  }

  // -- inspection -------------------------------------------------------------
  methods(): string[] {
    return this.requests.map((r) => r.msg.method ?? "");
  }
  calls(method: string): Msg[] {
    return this.requests.filter((r) => r.msg.method === method).map((r) => r.msg);
  }
  addFeature(id: string, title: string, items: Json[]): void {
    this.features.set(id, { title, items: items.map((i) => clone(i)) });
  }
  item(fid: string, iid: string): Json {
    const it = this.features.get(fid)?.items.find((i) => i.id === iid);
    if (!it) throw new Error(`no item ${iid}`);
    return it;
  }
  /** The analyst revises a question: the old one is superseded, the new one keeps its deferred status (spec section 6). */
  revise(fid: string, iid: string, newId: string, text: string): void {
    const old = this.item(fid, iid);
    const neu = { ...clone(old), id: newId, text, revision: 0 };
    old.status = "superseded";
    old.revision += 1;
    const items = this.features.get(fid)!.items;
    items.splice(items.indexOf(old) + 1, 0, neu);
  }
  /** Opens a session as another client would, without a connection. */
  openSession(feature: string): string {
    const tok = randomBytes(16).toString("hex");
    this.sessions.set(tok, { feature, started_at: nowIso(), shown: new Set(), approved: true });
    this.locks.set(feature, tok);
    return tok;
  }

  // -- dispatch -----------------------------------------------------------------
  async handle(msg: Msg): Promise<Outcome> {
    const params = msg.params ?? {};
    const fn = (this as unknown as Record<string, unknown>)["m_" + String(msg.method).replace(/\./g, "_")];
    if (typeof fn !== "function") return ["error", -32601, "Method not found"];
    if (typeof params !== "object") return ["error", -32602, "Invalid params"];
    try {
      return ["result", await (fn as (p: Json) => Json).call(this, Array.isArray(params) ? {} : params)];
    } catch (e) {
      if (e instanceof RpcError) return ["error", e.code, e.message, e.data];
      return ["error", -32603, `Fake engine bug: ${(e as Error).message}`];
    }
  }

  private wire(item: Json): Json {
    if (item === null || item === undefined) return null;
    const out = Object.fromEntries(Object.entries(item).filter(([k]) => !k.startsWith("_")));
    if (Array.isArray(out.advice)) {
      out.advice = (out.advice as Json[]).map((a) => (a && typeof a === "object" && !Array.isArray(a)
        ? Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith("_"))) : a));
    }
    return clone(out);
  }

  private session(p: Json, needApproved = true): [string, Session] {
    const tok = p.session;
    const s = typeof tok === "string" ? this.sessions.get(tok) : undefined;
    if (!s) throw new RpcError(-32004, "Unknown or expired session");
    if (needApproved && !s.approved) throw new RpcError(-32006, "Waiting for the owner's approval");
    return [tok, s];
  }

  private settle(feature: string): void {
    for (const it of this.features.get(feature)!.items) {
      if (it.status === "researching" && Date.now() >= (it._ready_at ?? 0)) {
        it.status = "open";
        it.revision += 1;
        it.findings = clone(this.findings);
        delete it._ready_at;
      }
      const advice = it.advice;
      for (const a of Array.isArray(advice) ? advice : []) {
        // Only calls this engine started finish; a planted "running" entry stays running.
        if (a && typeof a === "object" && a.status === "running" && "_ready_at" in a && Date.now() >= a._ready_at) {
          delete a._ready_at;
          if (this.adviceFails) {
            a.status = "failed";
            a.reason = "output did not have the four sections";
          } else {
            a.status = "done";
            a.text = this.adviceText;
            a.sha256 = sha256Hex(this.adviceText);
            if (this.adviceQueries !== null) a.web_queries = [...this.adviceQueries];
          }
        }
      }
    }
  }

  private pick(s: Session): Json {
    this.settle(s.feature);
    const items = this.features.get(s.feature)!.items;
    for (const it of items) {
      if (it.status === "deferred" && !s.shown.has(it.id)) {
        s.shown.add(it.id);
        return it;
      }
    }
    return items.find((it) => it.status === "open") ?? null;
  }

  private startCall(feature: string, qid: string, via: string, rid: string): void {
    const q = this.item(feature, qid);
    const call = `A-${String(this.advisorCalls.length + 1).padStart(4, "0")}`;
    this.advisorCalls.push({ call, question: qid, via, reply_id: rid });
    (q.advice ??= []).push({ call, status: "running", revision: q.revision, _ready_at: Date.now() + this.advisorS * 1000 });
  }

  m_engine_status(): Json {
    return { version: this.version, capabilities: this.capabilities, uptime_s: Math.floor((Date.now() - this.started) / 1000),
      features: [...this.features.keys()].map((id) => ({ id, stage: "requirements_interview", active_agents: 1, ...this.statusExtra })) };
  }

  m_feature_start(p: Json): Json {
    if (this.startError) throw new RpcError(...this.startError);
    if ("document" in p && (this.noDocuments || !this.capabilities.includes("document"))) throw new RpcError(-32602, "Invalid params: unknown key document");
    if (typeof p.request !== "string") throw new RpcError(-32602, "Invalid params");
    this.startedRequests.push(p.request);
    this.documents.push(p.document ?? null);
    const fid = `F-${this.nextFeature++}`;
    this.features.set(fid, { title: p.request.slice(0, 40), items: [] });
    return { feature: fid };
  }

  m_interview_list(): Json {
    const out: Json[] = [];
    for (const [id, f] of this.features) {
      const qs = f.items.filter((i) => i.kind === "question");
      const asm = f.items.filter((i) => i.kind === "assumption");
      const row = { id, title: f.title,
        open: qs.filter((i) => i.status === "open" || i.status === "researching").length,
        deferred: qs.filter((i) => i.status === "deferred").length,
        pending_assumptions: asm.filter((i) => i.status === "open" || i.status === "deferred").length };
      if (row.open || row.deferred || row.pending_assumptions) out.push(row);
    }
    return { features: out };
  }

  m_interview_open(p: Json): Json {
    const fid = p.feature;
    if (!this.features.has(fid)) throw new RpcError(-32003, "Unknown feature");
    const held = this.locks.get(fid);
    if (held !== undefined && this.sessions.has(held)) {
      if (p.takeover !== true) {
        const started = this.sessions.get(held)!.started_at;
        throw new RpcError(-32001, `Another session holds ${fid} since ${started}`, { started_at: started });
      }
      this.sessions.delete(held);
    }
    const tok = randomBytes(16).toString("hex");
    this.sessions.set(tok, { feature: fid, started_at: nowIso(), shown: new Set(), approved: this.approval === null });
    this.locks.set(fid, tok);
    return { session: tok, started_at: this.sessions.get(tok)!.started_at, ...(this.approval ? { approval: clone(this.approval) } : {}) };
  }

  m_interview_awaitApproval(p: Json): Json {
    const [tok, s] = this.session(p, false);
    if (this.approvalResult === true) {
      s.approved = true;
      return { approved: true };
    }
    this.sessions.delete(tok);
    this.locks.delete(s.feature);
    throw new RpcError(this.approvalResult, "Approval did not complete");
  }

  async m_interview_next(p: Json): Promise<Json> {
    const waitS = p.wait_s ?? 0;
    if (typeof waitS !== "number" || !Number.isInteger(waitS) || waitS < 0 || waitS > 600) throw new RpcError(-32602, "Invalid params: wait_s");
    const deadline = Date.now() + waitS * 1000;
    for (;;) {
      const [, s] = this.session(p);
      const item = this.pick(s);
      const researching = this.features.get(s.feature)!.items.filter((i) => i.status === "researching");
      if (item !== null || researching.length === 0 || Date.now() >= deadline) {
        return { item: this.wire(item ?? researching[0] ?? null) };
      }
      await sleep(20);
    }
  }

  m_interview_reply(p: Json): Json {
    const [, s] = this.session(p);
    const rid = p.reply_id;
    if (typeof rid !== "string" || !ID_RE.test(rid)) throw new RpcError(-32602, "Invalid params: reply_id");
    if (this.replies.has(rid)) return clone(this.replies.get(rid));
    const it = this.features.get(s.feature)!.items.find((i) => i.id === p.item);
    if (!it) throw new RpcError(-32003, "Unknown item");
    if (p.revision !== it.revision || !["open", "deferred", "researching"].includes(it.status)) throw new RpcError(-32002, "Stale revision");
    const kind = p.kind;
    if (!(KINDS[it.kind] ?? []).includes(kind)) throw new RpcError(-32005, "Reply kind not allowed for this item");
    if (typeof p.text !== "string") throw new RpcError(-32602, "Invalid params: text");
    let status: string;
    if (kind === "ask_advisor") {
      // The question stays as it was while the advisor works (F-006 2.3).
      this.startCall(s.feature, it.id, kind, rid);
      status = it.status;
    } else {
      status = NEW_STATUS[kind]!;
      it.status = status;
      if (kind === "approve_advisor") this.startCall(s.feature, it.about, kind, rid);
      if (status === "researching") it._ready_at = Date.now() + this.researchS * 1000;
      if (status === "deferred") s.shown.add(it.id);
    }
    this.transcript.push({ feature: s.feature, item: it.id, kind, text: p.text, reply_id: rid, at: nowIso() });
    const result = { status, next: this.wire(this.pick(s)) };
    this.replies.set(rid, clone(result));
    return result;
  }

  m_interview_state(p: Json): Json {
    if (!this.features.has(p.feature)) throw new RpcError(-32003, "Unknown feature");
    const it = this.features.get(p.feature)!.items.find((i) => i.id === p.item);
    if (!it) throw new RpcError(-32003, "Unknown item");
    this.settle(p.feature);
    const out: Json = { status: it.status, revision: it.revision };
    const rec = this.transcript.filter((t) => t.item === it.id);
    if (rec.length) out.recorded_at = rec[rec.length - 1].at;
    return out;
  }

  m_interview_close(p: Json): Json {
    const [tok, s] = this.session(p, false);
    this.sessions.delete(tok);
    if (this.locks.get(s.feature) === tok) this.locks.delete(s.feature);
    return { ok: true };
  }
}

// Hook helpers --------------------------------------------------------------------

/** The engine handles the request, then the connection drops before the answer. */
export const recordThenDrop: Hook = async (conn, msg) => {
  await conn.engine.handle(msg);
  conn.close();
  return true;
};
export const dropBefore: Hook = (conn) => {
  conn.close();
  return true;
};
export const neverAnswer: Hook = () => true;
export const recordNeverAnswer: Hook = async (conn, msg) => {
  await conn.engine.handle(msg);
  return true;
};
export const errorHook = (code: number, message: string, data?: Json): Hook => (conn, msg) => {
  conn.respond(msg, ["error", code, message, data]);
  return true;
};
export const resultHook = (result: Json): Hook => (conn, msg) => {
  conn.respond(msg, ["result", result]);
  return true;
};
export const rawHook = (data: Buffer | string): Hook => (conn) => {
  conn.sendRaw(data);
  return true;
};
