// Engine control channel v1.3 as a contract: transport, access (AC-4,
// SR-15), framing, JSON-RPC errors and the engine.* methods.
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, join } from "node:path";
import { realDelay } from "./support/clock";
import { answerOne, expectRpcError, interviewReady } from "./support/flows";
import { ERR, MAX_FRAME, RpcClient } from "./support/rpc";
import { mode, waitFor, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const isRoot = process.getuid?.() === 0;

/** Connects to the socket as another user and asks for engine.status.
 * The engine runs in this test process and refuses its own descendants, so
 * the probe is double-forked (its shell exits and it is re-parented) and
 * reports through a file. It must also be async: a sync spawn would block
 * the in-process engine from answering. */
async function probeAs(uid: number, socketPath: string): Promise<string> {
  const outDir = join(tmpdir(), `f007-probe-${process.pid}-${uid}-${Date.now()}`);
  mkdirSync(outDir);
  chmodSync(outDir, 0o777);
  const file = join(outDir, "result");
  const script = `
    const s = require("net").createConnection(${JSON.stringify(socketPath)});
    let buf = "";
    const end = (v) => { require("fs").writeFileSync(${JSON.stringify(file)}, v); process.exit(0); };
    s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.status" }) + "\\n"));
    s.on("data", (d) => { buf += d; if (buf.includes("\\n")) end(JSON.parse(buf.split("\\n")[0]).result ? "result" : "error"); });
    s.on("error", (e) => end("connect-error:" + e.code));
    s.on("close", () => end("closed"));
    setTimeout(() => end("timeout"), 3000);`;
  const scriptFile = join(outDir, "probe.js");
  writeFileSync(scriptFile, script);
  chmodSync(scriptFile, 0o644);
  spawn("/bin/sh", ["-c", `"${process.execPath}" "${scriptFile}" </dev/null >/dev/null 2>&1 &`], {
    uid,
    gid: uid,
    stdio: "ignore",
  });
  try {
    return await waitFor(() => (existsSync(file) ? readFileSync(file, "utf8") : ""), 15_000, `the probe as uid ${uid}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe("Channel transport and access (AC-4, FR-4, SR-15 on Linux)", () => {
  it("[CH-1] Channel v1.1 access: the socket is mode 0600 inside an owner-only directory owned by the owner", async () => {
    w = await World.create();
    await w.boot();
    const sock = w.socket();
    const st = lstatSync(sock);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(process.getuid!());
    const dir = statSync(dirname(sock));
    expect(dir.mode & 0o077).toBe(0);
    expect(dir.uid).toBe(process.getuid!());
  });

  it("[CH-2] SR-15: a runtime directory pre-created world-writable doesn't leave the socket reachable by others", async () => {
    w = await World.create();
    chmodSync(w.runtimeDir, 0o777);
    let started = true;
    try {
      await w.boot();
    } catch (e) {
      started = false;
      if (/engine not available/.test((e as Error).message)) throw e;
    }
    if (started) {
      const sock = w.socket();
      expect(lstatSync(sock).mode & 0o077).toBe(0);
      expect(statSync(dirname(sock)).mode & 0o077).toBe(0);
    }
  });

  it.runIf(isRoot)("[CH-3] AC-4: a peer running as another user is refused, as the owner's own peer is answered (needs root to switch uid)", async () => {
    w = await World.create();
    await w.boot();
    const sock = w.socket();
    expect(await probeAs(0, sock)).toBe("result");
    // Directory permissions alone already refuse another user.
    expect(await probeAs(65534, sock)).not.toBe("result");
    // Loosen the filesystem so only the engine's own peer check stands.
    let d = dirname(sock);
    while (relative(w.root, d) && !relative(w.root, d).startsWith("..")) {
      chmodSync(d, 0o711);
      d = dirname(d);
    }
    chmodSync(w.root, 0o711);
    chmodSync(sock, 0o666);
    expect(await probeAs(65534, sock)).not.toBe("result");
  });

  it("[CH-4] AC-4: a process the engine started (its gitleaks run) is refused on the channel", async () => {
    w = await World.create();
    w.gitleaks.control({ probeEngineJson: w.engineJsonPath() });
    await answerOne(w);
    const runs = await waitFor(() => w!.gitleaks.scans().filter((r) => r.probe), 15_000, "a gitleaks scan");
    for (const r of runs) expect(r.probe, "engine answered its own child process").not.toBe("result");
  });

  it("[CH-5] Channel v1.1: a client may use a new connection per call (the lock is the token, not the connection)", async () => {
    w = await World.create();
    await w.boot();
    const a = await w.rpc("engine.status");
    const b = await w.rpc("engine.status");
    expect(a.result).toBeDefined();
    expect(b.result).toBeDefined();
  });
});

describe("Framing (channel v1.1): one JSON-RPC message per line, UTF-8, \\n, at most 1 MiB", () => {
  it("[CH-6] two messages in one write get two responses; one message split over writes gets one", async () => {
    w = await World.create();
    await w.boot();
    const c = await w.connect();
    try {
      const both = Promise.all([c.request(1, ""), c.request(2, "")]);
      c.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.status" }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "engine.status" }) +
          "\n",
      );
      const [r1, r2] = await both;
      expect(r1.result).toBeDefined();
      expect(r2.result).toBeDefined();
      const line = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "engine.status" }) + "\n";
      const p = c.request(3, line.slice(0, 10));
      await realDelay(50);
      c.write(line.slice(10));
      expect((await p).result).toBeDefined();
      for (const l of c.lines) expect(Buffer.byteLength(l) + 1).toBeLessThanOrEqual(MAX_FRAME);
    } finally {
      c.close();
    }
  });

  it("[CH-7] a message of exactly 1 MiB including its newline is read and answered", async () => {
    w = await World.create();
    await w.boot();
    const head = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "interview.state", params: { feature: "F-999", item: "x", pad: "" } });
    const padLen = MAX_FRAME - Buffer.byteLength(head) - 1;
    const line = head.replace('"pad":""', `"pad":"${"a".repeat(padLen)}"`) + "\n";
    expect(Buffer.byteLength(line)).toBe(MAX_FRAME);
    const c = await w.connect();
    try {
      const r = await c.request(7, line, 15_000);
      expect(r.id).toBe(7);
      expect(r.error?.message === "connection closed").toBe(false);
    } finally {
      c.close();
    }
  });

  it("[CH-8] a line over 1 MiB is refused without the engine buffering it forever; the engine keeps serving", async () => {
    w = await World.create();
    await w.boot();
    const c = await w.connect();
    c.write("{" + '"x":"' + "b".repeat(MAX_FRAME + 16));
    const closedOrAnswered = await Promise.race([c.waitClosed(10_000), c.waitLine(10_000).then(() => true)]);
    expect(closedOrAnswered, "engine neither answered nor closed an over-long line").toBe(true);
    if (!c.closed) {
      const msg = JSON.parse(c.lines[0]);
      expect([ERR.parse, ERR.invalidRequest]).toContain(msg.error?.code);
    }
    c.close();
    expect((await w.rpc("engine.status")).result).toBeDefined();
  });

  it("[CH-9] JSON-RPC errors: invalid JSON is -32700, a non-request is -32600, an unknown method is -32601", async () => {
    w = await World.create();
    await w.boot();
    const firstLine = async (raw: string) => {
      const c = await w!.connect();
      try {
        c.write(raw);
        await waitFor(() => c.lines.length >= 1, 5000, `a response to ${raw.trim()}`);
        return JSON.parse(c.lines[0]);
      } finally {
        c.close();
      }
    };
    expect((await firstLine("{not json\n")).error?.code).toBe(ERR.parse);
    expect((await firstLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: 42 }) + "\n")).error?.code).toBe(ERR.invalidRequest);
    expectRpcError(await w.rpc("engine.selfDestruct"), ERR.methodNotFound);
    // The engine is still up after all three.
    expect((await w.rpc("engine.status")).result).toBeDefined();
  });

  it("[CH-10] a multi-byte character split across writes is decoded correctly", async () => {
    w = await World.create();
    await w.boot();
    const request = "Data export for 🇳🇿 and naïve users";
    const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "feature.start", params: { request } }) + "\n");
    const cut = line.indexOf(Buffer.from("🇳")) + 2;
    const c = await w.connect();
    try {
      const p = c.request(1, line.subarray(0, cut));
      await realDelay(50);
      c.write(line.subarray(cut));
      const r = await p;
      expect(r.result?.feature).toMatch(/^F-\d{3,}$/);
    } finally {
      c.close();
    }
  });
});

describe("engine.* methods (channel v1.3)", () => {
  it("[CH-11] engine.status lists a started feature with stage and active_agents", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const st = await w.ok("engine.status");
    const entry = st.features.find((x: any) => x.id === f);
    expect(entry).toBeDefined();
    expect(typeof entry.stage).toBe("string");
    expect(Number.isInteger(entry.active_agents)).toBe(true);
  });

  it("[CH-12] engine.pause and engine.resume, for one feature and for all", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    expect((await w.ok("engine.pause", { feature: f })).paused).toEqual([f]);
    expect((await w.ok("engine.resume", { feature: f })).resumed).toEqual([f]);
    expect((await w.ok("engine.pause", {})).paused).toContain(f);
    expect((await w.ok("engine.resume", {})).resumed).toContain(f);
  });

  it("[CH-13] engine.pause of an unknown feature is -32003", async () => {
    w = await World.create();
    await w.boot();
    expectRpcError(await w.rpc("engine.pause", { feature: "F-999" }), ERR.unknown);
  });

  it("[CH-14] engine.shutdown answers { ok: true } and the channel then closes", async () => {
    w = await World.create();
    await w.boot();
    const sock = w.socket();
    expect((await w.rpc("engine.shutdown")).result).toEqual({ ok: true });
    await waitFor(
      async () => {
        try {
          const c = await RpcClient.connect(sock, 500);
          const r = await c.call("engine.status", undefined, 500).catch(() => undefined);
          c.close();
          return !r?.result;
        } catch {
          return true;
        }
      },
      15_000,
      "the channel to close after shutdown",
    );
    w.engine = undefined;
  });
});

describe("Advisor kinds are refused until the advisor increment (FR-4, F-006 deferred list)", () => {
  it("[CH-15] the engine refuses every advisor reply kind with -32005 and sends no advisor fields (ST-1 checks the served version)", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const q = await w.ask(feature, { text: "Which format?" });
    const next = await w.ok("interview.next", { session });
    expect(next.item.id).toBe(q.id);
    for (const kind of ["ask_advisor", "approve_advisor", "decline_advisor"]) {
      expectRpcError(await w.reply(session, next.item, kind, ""), ERR.kindNotAllowed);
    }
    const a = await w.propose(feature);
    for (const kind of ["approve_advisor", "decline_advisor", "ask_advisor"]) {
      expectRpcError(await w.reply(session, a, kind, ""), ERR.kindNotAllowed);
    }
    // No advisor fields ever appear on items in this increment.
    const st = await w.ok("interview.state", { feature, item: q.id });
    expect(st.status).toBe("open");
    const again = await w.ok("interview.next", { session });
    for (const it2 of [next.item, again.item].filter(Boolean)) {
      expect(["question", "assumption"]).toContain(it2.kind);
      expect(it2).not.toHaveProperty("advice");
      expect(it2).not.toHaveProperty("advisor_call");
      expect(it2).not.toHaveProperty("about");
    }
  });
});

describe("Files the channel depends on", () => {
  it("[CH-16] engine.json and .factory survive a restart with the same modes", async () => {
    w = await World.create();
    await w.boot();
    await w.restart();
    expect(mode(w.engineJsonPath())).toBe(0o600);
    expect(mode(join(w.projects[0].clone, ".factory")) & 0o022).toBe(0);
  });
});
