// Fake programs the engine runs on the host: gitleaks and a logging `git`
// wrapper. Both are Node scripts with an absolute interpreter path, so they
// work even when the engine clears PATH.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Text a staged blob must contain for the fake scanner to report a leak. */
export const LEAK_MARKER = "FAKE-LEAK-";

export interface GitleaksControl {
  /** Exit code to use instead of 0 / 99. */
  exitCode?: number;
  /** What `gitleaks version` prints. */
  version?: string;
  /** Connect to the engine socket during the scan (AC-4). */
  probeEngineJson?: string;
}

export interface GitleaksRun {
  argv: string[];
  cwd: string;
  cwdEntries: string[] | null;
  env: Record<string, string>;
  staging?: {
    dir: string;
    mode: number;
    files: Array<{ name: string; isFile: boolean; isSymlink: boolean; mode: number; content: string }>;
  };
  configText?: string | null;
  ignoreDirEntries?: string[] | null;
  probe?: string;
  exit: number;
}

const GITLEAKS_SCRIPT = String.raw`
const fs = require("fs"), path = require("path"), net = require("net");
const LOG = __LOG__, CONTROL = __CONTROL__, MARKER = __MARKER__;
const control = fs.existsSync(CONTROL) ? JSON.parse(fs.readFileSync(CONTROL, "utf8")) : {};
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const run = { argv, cwd: process.cwd(), cwdEntries: null, env: { ...process.env }, exit: 0 };
try { run.cwdEntries = fs.readdirSync(process.cwd()); } catch {}
function finish(code, out) {
  run.exit = code;
  fs.appendFileSync(LOG, JSON.stringify(run) + "\n");
  if (out) process.stdout.write(out);
  process.exit(code);
}
async function probe() {
  if (!control.probeEngineJson) return;
  run.probe = await new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = JSON.parse(fs.readFileSync(control.probeEngineJson, "utf8")).path;
      const s = net.createConnection(p);
      let buf = "";
      s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.status" }) + "\n"));
      s.on("data", (d) => { buf += d; if (buf.includes("\n")) { const m = JSON.parse(buf.split("\n")[0]); end(m.result ? "result" : "error"); s.destroy(); } });
      s.on("error", (e) => end("connect-error:" + e.code));
      s.on("close", () => end("closed"));
      setTimeout(() => { end("timeout"); s.destroy(); }, 3000);
    } catch (e) { end("probe-failed:" + e.message); }
  });
}
(async () => {
  if (argv[0] === "version") return finish(0, (control.version || "8.30.1") + "\n");
  await probe();
  if (argv[0] !== "dir") return finish(control.exitCode ?? 1, "");
  const dir = argv[1];
  let leak = false;
  try {
    const st = fs.statSync(dir);
    run.staging = { dir, mode: st.mode & 0o777, files: [] };
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const l = fs.lstatSync(p);
      let content = "";
      if (l.isFile()) content = fs.readFileSync(p).toString("utf8").slice(0, 262144);
      if (content.includes(MARKER)) leak = true;
      run.staging.files.push({ name, isFile: l.isFile(), isSymlink: l.isSymbolicLink(), mode: l.mode & 0o777, content });
    }
  } catch (e) { run.staging = { dir, mode: -1, files: [], error: String(e) }; }
  const cfg = flag("--config");
  run.configText = cfg && fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null;
  const ign = flag("--gitleaks-ignore-path");
  try { run.ignoreDirEntries = ign ? fs.readdirSync(ign) : null; } catch { run.ignoreDirEntries = null; }
  if (control.exitCode !== undefined) return finish(control.exitCode, "");
  if (leak) return finish(99, JSON.stringify([{ RuleID: "generic-api-key", Description: "fake", File: "x", Secret: "REDACTED", Match: "REDACTED", StartLine: 1 }]));
  finish(0, "[]");
})();
`;

export class FakeGitleaks {
  readonly path: string;
  readonly logPath: string;
  readonly controlPath: string;

  constructor(dir: string) {
    this.path = join(dir, "gitleaks");
    this.logPath = join(dir, "gitleaks-runs.jsonl");
    this.controlPath = join(dir, "gitleaks-control.json");
    const body = GITLEAKS_SCRIPT.replace("__LOG__", JSON.stringify(this.logPath))
      .replace("__CONTROL__", JSON.stringify(this.controlPath))
      .replace("__MARKER__", JSON.stringify(LEAK_MARKER));
    writeFileSync(this.path, `#!${process.execPath}\n${body}`);
    chmodSync(this.path, 0o755);
  }

  get sha256(): string {
    return createHash("sha256").update(readFileSync(this.path)).digest("hex");
  }

  control(c: GitleaksControl) {
    writeFileSync(this.controlPath, JSON.stringify(c));
  }

  runs(): GitleaksRun[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  scans(): GitleaksRun[] {
    return this.runs().filter((r) => r.argv[0] !== "version");
  }
}

export interface GitCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

const GIT_WRAPPER = String.raw`
const fs = require("fs"), cp = require("child_process");
const LOG = __LOG__, REAL = __REAL__;
const env = {};
for (const [k, v] of Object.entries(process.env)) if (/^GIT_|^SSH_/.test(k)) env[k] = v;
fs.appendFileSync(LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }) + "\n");
const r = cp.spawnSync(REAL, process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`;

export class GitWrapper {
  readonly path: string;
  readonly logPath: string;

  constructor(dir: string, realGit: string) {
    this.path = join(dir, "git");
    this.logPath = join(dir, "git-calls.jsonl");
    writeFileSync(
      this.path,
      `#!${process.execPath}\n` +
        GIT_WRAPPER.replace("__LOG__", JSON.stringify(this.logPath)).replace("__REAL__", JSON.stringify(realGit)),
    );
    chmodSync(this.path, 0o755);
  }

  calls(): GitCall[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}

/** The effective `-c` and GIT_CONFIG_* settings of one git call. */
export function gitOverrides(call: GitCall): { config: Map<string, string>; subcommand: string | undefined; rest: string[] } {
  const config = new Map<string, string>();
  const a = call.argv;
  let i = 0;
  for (; i < a.length; i++) {
    const x = a[i];
    if (x === "-c") {
      const kv = a[++i] ?? "";
      const eq = kv.indexOf("=");
      config.set((eq < 0 ? kv : kv.slice(0, eq)).toLowerCase(), eq < 0 ? "true" : kv.slice(eq + 1));
    } else if (x === "-C" || x === "--git-dir" || x === "--work-tree" || x === "--exec-path") {
      i++;
    } else if (x.startsWith("--git-dir=") || x.startsWith("--work-tree=") || x.startsWith("--exec-path=")) {
      continue;
    } else if (x.startsWith("-")) {
      continue;
    } else break;
  }
  const n = parseInt(call.env.GIT_CONFIG_COUNT ?? "0", 10);
  for (let k = 0; k < n; k++) {
    const key = call.env[`GIT_CONFIG_KEY_${k}`];
    if (key) config.set(key.toLowerCase(), call.env[`GIT_CONFIG_VALUE_${k}`] ?? "");
  }
  if (call.env.GIT_CONFIG_PARAMETERS) {
    for (const m of call.env.GIT_CONFIG_PARAMETERS.matchAll(/'([^'=]+)'='([^']*)'/g)) config.set(m[1].toLowerCase(), m[2]);
  }
  return { config, subcommand: a[i], rest: a.slice(i + 1) };
}
