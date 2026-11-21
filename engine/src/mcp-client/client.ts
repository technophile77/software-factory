import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * Just enough of an MCP client to ask a project server for its tools
 * (F-025 SR-7, FR-10, FR-12): `initialize`, then `tools/list` page by page.
 * The agent's own calls go through Claude Code, not through this. A tool
 * list is untrusted text (SR-4): it is only hashed, compared and printed
 * escaped, never followed.
 */

export const PROTOCOL_VERSION = "2025-06-18";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  /** The server's own claim (MCP tool annotations); a hint for the review, never trusted alone (SR-6). */
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
}

export type McpTarget =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { kind: "http"; url: string; headers: Record<string, string> };

export class McpClientError extends Error {
  override name = "McpClientError";
}

export interface ListOptions {
  timeoutMs?: number;
  spawner?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The tools a server reports, in its order; a tool whose name Claude Code couldn't call is dropped. */
export async function listTools(t: McpTarget, o: ListOptions = {}): Promise<{ tools: McpTool[]; dropped: string[] }> {
  const timeoutMs = o.timeoutMs ?? 60_000;
  const conn = t.kind === "stdio" ? new StdioConn(t, o, timeoutMs) : new HttpConn(t, o.fetchImpl ?? fetch, timeoutMs);
  try {
    await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "software-factory-engine", version: "1" } });
    await conn.notify("notifications/initialized");
    const tools: McpTool[] = [];
    const dropped: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await conn.request("tools/list", cursor ? { cursor } : {});
      if (!isObj(r) || !Array.isArray(r.tools)) throw new McpClientError("tools/list returned no tool list");
      for (const x of r.tools) {
        if (!isObj(x) || typeof x.name !== "string" || !TOOL_NAME_RE.test(x.name)) {
          dropped.push(isObj(x) && typeof x.name === "string" ? x.name.slice(0, 80) : "(no name)");
          continue;
        }
        const ann = isObj(x.annotations) ? x.annotations : {};
        tools.push({
          name: x.name, description: typeof x.description === "string" ? x.description : "", inputSchema: x.inputSchema ?? {},
          ...(typeof ann.readOnlyHint === "boolean" ? { readOnlyHint: ann.readOnlyHint } : {}),
          ...(typeof ann.destructiveHint === "boolean" ? { destructiveHint: ann.destructiveHint } : {}),
        });
      }
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) return { tools, dropped };
    }
    throw new McpClientError(`tools/list went on for more than ${MAX_PAGES} pages`);
  } finally {
    await conn.close();
  }
}

interface Conn {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): Promise<void>;
  close(): Promise<void>;
}

function rpcResult(msg: unknown, id: number): { done: true; result: unknown } | { done: false } {
  if (!isObj(msg) || msg.id !== id) return { done: false };
  if (isObj(msg.error)) throw new McpClientError(`the server answered ${String((msg.error as { message?: unknown }).message ?? "an error").slice(0, 200)}`);
  return { done: true, result: msg.result };
}

class StdioConn implements Conn {
  private readonly child: ChildProcess;
  private buf = "";
  private bytes = 0;
  private next = 1;
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private failed: Error | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly platform: NodeJS.Platform;

  constructor(t: Extract<McpTarget, { kind: "stdio" }>, o: ListOptions, timeoutMs: number) {
    this.platform = o.platform ?? process.platform;
    this.child = (o.spawner ?? nodeSpawn)(t.command, t.args, {
      cwd: t.cwd, env: t.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      // Its own process group on POSIX, so whatever it starts goes with it.
      detached: this.platform !== "win32",
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.data(d));
    // Its stderr can hold anything, a secret included; it is drained and never kept.
    this.child.stderr!.resume();
    this.child.on("error", () => this.fail(new McpClientError("the server couldn't be started")));
    this.child.on("exit", (code, signal) => this.fail(new McpClientError(`the server exited (${signal ?? `code ${code}`}) before answering`)));
    this.timer = setTimeout(() => this.fail(new McpClientError(`the server didn't answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  }

  private fail(e: Error): void {
    if (this.failed) return;
    this.failed = e;
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  private data(d: string): void {
    this.bytes += Buffer.byteLength(d);
    if (this.bytes > MAX_BYTES) return this.fail(new McpClientError("the server sent more than 4 MiB"));
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(msg) || typeof msg.id !== "number") continue;
      const w = this.waiting.get(msg.id);
      if (!w) continue;
      this.waiting.delete(msg.id);
      try {
        const r = rpcResult(msg, msg.id);
        w.resolve(r.done ? r.result : undefined);
      } catch (e) {
        w.reject(e as Error);
      }
    }
  }

  private write(msg: unknown): void {
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async notify(method: string): Promise<void> {
    if (this.failed) throw this.failed;
    this.write({ jsonrpc: "2.0", method });
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    const pid = this.child.pid;
    if (this.child.exitCode !== null || this.child.signalCode !== null || !pid) return;
    const gone = new Promise<void>((r) => this.child.once("exit", () => r()));
    try {
      this.child.stdin!.end();
      if (this.platform === "win32") nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(-pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  }
}

class HttpConn implements Conn {
  private next = 1;
  private session: string | null = null;
  private readonly deadline: number;

  constructor(private readonly t: Extract<McpTarget, { kind: "http" }>, private readonly f: typeof fetch, timeoutMs: number) {
    this.deadline = Date.now() + timeoutMs;
  }

  private async post(body: unknown): Promise<Response> {
    const left = this.deadline - Date.now();
    if (left <= 0) throw new McpClientError("the server didn't answer in time");
    const headers: Record<string, string> = {
      ...this.t.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.session ? { "mcp-session-id": this.session } : {}),
    };
    let r: Response;
    try {
      // SR-10: a redirect could carry the server's secret headers to another origin, so none is followed.
      r = await this.f(this.t.url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(left) });
    } catch {
      throw new McpClientError("the server couldn't be reached");
    }
    if (r.status >= 300 && r.status < 400) throw new McpClientError(`the server answered with a redirect (${r.status}), which the engine doesn't follow`);
    if (!r.ok) throw new McpClientError(`the server answered HTTP ${r.status}`);
    const sid = r.headers.get("mcp-session-id");
    if (sid && /^[\x21-\x7e]{1,200}$/.test(sid)) this.session = sid;
    return r;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    const r = await this.post({ jsonrpc: "2.0", id, method, params });
    const text = await readCapped(r);
    const type = r.headers.get("content-type") ?? "";
    const messages: unknown[] = [];
    if (type.includes("text/event-stream")) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          messages.push(JSON.parse(data));
        } catch {
          // Not a message; skipped.
        }
      }
    } else {
      try {
        const m = JSON.parse(text) as unknown;
        messages.push(...(Array.isArray(m) ? m : [m]));
      } catch {
        throw new McpClientError("the server's answer isn't JSON");
      }
    }
    for (const m of messages) {
      const res = rpcResult(m, id);
      if (res.done) return res.result;
    }
    throw new McpClientError(`the server didn't answer ${method}`);
  }

  async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method });
  }

  async close(): Promise<void> {
    if (!this.session) return;
    // Ending the session is a courtesy; a server that doesn't support it is fine.
    await this.f(this.t.url, { method: "DELETE", headers: { ...this.t.headers, "mcp-session-id": this.session }, redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  }
}

async function readCapped(r: Response): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpClientError("the server sent more than 4 MiB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
