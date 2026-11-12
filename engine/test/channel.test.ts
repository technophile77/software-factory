import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Conn, serve } from "../src/channel/framing";
import { checkSocketReadBack, listenUnix } from "../src/channel/unix";
import { EngineHandle } from "../src/engine";
import { MemoryLogger } from "../src/log";
import { FfiError, OsApi, UnixApi, realOsApi } from "../src/os/ffi";
import { Children } from "../src/proc";
import { RpcClient, World, engineJson, makeWorld, start, tmpdir } from "./helpers";

let engines: EngineHandle[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop();
  engines = [];
});

const linux = process.platform === "linux";

function fakeOs(unix: Partial<UnixApi>): OsApi {
  const real = realOsApi();
  return {
    platform: process.platform,
    unix: () => ({ geteuid: () => process.geteuid!(), peerCred: (fd) => real.unix().peerCred(fd), ...unix }),
    windows: () => {
      throw new FfiError("no");
    },
    credentials: () => {
      throw new FfiError("no");
    },
  };
}

async function refused(w: World): Promise<boolean> {
  const s = net.connect(engineJson(w).path);
  return new Promise((resolve) => {
    let data = "";
    s.on("data", (d) => (data += d));
    s.on("close", () => resolve(data === ""));
    s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.status" }) + "\n"));
    s.on("error", () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });
}

describe.runIf(linux)("Unix socket access (FR-4, AC-4, SR-15)", () => {
  it("serves the owner: the real SO_PEERCRED check through koffi passes for this process", async () => {
    const w = makeWorld();
    engines.push(await start(w));
    const c = await RpcClient.connect(engineJson(w).path);
    expect((await c.ok("engine.status")).version).toBe("1.2");
    c.close();
  });

  it("AC-4: refuses a peer running as another uid", async () => {
    const w = makeWorld();
    const real = realOsApi();
    engines.push(await start(w, { os: fakeOs({ peerCred: (fd) => ({ ...real.unix().peerCred(fd), uid: process.geteuid!() + 1 }) }) }));
    expect(await refused(w)).toBe(true);
    expect(w.log.text()).toMatch(/is not the owner/);
  });

  it("AC-4: refuses a descendant of the engine (a grandchild, by ancestry)", async () => {
    const w = makeWorld();
    const real = realOsApi();
    const parents: Record<number, number> = { 999999: 999998, 999998: process.pid };
    engines.push(await start(w, {
      os: fakeOs({ peerCred: (fd) => ({ ...real.unix().peerCred(fd), pid: 999999 }) }),
      parentOf: (pid) => parents[pid] ?? null,
    }));
    expect(await refused(w)).toBe(true);
    expect(w.log.text()).toMatch(/a process the engine started/);
  });

  it("SR-15: a forced FFI error refuses the connection", async () => {
    const w = makeWorld();
    engines.push(await start(w, { os: fakeOs({ peerCred: () => { throw new FfiError("forced"); } }) }));
    expect(await refused(w)).toBe(true);
    expect(w.log.text()).toMatch(/the peer check failed/);
  });

  it("refuses a peer the engine spawned (pid in its own child list)", async () => {
    const w = makeWorld();
    const real = realOsApi();
    engines.push(await start(w, { os: fakeOs({ peerCred: (fd) => ({ ...real.unix().peerCred(fd), pid: 4242 }) }), parentOf: (pid) => (pid === 4242 ? process.pid : null) }));
    expect(await refused(w)).toBe(true);
  });

  it("SR-15: the socket mode is read back; a wider mode or a shared folder refuses to serve", () => {
    const dir = tmpdir();
    const sock = path.join(dir, "s.sock");
    const srv = net.createServer().listen(sock);
    return new Promise<void>((resolve) => srv.on("listening", () => {
      fs.chmodSync(sock, 0o660);
      expect(() => checkSocketReadBack(sock, process.geteuid!())).toThrow(/owner-only/);
      fs.chmodSync(sock, 0o600);
      expect(() => checkSocketReadBack(sock, process.geteuid!())).not.toThrow();
      fs.chmodSync(dir, 0o750);
      expect(() => checkSocketReadBack(sock, process.geteuid!())).toThrow(/folder/);
      expect(() => checkSocketReadBack(sock, process.geteuid!() + 1)).toThrow();
      srv.close(() => resolve());
    }));
  });

  it("won't replace something that isn't an old socket", async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "x.sock"), "not a socket");
    await expect(listenUnix({ dir, name: "x.sock", os: realOsApi().unix(), children: new Children(), log: new MemoryLogger(), onConnection: () => undefined }))
      .rejects.toThrow(/in the way/);
  });
});

