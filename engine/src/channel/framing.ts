import { MAX_MESSAGE_BYTES, RPC } from "../constants";

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/** A connected peer that passed the access checks, whatever the transport. */
export interface Conn {
  write(data: Buffer): void;
  close(): void;
  onData(cb: (b: Buffer) => void): void;
  onClose(cb: () => void): void;
}

export type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function line(msg: unknown): Buffer {
  return Buffer.from(JSON.stringify(msg) + "\n", "utf8");
}

/**
 * Channel framing (v1.1): one JSON-RPC 2.0 message per line, UTF-8, at most
 * 1 MiB each way. A longer line ends the connection, since the rest of the
 * stream can no longer be trusted to be framed.
 */
export function serve(conn: Conn, handle: Handler, onError: (e: unknown) => void): void {
  let buf = Buffer.alloc(0);
  let closed = false;
  conn.onClose(() => {
    closed = true;
  });
  const send = (msg: unknown) => {
    if (closed) return;
    let out = line(msg);
    if (out.length > MAX_MESSAGE_BYTES) {
      const id = (msg as { id?: unknown }).id ?? null;
      out = line({ jsonrpc: "2.0", id, error: { code: RPC.internal, message: "The answer would be over 1 MiB." } });
    }
    conn.write(out);
  };
  conn.onData((chunk) => {
    if (closed) return;
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_MESSAGE_BYTES) {
          send({ jsonrpc: "2.0", id: null, error: { code: RPC.invalidRequest, message: "Message over 1 MiB." } });
          closed = true;
          conn.close();
        }
        return;
      }
      const raw = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (raw.length > MAX_MESSAGE_BYTES) {
        send({ jsonrpc: "2.0", id: null, error: { code: RPC.invalidRequest, message: "Message over 1 MiB." } });
        closed = true;
        conn.close();
        return;
      }
      void dispatch(raw);
    }
  });

  async function dispatch(raw: Buffer) {
    let msg: unknown;
    try {
      msg = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: RPC.parseError, message: "Not valid JSON." } });
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return send({ jsonrpc: "2.0", id: null, error: { code: RPC.invalidRequest, message: "Not a JSON-RPC request." } });
    }
    const m = msg as Record<string, unknown>;
    const hasId = "id" in m;
    const id = m.id;
    if (hasId && id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) {
      return send({ jsonrpc: "2.0", id: null, error: { code: RPC.invalidRequest, message: "Bad id." } });
    }
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      return send({ jsonrpc: "2.0", id: hasId ? id : null, error: { code: RPC.invalidRequest, message: "Not a JSON-RPC 2.0 request." } });
    }
    // Every method acts, so a notification (no id, no answer) is ignored rather than run unseen.
    if (!hasId) return;
    if (m.params !== undefined && (m.params === null || typeof m.params !== "object" || Array.isArray(m.params))) {
      return send({ jsonrpc: "2.0", id, error: { code: RPC.invalidParams, message: "params must be an object." } });
    }
    try {
      const result = await handle(m.method, (m.params ?? {}) as Record<string, unknown>);
      send({ jsonrpc: "2.0", id, result });
    } catch (e) {
      if (e instanceof RpcError) {
        const error: Record<string, unknown> = { code: e.code, message: e.message };
        if (e.data !== undefined) error.data = e.data;
        send({ jsonrpc: "2.0", id, error });
      } else {
        onError(e);
        send({ jsonrpc: "2.0", id, error: { code: RPC.internal, message: "Internal error." } });
      }
    }
  }
}

/** For notifications to long-lived clients (`interview.itemReady`). */
export function notification(method: string, params: Record<string, unknown>): Buffer {
  return line({ jsonrpc: "2.0", method, params });
}
