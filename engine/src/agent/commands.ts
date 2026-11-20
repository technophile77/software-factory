import { execFile, spawn } from "node:child_process";
import * as path from "node:path";

/**
 * F-015 FR-20: the processes a session's Claude Code started, found by parent
 * pid and killed with their whole trees. Claude Code's own command timeout
 * kills only the shell on Windows; a child the command started keeps the
 * tool's output open, and the tool call never returns.
 */
export interface ProcessRow {
  pid: number;
  ppid: number;
}

export interface ProcessOps {
  /** Every process on the machine with its parent; Windows keeps an orphan's parent pid after the parent exits. */
  list(): Promise<ProcessRow[]>;
  /** Kills `pid` and every process under it. */
  killTree(pid: number): Promise<void>;
  /** POSIX: kills the process group led by `pid`, which holds what the session started even after re-parenting. */
  killGroup?(pid: number): void;
}

/** Everything under `root` (not `root`), deepest last. */
export function descendants(rows: ProcessRow[], root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const r of rows) if (r.pid !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      queue.push(k);
    }
  }
  return out;
}

/**
 * Kills every process under `root` but `root` itself. On Windows each direct
 * child is ended with its tree; elsewhere each descendant is killed, deepest
 * first. Returns how many processes were found.
 */
export async function killUnder(ops: ProcessOps, root: number): Promise<number> {
  const rows = await ops.list();
  const under = descendants(rows, root);
  const direct = rows.filter((r) => r.ppid === root && r.pid !== root).map((r) => r.pid);
  for (const pid of direct) await ops.killTree(pid).catch(() => undefined);
  return under.length;
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (e, out) => (e ? reject(e) : resolve(String(out))));
  });

function parseRows(text: string, sep: RegExp): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [a, b] = line.trim().split(sep);
    const pid = Number(a);
    const ppid = Number(b);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0) rows.push({ pid, ppid });
  }
  return rows;
}

export function realProcessOps(platform: NodeJS.Platform = process.platform): ProcessOps {
  if (platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const ps = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      list: async () =>
        parseRows(await run(ps, ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }"]), /,/),
      killTree: (pid) =>
        new Promise((resolve) => {
          const k = spawn(path.join(root, "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { shell: false, windowsHide: true, stdio: "ignore" });
          k.on("error", () => resolve());
          k.on("exit", () => resolve());
        }),
    };
  }
  return {
    list: async () => parseRows(await run("ps", ["-A", "-o", "pid=,ppid="]), /\s+/),
    killTree: async (pid) => {
      const under = descendants(await run("ps", ["-A", "-o", "pid=,ppid="]).then((t) => parseRows(t, /\s+/)), pid);
      for (const p of [pid, ...under].reverse()) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
    killGroup: (pid) => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // No such group: nothing is left in it.
      }
    },
  };
}
