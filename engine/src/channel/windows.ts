import * as crypto from "node:crypto";
import * as net from "node:net";
import { Logger } from "../log";
import type { Handle, WindowsApi } from "../os/ffi";
import { isOwnerOnlyPipe, ownerOnlyPipeSddl } from "../os/sddl";
import { Children } from "../proc";
import { Conn } from "./framing";
import { ChannelRefused, Listener } from "./unix";

const POLL_MS = 10;
const READ_CHUNK = 64 * 1024;

export function pipeName(): string {
  return `\\\\.\\pipe\\software-factory-${crypto.randomBytes(16).toString("hex")}`;
}

/**
 * Serves the channel on a named pipe the engine creates itself (channel v1.1
 * access rules): an unguessable name, FILE_FLAG_FIRST_PIPE_INSTANCE, remote
 * clients rejected, and a protected DACL for the owner only, read back from
 * the kernel after creation (SR-15). Each client must run as the owner's SID
 * and not be a process the engine started.
 *
 * Node can't put an ACL on a pipe it creates, so the pipe is the engine's own
 * through the FFI module. Reads poll PeekNamedPipe, which never blocks, so no
 * worker thread is held per connection; only the wait for the next client
 * (ConnectNamedPipe) runs on a koffi worker thread.
 */
export async function listenPipe(o: {
  name?: string;
  os: WindowsApi;
  children: Children;
  log: Logger;
  onConnection: (c: Conn) => void;
}): Promise<Listener> {
  const name = o.name ?? pipeName();
  const sid = o.os.currentUserSid();
  const sddl = ownerOnlyPipeSddl(sid);
  let closed = false;
  const open = new Set<() => void>();

  const create = (first: boolean): Handle => {
    const h = o.os.createPipe(name, sddl, first);
    let ok = false;
    try {
      ok = isOwnerOnlyPipe(o.os.handleSddl(h), sid);
    } catch {
      ok = false;
    }
    if (!ok) {
      o.os.closePipe(h);
      throw new ChannelRefused("The channel pipe's ACL isn't owner-only after creation.");
    }
    return h;
  };

  let current = create(true);

  const serveClient = (h: Handle) => {
    let alive = true;
    const closers: Array<() => void> = [];
    const shut = () => {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      open.delete(shut);
      try {
        o.os.closePipe(h);
      } catch {
        // already gone
      }
      for (const c of closers) c();
    };
    const listeners: Array<(b: Buffer) => void> = [];
    const timer = setInterval(() => {
      try {
        const n = o.os.pipeAvailable(h);
        if (n > 0) {
          const data = o.os.readPipe(h, Math.min(n, READ_CHUNK));
          for (const l of listeners) l(data);
        }
      } catch {
        shut();
      }
    }, POLL_MS);
    open.add(shut);
    o.onConnection({
      write: (d) => {
        if (!alive) return;
        try {
          o.os.writePipe(h, d);
        } catch {
          shut();
        }
      },
      close: shut,
      onData: (cb) => listeners.push(cb),
      onClose: (cb) => closers.push(cb),
    });
  };

  const loop = async () => {
    while (!closed) {
      const h = current;
      try {
        await o.os.connectPipe(h);
      } catch {
        if (closed) return;
        o.log.warn("The channel pipe stopped accepting clients.");
        return;
      }
      if (closed) {
        o.os.closePipe(h);
        return;
      }
      // A fresh instance first, so the next client can connect while this one is checked.
      try {
        current = create(false);
      } catch (e) {
        o.os.closePipe(h);
        o.log.warn(`The channel stopped: ${(e as Error).message}`);
        closed = true;
        return;
      }
      try {
        const pid = o.os.pipeClientPid(h);
        const clientSid = o.os.processUserSid(pid);
        if (clientSid !== sid) throw new ChannelRefused("the client isn't the owner");
        if (o.children.startedByEngine(pid)) throw new ChannelRefused(`client ${pid} is a process the engine started (it, then its parents: ${o.children.lastChain.join(", ")})`);
      } catch (e) {
        o.log.warn(`Refused a channel connection: ${e instanceof ChannelRefused ? e.message : "the client check failed"}.`);
        o.os.closePipe(h);
        continue;
      }
      serveClient(h);
    }
  };
  void loop();

  return {
    path: name,
    close: async () => {
      closed = true;
      for (const shut of [...open]) shut();
      // ConnectNamedPipe is still waiting on a worker thread; a client of our own wakes it.
      await new Promise<void>((resolve) => {
        const s = net.connect(name);
        s.on("error", () => resolve());
        s.on("close", () => resolve());
        s.on("connect", () => s.destroy());
      });
    },
  };
}
