import * as fs from "node:fs";
import * as path from "node:path";
import { canonical } from "../state/transcript";
import { sha256Hex } from "../fsutil";
import { mcpIdentity } from "../config/mcp-servers";
import type { McpServer, McpValue } from "../config/mcp-servers";
import type { McpServerRecord } from "../schemas/mcp-server-record";
import { mcpCovers } from "../policy/role-policy";
import type { RolePolicy } from "../policy/role-policy";
import type { CredentialStore } from "../secrets";
import { mcpSecretItem } from "../secrets";
import { listTools } from "../mcp-client/client";
import { HostError } from "./host";
import type { McpTarget, McpTool } from "../mcp-client/client";

/**
 * F-025: the project MCP servers one session gets. Only servers the role's
 * `mcp.allow` names, whose manifest entry matches the approved record, and
 * only tools whose name, description and input schema still hash to what
 * was approved (SR-7). Everything else is left out or stops the session
 * before it starts (FR-10).
 */

export interface ProjectMcpSession {
  /** SDK `mcpServers` entries, by server name. */
  servers: Record<string, unknown>;
  /** `mcp__<server>__<tool>` names the gate allows. */
  tools: string[];
  /** The allowed tools the record classes `acts`, logged on every call (SR-6, ADR 0036). */
  acts: string[];
  /** Hosts of allowed remote servers, granted to a proxied session for its life (FR-9). */
  hosts: string[];
  /** Allowed tools a server reports that aren't in its record, or changed since (SR-7, FR-18): left out; the engine reviews new and changed ones (FR-20). */
  leftOut: Array<{ server: string; tool: string; why: "new" | "changed" | "unusable name" }>;
  /** Servers the owner chose to run this session without (FR-10, SR-12); the agent is told. */
  missing: string[];
  /** FR-18: `<server>/<tool>` the role allows that this session doesn't get; the agent is told. */
  missingTools: string[];
  /** The secret values handed to servers, so the engine can mask them wherever it writes text (SR-10). */
  masks: string[];
}

/** Why an allowed server can't be given to the session; the session doesn't start (FR-10). */
export class McpServerUnavailable extends HostError {
  override name = "McpServerUnavailable";
  constructor(readonly server: string, readonly reason: string, readonly needsApproval = false) {
    super(`MCP server ${server}: ${reason}`);
  }
}

/** `<mcpRoot>/<project>/<server>/install.json`: what approval installed, written by the installer (SR-5, SR-13). */
export const INSTALL_SCHEMA = "mcp-install/1.0";
export interface McpInstall {
  schema: typeof INSTALL_SCHEMA;
  identity: string;
  /** Relative to the server's folder: the program and its arguments, before the manifest's `args`. */
  command: string[];
  /** Relative path of the file whose SHA-256 must match the record: the lockfile or the copied executable. */
  pinned_file: string;
}

export interface ResolveInput {
  project: string;
  policy: RolePolicy;
  servers: readonly McpServer[];
  record(server: string): Promise<McpServerRecord | null>;
  secrets: CredentialStore;
  /** Engine-owned folder holding each project's installed servers. */
  mcpRoot: string;
  /** Node, and the engine's `mcp-launch` entry, which starts a local server with only the env it should have (FR-8). */
  launcher: { command: string; args: string[] };
  /** Where the session's Claude Code runs; a local server's working folder (FR-8). */
  cwd: string;
  /** The environment a local server starts from: platform basics and PATH, nothing of the engine's (FR-8). */
  baseEnv: Record<string, string>;
  /** The session's HTTPS_PROXY and NO_PROXY, for a role that goes through the egress proxy (FR-9); empty otherwise. */
  proxyEnv: Record<string, string>;
  list?: (t: McpTarget) => Promise<{ tools: McpTool[]; dropped: string[] }>;
  /** Servers the owner chose, on an item, to leave out of the next session once (FR-10, SR-12). */
  skip?: ReadonlySet<string>;
}

