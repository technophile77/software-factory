// A plain JSON-RPC 2.0 client over the engine's Unix socket, written from the
// channel contract's framing rule: one message per line, UTF-8, `\n`, at most
// 1 MiB.

import { createConnection, type Socket } from "node:net";

export const MAX_FRAME = 1024 * 1024;

export interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export class RpcClient {
  private buf = Buffer.alloc(0);
  private pending = new Map<number | string, (r: RpcResponse) => void>();
  private nextId = 1;
  readonly lines: string[] = [];
  readonly notifications: Array<{ method: string; params: any }> = [];
  readonly unmatched: RpcResponse[] = [];
  closed = false;
  private closeWaiters: Array<() => void> = [];
  private lineWaiters: Array<() => void> = [];

  private constructor(private sock: Socket) {
    sock.on("data", (d) => this.onData(d));
    const onClose = () => {
      this.closed = true;
      for (const w of this.closeWaiters.splice(0)) w();
      for (const w of this.lineWaiters.splice(0)) w();
      for (const [, r] of this.pending) r({ error: { code: 0, message: "connection closed" } });
      this.pending.clear();
    };
    sock.on("close", onClose);
    sock.on("error", () => undefined);
  }

  static connect(path: string, timeoutMs = 5000): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const s = createConnection(path);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`connect timeout: ${path}`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(new RpcClient(s));
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) break;
      const raw = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      const line = raw.toString("utf8");
      this.lines.push(line);
      for (const w of this.lineWaiters.splice(0)) w();
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg.method === "string" && msg.id === undefined) {
        this.notifications.push({ method: msg.method, params: msg.params });
        continue;
      }
      const r = this.pending.get(msg.id);
      if (r) {
        this.pending.delete(msg.id);
        r(msg);
      } else {
        this.unmatched.push(msg);
      }
    }
  }

  call(method: string, params?: unknown, timeoutMs = 30_000): Promise<RpcResponse> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    return this.request(id, JSON.stringify(msg) + "\n", timeoutMs);
  }

  /** Sends a prepared line (or any bytes) and waits for the response with `id`. */
  request(id: number | string, raw: string | Buffer, timeoutMs = 30_000): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to id ${id} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.sock.write(raw);
    });
  }

  write(raw: string | Buffer): void {
    this.sock.write(raw);
  }

  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Waits for any new line or for close. */
  waitLine(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.lineWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close() {
    this.sock.end();
    this.sock.destroy();
  }
}

/** One call on a fresh connection, as a per-call client (the skill) does. */
export async function rpcOnce(path: string, method: string, params?: unknown, timeoutMs?: number): Promise<RpcResponse> {
  const c = await RpcClient.connect(path);
  try {
    return await c.call(method, params, timeoutMs);
  } finally {
    c.close();
  }
}

/** Channel v1.3 error codes. */
export const ERR = {
  busy: -32001,
  stale: -32002,
  unknown: -32003,
  session: -32004,
  kindNotAllowed: -32005,
  approvalPending: -32006,
  approvalFailed: -32007,
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;