describe.runIf(linux)("the real FFI module on Linux (SR-15)", () => {
  it("reads the peer's uid and pid from a connected socket", async () => {
    const dir = tmpdir();
    const sock = path.join(dir, "p.sock");
    const api = realOsApi("linux").unix();
    expect(api.geteuid()).toBe(process.geteuid!());
    const got = await new Promise<{ uid: number; pid: number | null }>((resolve, reject) => {
      const srv = net.createServer((s) => {
        try {
          resolve(api.peerCred((s as unknown as { _handle: { fd: number } })._handle.fd));
        } catch (e) {
          reject(e);
        }
        s.destroy();
        srv.close();
      }).listen(sock, () => net.connect(sock).on("error", () => undefined));
    });
    expect(got).toEqual({ uid: process.geteuid!(), pid: process.pid });
  });

  it("fails closed on a bad descriptor or one that isn't a socket", () => {
    const api = realOsApi("linux").unix();
    expect(() => api.peerCred(-1)).toThrow(FfiError);
    const fd = fs.openSync(__filename, "r");
    try {
      expect(() => api.peerCred(fd)).toThrow(FfiError);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("has no Windows pipe support off Windows", () => {
    expect(() => realOsApi("linux").windows()).toThrow(FfiError);
  });
});

function pair(): { conn: Conn; out: Buffer[]; push(s: string | Buffer): void; closed: () => boolean } {
  const out: Buffer[] = [];
  let onData: (b: Buffer) => void = () => undefined;
  let isClosed = false;
  const conn: Conn = {
    write: (d) => void out.push(d),
    close: () => void (isClosed = true),
    onData: (cb) => void (onData = cb),
    onClose: () => undefined,
  };
  return { conn, out, push: (s) => onData(Buffer.isBuffer(s) ? s : Buffer.from(s)), closed: () => isClosed };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const msgs = (out: Buffer[]) => Buffer.concat(out).toString().trim().split("\n").map((l) => JSON.parse(l));

describe("framing (channel v1.1)", () => {
  it("answers one message per line, split across chunks", async () => {
    const p = pair();
    serve(p.conn, async (m, params) => ({ m, params }), () => undefined);
    p.push('{"jsonrpc":"2.0","id":1,"method":"a","params":{"x":1}}\n{"jsonrpc":"2.0","id":"two",');
    p.push('"method":"b"}\n');
    await tick();
    expect(msgs(p.out)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { m: "a", params: { x: 1 } } },
      { jsonrpc: "2.0", id: "two", result: { m: "b", params: {} } },
    ]);
  });

  it("closes on a line over 1 MiB", async () => {
    const p = pair();
    serve(p.conn, async () => ({}), () => undefined);
    p.push(Buffer.alloc(1024 * 1024 + 1, 0x61));
    await tick();
    expect(msgs(p.out)[0].error.code).toBe(-32600);
    expect(p.closed()).toBe(true);
  });

  it("parse errors, bad requests, array params, and ignored notifications", async () => {
    const p = pair();
    let calls = 0;
    serve(p.conn, async () => ++calls, () => undefined);
    p.push("not json\n");
    p.push('{"jsonrpc":"1.0","id":2,"method":"a"}\n');
    p.push('{"jsonrpc":"2.0","id":3,"method":"a","params":[1]}\n');
    p.push('{"jsonrpc":"2.0","method":"a"}\n');
    p.push(Buffer.from([0xff, 0x0a]));
    await tick();
    expect(msgs(p.out).map((m) => m.error.code)).toEqual([-32700, -32600, -32602, -32700]);
    expect(calls).toBe(0);
  });

  it("hides internal errors behind a fixed message", async () => {
    const p = pair();
    const seen: unknown[] = [];
    serve(p.conn, async () => {
      throw new Error("/home/owner/secret/path");
    }, (e) => seen.push(e));
    p.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    await tick();
    expect(msgs(p.out)[0]).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error." } });
    expect(seen).toHaveLength(1);
  });
});

describe.runIf(linux)("method parameters", () => {
  it("rejects unexpected or malformed params", async () => {
    const w = makeWorld();
    engines.push(await start(w));
    const c = await RpcClient.connect(engineJson(w).path);
    const code = async (m: string, p?: Record<string, unknown>) => ((await c.call(m, p)).error as { code: number }).code;
    expect(await code("engine.status", { x: 1 })).toBe(-32602);
    expect(await code("feature.start", { request: "" })).toBe(-32602);
    expect(await code("feature.start", { request: "x".repeat(4001) })).toBe(-32602);
    expect(await code("interview.open", { feature: "../x" })).toBe(-32602);
    expect(await code("interview.open", { feature: "F-404" })).toBe(-32003);
    expect(await code("interview.next", { session: "nope" })).toBe(-32004);
    expect(await code("interview.next", { session: "0".repeat(32) })).toBe(-32004);
    expect(await code("interview.next", { session: "0".repeat(32), wait_s: -1 })).toBe(-32602);
    expect(await code("no.such")).toBe(-32601);
    c.close();
  });
});
