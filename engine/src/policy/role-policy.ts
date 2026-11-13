import { Rules, globError } from "./glob";

/** Role policy v2.5: the built-in tools a role may list, and the engine tool `fetch_page`. */
export const KNOWN_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "Skill", "fetch_page"] as const;
export type ToolName = (typeof KNOWN_TOOLS)[number];
const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "Edit", "Write", "Bash", "Skill"]);
const WEB_ONLY_TOOLS: ReadonlySet<string> = new Set(["fetch_page", "WebFetch", "WebSearch"]);

export const SECRET_DENIES = [
  "**/.env", "**/.env.*", "**/.envrc", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.jks", "**/*.keystore",
  "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*", "**/.npmrc", "**/.pypirc", "**/.netrc",
  "**/.git-credentials", "**/*.tfvars", "**/credentials*.json", "**/*.tfstate", "**/*.tfstate.*", "**/.aws/credentials",
  "**/.docker/config.json", "**/*.ppk", "**/kubeconfig", "**/.kube/config", ".factory/engine.json", "**/.factory/engine.json",
];

export const CHANGE_CONTROLLED_DENIES = [
  "CLAUDE.md", "**/CLAUDE.md", "CLAUDE.local.md", "**/CLAUDE.local.md", ".claude/**", ".mcp.json", ".github/**",
  ".gitignore", ".gitattributes", ".husky/**", ".pre-commit-config.yaml", "lefthook.yml", "osv-scanner.toml",
  "agents/**", "skills/**", "plugins/**", ".claude-plugin/**", "workflows/**", "**/.claude/**", ".envrc", "**/.envrc",
  ".git", ".git/**", ".gitmodules", ".vscode/**", ".devcontainer/**",
];

/** Role policy v2.6 (H-0107): the source documents the engine stores for F-009 are never an agent's to change. */
export const SOURCE_DOCUMENT_DENIES = ["docs/features/*-source.md", "docs/features/*-source.txt"];

export const CORE_ROLES = ["orchestrator", "requirements-analyst", "software-developer", "test-engineer", "security-reviewer", "validation-judge"];
export const ROLE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export interface RolePolicy {
  role: string;
  tools: ToolName[];
  read: Rules;
  write: Rules;
  commands: string[];
  /** Host names, or exactly ["*"] for an open-web role. */
  network: string[];
  mayRequest: string[];
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new PolicyError(`${where} must be a list of strings`);
  return v as string[];
}

function section(v: unknown, where: string, keys: string[]): Record<string, unknown> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new PolicyError(`${where} must be a mapping`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new PolicyError(`${where}.${k} is not a policy key`);
  return v;
}

function globs(v: unknown, where: string): string[] {
  const list = strList(v, where);
  for (const g of list) {
    const e = globError(g);
    if (e) throw new PolicyError(`${where}: ${JSON.stringify(g).slice(0, 80)} ${e}`);
  }
  return list;
}

function parseRole(role: string, v: unknown, where: string): RolePolicy {
  const r = section(v, where, ["tools", "read", "write", "commands", "network", "may_request"]);
  const tools = strList(section(r.tools, `${where}.tools`, ["allow"]).allow, `${where}.tools.allow`);
  for (const t of tools) if (!(KNOWN_TOOLS as readonly string[]).includes(t)) throw new PolicyError(`${where}.tools: unknown tool ${JSON.stringify(t).slice(0, 40)}`);
  const read = section(r.read, `${where}.read`, ["allow", "deny"]);
  const write = section(r.write, `${where}.write`, ["allow", "deny"]);
  const network = strList(section(r.network, `${where}.network`, ["allow"]).allow, `${where}.network.allow`);
  for (const h of network) if (h !== "*" && !HOST_RE.test(h)) throw new PolicyError(`${where}.network: ${JSON.stringify(h).slice(0, 80)} is not a host name`);
  const commands = strList(section(r.commands, `${where}.commands`, ["allow"]).allow, `${where}.commands.allow`);
  for (const c of commands) if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(c)) throw new PolicyError(`${where}.commands: ${JSON.stringify(c).slice(0, 40)} is not a program name`);
  return {
    role,
    tools: [...new Set(tools)] as ToolName[],
    read: { allow: globs(read.allow, `${where}.read.allow`), deny: globs(read.deny, `${where}.read.deny`) },
    write: { allow: globs(write.allow, `${where}.write.allow`), deny: globs(write.deny, `${where}.write.deny`) },
    commands,
    network,
    mayRequest: strList(r.may_request, `${where}.may_request`),
  };
}

