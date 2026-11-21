import { type ChildProcess, spawn } from "node:child_process";
import type { ProjectMcpSession } from "./project-mcp";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_CODE_SHA256 } from "../constants";
import { ensureOwnerDir } from "../fsutil";
import type { Logger } from "../log";
import type { RolePolicy } from "../policy/role-policy";
import { type Children, killTree } from "../proc";
import { type ProcessOps, killUnder, realProcessOps } from "./commands";
import type { ModelCredential } from "../proxy/server";
import { type AgentContainer, type AgentGroup, DUMMY_KEY, ProxyClient, type StartAgentOptions } from "./sandbox";
import type { SpawnOptions, SpawnedProcess } from "./sdk";
import { CONTAINER_FLAGS, FULL_SHELL_ROLES } from "./session";

/** Everything the engine needs to run agent sessions on the owner's PC (ADR 0026, H-0204). */
export interface HostRuntime {
  /** Claude Code from the SDK's platform package, checked against its pinned hash (`resolveClaudeBinary`). */
  claude(): Promise<string>;
  /** This Node, which runs the bundled proxy. */
  node: string;
}

export class HostError extends Error {
  override name = "HostError";
}

/** The SDK platform package's key for this machine, as the SDK's own manifest names it. */
export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

/**
 * Claude Code for this machine: the binary the Agent SDK pins, found in its
 * platform package and checked against the SHA-256 this engine pins
 * (CLAUDE_CODE_SHA256, copied from the SDK's manifest). The engine runs only
 * that file; the SDK's own `command` is never used.
 */
export async function resolveClaudeBinary(o: { platform?: NodeJS.Platform; arch?: string; resolve?: (id: string) => string } = {}): Promise<string> {
  const key = platformKey(o.platform, o.arch);
  const want = CLAUDE_CODE_SHA256[key];
  if (!want) throw new HostError(`Claude Code has no pinned build for ${key}`);
  let pkg: string;
  try {
    pkg = path.dirname((o.resolve ?? require.resolve)(`@anthropic-ai/claude-agent-sdk-${key}/package.json`));
  } catch {
    throw new HostError(`the Agent SDK's package for ${key} isn't installed: run npm ci in engine/`);
  }
  const bin = path.join(pkg, (o.platform ?? process.platform) === "win32" ? "claude.exe" : "claude");
  const got = await new Promise<string>((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(bin).on("error", reject).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
  }).catch(() => null);
  if (got !== want) throw new HostError(got === null ? `Claude Code wasn't found at ${bin}` : "Claude Code doesn't match its pinned SHA-256; reinstall the engine's packages");
  return bin;
}

/** Variables the SDK sets for its CLI protocol, the only ones taken from its env. */
const SDK_ENV = new Set(["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE", ...Object.keys(CONTAINER_FLAGS)]);
const REQUIRED_ARGS = ["--setting-sources=", "--strict-mcp-config"];
const FORBIDDEN_ARGS = /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions)$|^bypassPermissions$/;

/** What a Windows process needs to start at all, and nothing else of the engine's environment. */
const WINDOWS_BASE = ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "windir", "WINDIR"];
/** Locale and terminal settings the owner's tools read. No credentials. */
const SHELL_PASS = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];

/**
 * The environment of one session's Claude Code: the fixed flags, the
 * gateway with this session's credential, a home of its own (so the owner's
 * `~/.claude` is never read), the owner's PATH so tools resolve, and nothing
 * else of the engine's. Roles with a full shell aren't sent through the
 * egress proxy: their commands reach the network as the owner's would (SR-1).
 */
