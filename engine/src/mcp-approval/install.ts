import * as fs from "node:fs";
import * as path from "node:path";
import { findOnPath, sha256Hex } from "../fsutil";
import type { McpServer } from "../config/mcp-servers";
import { mcpIdentity } from "../config/mcp-servers";
import { Children, baseEnv, runFixed } from "../proc";
import { INSTALL_SCHEMA } from "../agent/project-mcp";
import type { McpInstall } from "../agent/project-mcp";

/**
 * F-025 SR-5, SR-13: a local server is installed once, at approval, into a
 * folder of its own; every session starts it from there and checks the
 * pinned file first. Package installs run with install scripts off and with
 * a home of their own, so the owner's `.npmrc`, pip config and caches are
 * neither read nor changed.
 */

export class McpInstallError extends Error {
  override name = "McpInstallError";
}

export interface Installed {
  dir: string;
  install: McpInstall;
  /** SHA-256 of the pinned file: the lockfile, or the copied executable. */
  pinnedSha256: string;
  /** For the CVE scan: every package in the lockfile. */
  packages: Array<{ ecosystem: "npm" | "PyPI"; name: string; version: string }>;
}

export interface InstallOptions {
  mcpRoot: string;
  project: string;
  env: NodeJS.ProcessEnv;
  children: Children;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Tests replace the tools; by default npm comes with this Node and uv from PATH. */
  npmCli?: string;
  uv?: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** npm's own script beside this Node, run with this Node: no `.cmd` shim, so no shell on Windows. */
export function npmCliPath(node: string = process.execPath, platform: NodeJS.Platform = process.platform): string | null {
  const dir = path.dirname(node);
  const candidates = platform === "win32"
    ? [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
    : [path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function toolEnv(o: InstallOptions, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv(o.env), HOME: home, USERPROFILE: home, npm_config_cache: path.join(home, ".npm"), npm_config_userconfig: path.join(home, ".npmrc"), UV_CACHE_DIR: path.join(home, ".uv-cache"), UV_NO_CONFIG: "1" };
  if ((o.platform ?? process.platform) === "win32") for (const k of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "windir"]) if (o.env[k]) env[k] = o.env[k];
  return env;
}

async function run(o: InstallOptions, bin: string, args: string[], cwd: string, home: string, what: string): Promise<string> {
  const r = await runFixed(bin, args, { cwd, env: toolEnv(o, home), timeoutMs: o.timeoutMs ?? 10 * 60_000, maxStdout: 16 * 1024 * 1024 }, o.children);
  if (r.timedOut) throw new McpInstallError(`${what} timed out`);
  // Its output can name the registry and paths; the owner reads the log on the PC, not on GitHub.
  if (r.code !== 0) throw new McpInstallError(`${what} failed (exit ${r.code ?? r.signal}): ${r.stderr.slice(-500)}`);
  return r.stdout.toString("utf8");
}

/** The package's command: its `bin` entry named like the package, or its only one. */
function npmBin(dir: string, name: string): string {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8"));
  } catch {
    throw new McpInstallError(`${name} wasn't installed`);
  }
  const bin = isObj(pkg) ? pkg.bin : undefined;
  const short = name.split("/").pop()!;
  const entry = typeof bin === "string" ? bin : isObj(bin) ? (typeof bin[short] === "string" ? bin[short] : Object.values(bin).length === 1 ? Object.values(bin)[0] : undefined) : undefined;
  if (typeof entry !== "string") throw new McpInstallError(`${name} has no single command to start (its package.json bin)`);
  const rel = path.posix.normalize(["node_modules", ...name.split("/"), entry].join("/"));
  if (!rel.startsWith("node_modules/") || rel.includes("..")) throw new McpInstallError(`${name}'s bin points outside the package`);
  return rel;
}

export function npmLockPackages(lock: unknown): Installed["packages"] {
  const out: Installed["packages"] = [];
  const pkgs = isObj(lock) && isObj(lock.packages) ? lock.packages : {};
  for (const [p, v] of Object.entries(pkgs)) {
    if (!p.includes("node_modules/") || !isObj(v) || typeof v.version !== "string") continue;
    out.push({ ecosystem: "npm", name: p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length), version: v.version });
  }
  return out;
}

export function pipLockPackages(text: string): Installed["packages"] {
  const out: Installed["packages"] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)/.exec(line.trim());
    if (m) out.push({ ecosystem: "PyPI", name: m[1]!, version: m[2]! });
  }
  return out;
}