/** The checks every effective role must pass (Role policy v2.6). */
function checkRole(p: RolePolicy, where: string): void {
  if (p.tools.length === 0) throw new PolicyError(`${where}: a role must list at least one tool`);
  if (p.tools.some((t) => FILE_TOOLS.has(t)) && p.read.allow.length === 0) throw new PolicyError(`${where}: a role with file tools must list a read glob`);
  const lower = new Set(p.read.deny.map((g) => g.toLowerCase()));
  for (const d of SECRET_DENIES) if (!lower.has(d.toLowerCase())) throw new PolicyError(`${where}: read.deny must hold ${d}`);
  const writesOutsideFactory = p.write.allow.some((g) => !g.startsWith(".factory/"));
  if (writesOutsideFactory) {
    const wd = new Set(p.write.deny.map((g) => g.toLowerCase()));
    for (const d of [...CHANGE_CONTROLLED_DENIES, ...SOURCE_DOCUMENT_DENIES]) if (!wd.has(d.toLowerCase())) throw new PolicyError(`${where}: write.deny must hold ${d}`);
  }
  if (p.network.includes("*")) {
    if (p.network.length !== 1) throw new PolicyError(`${where}: "*" must be the only network entry`);
    if (!p.tools.every((t) => WEB_ONLY_TOOLS.has(t))) throw new PolicyError(`${where}: "*" is only for a role whose tools are fetch_page, WebFetch and WebSearch`);
  }
  if (p.mayRequest.length > 0 && p.role !== "advisor") throw new PolicyError(`${where}: only advisor may have may_request`);
  if (p.role === "web-reader") {
    const fixed = p.tools.length === 2 && p.tools.includes("fetch_page") && p.tools.includes("WebSearch");
    if (!fixed || p.read.allow.length || p.write.allow.length || p.commands.length || p.network.join() !== "*") {
      throw new PolicyError(`${where}: the web-reader policy is fixed (Role policy v2.5)`);
    }
  }
}

/**
 * The effective policy of one role for one repo: the project's role, where
 * a repo override's allow lists replace the project's and its deny lists are
 * added. An override may not add tools or `may_request`. A role missing from
 * the policy may not run.
 */
export function effectiveRole(manifestDoc: unknown, role: string, repoName?: string): RolePolicy {
  if (!ROLE_RE.test(role)) throw new PolicyError("bad role name");
  if (!isObj(manifestDoc) || !isObj(manifestDoc.policy) || !isObj(manifestDoc.policy.roles)) throw new PolicyError("the manifest has no policy.roles");
  const roles = manifestDoc.policy.roles;
  for (const c of CORE_ROLES) if (!isObj(roles[c])) throw new PolicyError(`policy.roles must hold the core role ${c}`);
  if (!Object.prototype.hasOwnProperty.call(roles, role)) throw new PolicyError(`the policy has no role ${role}; it may not run`);
  const base = parseRole(role, roles[role], `policy.roles.${role}`);
  checkRole(base, `policy.roles.${role}`);
  if (repoName === undefined) return base;
  const repos = Array.isArray(manifestDoc.repos) ? manifestDoc.repos : [];
  const repo = repos.find((r) => isObj(r) && r.name === repoName) as Record<string, unknown> | undefined;
  const ov = repo && isObj(repo.policy) && isObj(repo.policy.roles) ? repo.policy.roles[role] : undefined;
  if (ov === undefined) return base;
  const where = `repos[${repoName}].policy.roles.${role}`;
  const o = parseRole(role, ov, where);
  if (isObj(ov) && ov.may_request !== undefined) throw new PolicyError(`${where}: may_request is set in the project policy only`);
  const has = (k: string, sub: string) => isObj(ov) && isObj(ov[k]) && (ov[k] as Record<string, unknown>)[sub] !== undefined;
  if (has("tools", "allow") && o.tools.some((t) => !base.tools.includes(t))) throw new PolicyError(`${where}: a repo override may not add tools`);
  const eff: RolePolicy = {
    role,
    tools: has("tools", "allow") ? o.tools : base.tools,
    read: { allow: has("read", "allow") ? o.read.allow : base.read.allow, deny: [...base.read.deny, ...o.read.deny] },
    write: { allow: has("write", "allow") ? o.write.allow : base.write.allow, deny: [...base.write.deny, ...o.write.deny] },
    commands: has("commands", "allow") ? o.commands : base.commands,
    network: has("network", "allow") ? o.network : base.network,
    mayRequest: base.mayRequest,
  };
  checkRole(eff, where);
  return eff;
}
