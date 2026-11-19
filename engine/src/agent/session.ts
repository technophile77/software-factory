import * as fs from "node:fs";
import * as path from "node:path";
import type { DockerCli } from "../docker/cli";
import type { Logger } from "../log";
import { OutsideWorktree, allowedBy, readableBy, worktreeRelative } from "../policy/glob";
import { askMatch, projectAsk } from "../policy/ask";
import type { RolePolicy } from "../policy/role-policy";
import type { AgentSdk, CanUseTool, FactoryTool, PreToolUseHook, SdkMessage, SessionOptions, SpawnOptions, SpawnedProcess, UserTurn } from "./sdk";

/** Where the worktree is mounted in every agent container. */
export const WORKSPACE = "/workspace";
/** Claude Code inside the agent image; the SDK's own `command` (a host path) is never run. */
export const CLAUDE_BIN = "/opt/claude/claude";
export const AGENT_USER = "1000:1000";
export const FACTORY_SERVER = "factory";

/** Off in the container (SR-10). */
export const CONTAINER_FLAGS: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** SR-18 session caps. All come from change-controlled config; the engine has no defaults. */
export interface SessionCaps {
  maxTurns: number;
  /** At least one of these two. */
  maxOutputTokens?: number;
  maxBudgetUsd?: number;
  wallTimeMs: number;
}

export function checkCaps(c: SessionCaps): void {
  const pos = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!pos(c.maxTurns) || !Number.isSafeInteger(c.maxTurns)) throw new Error("caps.maxTurns must be a positive integer");
  if (!pos(c.wallTimeMs)) throw new Error("caps.wallTimeMs must be positive");
  if (c.maxOutputTokens === undefined && c.maxBudgetUsd === undefined) throw new Error("caps need maxOutputTokens or maxBudgetUsd");
  if (c.maxOutputTokens !== undefined && (!pos(c.maxOutputTokens) || !Number.isSafeInteger(c.maxOutputTokens))) throw new Error("caps.maxOutputTokens must be a positive integer");
  if (c.maxBudgetUsd !== undefined && !pos(c.maxBudgetUsd)) throw new Error("caps.maxBudgetUsd must be positive");
}

