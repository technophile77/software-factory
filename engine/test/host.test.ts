// H-0204 (ADR 0026): agent sessions on the owner's PC, not in containers.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { buildSync } from "esbuild";
import YAML from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HostError, HostGroup, hostEnv, hostSpawn, platformKey, resolveClaudeBinary, runHome, sweepHomes } from "../src/agent/host";
import type { AgentRuntime } from "../src/agent/runtime";
import type { SdkMessage } from "../src/agent/sdk";
import { FULL_SHELL_ROLES, type HostGate, editsFiles, WallTimer, toolGate } from "../src/agent/session";
import { CLAUDE_CODE_SHA256 } from "../src/constants";
import type { DockerCli } from "../src/docker/cli";
import { MemoryLogger } from "../src/log";
import { askMatch, programName, projectAsk, splitWords } from "../src/policy/ask";
import { type RolePolicy, SECRET_DENIES } from "../src/policy/role-policy";
import { Children } from "../src/proc";
import { EngineRecord } from "../src/state/record";
import { FakeDocker } from "./fakes";
import { RpcClient, type World, engineJson, makeWorld, manifestYaml, start, tmpdir } from "./helpers";
import { policyDoc } from "./policy-fixture";
import { templateSections } from "./template-spec";

const sig = { signal: new AbortController().signal };
const policy = (role: string, o: Partial<RolePolicy> = {}): RolePolicy => ({
  role, tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], read: { allow: ["**"], deny: [...SECRET_DENIES] },
  write: { allow: ["src/**"], deny: [] }, commands: ["ls"], network: [], mayRequest: [], ...o,
});