/** The console scripts a wheel declares, from its dist-info. */
function pipScripts(venv: string, name: string, platform: NodeJS.Platform): string[] {
  const libs = platform === "win32" ? [path.join(venv, "Lib", "site-packages")] : fs.readdirSync(path.join(venv, "lib")).map((d) => path.join(venv, "lib", d, "site-packages"));
  const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "_");
  for (const lib of libs) {
    for (const d of fs.existsSync(lib) ? fs.readdirSync(lib) : []) {
      if (!d.endsWith(".dist-info") || norm(d.split("-")[0]!) !== norm(name)) continue;
      const ep = path.join(lib, d, "entry_points.txt");
      if (!fs.existsSync(ep)) return [];
      const text = fs.readFileSync(ep, "utf8");
      const section = /\[console_scripts\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? "";
      return section.split(/\r?\n/).map((l) => l.split("=")[0]!.trim()).filter((s) => /^[A-Za-z0-9._-]+$/.test(s));
    }
  }
  return [];
}

/** Installs a local server for approval into a fresh folder, replacing what was there only once the new install is complete. */
export async function installForApproval(s: Exclude<McpServer, { kind: "remote" }>, o: InstallOptions): Promise<Installed> {
  const platform = o.platform ?? process.platform;
  const final = path.join(o.mcpRoot, o.project, s.name);
  const stage = `${final}.new`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const home = path.join(stage, "home");
  fs.mkdirSync(home, { recursive: true });
  try {
    let install: McpInstall;
    let packages: Installed["packages"] = [];
    if (s.kind === "command") {
      // SR-13: the approved bytes are a copy the engine owns, so a later change to the original can't run.
      const bytes = fs.readFileSync(s.command[0]!);
      if (sha256Hex(bytes) !== s.sha256) throw new McpInstallError(`${s.command[0]} doesn't match the manifest's sha256`);
      fs.mkdirSync(path.join(stage, "bin"));
      const copy = path.join("bin", path.basename(s.command[0]!));
      fs.writeFileSync(path.join(stage, copy), bytes, { mode: 0o700 });
      install = { schema: INSTALL_SCHEMA, identity: mcpIdentity(s), command: [copy.split(path.sep).join("/")], pinned_file: copy.split(path.sep).join("/") };
    } else if (s.ecosystem === "npm") {
      const cli = o.npmCli ?? npmCliPath();
      if (!cli) throw new McpInstallError("npm wasn't found beside this Node");
      fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: `factory-mcp-${s.name}`, private: true, dependencies: { [s.package]: s.version } }, null, 2));
      await run(o, process.execPath, [cli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"], stage, home, "npm install");
      const lock = JSON.parse(fs.readFileSync(path.join(stage, "package-lock.json"), "utf8")) as unknown;
      packages = npmLockPackages(lock);
      install = { schema: INSTALL_SCHEMA, identity: mcpIdentity(s), command: ["node", `./${npmBin(stage, s.package)}`], pinned_file: "package-lock.json" };
    } else {
      const uv = o.uv === undefined ? findOnPath("uv", o.env, platform) : o.uv;
      if (!uv) throw new McpInstallError("uv isn't on PATH; it installs Python MCP servers with hashes (https://docs.astral.sh/uv/)");
      fs.writeFileSync(path.join(stage, "requirements.in"), `${s.package}==${s.version}\n`);
      await run(o, uv, ["pip", "compile", "--generate-hashes", "--quiet", "requirements.in", "-o", "requirements.txt"], stage, home, "uv pip compile");
      await run(o, uv, ["venv", "--quiet", ".venv"], stage, home, "uv venv");
      await run(o, uv, ["pip", "sync", "--require-hashes", "--quiet", "--python", path.join(".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python"), "requirements.txt"], stage, home, "uv pip sync");
      packages = pipLockPackages(fs.readFileSync(path.join(stage, "requirements.txt"), "utf8"));
      const scripts = pipScripts(path.join(stage, ".venv"), s.package, platform);
      const norm = (x: string) => x.toLowerCase().replace(/[-_.]+/g, "-");
      const script = scripts.find((x) => norm(x) === norm(s.package)) ?? (scripts.length === 1 ? scripts[0] : undefined);
      if (!script) throw new McpInstallError(`${s.package} has no single console script to start`);
      const bin = platform === "win32" ? `.venv/Scripts/${script}.exe` : `.venv/bin/${script}`;
      install = { schema: INSTALL_SCHEMA, identity: mcpIdentity(s), command: [bin], pinned_file: "requirements.txt" };
    }
    fs.writeFileSync(path.join(stage, "install.json"), JSON.stringify(install, null, 2));
    const pinnedSha256 = sha256Hex(fs.readFileSync(path.join(stage, ...install.pinned_file.split("/"))));
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(stage, final);
    return { dir: final, install, pinnedSha256, packages };
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e instanceof McpInstallError ? e : new McpInstallError((e as Error).message.slice(0, 300));
  }
}
