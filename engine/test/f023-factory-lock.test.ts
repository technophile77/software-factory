import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Listener } from "../src/channel/unix";
import { MemoryLogger } from "../src/log";
import { FactoryRunning, factoryHolder, takeFactoryLock } from "../src/os/factory-lock";
import { realOsApi } from "../src/os/ffi";
import { Children } from "../src/proc";

const held: Listener[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const l of held.splice(0)) await l.close().catch(() => undefined);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Short, so the socket path stays under the OS limit.
function lockDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fl-"));
  dirs.push(d);
  return path.join(d, "run");
}

const take = (dir: string, pipe: string) =>
  takeFactoryLock({ os: realOsApi(), children: new Children(), log: new MemoryLogger(), dir, pipe }).then((l) => (held.push(l), l));

describe("F-023 FR-1, SR-12: one factory per PC", () => {
  it("AC-1: a second engine is refused and told the first one's pid; once the first stops, a new one starts", async () => {
    const dir = lockDir();
    const pipe = `\\\\.\\pipe\\sf-lock-test-${crypto.randomBytes(8).toString("hex")}`;
    const first = await take(dir, pipe);
    const second = await take(dir, pipe).then(() => null, (e: unknown) => e);
    expect(second).toBeInstanceOf(FactoryRunning);
    expect((second as FactoryRunning).pid).toBe(process.pid);
    expect((second as FactoryRunning).message).toBe(`A factory is already running on this PC (pid ${process.pid}).`);
    await first.close();
    held.splice(held.indexOf(first), 1);
    await expect(take(dir, pipe)).resolves.toBeDefined();
  });

  it("the console's probe finds the running factory's pid without taking the lock, and nothing once it stops", async () => {
    const dir = lockDir();
    const pipe = `\\\\.\\pipe\\sf-lock-test-${crypto.randomBytes(8).toString("hex")}`;
    expect(await factoryHolder({ os: realOsApi(), dir, pipe })).toBeUndefined();
    const first = await take(dir, pipe);
    expect(await factoryHolder({ os: realOsApi(), dir, pipe })).toBe(process.pid);
    await first.close();
    held.splice(held.indexOf(first), 1);
    expect(await factoryHolder({ os: realOsApi(), dir, pipe })).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("SR-12: a lock left by an engine that died is cleared", async () => {
    const dir = lockDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sock = path.join(dir, "factory.sock");
    // A process that binds the socket and is then killed leaves the file behind with nobody listening.
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((r) => child.stdout!.once("data", () => r()));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(fs.existsSync(sock)).toBe(true);
    await expect(take(dir, "unused")).resolves.toBeDefined();
  });

  it.skipIf(process.platform === "win32")("SR-12: the lock folder is owner-only", async () => {
    const dir = lockDir();
    await take(dir, "unused");
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });
});

describe("F-023 FR-1: the engine takes the lock at start", () => {
  it("AC-1: a second engine with another engine folder and master clone doesn't start while the first runs", async () => {
    const { makeWorld, start } = await import("./helpers");
    const { StartError } = await import("../src/engine");
    const dir = lockDir();
    const pipe = `\\\\.\\pipe\\sf-lock-test-${crypto.randomBytes(8).toString("hex")}`;
    const a = makeWorld();
    const b = makeWorld();
    const e1 = await start(a, { factoryLock: { dir, pipe } });
    try {
      const refused = await start(b, { factoryLock: { dir, pipe } }).then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(StartError);
      expect((refused as Error).message).toMatch(/^A factory is already running on this PC \(pid \d+\)\.$/);
    } finally {
      await e1.stop();
    }
    const e2 = await start(b, { factoryLock: { dir, pipe } });
    await e2.stop();
  });
});

describe("F-023 FR-16: start from any folder", () => {
  it("AC-12: --master wins, then engine.yaml's master:, then the current folder; a relative master: is refused", async () => {
    const { masterClone, readEngineConfig } = await import("../src/config/engine-config");
    const home = lockDir();
    fs.mkdirSync(home, { recursive: true });
    const abs = path.resolve(home, "master");
    fs.writeFileSync(path.join(home, "engine.yaml"), `master: ${JSON.stringify(abs)}\n`);
    expect(readEngineConfig(home).master).toBe(abs);
    expect(masterClone(undefined, readEngineConfig(home).master, os.tmpdir())).toBe(abs);
    expect(masterClone(path.join(home, "flag"), abs, os.tmpdir())).toBe(path.join(home, "flag"));
    expect(masterClone(undefined, undefined, home)).toBe(path.resolve(home));
    expect(() => masterClone(undefined, "relative/master", home)).toThrow(/absolute/);
    fs.writeFileSync(path.join(home, "engine.yaml"), "master: x\nother: y\n");
    expect(() => readEngineConfig(home)).toThrow();
  });
});
