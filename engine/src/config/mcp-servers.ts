/**
 * Project manifest v1.12 `mcp_servers` (F-025, ADR 0036): the MCP servers a
 * project's agents may be given. Only the shape is checked here; whether a
 * server may run is decided by its approved MCP server record.
 */

export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MCP_SECRET_KEY_RE = /^[a-z0-9_-]{1,32}$/;
/** The engine's own server; a project can't take its name (FR-1). */
export const RESERVED_SERVER = "factory";
export const MAX_MCP_SERVERS = 32;

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
const PYPI_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
// Exact versions only (FR-2, SR-3): a range, tag or `latest` would let the code change without a new review.
const NPM_VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const PYPI_VERSION_RE = /^\d{1,9}(?:\.\d{1,9}){0,5}(?:(?:a|b|rc)\d{1,9})?(?:\.post\d{1,9})?(?:\.dev\d{1,9})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Variables the engine sets for a local server itself (FR-8); a manifest can't replace them.
const ENGINE_ENV = new Set(["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]);
const MAX_ARGS = 50;
const MAX_VALUES = 32;
const MAX_TEXT = 500;

export type McpValue = { literal: string } | { secret: string };

interface Base {
  name: string;
}
export interface McpPackageServer extends Base {
  kind: "package";
  ecosystem: "npm" | "pypi";
  package: string;
  version: string;
  args: string[];
  env: Record<string, McpValue>;
}
export interface McpCommandServer extends Base {
  kind: "command";
  command: string[];
  sha256: string;
  env: Record<string, McpValue>;
}
export interface McpRemoteServer extends Base {
  kind: "remote";
  url: string;
  headers: Record<string, McpValue>;
}
export type McpServer = McpPackageServer | McpCommandServer | McpRemoteServer;

export class McpConfigError extends Error {
  override name = "McpConfigError";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function keysOnly(v: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new McpConfigError(`${where}.${k} is not a key here`);
}

function plainText(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length > MAX_TEXT || CONTROL_RE.test(v)) throw new McpConfigError(`${where} must be text of at most ${MAX_TEXT} characters with no control characters`);
  return v;
}

function values(v: unknown, where: string, nameRe: RegExp, what: string): Record<string, McpValue> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new McpConfigError(`${where} must be a mapping`);
  const out: Record<string, McpValue> = {};
  const entries = Object.entries(v);
  if (entries.length > MAX_VALUES) throw new McpConfigError(`${where} has more than ${MAX_VALUES} entries`);
  for (const [k, val] of entries) {
    if (!nameRe.test(k)) throw new McpConfigError(`${where}: ${JSON.stringify(k).slice(0, 70)} is not ${what}`);
    if (nameRe === ENV_NAME_RE && ENGINE_ENV.has(k)) throw new McpConfigError(`${where}.${k} is set by the engine`);
    if (isObj(val)) {
      keysOnly(val, ["secret"], `${where}.${k}`);
      if (typeof val.secret !== "string" || !MCP_SECRET_KEY_RE.test(val.secret)) throw new McpConfigError(`${where}.${k}.secret must be a key of lower-case letters, digits, '_' or '-'`);
      out[k] = { secret: val.secret };
    } else {
      out[k] = { literal: plainText(val, `${where}.${k}`) };
    }
  }
  return out;
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function parseLocal(v: unknown, name: string, where: string): McpServer {
  if (!isObj(v)) throw new McpConfigError(`${where} must be a mapping`);
  keysOnly(v, ["package", "command", "sha256", "args", "env"], where);
  const env = values(v.env, `${where}.env`, ENV_NAME_RE, "an environment variable name");
  if ((v.package === undefined) === (v.command === undefined)) throw new McpConfigError(`${where} needs exactly one of package or command`);
  if (v.package !== undefined) {
    const p = v.package;
    if (!isObj(p)) throw new McpConfigError(`${where}.package must be a mapping`);
    keysOnly(p, ["ecosystem", "name", "version"], `${where}.package`);
    if (p.ecosystem !== "npm" && p.ecosystem !== "pypi") throw new McpConfigError(`${where}.package.ecosystem must be npm or pypi`);
    const nameOk = typeof p.name === "string" && (p.ecosystem === "npm" ? NPM_NAME_RE : PYPI_NAME_RE).test(p.name);
    if (!nameOk) throw new McpConfigError(`${where}.package.name is not a ${p.ecosystem} package name`);
    // YAML reads 1.4 as a number; an exact version must be written as text.
    const version = typeof p.version === "number" ? String(p.version) : p.version;
    const versionOk = typeof version === "string" && (p.ecosystem === "npm" ? NPM_VERSION_RE : PYPI_VERSION_RE).test(version);
    if (!versionOk) throw new McpConfigError(`${where}.package.version must be one exact version (no range, tag or latest)`);
    if (v.sha256 !== undefined) throw new McpConfigError(`${where}.sha256 is only for a command server`);
    const args = v.args === undefined ? [] : v.args;
    if (!Array.isArray(args) || args.length > MAX_ARGS) throw new McpConfigError(`${where}.args must be a list of at most ${MAX_ARGS} strings`);
    return { name, kind: "package", ecosystem: p.ecosystem, package: p.name as string, version: version as string, args: args.map((a, i) => plainText(a, `${where}.args[${i}]`)), env };
  }
  if (v.args !== undefined) throw new McpConfigError(`${where}.args is for a package server; put a command's arguments in command`);
  const cmd = v.command;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > MAX_ARGS) throw new McpConfigError(`${where}.command must be a list of 1 to ${MAX_ARGS} strings`);
  const command = cmd.map((a, i) => plainText(a, `${where}.command[${i}]`));
  if (!isAbsolute(command[0]!)) throw new McpConfigError(`${where}.command[0] must be an absolute path`);
  if (typeof v.sha256 !== "string" || !SHA256_RE.test(v.sha256)) throw new McpConfigError(`${where}.sha256 must be the executable's SHA-256 in lower-case hex`);
  return { name, kind: "command", command, sha256: v.sha256, env };
}

function parseRemote(v: unknown, name: string, where: string): McpServer {
  if (!isObj(v)) throw new McpConfigError(`${where} must be a mapping`);
  keysOnly(v, ["url", "headers"], where);
  const raw = plainText(v.url, `${where}.url`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpConfigError(`${where}.url is not a URL`);
  }
  if (u.protocol !== "https:") throw new McpConfigError(`${where}.url must be https`);
  if (u.username || u.password) throw new McpConfigError(`${where}.url must not hold a user name or password; use headers with a secret`);
  if (u.hash) throw new McpConfigError(`${where}.url must not have a #fragment`);
  return { name, kind: "remote", url: u.href, headers: values(v.headers, `${where}.headers`, HEADER_NAME_RE, "a header name") };
}

/** `mcp_servers` from the manifest; an absent key is an empty list. */
export function parseMcpServers(v: unknown): McpServer[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new McpConfigError("mcp_servers must be a list");
  if (v.length > MAX_MCP_SERVERS) throw new McpConfigError(`mcp_servers may list at most ${MAX_MCP_SERVERS} servers`);
  const seen = new Set<string>();
  return v.map((s, i) => {
    const where = `mcp_servers[${i}]`;
    if (!isObj(s)) throw new McpConfigError(`${where} must be a mapping`);
    keysOnly(s, ["name", "local", "remote"], where);
    if (typeof s.name !== "string" || !MCP_SERVER_NAME_RE.test(s.name)) throw new McpConfigError(`${where}.name must be lower-case letters, digits and '-', starting with a letter, at most 32`);
    if (s.name === RESERVED_SERVER) throw new McpConfigError(`${where}.name: "${RESERVED_SERVER}" is the engine's own server`);
    if (seen.has(s.name)) throw new McpConfigError(`mcp_servers lists '${s.name}' twice`);
    seen.add(s.name);
    if ((s.local === undefined) === (s.remote === undefined)) throw new McpConfigError(`${where} needs exactly one of local or remote`);
    return s.local !== undefined ? parseLocal(s.local, s.name, `${where}.local`) : parseRemote(s.remote, s.name, `${where}.remote`);
  });
}

/** Every literal value, for the credential scan that refuses a secret written in plain text (FR-4). */
export function mcpLiterals(servers: readonly McpServer[]): Array<{ where: string; value: string }> {
  const out: Array<{ where: string; value: string }> = [];
  for (const s of servers) {
    const vals = s.kind === "remote" ? s.headers : s.env;
    const part = s.kind === "remote" ? "headers" : "env";
    for (const [k, v] of Object.entries(vals)) if ("literal" in v) out.push({ where: `mcp_servers[${s.name}].${part}.${k}`, value: v.literal });
  }
  return out;
}

/**
 * What a server is pinned to (SR-3): the record must match this exactly. A
 * remote server's headers and a local server's env aren't part of it; the
 * whole entry is pinned with the owner keys instead (FR-13).
 */
export function mcpIdentity(s: McpServer): string {
  if (s.kind === "package") return `package:${s.ecosystem}:${s.package}@${s.version}`;
  if (s.kind === "command") return `command:${s.sha256}`;
  return `remote:${s.url}`;
}
