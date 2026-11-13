/**
 * The client end of the Engine control channel (v1.1 framing: one JSON-RPC
 * 2.0 message per line, at most 1 MiB), with the client-side checks of
 * F-005 SR-1 and SR-7: the engine must be a socket or pipe the owner owns,
 * served by a process running as the owner, under the pid engine.json names.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { Handle, OsApi } from "../os/ffi";
import { ChannelFailure, DocumentRefusal, Refused } from "./errors";
import { DOC_REASONS, MAX_MESSAGE, PIPE_RE, RULE_RE, TIMESTAMP_RE } from "./limits";
import { clean, head, seconds } from "./text";

export interface Transport {
  write(data: Buffer): void;
  onData(cb: (b: Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

function checkSocketPath(p: string, euid: number): void {
  if (p.includes("\0") || p.startsWith("@")) {
    // Abstract sockets have no file, so no owner or mode to check.
    throw new Refused("unsafe_socket", "The engine address is an abstract socket, which has no owner to check.");
  }
  if (!path.isAbsolute(p) || p.length > 400) throw new Refused("unsafe_socket", "The engine address is not an absolute socket path.");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ChannelFailure("engine_unreachable", "The engine isn't running: its socket is gone.");
    throw new Refused("unsafe_socket", "The engine socket can't be checked.");
  }
  if (st.isSymbolicLink()) throw new Refused("unsafe_socket", "The engine address is a symbolic link.");
  if (!st.isSocket()) throw new Refused("unsafe_socket", "The engine address is not a socket.");
  if (st.uid !== euid) throw new Refused("unsafe_socket", "The engine socket is not owned by you.");
  let parent: fs.Stats;
  try {
    parent = fs.lstatSync(fs.realpathSync.native(path.dirname(p)));
  } catch {
    throw new Refused("unsafe_socket", "The engine socket can't be checked.");
  }
  if (parent.uid !== euid || parent.mode & 0o077) throw new Refused("unsafe_socket", "The engine socket is in a folder other users can reach.");
}

/** Node keeps the descriptor on an internal handle only; no descriptor means no peer check. */
function fdOf(sock: net.Socket): number {
  const fd = (sock as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  return typeof fd === "number" ? fd : -1;
}

async function connectUnix(address: string, pid: number, os: OsApi, timeoutMs: number): Promise<Transport> {
  const euid = process.geteuid!();
  checkSocketPath(address, euid);
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(address);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new ChannelFailure("engine_unreachable", "The engine isn't running or can't be reached."));
    }, Math.max(1, timeoutMs));
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", () => {
      clearTimeout(timer);
      s.destroy();
      reject(new ChannelFailure("engine_unreachable", "The engine isn't running or can't be reached."));
    });
  });
  // The path checks above can race a swap; the peer's uid can't.
  let cred: { uid: number; pid: number | null } | null = null;
  try {
    cred = os.unix().peerCred(fdOf(sock));
  } catch {
    cred = null;
  }
  if (!cred || cred.uid !== euid) {
    sock.destroy();
    throw new Refused("peer_not_owner", "The process behind the engine socket is not running as you.");
  }
  // A guard rail, not a boundary (SR-5): another of the owner's processes could
  // still serve the socket, but not under the engine's recorded pid.
  if (cred.pid !== null && cred.pid !== pid) {
    sock.destroy();
    throw new Refused("peer_not_engine", "The process behind the engine socket is not the engine named in engine.json.");
  }
  sock.on("error", () => sock.destroy());
  return {
    write: (d) => {
      if (!sock.destroyed) sock.write(d);
    },
    onData: (cb) => sock.on("data", cb),
    onClose: (cb) => sock.on("close", cb),
    close: () => sock.destroy(),
  };
}

const POLL_MS = 20;
const READ_CHUNK = 64 * 1024;

/**
 * Windows named pipe (SR-7): a local `\\.\pipe\` name only, opened at
 * identification level so a squatting server can't impersonate the owner,
 * and served by a process running as the owner under engine.json's pid.
 * Reads poll PeekNamedPipe, which never blocks, as the engine's own side does.
 */
function connectPipe(address: string, pid: number, os: OsApi): Transport {
  if (!PIPE_RE.test(address)) throw new Refused("unsafe_pipe", "The engine address is not a local \\\\.\\pipe\\ name.");
  const w = os.windows();
  let h: Handle;
  try {
    h = w.openPipeClient(address);
  } catch {
    throw new ChannelFailure("engine_unreachable", "The engine isn't running or can't be reached.");
  }
  let ok = false;
  let serverPid = -1;
  try {
    serverPid = w.pipeServerPid(h);
    ok = w.processUserSid(serverPid) === w.currentUserSid();
  } catch {
    ok = false;
  }
  if (!ok) {
    w.closeHandle(h);
    throw new Refused("peer_not_owner", "The process behind the engine pipe is not running as you.");
  }
  if (serverPid !== pid) {
    w.closeHandle(h);
    throw new Refused("peer_not_engine", "The process behind the engine pipe is not the engine named in engine.json.");
  }
  let alive = true;
  const dataCbs: Array<(b: Buffer) => void> = [];
  const closeCbs: Array<() => void> = [];
  const shut = () => {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    try {
      w.closeHandle(h);
    } catch {
      // already gone
    }
    for (const c of closeCbs) c();
  };
  const timer = setInterval(() => {
    try {
      const n = w.pipeAvailable(h);
      if (n > 0) {
        const data = w.readPipe(h, Math.min(n, READ_CHUNK));
        for (const cb of dataCbs) cb(data);
      }
    } catch {
      shut();
    }
  }, POLL_MS);
  return {
    write: (d) => {
      if (!alive) return;
      try {
        w.writePipe(h, d);
      } catch {
        shut();
      }
    },
    onData: (cb) => dataCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: shut,
  };
}