const READ_TOOLS: Record<string, string> = { Read: "file_path", Grep: "path", Glob: "path" };
const WRITE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path" };
const SHELL_SYNTAX = /[;&|`$<>()\\\n\r]/;

/** A container path (or one relative to the workspace) as a worktree-relative path under the ADR 0015 rule, or null if it leaves the worktree. */
export function hostRelative(worktree: string, p: unknown, workspace: string = WORKSPACE): string | null {
  if (p === undefined) return "";
  if (typeof p !== "string" || p.includes("\0")) return null;
  let host: string;
  if (workspace !== WORKSPACE) {
    // A session on the owner's PC (ADR 0026) names host paths: absolute ones as they are, relative ones from its worktree.
    host = path.isAbsolute(p) ? p : path.join(worktree, p);
  } else {
    if (p.includes("\\")) return null;
    let rel: string;
    if (p.startsWith("/")) {
      if (p !== workspace && !p.startsWith(`${workspace}/`)) return null;
      rel = p.slice(workspace.length + 1);
    } else rel = p;
    host = rel === "" ? worktree : path.join(worktree, ...rel.split("/"));
  }
  try {
    return worktreeRelative(worktree, host);
  } catch (e) {
    if (e instanceof OutsideWorktree) return null;
    throw e;
  }
}

/** Past this many entries a folder search is refused rather than checked: the walk must stay cheap. */
const SEARCH_WALK_CAP = 100_000;

/**
 * The first file under `rel` (a folder) that the read rules don't allow, or
 * null. Grep reads the content of every file under the folder it is given,
 * so a folder search is allowed only when every file in it could be read on
 * its own. Links aren't followed, as the search tool doesn't follow them.
 */
export function unreadableUnder(worktree: string, rel: string, read: RolePolicy["read"], cap = SEARCH_WALK_CAP): string | null {
  const stack = [rel];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir === "" ? worktree : path.join(worktree, ...dir.split("/")), { withFileTypes: true });
    } catch {
      return dir || ".";
    }
    for (const e of names) {
      if (++seen > cap) return `${rel || "."} (more than ${cap} entries)`;
      const r = dir === "" ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) stack.push(r);
      else if (!readableBy(read, r)) return r;
    }
  }
  return null;
}

/**
 * FR-9: every file tool call is checked against the role's read or write
 * rules with the ADR 0015 path rule before it runs. The container is the
 * boundary; this is what keeps a role to its own files inside it. The same
 * check runs twice: as the PreToolUse hook, which Claude Code calls for
 * every tool call, and as `canUseTool`, which it skips for calls it
 * approves by itself (reads inside the working folder, read-only Bash).
 */
/** The tool Claude Code offers the model for a session's structured result. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** Full-shell roles until Beta (Role policy v2.7, F-015 FR-3, SR-1): `commands` doesn't limit their `Bash`. */
export const FULL_SHELL_ROLES: readonly string[] = ["software-developer", "test-engineer"];

/**
 * What the gate needs for a session on the owner's PC (ADR 0026, Role
 * policy v2.7): the ask rule's handler and the project's extra programs,
 * and a folder the role may read but never write (F-015 H-0192: the
 * approved spec and contracts, outside the worktree).
 */
export interface HostGate {
  /** Holds the command until the owner answers; true runs it once. An aborted signal is a denial. */
  ask(command: string, matched: string, signal?: AbortSignal): Promise<boolean>;
  askExtra: string[];
  readOnlyRoot?: string;
}

/**
 * The ask rule for a role with no ask handler of its own: nothing it runs on
 * the ask list goes ahead, and the gate's log records each held command.
 * Roles that can reach the owner (F-015's developer and test engineer) get
 * a handler that files an inbox item instead.
 */
export function denyAsk(manifestDoc: unknown): HostGate {
  let extra: string[] = [];
  try {
    extra = projectAsk(manifestDoc);
  } catch {
    // A malformed list can only add programs; the fixed list still applies.
  }
  return { ask: async () => false, askExtra: extra };
}

/** A path under `root` as a `/` path relative to it, or null. Links are followed, as for the worktree. */
function underRoot(root: string, p: unknown): string | null {
  if (typeof p !== "string" || p.includes("\0") || !path.isAbsolute(p)) return null;
  try {
    return worktreeRelative(root, p);
  } catch (e) {
    if (e instanceof OutsideWorktree) return null;
    throw e;
  }
}

export function toolGate(policy: RolePolicy, worktree: string | null, factoryTools: string[], log: Logger, workspace: string = WORKSPACE, structured = false, host?: HostGate): CanUseTool {
  const builtins = new Set<string>(policy.tools.filter((t) => t !== "fetch_page"));
  const mcp = new Set(factoryTools.map((t) => `mcp__${FACTORY_SERVER}__${t}`));
  // The gate runs twice for one call (hook, then canUseTool), so the owner's answer is kept briefly and used once more.
  const answered = new Map<string, { ok: boolean; at: number }>();
  return async (name, input, o) => {
    const deny = (why: string) => {
      log.warn(`${policy.role}: tool ${name.slice(0, 60)} refused: ${why}`);
      return { behavior: "deny" as const, message: `Refused by the factory engine: ${why}.` };
    };
    if (mcp.has(name)) return { behavior: "allow", updatedInput: input };
    // F-020 FR-9: the CLI's own tool for returning the report; it touches nothing, and exists only when the engine asked for a schema.
    if (structured && name === STRUCTURED_OUTPUT_TOOL) return { behavior: "allow", updatedInput: input };
    if (!builtins.has(name)) return deny("not one of this role's tools");
    const readKey = READ_TOOLS[name];
    const writeKey = WRITE_TOOLS[name];
    if (readKey || writeKey) {
      if (worktree === null) return deny("this role has no worktree");
      const key = (readKey ?? writeKey)!;
      // Only Grep and Glob default to the working folder; a file tool without a file is malformed.
      if (key === "file_path" && typeof input[key] !== "string") return deny("no file path");
      if (host?.readOnlyRoot && underRoot(host.readOnlyRoot, input[key]) !== null) {
        if (writeKey) return deny("the approved spec and contracts are read-only");
        const inside = underRoot(host.readOnlyRoot, input[key])!;
        if (!readableBy({ allow: ["**"], deny: policy.read.deny }, inside || ".")) return deny(`the role's read rules don't allow ${inside}`);
        return { behavior: "allow", updatedInput: input };
      }
      const rel = hostRelative(worktree, input[key], workspace);
      if (rel === null) return deny("the path is outside the worktree");
      if (!(writeKey ? allowedBy(policy.write, rel) : readableBy(policy.read, rel))) return deny(`the role's ${writeKey ? "write" : "read"} rules don't allow ${rel || "the worktree root"}`);
      if (name === "Grep") {
        let isDir = false;
        try {
          isDir = fs.lstatSync(rel === "" ? worktree : path.join(worktree, ...rel.split("/"))).isDirectory();
        } catch {
          // Missing: the tool reports that itself.
        }
        const hidden = isDir ? unreadableUnder(worktree, rel, policy.read) : null;
        if (hidden) return deny(`the folder holds ${hidden}, which the role's read rules don't allow; search a narrower path`);
      }
      return { behavior: "allow", updatedInput: input };
    }
    if (name === "Bash") {
      const cmd = typeof input.command === "string" ? input.command.trim() : "";
      if (!cmd) return deny("no command");
      const fullShell = host !== undefined && FULL_SHELL_ROLES.includes(policy.role);
      if (!fullShell) {
        const program = cmd.split(/\s+/)[0] ?? "";
        if (SHELL_SYNTAX.test(cmd)) return deny("one program per call, without shell syntax");
        if (!policy.commands.includes(program)) return deny(`${program.slice(0, 40)} is not on the role's command list`);
      }
      if (host) {
        const matched = askMatch(cmd, host.askExtra);
        if (matched) {
          const prior = answered.get(cmd);
          answered.delete(cmd);
          let ok: boolean;
          if (prior && Date.now() - prior.at < 60_000) ok = prior.ok;
          else {
            log.warn(`${policy.role}: Bash command held for the owner (ask rule, ${matched}): ${JSON.stringify(cmd).slice(0, 300)}`);
            ok = await host.ask(cmd, matched, o?.signal).catch(() => false);
            log.info(`${policy.role}: the held command was ${ok ? "approved and runs once" : "denied"}`);
            answered.set(cmd, { ok, at: Date.now() });
          }
          if (!ok) return deny(`the owner didn't approve ${matched} (ask rule); treat this step as not done`);
        }
      }
      return { behavior: "allow", updatedInput: input };
    }
    if (name === "WebSearch" || name === "Skill") return { behavior: "allow", updatedInput: input };
    return deny("no rule for this tool");
  };
}

