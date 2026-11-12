import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ensureOwnerDir } from "../fsutil";
import { Logger } from "../log";
import type { UnixApi } from "../os/ffi";
import { Children } from "../proc";
import { Conn } from "./framing";

export interface Listener {
  path: string;
  close(): Promise<void>;
}

export class ChannelRefused extends Error {
  override name = "ChannelRefused";
}

/** Node keeps the descriptor on an internal handle only; no descriptor means no peer check, so refuse. */
function fdOf(sock: net.Socket): number {
  const fd = (sock as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  return typeof fd === "number" ? fd : -1;
}

/**
 * Checks the socket after creating it (SR-15): a socket, ours, mode 0600, in
 * an owner-only folder that is ours. Anything else and the engine won't serve.
 */
export function checkSocketReadBack(sockPath: string, euid: number): void {
  const st = fs.lstatSync(sockPath);
  const dir = fs.lstatSync(path.dirname(sockPath));
  if (!st.isSocket() || st.uid !== euid || (st.mode & 0o777) !== 0o600) throw new ChannelRefused("The channel socket isn't owner-only after creation.");
  if (!dir.isDirectory() || dir.uid !== euid || (dir.mode & 0o077) !== 0) throw new ChannelRefused("The channel socket's folder isn't owner-only.");
}

/**
 * Serves the channel on a Unix socket (channel v1.1 access rules): mode 0600
 * in an owner-only folder, and each peer must run as the owner's uid and not
 * be a process the engine started. Every OS step fails closed (SR-15).
 */
export async function listenUnix(o: {
  dir: string;
  name: string;
  os: UnixApi;
  children: Children;
  log: Logger;
  onConnection: (c: Conn) => void;
}): Promise<Listener> {
  ensureOwnerDir(o.dir);
  const euid = o.os.geteuid();
  if (euid !== process.geteuid?.()) throw new ChannelRefused("The OS and Node disagree on the engine's uid.");
  const sockPath = path.join(o.dir, o.name);
  if (Buffer.byteLength(sockPath) > 100) throw new ChannelRefused("The channel socket path is too long for the OS.");
  try {
    const st = fs.lstatSync(sockPath);
    if (!st.isSocket() || st.uid !== euid) throw new ChannelRefused("Something other than an old engine socket is in the way.");
    fs.unlinkSync(sockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    let pid: number | null = null;
    try {
      const cred = o.os.peerCred(fdOf(sock));
      if (cred.uid !== euid) throw new ChannelRefused(`peer uid ${cred.uid} is not the owner`);
      pid = cred.pid;
      if (pid === null || o.children.startedByEngine(pid)) throw new ChannelRefused(`peer ${pid} is a process the engine started`);
    } catch (e) {
      o.log.warn(`Refused a channel connection: ${e instanceof ChannelRefused ? e.message : "the peer check failed"}.`);
      sock.destroy();
      return;
    }
    sockets.add(sock);
    const closers: Array<() => void> = [];
    sock.on("close", () => {
      sockets.delete(sock);
      for (const c of closers) c();
    });
    sock.on("error", () => sock.destroy());
    o.onConnection({
      write: (d) => {
        if (!sock.destroyed) sock.write(d);
      },
      close: () => sock.end(),
      onData: (cb) => sock.on("data", cb),
      onClose: (cb) => closers.push(cb),
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    // The folder is owner-only, so nobody else can connect before this.
    fs.chmodSync(sockPath, 0o600);
    checkSocketReadBack(sockPath, euid);
  } catch (e) {
    server.close();
    throw e instanceof ChannelRefused ? e : new ChannelRefused("The channel socket couldn't be made owner-only.");
  }
  return {
    path: sockPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