export function hostEnv(o: { from: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; port: number; cred: string; fullShell: boolean }): Record<string, string> {
  const env: Record<string, string> = { ...CONTAINER_FLAGS };
  const take = (k: string) => {
    const v = o.from[k];
    if (typeof v === "string") env[k] = v;
  };
  for (const k of ["PATH", "Path"]) take(k);
  if (o.platform === "win32") for (const k of WINDOWS_BASE) take(k);
  for (const k of SHELL_PASS) take(k);
  const tmp = path.join(o.home, "tmp");
  Object.assign(env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${o.port}/gw/${o.cred}`,
    ANTHROPIC_API_KEY: DUMMY_KEY,
    HOME: o.home,
    CLAUDE_CONFIG_DIR: path.join(o.home, ".claude"),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
  });
  if (o.platform === "win32") Object.assign(env, { USERPROFILE: o.home, APPDATA: path.join(o.home, "AppData", "Roaming"), LOCALAPPDATA: path.join(o.home, "AppData", "Local") });
  if (!o.fullShell) Object.assign(env, { HTTPS_PROXY: `http://factory:${o.cred}@127.0.0.1:${o.port}`, NO_PROXY: "127.0.0.1" });
  return env;
}

/** What a local MCP server starts from (F-025 FR-8): PATH, the Windows basics and locale, nothing else of the engine's. */
export function mcpBaseEnv(from: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = {};
  const take = (k: string) => {
    if (typeof from[k] === "string") env[k] = from[k]!;
  };
  for (const k of ["PATH", "Path", ...SHELL_PASS]) take(k);
  if (platform === "win32") for (const k of WINDOWS_BASE) take(k);
  return env;
}

/**
 * Starts Claude Code on the owner's PC for one session (ADR 0026): the
 * pinned binary by absolute path, no shell, the session's own environment,
 * its working folder. Arguments asking for a bypass permission mode, or
 * missing SR-10's fixed options, are refused. The process and everything it
 * starts are killed when the session is aborted, and the engine's channel
 * refuses them all (channel v1.1).
 */
export function hostSpawn(o: { bin: string; cwd: string; env: Record<string, string>; children: Children; platform?: NodeJS.Platform; spawner?: typeof spawn; onPid?(pid: number): void }): (s: SpawnOptions) => SpawnedProcess {
  return (s) => {
    if (s.args.some((a) => FORBIDDEN_ARGS.test(a) || a === "--permission-mode=bypassPermissions")) throw new HostError("refused: a bypass permission mode");
    for (const r of REQUIRED_ARGS) if (!s.args.includes(r)) throw new HostError(`refused: the CLI arguments lack ${r}`);
    const env: Record<string, string> = { ...o.env };
    for (const [k, v] of Object.entries(s.env)) if (SDK_ENV.has(k) && typeof v === "string") env[k] = v;
    const platform = o.platform ?? process.platform;
    const child = (o.spawner ?? spawn)(o.bin, s.args, {
      cwd: o.cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      // Its own process group on POSIX, so the whole tree can be killed at once.
      detached: platform !== "win32",
    });
    const pid = child.pid;
    if (pid) {
      o.children.add(pid);
      child.once("exit", () => o.children.remove(pid));
      o.onPid?.(pid);
    }
    child.stderr?.resume();
    const kill = () => killTree(child, platform);
    if (s.signal.aborted) kill();
    else s.signal.addEventListener("abort", kill, { once: true });
    return child as unknown as SpawnedProcess;
  };
}

export interface HostGroupConfig {
  host: HostRuntime;
  /** The engine's own process list: the channel refuses every process a session starts (channel v1.1). */
  children: Children;
  runId: string;
  project: string;
  /** The bundled proxy (dist/proxy.js). */
  proxyScript: string;
  /** Engine-owned folder holding each run's session home. */
  homeRoot: string;
  credential: ModelCredential;
  maxPageBytes: number;
  /** The engine's environment: PATH and the Windows basics are taken from it, nothing else. */
  env: NodeJS.ProcessEnv;
  log: Logger;
  platform?: NodeJS.Platform;
  /** Tests replace the processes. */
  spawner?: typeof spawn;
  /** F-015 FR-20: how a session's commands are found and killed; tests replace it. */
  processes?: ProcessOps;
  /** F-025: the project MCP servers a role's session gets; absent when the project declares none. */
  mcp?(policy: RolePolicy, at: { cwd: string; baseEnv: Record<string, string>; proxyEnv: Record<string, string> }): Promise<ProjectMcpSession>;
}

const RUN_ID_RE = /^[A-Za-z0-9-]{1,100}$/;

/** A run's session home under `root`, kept across resumes until the run ends. */
export function runHome(root: string, runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new HostError("bad run id");
  return path.join(root, runId);
}

/**
 * One run's sessions on the owner's PC (ADR 0026, H-0204): the egress proxy
 * as a local process listening on 127.0.0.1 only, holding the model
 * credential, and each session's Claude Code as a child process with its own
 * home folder and gateway credential. There is no boundary around the
 * session but the tool gate and the end-of-session write check; the owner
 * accepted that until Beta.
 */
export class HostGroup implements AgentGroup {
  private proxy: ProxyClient | null = null;
  private proxyChild: ChildProcess | null = null;
  private port = 0;
  private seq = 0;
  private readonly agents = new Map<string, AgentContainer & { home: string; temp: boolean; pids: number[] }>();
  private toldMcpJson = false;

  constructor(private readonly c: HostGroupConfig) {
    if (!RUN_ID_RE.test(c.runId)) throw new HostError("bad run id");
  }

  deadlineHit(): boolean {
    return false;
  }

  async open(): Promise<void> {
    const platform = this.c.platform ?? process.platform;
    const env: Record<string, string> = {};
    // Node on Windows needs SystemRoot for its network stack; nothing else of the engine's environment goes in.
    if (platform === "win32") for (const k of ["SystemRoot", "SYSTEMROOT"]) if (typeof this.c.env[k] === "string") env[k] = this.c.env[k]!;
    const child = (this.c.spawner ?? spawn)(this.c.host.node, [this.c.proxyScript], { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid) {
      const pid = child.pid;
      this.c.children.add(pid);
      child.once("exit", () => this.c.children.remove(pid));
    }
    child.stderr?.resume();
    this.proxyChild = child;
    this.proxy = new ProxyClient(child, this.c.log);
    try {
      const ready = await this.proxy.start({
        t: "start", listen: "loopback", internalSubnet: "127.0.0.1/32", credential: this.c.credential, dummyKey: DUMMY_KEY, blockedSubnets: [], maxPageBytes: this.c.maxPageBytes,
      });
      if (ready.address !== "127.0.0.1" || !Number.isInteger(ready.port) || ready.port <= 0) throw new HostError("the proxy isn't listening on 127.0.0.1");
      this.port = ready.port;
    } catch (e) {
      child.kill("SIGKILL");
      throw e instanceof HostError ? e : new HostError(`the proxy didn't start (${(e as Error).message.slice(0, 200)})`);
    }
  }

  async startAgent(policy: RolePolicy, worktree: string | null, o: StartAgentOptions = {}): Promise<AgentContainer> {
    if (!this.proxy) throw new HostError("the group isn't open");
    const bin = await this.c.host.claude();
    // Endpoint runs stay in containers beside the router (H-0204 decision b); report folders are a container mount.
    if (o.upstream !== undefined) throw new HostError("a model endpoint session runs in a container, not on the PC");
    if (o.reportDir) throw new HostError("a report folder is a container mount; on the PC a role returns its report as structured output");
    const platform = this.c.platform ?? process.platform;
    const n = ++this.seq;
    const name = `${this.c.runId}-${policy.role}-${n}`;
    ensureOwnerDir(this.c.homeRoot);
    const keep = o.sessionVolume === "run";
    const home = keep ? runHome(this.c.homeRoot, this.c.runId) : path.join(this.c.homeRoot, name);
    if (!keep) fs.rmSync(home, { recursive: true, force: true });
    ensureOwnerDir(home);
    ensureOwnerDir(path.join(home, "tmp"));
    const cred = crypto.randomBytes(32).toString("base64url");
    const fullShell = FULL_SHELL_ROLES.includes(policy.role);
    const env = hostEnv({ from: this.c.env, platform, home, port: this.port, cred, fullShell });
    const cwd = worktree ?? path.join(home, "tmp");
    // F-025 FR-14: --strict-mcp-config already ignores it; the owner hears once that it has no effect.
    if (worktree && !this.toldMcpJson && fs.existsSync(path.join(worktree, ".mcp.json"))) {
      this.toldMcpJson = true;
      this.c.log.info(`${this.c.project}: the worktree has a .mcp.json; sessions never read it. Project MCP servers go in the manifest's mcp_servers (F-025).`);
    }
    const proxyEnv: Record<string, string> = {};
    for (const k of ["HTTPS_PROXY", "NO_PROXY"]) if (env[k] !== undefined) proxyEnv[k] = env[k]!;
    // Before the grant: a server that can't be given to the session stops it here, with nothing to revoke (FR-10).
    const projectMcp = policy.mcp?.length && this.c.mcp ? await this.c.mcp(policy, { cwd, baseEnv: mcpBaseEnv(this.c.env, platform), proxyEnv }) : undefined;
    // FR-9: an allowed remote server's host, for this session only; the grant goes with the session's credential.
    const allow = policy.network.includes("*") ? policy.network : [...new Set([...policy.network, ...(projectMcp?.hosts ?? [])])];
    this.proxy.send({ t: "grant", cred, session: name, role: policy.role, allow, webSearch: policy.role === "web-reader" && policy.tools.includes("WebSearch") });
    const pids: number[] = [];
    const ops = this.c.processes ?? realProcessOps(platform);
    const a = {
      name, role: policy.role, cred, cwd, workspace: worktree ?? cwd, host: true, home, temp: !keep, pids, ...(projectMcp ? { projectMcp } : {}),
      spawn: hostSpawn({ bin, cwd, env, children: this.c.children, platform, onPid: (pid) => pids.push(pid), ...(this.c.spawner ? { spawner: this.c.spawner } : {}) }),
      killCommands: async () => {
        let n = 0;
        for (const pid of pids) n += await killUnder(ops, pid).catch(() => 0);
        return n;
      },
    };
    this.agents.set(name, a);
    return a;
  }

  fetch(a: AgentContainer, url: string): ReturnType<ProxyClient["fetch"]> {
    if (!this.proxy || !this.agents.has(a.name)) throw new HostError("no such session");
    return this.proxy.fetch(a.cred, url);
  }

  /** Ends a session: its credential is dropped at once; a home made for this session only goes with it. */
  async stopAgent(a: AgentContainer): Promise<void> {
    this.proxy?.send({ t: "revoke", cred: a.cred });
    const mine = this.agents.get(a.name);
    this.agents.delete(a.name);
    if (mine) {
      // F-015 FR-20 (c): what the session left running goes with it. Windows keeps an orphan's parent pid; POSIX keeps its process group.
      const left = await mine.killCommands!().catch(() => 0);
      const ops = this.c.processes ?? realProcessOps(this.c.platform ?? process.platform);
      for (const pid of mine.pids) ops.killGroup?.(pid);
      if (left) this.c.log.info(`${a.name}: killed ${left} process(es) the session left running`);
    }
    if (mine?.temp) fs.rmSync(mine.home, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    for (const a of [...this.agents.values()]) await this.stopAgent(a);
    this.proxyChild?.stdin?.end();
    const child = this.proxyChild;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.proxyChild = null;
    this.proxy = null;
  }
}

/**
 * At engine start: session homes left by runs that can't resume are
 * removed, since their files are sensitive; an interrupted run's home stays
 * so the run can resume its SDK session.
 */
export function sweepHomes(root: string, keep: Set<string>, log: Logger): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const n of names) {
    if (keep.has(n)) continue;
    fs.rmSync(path.join(root, n), { recursive: true, force: true });
    log.info(`removed leftover session home ${n}`);
  }
}
