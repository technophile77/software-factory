import * as path from "node:path";
import { localCommand, toolHash, values } from "../agent/project-mcp";
import { mcpBaseEnv } from "../agent/host";
import { mcpIdentity } from "../config/mcp-servers";
import type { Manifest } from "../config/manifest";
import type { Git } from "../git";
import { listTools } from "../mcp-client/client";
import type { McpTarget, McpTool } from "../mcp-client/client";
import { mcpServerRecord } from "../schemas/mcp-server-record";
import type { McpServerRecord } from "../schemas/mcp-server-record";
import type { CredentialStore } from "../secrets";
import { mcpPending } from "./approve";

/**
 * F-025 FR-12: `factory-engine mcp list` and `mcp check <server>`. Both
 * read the manifest from the config repo's main and the records from its
 * factory/state, as the engine does. `check` starts only a server whose
 * approved record still matches (stricter than SR-11: an unreviewed server
 * never runs from here), and prints what it reports as escaped text.
 */

export interface McpCliDeps {
  git: Git;
  configRepo: string;
  manifest: Manifest;
  secrets: CredentialStore;
  mcpRoot: string;
  env: NodeJS.ProcessEnv;
  say(line: string): void;
  list?: (t: McpTarget) => Promise<{ tools: McpTool[]; dropped: string[] }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Server text shown in a terminal: one line, no control characters or escape sequences. */
const shown = (t: string, max = 200) => JSON.stringify(t.length > max ? `${t.slice(0, max)}…` : t);

async function stateFile(d: McpCliDeps, file: string): Promise<unknown> {
  const head = await d.git.revParse(d.configRepo, "refs/heads/factory/state");
  const raw = head ? await d.git.readBlob(d.configRepo, head, file).catch(() => null) : null;
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function recordOf(d: McpCliDeps, server: string): Promise<McpServerRecord | null> {
  const r = mcpServerRecord.safeParse(await stateFile(d, `mcp/${server}.json`));
  return r.success ? r.data : null;
}

function recordIdentity(r: McpServerRecord): string {
  return r.kind === "package" ? `package:${r.ecosystem}:${r.name}@${r.version}` : r.kind === "command" ? `command:${r.sha256}` : `remote:${r.url}`;
}

/** Each role's `mcp.allow`, project-wide and per repo, as written. */
function allowByRole(raw: unknown): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  const add = (policy: unknown, prefix: string) => {
    const roles = isObj(policy) && isObj(policy.roles) ? policy.roles : {};
    for (const [role, r] of Object.entries(roles)) {
      const allow = isObj(r) && isObj(r.mcp) && Array.isArray(r.mcp.allow) ? r.mcp.allow.filter((x): x is string => typeof x === "string") : [];
      if (allow.length) out.push([`${prefix}${role}`, allow]);
    }
  };
  const doc = isObj(raw) ? raw : {};
  add(doc.policy, "");
  for (const repo of Array.isArray(doc.repos) ? doc.repos : []) if (isObj(repo) && typeof repo.name === "string") add(repo.policy, `${repo.name}: `);
  return out;
}

export async function mcpList(d: McpCliDeps): Promise<number> {
  const m = d.manifest;
  if (!m.mcpServers.length) {
    d.say(`${m.name} declares no MCP servers (mcp_servers in factory-project.yaml).`);
    return 0;
  }
  const roles = allowByRole(m.raw);
  for (const s of m.mcpServers) {
    const identity = mcpIdentity(s);
    const rec = await recordOf(d, s.name);
    const pending = mcpPending.safeParse(await stateFile(d, `mcp/${s.name}.pending.json`));
    const state = rec && recordIdentity(rec) === identity ? `approved (${rec.approved.item}, ${rec.approved.at})`
      : pending.success && pending.data.identity === identity ? "waiting for your approval in the inbox"
      : rec ? "the manifest changed since it was approved; it is prepared for approval again when a session needs it"
      : "not approved yet; it is prepared for your approval when a session needs it";
    d.say(`${s.name}: ${identity}`);
    d.say(`  state: ${state}`);
    if (rec) {
      const acts = rec.tools.filter((t) => t.class === "acts").map((t) => t.name);
      d.say(`  tools: ${rec.tools.length} approved; acting outside the factory: ${acts.join(", ") || "none"}`);
    }
    const who = roles.filter(([, allow]) => allow.some((a) => a === s.name || a.startsWith(`${s.name}/`)));
    d.say(`  roles: ${who.map(([role, allow]) => `${role} (${allow.filter((a) => a === s.name || a.startsWith(`${s.name}/`)).map((a) => (a === s.name ? "all tools" : a.slice(s.name.length + 1))).join(", ")})`).join("; ") || "none"}`);
  }
  return 0;
}

export async function mcpCheck(d: McpCliDeps, server: string): Promise<number> {
  const m = d.manifest;
  const s = m.mcpServers.find((x) => x.name === server);
  if (!s) {
    d.say(`${m.name} has no MCP server named ${shown(server, 40)}.`);
    return 2;
  }
  const rec = await recordOf(d, s.name);
  if (!rec || recordIdentity(rec) !== mcpIdentity(s)) {
    d.say(`${s.name} isn't approved as the manifest names it, so it isn't started from here. The engine prepares it for your approval (install, CVE check, security review) the next time a session needs it.`);
    return 1;
  }
  let target: McpTarget;
  try {
    if (s.kind === "remote") {
      target = { kind: "http", url: s.url, headers: await values({ project: m.name, secrets: d.secrets }, s.name, s.headers, []) };
    } else {
      const { command, args, dir } = localCommand({ mcpRoot: d.mcpRoot, project: m.name }, s, s.kind === "package" ? rec.lockfile_sha256 : rec.sha256);
      const home = path.join(dir, "home");
      target = { kind: "stdio", command, args, cwd: dir, env: { ...mcpBaseEnv(d.env, process.platform), HOME: home, USERPROFILE: home, ...(await values({ project: m.name, secrets: d.secrets }, s.name, s.env, [])) } };
    }
  } catch (e) {
    d.say(`${s.name}: ${(e as Error).message}`);
    return 1;
  }
  let got: { tools: McpTool[]; dropped: string[] };
  try {
    got = await (d.list ?? ((t) => listTools(t)))(target);
  } catch (e) {
    d.say(`${s.name} didn't list its tools: ${(e as Error).message}`);
    return 1;
  }
  const approved = new Map(rec.tools.map((t) => [t.name, t]));
  d.say(`${s.name} reports ${got.tools.length} tool(s). Descriptions are the server's own text.`);
  for (const t of got.tools) {
    const a = approved.get(t.name);
    const state = !a ? "new, not approved" : a.description_sha256 !== toolHash(t) ? "changed since approval, left out" : a.class;
    d.say(`  ${t.name} [${state}] ${shown(t.description)}`);
  }
  for (const name of got.dropped) d.say(`  ${shown(name, 80)} [name agents can't call]`);
  for (const t of rec.tools) if (!got.tools.some((x) => x.name === t.name)) d.say(`  ${t.name} [approved, but the server no longer lists it]`);
  return 0;
}