export async function connect(address: string, pid: number, os: OsApi, timeoutMs: number): Promise<Transport> {
  if (os.platform === "win32") return connectPipe(address, pid, os);
  if (address.startsWith("\\\\")) throw new Refused("unsafe_socket", "The engine address is a Windows pipe; this machine is not Windows.");
  return connectUnix(address, pid, os, timeoutMs);
}

type Msg = Record<string, unknown>;

/** JSON-RPC over one transport; one call at a time, notifications skipped. */
export class Channel {
  private buf = Buffer.alloc(0);
  private lines: Msg[] = [];
  private failure: ChannelFailure | null = null;
  private wake: (() => void) | null = null;
  private nextId = 1;

  constructor(private readonly t: Transport) {
    t.onData((chunk) => {
      if (this.failure) return;
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) {
          if (this.buf.length > MAX_MESSAGE) this.fail(new ChannelFailure("response_too_large", "The engine sent a message over 1 MiB."));
          break;
        }
        const raw = this.buf.subarray(0, nl);
        this.buf = this.buf.subarray(nl + 1);
        if (raw.length > MAX_MESSAGE) {
          this.fail(new ChannelFailure("response_too_large", "The engine sent a message over 1 MiB."));
          break;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        } catch {
          this.fail(new ChannelFailure("bad_response", "The engine sent a message that is not valid JSON."));
          break;
        }
        if (typeof msg !== "object" || msg === null || Array.isArray(msg) || (msg as Msg).jsonrpc !== "2.0") {
          this.fail(new ChannelFailure("bad_response", "The engine sent a message that is not JSON-RPC 2.0."));
          break;
        }
        this.lines.push(msg as Msg);
      }
      this.poke();
    });
    t.onClose(() => this.fail(new ChannelFailure("connection_lost", "The engine closed the connection.")));
  }

  private fail(e: ChannelFailure): void {
    if (!this.failure) this.failure = e;
    this.poke();
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  close(): void {
    this.t.close();
  }

  /**
   * One request and its result within `limitS` seconds. `data` on an error
   * is dropped unread (SR-16), except a well-formed `busy` start time and a
   * document refusal in the contract's shape.
   */
  async call(method: string, params: Msg | undefined, limitS: number): Promise<unknown> {
    const id = this.nextId++;
    const req: Msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) req.params = params;
    const line = Buffer.from(JSON.stringify(req) + "\n", "utf8");
    if (line.length > MAX_MESSAGE) {
      // The framing limit applies both ways; nothing is sent.
      throw new Refused("request_too_large", "The request would make a channel message over 1 MiB.");
    }
    this.t.write(line);
    const deadline = Date.now() + limitS * 1000;
    let msg: Msg | undefined;
    for (;;) {
      msg = this.lines.find((m) => m.id === id && !("method" in m));
      // Notifications and stray answers are skipped: a per-call client waits with wait_s, not itemReady.
      this.lines.length = 0;
      if (msg) break;
      if (this.failure) {
        this.failure.sent = true;
        throw this.failure;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new ChannelFailure("timeout", `The engine didn't answer ${method} within ${seconds(limitS)}.`, { sent: true });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    if ("error" in msg) {
      const err = (typeof msg.error === "object" && msg.error !== null ? msg.error : {}) as Msg;
      const code = typeof err.code === "number" && Number.isInteger(err.code) ? err.code : "error";
      const message = typeof err.message === "string" ? head(clean(err.message, true), 500) : "The engine reported an error.";
      let startedAt: string | undefined;
      const data = err.data as Msg | undefined;
      if (code === -32001 && typeof data === "object" && data !== null && typeof data.started_at === "string" && TIMESTAMP_RE.test(data.started_at)) {
        // The owner needs to know when the other session started (FR-11); a strict timestamp carries nothing else.
        startedAt = data.started_at;
      }
      const refusal = code === -32009 ? parseRefusal(data) : undefined;
      throw new ChannelFailure(code, message, { sent: true, answered: true, ...(startedAt ? { startedAt } : {}), ...(refusal ? { refusal } : {}) });
    }
    if (!("result" in msg)) throw new ChannelFailure("bad_response", "The engine's answer has no result.", { sent: true });
    return msg.result;
  }
}

/**
 * -32009's data, only in the contract's shape (H-0105): a known reason, line
 * numbers and a rule id. Anything else is dropped, so no document text can
 * come back through it.
 */
function parseRefusal(data: unknown): DocumentRefusal | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const d = data as Msg;
  if (typeof d.reason !== "string" || !(d.reason in DOC_REASONS)) return undefined;
  const out: DocumentRefusal = { reason: d.reason };
  if (Array.isArray(d.lines) && d.lines.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0)) out.lines = (d.lines as number[]).slice(0, 50);
  if (typeof d.rule === "string" && RULE_RE.test(d.rule)) out.rule = d.rule;
  return out;
}
