// F-015 FR-20: commands that hang. A command a session started that blocks for
// good is killed after the silence limit, with its children, without killing
// Claude Code; what a session leaves running is killed when it ends.
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { descendants, killUnder, realProcessOps } from "../src/agent/commands";
import { HostGroup } from "../src/agent/host";
import type { AgentSdk, SdkMessage } from "../src/agent/sdk";
import { type HostGate, type SessionCaps, runSession, sessionOptions, toolGate } from "../src/agent/session";
import { buildTurn } from "../src/build/worker";
import { MemoryLogger } from "../src/log";
import { type RolePolicy, SECRET_DENIES, effectiveRole } from "../src/policy/role-policy";
import { Children } from "../src/proc";
import { oneTurn } from "./fakes";
import { tmpdir } from "./helpers";
import { policyDoc } from "./policy-fixture";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

// A stand-in for Claude Code: it starts a command (child) that starts its own child (grandchild), as `bash -c python ...` does, and prints their pids.
const ROOT = `
const { spawn } = require("node:child_process");
const grand = "setInterval(() => {}, 1e6)";
const child = spawn(process.execPath, ["-e", \`const c = require("node:child_process").spawn(process.execPath, ["-e", \${JSON.stringify(grand)}], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1e6)\`], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", (d) => console.log(JSON.stringify({ child: child.pid, grand: Number(String(d).trim()) })));
setInterval(() => {}, 1e6);
`;

function readPids(p: ChildProcess): Promise<{ child: number; grand: number }> {
  return new Promise((resolve, reject) => {
    p.stdout!.once("data", (d) => resolve(JSON.parse(String(d).trim().split("\n")[0]!)));
    p.once("error", reject);
  });
}

const started: ChildProcess[] = [];
afterEach(() => {
  for (const p of started) p.kill("SIGKILL");
  started.length = 0;
});

describe("finding and killing a session's commands (FR-20)", () => {
  it("finds every process under a root, not the root, and survives a parent loop", () => {
    const rows = [{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }, { pid: 30, ppid: 31 }, { pid: 31, ppid: 30 }];
    expect(descendants(rows, 10)).toEqual([11, 12]);
    expect(descendants(rows, 1).sort((a, b) => a - b)).toEqual([10, 11, 12, 20]);
    expect(descendants(rows, 30)).toEqual([31]);
  });

  it("AC-39: kills a command and the child it started, and leaves the session's own process running; on Windows too", async () => {
    const root = spawn(process.execPath, ["-e", ROOT], { stdio: ["ignore", "pipe", "ignore"] });
    started.push(root);
    const { child, grand } = await readPids(root);
    expect(alive(child) && alive(grand)).toBe(true);
    const n = await killUnder(realProcessOps(), root.pid!);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await gone(child)).toBe(true);
    expect(await gone(grand)).toBe(true);
    expect(alive(root.pid!)).toBe(true);
  }, 30_000);
});