/** Claude Code's PreToolUse hook, answering with the gate's decision. An allow adds nothing, so `canUseTool` still applies. */
export function preToolUseGate(gate: CanUseTool): PreToolUseHook {
  return async (input, _id, o) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const r = await gate(String(input.tool_name), toolInput, { signal: o.signal }).catch(() => ({ behavior: "deny" as const, message: "the engine's tool check failed" }));
    if (r.behavior === "allow") return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.message } };
  };
}

/** Role policy v2.7: how long a held command waits for the owner before it is denied. */
export const ASK_WAIT_MS = 30 * 60_000;
/**
 * Claude Code runs the tool when a hook times out, so the gate's hook must
 * outlast the owner's whole answer window; its default (10 minutes) let a
 * held command run unanswered in the F-002 trial.
 */
export const GATE_HOOK_TIMEOUT_S = ASK_WAIT_MS / 1000 + 5 * 60;

export interface SessionInput {
  policy: RolePolicy;
  /** The session's working folder in the container: the workspace, or /tmp for a role with no worktree. */
  cwd?: string;
  /** The worktree on the host, for the path rule; null for a role that gets none. */
  worktree: string | null;
  /** Where the worktree appears to Claude Code: the container mount, except in the real-CLI test. */
  workspace?: string;
  /** `agents/<role>/AGENT.md` from the master factory, never the worktree (SR-10). */
  instructions: string;
  factoryServer: unknown;
  factoryTools: string[];
  caps: SessionCaps;
  /** The image's baked skills, as a local plugin path inside the container. */
  skillsPluginDir?: string;
  model?: string;
  resume?: string;
  /** F-020 FR-9: the JSON Schema the session's report must match, returned as its structured result. */
  outputSchema?: Record<string, unknown>;
  /** A session on the owner's PC (ADR 0026): the ask rule and the read-only spec folder. */
  host?: HostGate;
  spawn(o: SpawnOptions): SpawnedProcess;
  log: Logger;
}

