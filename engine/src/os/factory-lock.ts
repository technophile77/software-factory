import * as crypto from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";
import { listenPipe } from "../channel/windows";
import { type Listener, listenUnix } from "../channel/unix";
import type { Logger } from "../log";
import type { Children } from "../proc";
import type { OsApi } from "./ffi";

/** Another engine holds the lock; `pid` is null when it couldn't be read. */
export class FactoryRunning extends Error {
  override name = "FactoryRunning";
  constructor(readonly pid: number | null) {
    super(`A factory is already running on this PC${pid !== null ? ` (pid ${pid})` : ""}.`);
  }
}

const SOCKET = "factory.sock";
const PROBE_MS = 2000;
const PID_LINE = /^\{"pid":(\d{1,10})\}\n$/;

/** The per-user pipe name, fixed so a second engine finds it whatever --home it was given. */
export function factoryPipeName(sid: string): string {
  return `\\\\.\\pipe\\software-factory-engine-${crypto.createHash("sha256").update(sid).digest("hex").slice(0, 16)}`;
}

/**
 * F-023 FR-1, SR-12: one factory per OS user on a PC. The lock is a listener
 * the OS removes when the process ends, so a crashed engine never leaves it
 * held: a first-instance pipe with an owner-only DACL on Windows, a socket
 * in an owner-only folder elsewhere. Each connection is told the holder's pid.
 */
export async function takeFactoryLock(o: { os: OsApi; children: Children; log: Logger; dir: string; pipe?: string }): Promise<Listener> {
  const tellPid = (c: { write(b: Buffer): void; close(): void }) => {
    c.write(Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`));
    c.close();
  };
  if (o.os.platform === "win32") {
    const name = o.pipe ?? factoryPipeName(o.os.windows().currentUserSid());
    try {
      return await listenPipe({ name, os: o.os.windows(), children: o.children, log: o.log, onConnection: tellPid });
    } catch {
      throw new FactoryRunning(await pipeHolder(o.os, name));
    }
  }
  const sock = path.join(o.dir, SOCKET);
  const before = await socketHolder(sock);
  if (before !== undefined) throw new FactoryRunning(before);
  const l = await listenUnix({ dir: o.dir, name: SOCKET, os: o.os.unix(), children: o.children, log: o.log, onConnection: tellPid });
  // Two engines that both found no holder could each have bound; whoever's socket the path now names wins.
  const now = await socketHolder(sock);
  if (now !== process.pid) {
    await l.close();
    throw new FactoryRunning(now ?? null);
  }
  return l;
}

/** undefined: nobody is listening; null: someone is, but gave no pid. */
function socketHolder(sock: string): Promise<number | null | undefined> {
  return new Promise((resolve) => {
    let buf = "";
    let connected = false;
    const s = net.connect(sock);
    const done = (v: number | null | undefined) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(connected ? null : undefined), PROBE_MS);
    s.on("connect", () => (connected = true));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > 64) return done(null);
      const m = PID_LINE.exec(buf);
      if (m) done(Number(m[1]));
    });
    s.on("end", () => done(connected ? null : undefined));
    s.on("error", () => done(connected ? null : undefined));
  });
}

async function pipeHolder(os: OsApi, name: string): Promise<number | null> {
  try {
    const w = os.windows();
    const h = w.openPipeClient(name);
    try {
      let buf = "";
      for (let waited = 0; waited < PROBE_MS && buf.length <= 64; waited += 50) {
        const n = w.pipeAvailable(h);
        if (n > 0) buf += w.readPipe(h, n).toString("utf8");
        const m = PID_LINE.exec(buf);
        if (m) return Number(m[1]);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      w.closePipe(h);
    }
  } catch {
    // The holder closed the pipe before answering, or refused this process.
  }
  return null;
}