let proxyJs = "";
beforeAll(() => {
  const dir = tmpdir();
  proxyJs = path.join(dir, "proxy.js");
  buildSync({ entryPoints: [path.join(__dirname, "..", "src", "proxy", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: proxyJs, logLevel: "silent" });
});

describe("the ask rule's command matching (Role policy v2.7, F-015 SR-7)", () => {
  it("finds a listed program in any word, with folders, .exe/.cmd/.bat and case ignored", () => {
    expect(askMatch("gh pr list")).toBe("gh");
    expect(askMatch("npm test && GH.EXE auth token")).toBe("gh");
    expect(askMatch("C:\\Tools\\aws.cmd s3 ls")).toBe("aws");
    expect(askMatch("/usr/local/bin/kubectl get pods")).toBe("kubectl");
    expect(askMatch("env FOO=1 terraform apply")).toBe("terraform");
    expect(askMatch(`sh -c "docker ps"`)).toBe("docker");
    expect(askMatch("cat log | xargs ssh host")).toBe("ssh");
    expect(askMatch("g\\h auth token")).toBe("gh");
    expect(askMatch(`'g'"h" auth token`)).toBe("gh");
  });

  it("finds the publishing subcommands, options in between included", () => {
    expect(askMatch("git push origin main")).toBe("git push");
    expect(askMatch("git -C ../repo push")).toBe("git push");
    expect(askMatch("git remote add x https://example.com/r.git")).toBe("git remote");
    expect(askMatch("npm publish --access public")).toBe("npm publish");
    expect(askMatch("twine upload dist/*")).toBe("twine upload");
    expect(askMatch("cargo publish")).toBe("cargo publish");
  });

  it("counts a command it can't split as a match, and lets ordinary commands through", () => {
    expect(askMatch("echo `whoami`")).not.toBeNull();
    expect(askMatch("echo $(cat x)")).not.toBeNull();
    expect(askMatch(`echo "unclosed`)).not.toBeNull();
    expect(askMatch("npm test -- --reporter=junit")).toBeNull();
    expect(askMatch("git status && git diff")).toBeNull();
    expect(askMatch("ghost --help")).toBeNull();
  });

  it("adds a project's own programs and refuses a malformed list", () => {
    expect(askMatch("stripe charges list", ["stripe"])).toBe("stripe");
    expect(projectAsk({ policy: { ask: ["stripe"] } })).toEqual(["stripe"]);
    expect(projectAsk({})).toEqual([]);
    expect(() => projectAsk({ policy: { ask: ["rm -rf"] } })).toThrow(/program names/);
    expect(splitWords("a 'b c' d")).toEqual(["a", "b", "c", "d"]);
    expect(programName("C:\\x\\Docker.EXE")).toBe("docker");
  });
});

describe("the tool gate for sessions on the owner's PC", () => {
  const log = new MemoryLogger();
  const gateOf = (role: string, wt: string, h: Partial<HostGate> = {}, o: Partial<RolePolicy> = {}) => {
    const asked: string[] = [];
    const host: HostGate = { ask: async (c) => (asked.push(c), false), askExtra: [], ...h };
    return { gate: toolGate(policy(role, o), wt, [], log, wt, false, host), asked };
  };

  it("checks host paths, absolute or relative, under the path rule", async () => {
    const wt = tmpdir();
    fs.mkdirSync(path.join(wt, "src"));
    const { gate } = gateOf("software-developer", wt);
    expect((await gate("Write", { file_path: path.join(wt, "src", "a.ts") }, sig)).behavior).toBe("allow");
    expect((await gate("Write", { file_path: "src/b.ts" }, sig)).behavior).toBe("allow");
    expect((await gate("Write", { file_path: path.join(wt, "README.md") }, sig)).behavior).toBe("deny");
    expect((await gate("Read", { file_path: path.join(path.dirname(wt), "elsewhere.txt") }, sig)).behavior).toBe("deny");
    expect((await gate("Read", { file_path: "../escape" }, sig)).behavior).toBe("deny");
    expect((await gate("Read", { file_path: path.join(wt, ".env") }, sig)).behavior).toBe("deny");
  });

  it("lets a role read the approved spec folder outside its worktree, never write it (H-0192)", async () => {
    const wt = tmpdir();
    const specs = tmpdir();
    fs.writeFileSync(path.join(specs, "F-001-x.md"), "spec");
    fs.writeFileSync(path.join(specs, ".env"), "K=1");
    const { gate } = gateOf("test-engineer", wt, { readOnlyRoot: specs });
    expect((await gate("Read", { file_path: path.join(specs, "F-001-x.md") }, sig)).behavior).toBe("allow");
    expect((await gate("Grep", { path: specs }, sig)).behavior).toBe("allow");
    expect((await gate("Read", { file_path: path.join(specs, ".env") }, sig)).behavior).toBe("deny");
    expect((await gate("Write", { file_path: path.join(specs, "F-001-x.md") }, sig)).behavior).toBe("deny");
    expect((await gate("Edit", { file_path: path.join(specs, "F-001-x.md") }, sig)).behavior).toBe("deny");
  });

  it("gives the developer and test engineer a full shell, and keeps other roles to their command list", async () => {
    const wt = tmpdir();
    expect(FULL_SHELL_ROLES).toEqual(["software-developer", "test-engineer"]);
    for (const role of FULL_SHELL_ROLES) {
      const { gate } = gateOf(role, wt);
      expect((await gate("Bash", { command: "npm ci && npm test | tee out.txt" }, sig)).behavior).toBe("allow");
    }
    const { gate } = gateOf("requirements-analyst", wt);
    expect((await gate("Bash", { command: "npm test" }, sig)).behavior).toBe("deny");
    expect((await gate("Bash", { command: "ls | cat" }, sig)).behavior).toBe("deny");
    expect((await gate("Bash", { command: "ls src" }, sig)).behavior).toBe("allow");
  });

  it("a refused command the engine can't split tells the agent to use the file tools", async () => {
    const wt = tmpdir();
    const { gate } = gateOf("test-engineer", wt);
    const r = await gate("Bash", { command: "cd fix && cat $(ls tests/*.py | head -1)" }, sig);
    expect(r.behavior).toBe("deny");
    expect((r as { message: string }).message).toMatch(/not done\. Read files with Read, search them with Grep, and change them with Edit or Write/);
    const plain = await gate("Bash", { command: "gh pr create" }, sig);
    expect((plain as { message: string }).message).not.toMatch(/Edit or Write/);
  });

  // Role policy v2.14: the shell edits F-004's and F-005's agents tried on 2026-11-27, and commands that only look alike.
  const SHELL_EDITS = [
    "cd \"C:/b/F-004/fix\" && python - <<'E'\np='tests/f004_harness.py'\ns=open(p,encoding='utf-8').read()\nE",
    "mkdir -p tests/contract && cat > tests/contract/portal_schema.json <<'EOF'\n{}\nEOF",
    "cat > test/f002.acceptance.test.js <<EOF\n'use strict';\nEOF",
    "cat <<-\"END\" > a.txt\n\tx\nEND",
    "sed -i -E '/^def test_.*\\(sandbox/ s/^/@needs_flock\\n/' test_f004_job.py",
    "sed -i.bak 's/a/b/' x.py",
    "sed -E -i 's/a/b/' x.py",
    "sed --in-place 's/a/b/' x.py",
    "git status; /usr/bin/sed -i 's/a/b/' x.py",
    "perl -pi -e 's/a/b/' x.py",
    "perl -i.orig -pe 's/a/b/' x.py",
  ];
  const NOT_EDITS = [
    "sed -n 1,120p tests/f004_harness.py",
    "sed -E 's/i/I/' x.py | head",
    "perl -Mstrict -ne 'print if /x/' x.py",
    "python -I -c \"import json;json.load(open('a.json'))\"",
    "grep -n \"a << b\" main.py",
    "python3 - <<< 'print(1)'",
    "git log --oneline -5",
  ];

  it("refuses a shell edit at once, without asking the owner, from a role that has Edit or Write (Role policy v2.14)", async () => {
    const wt = tmpdir();
    const { gate, asked } = gateOf("test-engineer", wt);
    for (const command of SHELL_EDITS) {
      expect(editsFiles(command), command).toBe(true);
      const r = await gate("Bash", { command }, sig);
      expect(r.behavior, command).toBe("deny");
      expect((r as { message: string }).message).toMatch(/changes files through the shell\. Change a file with Edit.*refuses those at once/);
      expect((await gate("Monitor", { command }, sig)).behavior).toBe("deny");
    }
    expect(asked).toEqual([]);
    for (const command of NOT_EDITS) expect(editsFiles(command), command).toBe(false);
    expect((await gate("Bash", { command: "sed -n 1,40p tests/x.py" }, sig)).behavior).toBe("allow");
    // A role with no Edit or Write has no file tool to point to, so the rule leaves it to the ask rule as before.
    const reader = gateOf("software-developer", wt, {}, { tools: ["Read", "Grep", "Bash"] });
    for (const command of SHELL_EDITS) expect(JSON.stringify(await reader.gate("Bash", { command }, sig))).not.toMatch(/changes files through the shell/);
  });

  it("a file tool refused outside the worktree says where to work instead of a shell command", async () => {
    const wt = tmpdir();
    const { gate } = gateOf("software-developer", wt);
    // F-005's developer tried to Read the CLI's saved copy of a long command output, then fell back to `cat`.
    const r = await gate("Read", { file_path: path.join(path.dirname(wt), "tool-results", "b1.txt") }, sig);
    expect(r.behavior).toBe("deny");
    expect((r as { message: string }).message).toMatch(/outside the worktree\. Work on files in your worktree.*don't reach such paths with a shell command.*Read the file it came from with offset and limit/);
    const w = await gate("Write", { file_path: "/tmp/msa/sc" }, sig);
    expect((w as { message: string }).message).toMatch(/don't keep scratch files anywhere else/);
  });

  it("holds a listed command for the owner once, though Claude Code checks it twice, and runs it only on approval", async () => {
    const wt = tmpdir();
    const denied = gateOf("software-developer", wt);
    const r1 = await denied.gate("Bash", { command: "gh pr create" }, sig);
    const r2 = await denied.gate("Bash", { command: "gh pr create" }, sig);
    expect(r1.behavior).toBe("deny");
    expect(r2.behavior).toBe("deny");
    expect(denied.asked).toEqual(["gh pr create"]);
    expect((r1 as { message: string }).message).toMatch(/not done/);

    let n = 0;
    const ok = gateOf("software-developer", wt, { ask: async () => (n++, true) });
    expect((await ok.gate("Bash", { command: "git push" }, sig)).behavior).toBe("allow");
    expect((await ok.gate("Bash", { command: "git push" }, sig)).behavior).toBe("allow");
    // A third call is a new command: the owner is asked again.
    expect((await ok.gate("Bash", { command: "git push" }, sig)).behavior).toBe("allow");
    expect(n).toBe(2);

    const extra = gateOf("software-developer", wt, { askExtra: ["stripe"] });
    expect((await extra.gate("Bash", { command: "stripe login" }, sig)).behavior).toBe("deny");
  });

  it("passes the tool call's signal to the ask, so an ended call denies the held command", async () => {
    const wt = tmpdir();
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const { gate } = gateOf("software-developer", wt, { ask: async (_c, _m, signal) => ((seen = signal), !signal?.aborted) });
    ac.abort();
    expect((await gate("Bash", { command: "git push" }, { signal: ac.signal })).behavior).toBe("deny");
    expect(seen).toBe(ac.signal);
  });
});

describe("the session wall-time cap can be held while the owner answers", () => {
  it("doesn't count held time", async () => {
    let t = 0;
    let fired = false;
    const w = new WallTimer(50, () => (fired = true), () => t);
    w.start();
    const release = w.hold();
    t = 40;
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(true);
    w.stop();
  });
});

describe("Claude Code on the PC: the pinned binary, its environment and its process", () => {
  it("pins the same hashes as the SDK's manifest", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "manifest.json"), "utf8")) as { platforms: Record<string, { checksum: string }> };
    for (const [k, v] of Object.entries(CLAUDE_CODE_SHA256)) expect(manifest.platforms[k]?.checksum, k).toBe(v);
  });

  it("runs only a binary with the pinned hash", async () => {
    const key = platformKey();
    if (CLAUDE_CODE_SHA256[key] && fs.existsSync(path.join(__dirname, "..", "node_modules", "@anthropic-ai", `claude-agent-sdk-${key}`))) {
      expect(await resolveClaudeBinary()).toContain(`claude-agent-sdk-${key}`);
    }
    const fake = tmpdir();
    fs.writeFileSync(path.join(fake, "claude"), "not claude");
    await expect(resolveClaudeBinary({ platform: "linux", arch: "x64", resolve: () => path.join(fake, "package.json") })).rejects.toThrow(/pinned SHA-256/);
    await expect(resolveClaudeBinary({ platform: "linux", arch: "x64", resolve: () => { throw new Error("no"); } })).rejects.toThrow(/npm ci/);
    await expect(resolveClaudeBinary({ platform: "aix", arch: "ppc64" })).rejects.toThrow(HostError);
  });

  it("gives a session nothing of the engine's environment but PATH and the basics, and its own home", () => {
    const from = { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "sk-real", SSH_AUTH_SOCK: "/tmp/a", LANG: "en_GB.UTF-8", SystemRoot: "C:\\Windows" };
    const shell = hostEnv({ from, platform: "linux", home: "/h/run", port: 4000, cred: "c1", fullShell: true });
    expect(shell.PATH).toBe("/usr/bin");
    expect(shell.LANG).toBe("en_GB.UTF-8");
    expect(shell.GITHUB_TOKEN).toBeUndefined();
    expect(shell.SSH_AUTH_SOCK).toBeUndefined();
    expect(shell.SystemRoot).toBeUndefined();
    expect(shell.ANTHROPIC_API_KEY).not.toBe("sk-real");
    expect(shell.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000/gw/c1");
    expect(shell.HOME).toBe("/h/run");
    expect(shell.CLAUDE_CONFIG_DIR).toBe(path.join("/h/run", ".claude"));
    expect(shell.HTTPS_PROXY).toBeUndefined();
    const reader = hostEnv({ from, platform: "win32", home: "C:\\h", port: 4000, cred: "c2", fullShell: false });
    expect(reader.HTTPS_PROXY).toBe("http://factory:c2@127.0.0.1:4000");
    expect(reader.SystemRoot).toBe("C:\\Windows");
    expect(reader.USERPROFILE).toBe("C:\\h");
  });

  it("refuses bypass modes and missing fixed options, and keeps only the SDK's protocol variables", () => {
    const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawner = ((bin: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
      calls.push({ bin, args, env: o.env });
      return Object.assign(new (require("node:events").EventEmitter)(), { pid: undefined, stderr: null, kill: () => true });
    }) as unknown as typeof spawn;
    const sp = hostSpawn({ bin: "/opt/claude", cwd: "/w", env: { HOME: "/h" }, children: new Children(), platform: "linux", spawner });
    const signal = new AbortController().signal;
    const ok = ["--setting-sources=", "--strict-mcp-config"];
    expect(() => sp({ command: "x", args: [...ok, "--dangerously-skip-permissions"], env: {}, signal })).toThrow(/bypass/);
    expect(() => sp({ command: "x", args: ["--strict-mcp-config"], env: {}, signal })).toThrow(/setting-sources/);
    sp({ command: "/somewhere/else/claude", args: ok, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", GITHUB_TOKEN: "x" }, signal });
    expect(calls[0]!.bin).toBe("/opt/claude");
    expect(calls[0]!.env).toEqual({ HOME: "/h", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
  });

  it.skipIf(process.platform !== "linux")("logs the end of stderr when Claude Code exits with an error, so a failure at start says why", async () => {
    const log = new MemoryLogger();
    const sp = hostSpawn({ bin: "/bin/sh", cwd: tmpdir(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, children: new Children(), log, name: "run-1-security-reviewer-1" });
    const child = sp({ command: "x", args: ["-c", "printf 'Error: --json-schema is not a valid JSON Schema\\033[0m' >&2; exit 1", "--setting-sources=", "--strict-mcp-config"], env: {}, signal: new AbortController().signal }) as unknown as import("node:child_process").ChildProcess;
    await new Promise((r) => child.once("close", r));
    expect(log.lines.map((l) => l.message)).toContain("run-1-security-reviewer-1: Claude Code exited with code 1; it said: Error: --json-schema is not a valid JSON Schema");
  });

  it.skipIf(process.platform !== "linux")("kills the whole process tree when the session is aborted", async () => {
    const ab = new AbortController();
    const children = new Children();
    const sp = hostSpawn({ bin: "/bin/sh", cwd: tmpdir(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, children });
    const child = sp({ command: "x", args: ["-c", "sleep 30 & sleep 30", "--setting-sources=", "--strict-mcp-config"], env: {}, signal: ab.signal }) as unknown as import("node:child_process").ChildProcess;
    await new Promise((r) => setTimeout(r, 200));
    expect(children.startedByEngine(child.pid!)).toBe(true);
    ab.abort();
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => setTimeout(r, 200));
    // Killed processes nobody reaps stay as zombies in a container whose init doesn't wait for them; only live ones count.
    const live = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).filter((n) => {
      try {
        const st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
        const rest = st.slice(st.lastIndexOf(")") + 2).split(" ");
        return Number(rest[2]) === child.pid && rest[0] !== "Z";
      } catch {
        return false;
      }
    });
    expect(live).toEqual([]);
  });
});

describe("a run's sessions on the PC (HostGroup)", () => {
  const groups: HostGroup[] = [];
  afterEach(async () => {
    for (const g of groups) await g.close();
    groups.length = 0;
  });

  const make = (root: string, runId = "run-1") => {
    const g = new HostGroup({
      host: { node: process.execPath, claude: async () => "/opt/claude" }, children: new Children(), runId, project: "shop", proxyScript: proxyJs,
      homeRoot: root, credential: { kind: "api_key", value: "sk-ant-real" }, maxPageBytes: 1024, env: { PATH: "/usr/bin" }, log: new MemoryLogger(),
    });
    groups.push(g);
    return g;
  };

  const status = (port: number, cred: string) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: `/gw/${cred}/v1/models`, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

  it("runs the proxy on 127.0.0.1, gives each session its own credential and home, and refuses a revoked or unknown one", async () => {
    const root = tmpdir();
    const g = make(root);
    await g.open();
    const wt = tmpdir();
    const a = await g.startAgent(policy("software-developer"), wt, { sessionVolume: "run" });
    expect(a.host).toBe(true);
    expect(a.cwd).toBe(wt);
    expect(a.workspace).toBe(wt);
    const home = runHome(root, "run-1");
    expect(fs.statSync(path.join(home, "tmp")).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(home).mode & 0o077).toBe(0);
    const port = (g as unknown as { port: number }).port;
    expect(port).toBeGreaterThan(0);
    expect(await status(port, "not-a-credential")).toBeGreaterThanOrEqual(400);
    await g.stopAgent(a);
    // The run's home stays for a resume; a session-only home goes with its session.
    expect(fs.existsSync(home)).toBe(true);
    const b = await g.startAgent(policy("requirements-analyst"), null, { sessionVolume: true });
    const bHome = path.join(root, "run-1-requirements-analyst-2");
    expect(fs.existsSync(bHome)).toBe(true);
    expect(b.cwd).toBe(path.join(bHome, "tmp"));
    await g.stopAgent(b);
    expect(fs.existsSync(bHome)).toBe(false);
  });

  it("leaves endpoint sessions and report folders to containers", async () => {
    const g = make(tmpdir(), "run-2");
    await g.open();
    await expect(g.startAgent(policy("security-reviewer"), tmpdir(), { upstream: "qwen" })).rejects.toThrow(/container/);
    await expect(g.startAgent(policy("security-reviewer"), tmpdir(), { reportDir: { source: "/a", target: "/workspace/.factory/x" } })).rejects.toThrow(/container/);
  });

  it("sweeps homes of runs that can't resume", () => {
    const root = tmpdir();
    for (const n of ["keep-1", "gone-1", "gone-1-requirements-analyst-1"]) fs.mkdirSync(path.join(root, n));
    sweepHomes(root, new Set(["keep-1"]), new MemoryLogger());
    expect(fs.readdirSync(root)).toEqual(["keep-1"]);
    expect(() => runHome(root, "../x")).toThrow(/bad run id/);
  });
});

describe("the engine runs the analyst on the PC (H-0204)", () => {
  const engines: Array<{ stop(): Promise<void> }> = [];
  const clients: RpcClient[] = [];
  afterEach(async () => {
    for (const c of clients) c.close();
    for (const e of engines) await e.stop();
    engines.length = 0;
    clients.length = 0;
  });

  it("starts no container and builds no image; the session runs in the worktree with a home the run ends with", async () => {
    const w: World = makeWorld({ manifest: manifestYaml({ extra: YAML.stringify({ policy: policyDoc().policy }) }) });
    const d = new FakeDocker();
    let feature = "";
    const cwds: string[] = [];
    const sdk = {
      createFactoryServer: () => ({ factory: true }),
      query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { cwd: string } }) => (async function* (): AsyncGenerator<SdkMessage> {
        cwds.push(options.cwd);
        const it = prompt[Symbol.asyncIterator]();
        await it.next();
        yield { type: "system", subtype: "init", session_id: "s-1" };
        const wt = new EngineRecord(w.home).runs().find((r) => r.feature === feature)!.worktree!;
        fs.mkdirSync(path.join(wt, "docs", "features"), { recursive: true });
        fs.writeFileSync(path.join(wt, "docs", "features", `${feature}-export.md`), [`# Feature: Export`, "", `- **Id:** ${feature}`, "- **Spec version:** 1", "", ...templateSections()].join("\n"));
        yield { type: "result", subtype: "error_max_turns", session_id: "s-1", num_turns: 1 };
      })(),
    };
    const rt: AgentRuntime = {
      docker: d as unknown as DockerCli, sdk: async () => sdk as never, dockerDir: path.join(__dirname, "..", "docker"), proxyScript: proxyJs, platform: process.platform,
      host: { node: process.execPath, claude: async () => "/opt/claude" },
    };
    const e = await start(w, { agents: rt });
    engines.push(e);
    const c = await RpcClient.connect(engineJson(w).path);
    clients.push(c);
    feature = (await c.ok("feature.start", { request: "Export orders as CSV" })).feature as string;
    const runOf = () => new EngineRecord(w.home).runs().find((r) => r.feature === feature);
    const end = Date.now() + 20_000;
    while (runOf()?.status !== "failed" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(runOf()?.status).toBe("failed");
    expect(cwds).toEqual([runOf()!.worktree]);
    expect(d.calls.filter((x) => ["run", "buildx", "build", "exec"].includes(x.args[0]!))).toEqual([]);
    expect(fs.existsSync(runHome(path.join(w.home, "sessions"), runOf()!.id))).toBe(false);
  });
});