let proxyJs = "";
beforeAll(() => {
  proxyJs = path.join(tmpdir(), "proxy.js");
  buildSync({ entryPoints: [path.join(__dirname, "..", "src", "proxy", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: proxyJs, logLevel: "silent" });
});

describe("a host session's commands (FR-20)", () => {
  const policy = (role: string): RolePolicy => ({
    role, tools: ["Read", "Bash", "Monitor", "TaskStop"], read: { allow: ["**"], deny: [...SECRET_DENIES] },
    write: { allow: ["src/**"], deny: [] }, commands: [], network: [], mayRequest: [],
  });

  it("AC-39, AC-40: kills the session's commands on demand, and what it left running when it ends", async () => {
    const g = new HostGroup({
      host: { node: process.execPath, claude: async () => "/opt/claude" }, children: new Children(), runId: "run-c", project: "shop", proxyScript: proxyJs,
      homeRoot: tmpdir(), credential: { kind: "api_key", value: "sk-ant-real" }, maxPageBytes: 1024, env: { PATH: process.env.PATH ?? "" }, log: new MemoryLogger(),
      // The group starts its proxy through the same spawner: that one is real.
      spawner: ((bin: string, args: string[], o: object) => {
        if (args[0] === proxyJs) return spawn(bin, args, o);
        const p = spawn(process.execPath, ["-e", ROOT], { ...o, stdio: ["pipe", "pipe", "pipe"] });
        started.push(p);
        return p;
      }) as never,
    });
    await g.open();
    try {
      const a = await g.startAgent(policy("software-developer"), tmpdir(), { sessionVolume: "run" });
      const ac = new AbortController();
      const proc = a.spawn({ command: "claude", args: ["--setting-sources=", "--strict-mcp-config"], cwd: a.cwd, env: {}, signal: ac.signal }) as unknown as ChildProcess;
      const first = await readPids(proc);
      expect(await a.killCommands!()).toBeGreaterThanOrEqual(2);
      expect(await gone(first.child)).toBe(true);
      expect(await gone(first.grand)).toBe(true);
      expect(alive(proc.pid!)).toBe(true);

      // A second session leaves its command running; ending the session kills it.
      const b = await g.startAgent(policy("test-engineer"), tmpdir(), { sessionVolume: "run" });
      const proc2 = b.spawn({ command: "claude", args: ["--setting-sources=", "--strict-mcp-config"], cwd: b.cwd, env: {}, signal: new AbortController().signal }) as unknown as ChildProcess;
      const second = await readPids(proc2);
      await g.stopAgent(b);
      expect(await gone(second.child)).toBe(true);
      expect(await gone(second.grand)).toBe(true);
      ac.abort();
    } finally {
      await g.close();
    }
  }, 30_000);
});

describe("the session watchdog (FR-20)", () => {
  const CAPS: SessionCaps = { maxTurns: 50, maxOutputTokens: 10_000, wallTimeMs: 60_000 };
  const opts = () => sessionOptions({ policy: effectiveRole(policyDoc(), "requirements-analyst"), worktree: tmpdir(), instructions: "i", factoryServer: {}, factoryTools: [], caps: CAPS, skillsPluginDir: "/s", spawn: () => null as never, log: new MemoryLogger() }, new AbortController());

  // A session whose tool call answers only once its command is killed, as a Bash call does.
  function hungSdk(killed: Promise<void>): AgentSdk {
    return {
      createFactoryServer: () => ({}),
      query: () => (async function* () {
        yield { type: "assistant", session_id: "s", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "python smoke.py" } }], usage: { output_tokens: 5 } } } as SdkMessage;
        await killed;
        yield { type: "user", session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Killed", is_error: true }] } } as unknown as SdkMessage;
        yield { type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "The smoke test hung; moving on." }], usage: { output_tokens: 5 } } } as SdkMessage;
        yield { type: "result", subtype: "success", session_id: "s", num_turns: 2 } as SdkMessage;
      })(),
    };
  }

  it("AC-39: kills the session's commands when a tool call is silent past the limit, and the session carries on", async () => {
    let release!: () => void;
    const killed = new Promise<void>((r) => (release = r));
    let calls = 0;
    const out = await runSession(hungSdk(killed), opts(), oneTurn(), CAPS, {
      silenceMs: 60,
      onSilentTool: async () => {
        calls++;
        release();
        return 2;
      },
    });
    expect(calls).toBe(1);
    expect(out.status).toBe("complete");
  });

  it("does nothing while no tool call is open, however quiet the session is", async () => {
    let calls = 0;
    const sdk: AgentSdk = {
      createFactoryServer: () => ({}),
      query: () => (async function* () {
        yield { type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "thinking" }], usage: { output_tokens: 1 } } } as SdkMessage;
        await new Promise((r) => setTimeout(r, 300));
        yield { type: "result", subtype: "success", session_id: "s" } as SdkMessage;
      })(),
    };
    await runSession(sdk, opts(), oneTurn(), CAPS, { silenceMs: 30, onSilentTool: async () => (calls++, 0) });
    expect(calls).toBe(0);
  });
});

