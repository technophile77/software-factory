/**
 * Finds the running engine's address (F-005 FR-2, FR-19, SR-1): only from
 * `.factory/engine.json` in the `factory/state` linked worktree of the repo
 * the owner's Claude Code session is in. A repo can track its own `.factory/`
 * or make it a link, to point the session at a socket of its choosing
 * (F-003 Code Review R2-5), so only the worktree git registered is trusted.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Refused } from "./errors";
import { CAPABILITY_RE, ENGINE_VERSION_RE, MAX_ENGINE_JSON, STATE_BRANCH } from "./limits";

export interface EngineAddress {
  address: string;
  pid: number;
  /** Channel minor version, from "1.<minor>". */
  minor: number;
  capabilities: ReadonlySet<string>;
}

const WINDOWS = process.platform === "win32";

function euid(): number {
  return process.geteuid!();
}

/** git's exit code and stdout; code null when git couldn't run or timed out. */
export function gitRc(where: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve) => {
    // The repo's own config could name commands for git to run.
    execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", where, ...args],
      { encoding: "buffer", timeout: Math.max(1000, timeoutMs), maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, out: stdout });
        const code = (err as { code?: unknown }).code;
        resolve({ code: typeof code === "number" && !(err as { killed?: boolean }).killed ? code : null, out: Buffer.alloc(0) });
      });
  });
}

async function worktrees(cwd: string, timeoutMs: number): Promise<Array<Record<string, string>>> {
  const { code, out } = await gitRc(cwd, ["worktree", "list", "--porcelain", "-z"], timeoutMs);
  if (code !== 0) {
    throw new Refused("not_in_repo", "This folder is not inside a git repository, so there is no factory/state worktree to read.");
  }
  const entries: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  for (const field of out.toString("utf8").split("\0")) {
    if (!field) {
      if (Object.keys(cur).length) entries.push(cur);
      cur = {};
      continue;
    }
    const sp = field.indexOf(" ");
    cur[sp < 0 ? field : field.slice(0, sp)] = sp < 0 ? "" : field.slice(sp + 1);
  }
  if (Object.keys(cur).length) entries.push(cur);
  return entries;
}

function requireOwnerOnly(st: fs.Stats, p: string, name: string): void {
  if (st.uid !== euid()) throw new Refused("not_owner", `${name} is not owned by you, so the engine address in it can't be trusted.`);
  if (st.mode & 0o022) {
    // Common with umask 002, so the owner gets the cause and the fix.
    throw new Refused("group_writable", `${name} can be written by your group or other users, so the engine `
      + `address in it can't be trusted. Run \`chmod go-w ${p}\` and try again.`);
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Path of the trusted engine.json: `<main worktree>/.factory/engine.json`. */
export async function findEngineFile(cwd: string, timeoutMs: number): Promise<string> {
  const entries = await worktrees(cwd, timeoutMs);
  const main = entries[0];
  if (!main || "bare" in main || !main.worktree) throw new Refused("not_in_repo", "No main worktree found for this repository.");
  const factory = path.join(main.worktree, ".factory");
  const fail = "The engine address is trusted only from .factory/engine.json in this repo's factory/state worktree";
  let fst: fs.Stats;
  try {
    fst = fs.lstatSync(factory);
  } catch {
    throw new Refused("not_state_worktree", `${fail}; .factory does not exist. Is the repo onboarded?`);
  }
  if (fst.isSymbolicLink()) throw new Refused("not_state_worktree", `${fail}; .factory is a symbolic link.`);
  if (!fst.isDirectory()) throw new Refused("not_state_worktree", `${fail}; .factory does not exist. Is the repo onboarded?`);
  const real = realpath(factory);
  const same = (a: string, b: string) => (WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);
  const state = entries.slice(1).filter((e) => e.branch === STATE_BRANCH && e.worktree);
  if (!state.some((e) => same(realpath(e.worktree!), real))) throw new Refused("not_state_worktree", `${fail}; .factory is not that worktree.`);
  // Someone else who can write here could swap engine.json after the checks.
  if (!WINDOWS) requireOwnerOnly(fst, factory, ".factory");
  const file = path.join(factory, "engine.json");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new Refused("engine_not_running", "Engine not reachable: the engine isn't running (factory/state has no engine.json).");
  }
  if (st.isSymbolicLink()) throw new Refused("not_state_worktree", `${fail}; engine.json is a symbolic link.`);
  if (!st.isFile() || st.size > MAX_ENGINE_JSON) throw new Refused("bad_engine_file", "engine.json is not a small regular file.");
  if (!WINDOWS && st.uid !== euid()) throw new Refused("bad_engine_file", "engine.json is not owned by you.");
  // The engine writes it untracked; a committed one came from someone else.
  // Only git's "not tracked" (exit 1) passes: an error must not read as untracked.
  const { code } = await gitRc(factory, ["ls-files", "--error-unmatch", "--", "engine.json"], timeoutMs);
  if (code === 0) throw new Refused("bad_engine_file", "engine.json is committed on factory/state; the engine never commits it.");
  if (code !== 1) throw new Refused("bad_engine_file", "git couldn't say whether engine.json is committed.");
  return file;
}

/**
 * Reads engine.json through one descriptor, so a file swapped in after
 * findEngineFile's checks is caught too; O_NONBLOCK keeps a swapped-in FIFO
 * from hanging the open.
 */
export function readEngineAddress(file: string): EngineAddress {
  const c = fs.constants;
  const flags = c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(file, flags);
  } catch {
    throw new Refused("bad_engine_file", "engine.json can't be opened.");
  }
  let raw: Buffer;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_ENGINE_JSON) throw new Refused("bad_engine_file", "engine.json is not a small regular file.");
    if (!WINDOWS) requireOwnerOnly(st, file, "engine.json");
    const buf = Buffer.alloc(MAX_ENGINE_JSON + 1);
    let n = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n >= buf.length) break;
    }
    raw = buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Refused("bad_engine_file", "engine.json can't be read as JSON.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Refused("bad_engine_file", "engine.json is not a JSON object.");
  const d = data as Record<string, unknown>;
  const m = typeof d.version === "string" ? ENGINE_VERSION_RE.exec(d.version) : null;
  if (!m) throw new Refused("bad_engine_file", "engine.json is not from an engine speaking channel v1.1 or a later 1.x.");
  if (typeof d.pid !== "number" || !Number.isInteger(d.pid) || d.pid <= 0) throw new Refused("bad_engine_file", "engine.json has no valid pid.");
  if (typeof d.path !== "string" || !d.path) throw new Refused("bad_engine_file", "engine.json has no channel path.");
  // Channel v1.4: what the engine accepts beyond its version. Absent means none.
  const caps = d.capabilities ?? [];
  if (!Array.isArray(caps) || caps.length > 32 || !caps.every((x) => typeof x === "string" && CAPABILITY_RE.test(x))) {
    throw new Refused("bad_engine_file", "engine.json has a capability list that isn't a short list of plain names.");
  }
  return { address: d.path, pid: d.pid, minor: Number(m[1]), capabilities: new Set(caps as string[]) };
}