/** SR-10's fixed options; nothing from the repo or the owner's settings can change them. */
export function sessionOptions(s: SessionInput, abort: AbortController): SessionOptions {
  checkCaps(s.caps);
  const builtins: string[] = s.policy.tools.filter((t) => t !== "fetch_page");
  if (builtins.includes("Skill") && !s.skillsPluginDir) throw new Error("the role uses Skill, but the image has no baked skills");
  if (!s.instructions.trim()) throw new Error("no instructions for the role");
  const gate = toolGate(s.policy, s.worktree, s.factoryTools, s.log, s.workspace, s.outputSchema !== undefined, s.host);
  return {
    cwd: s.cwd ?? WORKSPACE,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [FACTORY_SERVER]: s.factoryServer } as Record<"factory", unknown>,
    tools: builtins,
    allowedTools: s.factoryTools.map((t) => `mcp__${FACTORY_SERVER}__${t}`),
    disallowedTools: ["WebFetch"].filter((t) => !builtins.includes(t)),
    permissionMode: "default",
    canUseTool: gate,
    hooks: { PreToolUse: [{ hooks: [preToolUseGate(gate)], timeout: GATE_HOOK_TIMEOUT_S }] },
    systemPrompt: s.instructions,
    plugins: builtins.includes("Skill") ? [{ type: "local", path: s.skillsPluginDir! }] : [],
    maxTurns: s.caps.maxTurns,
    ...(s.caps.maxBudgetUsd !== undefined ? { maxBudgetUsd: s.caps.maxBudgetUsd } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.resume ? { resume: s.resume } : {}),
    ...(s.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: s.outputSchema } } : {}),
    // The SDK's environment for the CLI: the container sets its own, so nothing of the engine's goes in.
    env: { ...CONTAINER_FLAGS },
    abortController: abort,
    spawnClaudeCodeProcess: s.spawn,
  };
}

/** Variables the SDK sets for its CLI protocol, the only ones taken from its env. */
const SDK_ENV = new Set(["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE", ...Object.keys(CONTAINER_FLAGS)]);
/** What SDK 0.3.311 passes for SR-10's options; a session whose arguments lack them doesn't start. */
const REQUIRED_ARGS = ["--setting-sources=", "--strict-mcp-config"];
const FORBIDDEN_ARGS = /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions)$|^bypassPermissions$/;

/**
 * SR-10: every session runs Claude Code in its container with `docker exec`;
 * no `claude` process ever starts on the host. Arguments asking for a bypass
 * permission mode are refused.
 */
export function containerSpawn(docker: DockerCli, container: string, workdir: string = WORKSPACE): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    if (o.args.some((a) => FORBIDDEN_ARGS.test(a) || a === "--permission-mode=bypassPermissions")) throw new Error("refused: a bypass permission mode");
    for (const r of REQUIRED_ARGS) if (!o.args.includes(r)) throw new Error(`refused: the CLI arguments lack ${r}`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env)) if (SDK_ENV.has(k) && typeof v === "string") env[k] = v;
    const envFlags = Object.keys(env).flatMap((k) => ["--env", k]);
    const child = docker.spawn(["exec", "--interactive", "--user", AGENT_USER, "--workdir", workdir, ...envFlags, container, CLAUDE_BIN, ...o.args], env);
    const kill = () => child.kill("SIGKILL");
    if (o.signal.aborted) kill();
    else o.signal.addEventListener("abort", kill, { once: true });
    return child as unknown as SpawnedProcess;
  };
}

export interface SessionOutcome {
  status: "complete" | "cap" | "error";
  reason?: string;
  sessionId?: string;
  /** The final result text the CLI reported, if any. */
  result?: string;
  /** F-020 FR-9, SR-7: the structured result of a successful session, and only of one. */
  structured?: unknown;
  /** The CLI's own error text for a failed session, for the engine log only: it isn't engine words, so the owner never sees it. */
  detail?: string;
  turns: number;
  outputTokens: number;
  inputTokens: number;
  costUsd: number;
  durationMs: number;
}

/**
 * A session's wall-time cap that can be held: the owner's time to answer an
 * ask-rule item doesn't count against the session (Role policy v2.7).
 */