describe("background commands for build agents (FR-20, Role policy v2.11) and the repo's commands (FR-22)", () => {
  const sig = { signal: new AbortController().signal };
  const policy = (role: string, tools: RolePolicy["tools"]): RolePolicy => ({
    role, tools, read: { allow: ["**"], deny: [...SECRET_DENIES] }, write: { allow: ["src/**"], deny: [] }, commands: ["ls"], network: [], mayRequest: [],
  });

  it("AC-41: holds a Monitor command on the ask list for the owner, as Bash, and allows TaskStop only where listed", async () => {
    const wt = tmpdir();
    const asked: string[] = [];
    const host: HostGate = { ask: async (c) => (asked.push(c), false), askExtra: [] };
    const gate = toolGate(policy("software-developer", ["Bash", "Monitor", "TaskStop"]), wt, [], new MemoryLogger(), wt, false, host);
    expect((await gate("Monitor", { description: "tests", timeout_ms: 60_000, command: "npm test" }, sig)).behavior).toBe("allow");
    expect((await gate("Monitor", { description: "push", timeout_ms: 60_000, command: "git push origin x" }, sig)).behavior).toBe("deny");
    expect(asked).toEqual(["git push origin x"]);
    expect((await gate("Monitor", { description: "ws", timeout_ms: 60_000, ws: { url: "wss://x" } }, sig)).behavior).toBe("deny");
    expect((await gate("TaskStop", { task_id: "b1" }, sig)).behavior).toBe("allow");
    const plain = toolGate(policy("software-developer", ["Bash"]), wt, [], new MemoryLogger(), wt, false, host);
    expect((await plain("TaskStop", { task_id: "b1" }, sig)).behavior).toBe("deny");
    expect((await plain("Monitor", { description: "t", timeout_ms: 1, command: "ls" }, sig)).behavior).toBe("deny");
    // A role without a full shell keeps Monitor to its command list.
    const analystish = toolGate(policy("orchestrator", ["Monitor"]), wt, [], new MemoryLogger(), wt, false, host);
    expect((await analystish("Monitor", { description: "t", timeout_ms: 1, command: "npm test" }, sig)).behavior).toBe("deny");
    expect((await analystish("Monitor", { description: "t", timeout_ms: 1, command: "ls src" }, sig)).behavior).toBe("allow");
  });

  it("AC-41: tells a build agent with the background tools to run long or blocking commands in the background", () => {
    const facts = { feature: "F-1", title: "t", repo: "r", branch: "b", worktree: "/w", spec: "/s", folder: "/f", version: 1, commit: "c".repeat(40), stage: "build_and_test_prep" };
    for (const role of ["software-developer", "test-engineer"] as const) {
      expect(buildTurn(role, { ...facts, background: true })).toMatch(/in the background \(`Bash` with `run_in_background`\).*`TaskStop`.*silent for 10 minutes is killed/s);
      expect(buildTurn(role, facts)).not.toMatch(/run_in_background/);
    }
  });

  it("AC-44, AC-49: tells the build roles to test only with run_tests", () => {
    const facts = { feature: "F-1", title: "t", repo: "r", branch: "b", worktree: "/w", spec: "/s", folder: "/f", version: 1, commit: "c".repeat(40), stage: "build_and_test_prep" };
    for (const role of ["software-developer", "test-engineer"] as const) {
      const turn = buildTurn(role, { ...facts, runTests: { single: true } });
      expect(turn).toMatch(/Run tests only with the factory tool `run_tests`.*with `test` set to a test id.*A shell command that runs tests is refused/s);
      expect(turn.includes("criteria_map")).toBe(role === "test-engineer");
      expect(buildTurn(role, { ...facts, runTests: { single: false } })).not.toMatch(/with `test` set/);
      expect(buildTurn(role, facts)).not.toMatch(/run_tests/);
    }
  });
});
