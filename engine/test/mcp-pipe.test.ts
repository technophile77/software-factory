import { describe, expect, test } from "vitest";
import { Channel, connect } from "../src/mcp/client";
import { ChannelFailure, Refused } from "../src/mcp/errors";
import type { Handle, OsApi, WindowsApi } from "../src/os/ffi";

// F-005 SR-7: the MCP mode's Windows named pipe client, driven through a fake
// WindowsApi so the checks run on every platform. A real pipe is covered by
// the engine's own Windows channel tests, which share these koffi calls' types.

const NAME = "\\\\.\\pipe\\software-factory-engine-1234";
const OWNER = "S-1-5-21-1-2-3-1001";

interface Fake {
  api: WindowsApi;
  opened: string[];
  closed: number;
  written: Buffer[];
  /** Bytes the fake engine will hand to the next reads. */
  inbox: Buffer[];
  broken: boolean;
}

function fake(opts: { serverPid?: number; serverSid?: string; openFails?: boolean; answer?: boolean } = {}): Fake {
  const h = {} as Handle;
  const f: Fake = { api: {} as WindowsApi, opened: [], closed: 0, written: [], inbox: [], broken: false };
  const unused = () => { throw new Error("not used by the client"); };
  f.api = {
    currentUserSid: () => OWNER,
    processUserSid: (pid) => (pid === (opts.serverPid ?? 4242) ? (opts.serverSid ?? OWNER) : "S-1-5-18"),
    openPipeClient: (name) => {
      f.opened.push(name);
      if (opts.openFails) throw new Error("ERROR_FILE_NOT_FOUND");
      return h;
    },
    pipeServerPid: () => opts.serverPid ?? 4242,
    closeHandle: () => { f.closed++; },
    pipeAvailable: () => {
      if (f.broken) throw new Error("ERROR_BROKEN_PIPE");
      return f.inbox.reduce((n, b) => n + b.length, 0);
    },
    readPipe: (_h, n) => {
      const all = Buffer.concat(f.inbox);
      f.inbox = [all.subarray(n)];
      return all.subarray(0, n);
    },
    writePipe: (_h, data) => {
      f.written.push(data);
      if (opts.answer === false) return;
      const req = JSON.parse(data.toString("utf8"));
      f.inbox.push(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { echo: req.method } })}\n`));
    },
    createPipe: unused, handleSddl: unused, fileSddl: unused, connectPipe: unused,
    pipeClientPid: unused, closePipe: unused,
  };
  return f;
}

function os(api: WindowsApi): OsApi {
  return { platform: "win32", windows: () => api, unix: () => { throw new Error("no"); }, credentials: () => { throw new Error("no"); } };
}

async function refusal(p: Promise<unknown>): Promise<Refused | ChannelFailure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refused || e instanceof ChannelFailure) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("SR-7: Windows pipe client", () => {
  test("a call round-trips over a pipe served as the owner by engine.json's pid", async () => {
    const f = fake();
    const ch = new Channel(await connect(NAME, 4242, os(f.api), 5000));
    expect(await ch.call("engine.status", undefined, 5)).toEqual({ echo: "engine.status" });
    ch.close();
    expect(f.opened).toEqual([NAME]);
    expect(f.closed).toBe(1);
  });

  test.each([
    "\\\\host\\pipe\\software-factory-engine",
    "\\\\?\\pipe\\x",
    "\\\\.\\pipe\\..\\x",
    "/tmp/engine.sock",
  ])("a name other than a local \\\\.\\pipe\\ name is refused before opening: %s", async (name) => {
    const f = fake();
    expect((await refusal(connect(name, 4242, os(f.api), 5000))).code).toBe("unsafe_pipe");
    expect(f.opened).toEqual([]);
  });

  test("a server running as another user is refused and its handle closed, nothing written", async () => {
    const f = fake({ serverSid: "S-1-5-21-9-9-9-1002" });
    expect((await refusal(connect(NAME, 4242, os(f.api), 5000))).code).toBe("peer_not_owner");
    expect(f.closed).toBe(1);
    expect(f.written).toEqual([]);
  });

  test("a server that isn't engine.json's pid is refused and its handle closed, nothing written", async () => {
    const f = fake({ serverPid: 777 });
    f.api.processUserSid = () => OWNER;
    expect((await refusal(connect(NAME, 4242, os(f.api), 5000))).code).toBe("peer_not_engine");
    expect(f.closed).toBe(1);
    expect(f.written).toEqual([]);
  });

  test("a pipe that can't be opened reads as an unreachable engine", async () => {
    const f = fake({ openFails: true });
    expect((await refusal(connect(NAME, 4242, os(f.api), 5000))).code).toBe("engine_unreachable");
  });

  test("a broken pipe ends the call as connection_lost", async () => {
    const f = fake({ answer: false });
    const ch = new Channel(await connect(NAME, 4242, os(f.api), 5000));
    const pending = refusal(ch.call("engine.status", undefined, 5));
    f.broken = true;
    expect((await pending).code).toBe("connection_lost");
    expect(f.closed).toBe(1);
  });

  test("a silent engine times out", async () => {
    const f = fake({ answer: false });
    const ch = new Channel(await connect(NAME, 4242, os(f.api), 5000));
    const e = await refusal(ch.call("engine.status", undefined, 0.3));
    expect(e).toBeInstanceOf(ChannelFailure);
    expect(e.code).toBe("timeout");
    ch.close();
  });
});

// The real Win32 calls (CreateFileW, GetNamedPipeServerProcessId) against the
// engine's own owner-only pipe, on the windows-latest CI shards (owner,
// 2026-11-13: the two calls are approved after a real Windows run).
describe.runIf(process.platform === "win32")("SR-7: the real Windows pipe, client against the engine's listener", () => {
  async function engine() {
    const { listenPipe } = await import("../src/channel/windows");
    const { serve } = await import("../src/channel/framing");
    const { Children } = await import("../src/proc");
    const { MemoryLogger } = await import("../src/log");
    const { realOsApi } = await import("../src/os/ffi");
    const real = realOsApi();
    const listener = await listenPipe({
      os: real.windows(), children: new Children(() => null), log: new MemoryLogger(),
      onConnection: (c) => serve(c, async (method) => ({ echo: method }), () => {}),
    });
    return { real, listener };
  }

  test("a call round-trips when the pipe's server is this process, running as the owner", async () => {
    const { real, listener } = await engine();
    try {
      const ch = new Channel(await connect(listener.path, process.pid, real, 5000));
      expect(await ch.call("engine.status", undefined, 10)).toEqual({ echo: "engine.status" });
      ch.close();
    } finally {
      await listener.close();
    }
  }, 30_000);

  test("a server pid other than engine.json's is refused", async () => {
    const { real, listener } = await engine();
    try {
      expect((await refusal(connect(listener.path, process.pid + 4, real, 5000))).code).toBe("peer_not_engine");
    } finally {
      await listener.close();
    }
  }, 30_000);

  test("a pipe that doesn't exist reads as an unreachable engine", async () => {
    const { realOsApi } = await import("../src/os/ffi");
    const e = await refusal(connect("\\\\.\\pipe\\software-factory-missing-0000", process.pid, realOsApi(), 5000));
    expect(e.code).toBe("engine_unreachable");
  });
});