export class WallTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private left: number;
  private since = 0;
  private holds = 0;
  private done = false;

  constructor(ms: number, private readonly onExpire: () => void, private readonly now: () => number = Date.now) {
    this.left = ms;
  }

  start(): void {
    if (this.done || this.holds > 0 || this.timer) return;
    this.since = this.now();
    this.timer = setTimeout(() => {
      this.done = true;
      this.onExpire();
    }, Math.max(0, this.left));
  }

  /** Stops the clock until the returned release is called. */
  hold(): () => void {
    if (this.holds++ === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.left -= this.now() - this.since;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0) this.start();
    };
  }

  stop(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface SessionEvents {
  /** The SDK's session id, recorded as soon as it's known, so an interrupted run can resume from it (FR-14). */
  onSessionId?(id: string): void;
  /** SR-21: every WebSearch query, from the message stream. */
  onWebSearch?(query: string): void;
  /** Given, the session's wall-time cap runs on it, so an ask can hold it. */
  wall?(onExpire: () => void): WallTimer;
}

/**
 * Runs one session to its end, a cap, or an error (SR-18). A cap stops the
 * session at once and the outcome says which.
 */
export async function runSession(sdk: AgentSdk, opts: SessionOptions, turns: AsyncIterable<UserTurn>, caps: SessionCaps, ev: SessionEvents, now: () => number = Date.now): Promise<SessionOutcome> {
  const started = now();
  const out: SessionOutcome = { status: "complete", turns: 0, outputTokens: 0, inputTokens: 0, costUsd: 0, durationMs: 0 };
  const stop = (reason: string) => {
    if (out.status === "complete") Object.assign(out, { status: "cap", reason });
    opts.abortController.abort();
  };
  const wall = ev.wall ? ev.wall(() => stop("wall time")) : new WallTimer(caps.wallTimeMs, () => stop("wall time"), now);
  wall.start();
  try {
    for await (const m of sdk.query({ prompt: turns, options: opts }) as AsyncIterable<SdkMessage>) {
      if (typeof m.session_id === "string" && m.session_id && m.session_id !== out.sessionId) {
        out.sessionId = m.session_id;
        ev.onSessionId?.(m.session_id);
      }
      if (m.type === "assistant") {
        const msg = (m as Extract<SdkMessage, { type: "assistant" }>).message;
        for (const c of msg.content ?? []) {
          if (c.type === "tool_use" && c.name === "WebSearch") {
            const q = (c.input as { query?: unknown } | undefined)?.query;
            ev.onWebSearch?.(typeof q === "string" ? q.slice(0, 2000) : "");
          }
        }
        out.outputTokens += msg.usage?.output_tokens ?? 0;
        if (caps.maxOutputTokens !== undefined && out.outputTokens > caps.maxOutputTokens) stop("output tokens");
      } else if (m.type === "result") {
        const r = m as Extract<SdkMessage, { type: "result" }>;
        out.turns = r.num_turns ?? out.turns;
        out.costUsd = r.total_cost_usd ?? out.costUsd;
        out.inputTokens = r.usage?.input_tokens ?? out.inputTokens;
        if (typeof r.result === "string") out.result = r.result;
        if (r.subtype === "success" && r.structured_output !== undefined) out.structured = r.structured_output;
        else delete out.structured;
        if (r.usage?.output_tokens !== undefined) out.outputTokens = Math.max(out.outputTokens, r.usage.output_tokens);
        if (r.subtype === "error_max_turns") stop("turns");
        else if (r.subtype === "error_max_budget_usd") stop("dollars");
        else if (r.subtype !== "success" && out.status === "complete") Object.assign(out, { status: "error", reason: r.subtype });
        if (r.subtype !== "success" && Array.isArray(r.errors) && r.errors.length) out.detail = r.errors.map(String).join("; ").slice(0, 2000);
        if (caps.maxBudgetUsd !== undefined && out.costUsd > caps.maxBudgetUsd) stop("dollars");
      }
      if (opts.abortController.signal.aborted) break;
    }
  } catch (e) {
    if (out.status === "complete") Object.assign(out, { status: "error", reason: (e as Error).message.slice(0, 300) });
  } finally {
    wall.stop();
    out.durationMs = now() - started;
  }
  return out;
}

export type { FactoryTool };