export function toolHash(t: McpTool): string {
  return sha256Hex(canonical({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function fileSha(p: string): string | null {
  try {
    return sha256Hex(fs.readFileSync(p));
  } catch {
    return null;
  }
}

function recordIdentity(r: McpServerRecord): string {
  if (r.kind === "package") return `package:${r.ecosystem}:${r.name}@${r.version}`;
  if (r.kind === "command") return `command:${r.sha256}`;
  return `remote:${r.url}`;
}

export async function values(i: Pick<ResolveInput, "project" | "secrets">, server: string, v: Record<string, McpValue>, masks: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if ("literal" in val) {
      out[k] = val.literal;
      continue;
    }
    const got = await i.secrets.get(mcpSecretItem(i.project, server, val.secret)).catch(() => null);
    // Names the item, never a value (SR-1).
    if (got === null) throw new McpServerUnavailable(server, `its secret ${val.secret} isn't stored: run factory-engine secret set ${mcpSecretItem(i.project, server, val.secret)}`);
    out[k] = got;
    masks.push(got);
  }
  return out;
}

/** The program and arguments that start a local server from its approved install, checked against the record. */
export function localCommand(i: Pick<ResolveInput, "mcpRoot" | "project">, s: Exclude<McpServer, { kind: "remote" }>, want: string | undefined): { command: string; args: string[]; dir: string } {
  const dir = path.join(i.mcpRoot, i.project, s.name);
  let inst: McpInstall;
  try {
    inst = JSON.parse(fs.readFileSync(path.join(dir, "install.json"), "utf8")) as McpInstall;
  } catch {
    throw new McpServerUnavailable(s.name, "it isn't installed on this PC; approve it again", true);
  }
  if (inst.schema !== INSTALL_SCHEMA || inst.identity !== mcpIdentity(s) || !Array.isArray(inst.command) || inst.command.length === 0) {
    throw new McpServerUnavailable(s.name, "its install doesn't match the manifest; approve it again", true);
  }
  const inside = (rel: string) => {
    const p = path.resolve(dir, rel);
    if (path.relative(dir, p).startsWith("..") || path.isAbsolute(path.relative(dir, p))) throw new McpServerUnavailable(s.name, "its install names a file outside its folder");
    return p;
  };
  // SR-5, SR-13: what runs is exactly what was approved: the lockfile it was installed from, or the copied executable.
  if (!want || fileSha(inside(inst.pinned_file)) !== want) throw new McpServerUnavailable(s.name, "its installed files don't match the approved record; approve it again", true);
  const [first, ...rest] = inst.command;
  // `node` means the Node the engine runs on, so no PATH lookup can swap it.
  const command = first === "node" ? process.execPath : inside(first!);
  return { command, args: [...rest.map((a) => (a.startsWith("./") ? inside(a) : a)), ...(s.kind === "package" ? s.args : s.command.slice(1))], dir };
}

export async function resolveProjectMcp(i: ResolveInput): Promise<ProjectMcpSession> {
  const out: ProjectMcpSession = { servers: {}, tools: [], acts: [], hosts: [], leftOut: [], missing: [], missingTools: [], masks: [] };
  const allow = i.policy.mcp ?? [];
  if (!allow.length) return out;
  const list = i.list ?? ((t) => listTools(t));
  const wanted = [...new Set(allow.map((a) => a.split("/")[0]!))];
  for (const name of wanted) {
    if (i.skip?.has(name)) {
      out.missing.push(name);
      continue;
    }
    const s = i.servers.find((x) => x.name === name);
    if (!s) throw new McpServerUnavailable(name, "it isn't in mcp_servers");
    const r = await i.record(name);
    if (!r) throw new McpServerUnavailable(name, "it hasn't been approved yet", true);
    if (r.server !== name || recordIdentity(r) !== mcpIdentity(s)) throw new McpServerUnavailable(name, "the manifest names a different version, file or URL than was approved", true);
    let sdk: unknown;
    let target: McpTarget;
    if (s.kind === "remote") {
      const headers = await values(i, name, s.headers, out.masks);
      sdk = { type: "http", url: s.url, headers };
      target = { kind: "http", url: s.url, headers };
      out.hosts.push(new URL(s.url).hostname);
    } else {
      const { command, args, dir } = localCommand(i, s, s.kind === "package" ? r.lockfile_sha256 : r.sha256);
      const declared = await values(i, name, s.env, out.masks);
      const home = path.join(dir, "home");
      const tmp = path.join(dir, "tmp");
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(tmp, { recursive: true });
      // FR-8: a home and temp folder of its own, so it reads none of the owner's tool settings by default (SR-8).
      const own: Record<string, string> = { HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
      const env = { ...i.baseEnv, ...i.proxyEnv, ...own, ...declared };
      // Claude Code starts the server with its own environment added, so the engine's launcher keeps only these names.
      const keep = Object.keys(env).sort();
      sdk = { type: "stdio", command: i.launcher.command, args: [...i.launcher.args, "--keep", keep.join(","), "--cwd", i.cwd, "--", command, ...args], env };
      target = { kind: "stdio", command, args, env, cwd: i.cwd };
    }
    let reported: { tools: McpTool[]; dropped: string[] };
    try {
      reported = await list(target);
    } catch (e) {
      throw new McpServerUnavailable(name, `it didn't list its tools (${(e as Error).message.slice(0, 200)})`);
    }
    const approved = new Map(r.tools.map((t) => [t.name, t]));
    for (const d of reported.dropped) out.leftOut.push({ server: name, tool: d, why: "unusable name" });
    for (const t of reported.tools) {
      // v2: only allowed tools are reviewed, so a tool no entry covers is neither offered nor news.
      if (!mcpCovers(allow, `${name}/${t.name}`)) continue;
      const a = approved.get(t.name);
      if (!a || a.description_sha256 !== toolHash(t)) {
        out.leftOut.push({ server: name, tool: t.name, why: a ? "changed" : "new" });
        out.missingTools.push(`${name}/${t.name}`);
        continue;
      }
      const full = `mcp__${name}__${t.name}`;
      out.tools.push(full);
      if (a.class === "acts") out.acts.push(full);
    }
    out.servers[name] = sdk;
  }
  return out;
}

/**
 * `factory-engine mcp-launch --keep A,B --cwd <dir> -- <command> <args>`:
 * Claude Code starts a stdio server with its own environment, which holds
 * the session's gateway credential. This keeps only the names the engine
 * chose (FR-8, AC-8) and starts the server with no shell.
 */
export function launchSpec(argv: string[], env: NodeJS.ProcessEnv): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const sep = argv.indexOf("--");
  if (sep < 0 || argv[0] !== "--keep" || argv[2] !== "--cwd" || sep !== 4 || argv.length < 6) throw new Error("usage: mcp-launch --keep <names> --cwd <dir> -- <command> [args]");
  const keep = argv[1]!.split(",").filter(Boolean);
  const out: Record<string, string> = {};
  for (const k of keep) if (typeof env[k] === "string") out[k] = env[k]!;
  return { command: argv[5]!, args: argv.slice(6), cwd: argv[3]!, env: out };
}
