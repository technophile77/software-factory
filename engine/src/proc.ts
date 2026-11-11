import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every process the engine starts goes through here: absolute path, an
 * argument array, no shell, an environment built from scratch. The pids are
 * kept so the channel can refuse a connection from one of them (channel
 * v1.1 access rule: no agent processes the engine started).
 */
export class Children {
  private readonly live = new Set<number>();

  constructor(private readonly parentOf: (pid: number) => number | null = linuxParent) {}

  add(pid: number): void {
    this.live.add(pid);
  }
  remove(pid: number): void {
    this.live.delete(pid);
  }

  /** True if `pid` is one of ours or a descendant of this engine. */
  startedByEngine(pid: number, enginePid = process.pid): boolean {
    if (this.live.has(pid)) return true;
    let cur = pid;
    for (let i = 0; i < 64 && cur > 1; i++) {
      const parent = this.parentOf(cur);
      if (parent === null) return false;
      if (parent === enginePid || this.live.has(parent)) return true;
      cur = parent;
    }
    return false;
  }
}

/**
 * How the channel walks a peer's ancestry on this OS: /proc on Linux,
 * proc_pidinfo on macOS, a Toolhelp snapshot on Windows. A failed FFI call
 * throws, and the channel refuses the peer (SR-15).
 */
export function osParent(os: { platform: NodeJS.Platform; unix(): { parentPid?(pid: number): number | null }; windows(): { parentPid?(pid: number): number | null } }): (pid: number) => number | null {
  if (os.platform === "darwin" || os.platform === "win32") {
    return (pid) => {
      const api = os.platform === "win32" ? os.windows() : os.unix();
      if (!api.parentPid) throw new Error("no parent lookup on this OS");
      return api.parentPid(pid);
    };
  }
  return linuxParent;
}

export function linuxParent(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may itself hold spaces or parentheses.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: Buffer | string;
  timeoutMs?: number;
  maxStdout?: number;
}

/** Variables a child may inherit, so proxies and Windows system paths still work. */
export function baseEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (from[k] !== undefined) env[k] = from[k];
  return env;
}

export function runFixed(binary: string, args: string[], opts: RunOptions, children: Children): Promise<RunResult> {
  if (!path.isAbsolute(binary)) return Promise.reject(new Error("programs run by absolute path only"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) children.add(child.pid);
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let timedOut = false;
    const max = opts.maxStdout ?? 64 * 1024 * 1024;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > max) {
        child.kill("SIGKILL");
        return;
      }
      out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 8192) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if (child.pid) children.remove(child.pid);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (child.pid) children.remove(child.pid);
      if (outLen > max) return reject(new Error("output over the limit"));
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: err, timedOut });
    });
    child.stdin.on("error", () => {
      // The child may exit before reading its input; its exit code says what happened.
    });
    child.stdin.end(opts.input ?? "");
  });
}
