import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Children } from "./proc";

/** The reader got out of step, died or timed out; the caller makes the read with a plain git call instead (F-014 FR-2). */
export class ReaderBroken extends Error {
  override name = "ReaderBroken";
}

/** A name the reader isn't given (SR-2); the plain call handles it, and the reader isn't counted as broken. */
export class NotForReader extends ReaderBroken {
  override name = "NotForReader";
}

export interface ReaderObject {
  sha: string;
  type: string;
  size: number;
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  name: string;
}

export interface ReaderOptions {
  gitPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  children: Children;
  idleMs: number;
  timeoutMs: number;
  onSpawn?: () => void;
}

const HEX_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
// Object names the engine sends: ids and validated ref names, never paths (F-014 SR-2).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*(?:\^\{(?:commit|tree)\})?$/;

/**
 * One `git cat-file --batch-command` for one repo (F-014 FR-1), started on
 * the first read and closed after `idleMs` without one, so a Windows `git gc`
 * the owner runs isn't kept from deleting packs for long (OQ-1). Like
 * `cat-file blob` it applies no filters or textconv. Requests go one at a
 * time; any reply that isn't exactly what was asked for kills the process.
 */
export class CatFileReader {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private dead: Error | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  constructor(private readonly o: ReaderOptions) {}

  /** The object's id, type and size, or null if git has no object by that name. */
  info(name: string): Promise<ReaderObject | null> {
    return this.serial(async () => {
      return this.ask(`info ${checkName(name)}`, name);
    });
  }

  /** The object's header and body; null if missing. A body over `limit` is never read: the reader is closed instead. */
  contents(name: string, limit: number): Promise<(ReaderObject & { body: Buffer }) | null> {
    return this.serial(async () => {
      // Info first, so a body over the limit never reaches memory (SR-6).
      const head = await this.ask(`info ${checkName(name)}`, name);
      if (!head) return null;
      if (head.size > limit) throw new ReaderLimit(head);
      const again = await this.ask(`contents ${head.sha}`, head.sha);
      if (!again || again.sha !== head.sha || again.type !== head.type || again.size !== head.size) this.fail("the object changed between two replies");
      const body = await this.take(head.size + 1);
      if (body[head.size] !== 0x0a) this.fail("a reply body wasn't followed by a newline");
      return { ...head, body: Buffer.from(body.subarray(0, head.size)) };
    });
  }

  /**
   * Ends the reader by closing its input, so git exits by itself. Killing it
   * would not be enough on Windows: Git for Windows' `cmd\git.exe` and
   * `bin\git.exe` are launchers, and a killed launcher leaves the real git
   * running in the repo, which keeps the folder from being deleted. Resolves
   * when the process is gone, killing it after `graceMs` as a last resort.
   */
  close(graceMs = 2000): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const c = this.child;
    this.child = null;
    if (!c) return Promise.resolve();
    // A read still waiting (an engine stop mid-read) fails over rather than hanging.
    this.dead = new ReaderBroken("the reader was closed");
    this.wake?.();
    return endProcess(c, graceMs);
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.idle) clearTimeout(this.idle);
      this.idle = null;
      this.start();
      this.ref(true);
      const timer = setTimeout(() => this.breakOff("the reader timed out"), this.o.timeoutMs);
      try {
        return await f();
      } finally {
        clearTimeout(timer);
        if (this.child) {
          this.ref(false);
          this.idle = setTimeout(() => void this.close(), this.o.idleMs);
          this.idle.unref();
        }
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private start(): void {
    if (this.child) return;
    this.buf = Buffer.alloc(0);
    this.dead = null;
    const child = spawn(this.o.gitPath, [...this.o.args, "cat-file", "--batch-command"], {
      cwd: this.o.cwd,
      env: this.o.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.o.onSpawn?.();
    this.child = child;
    const pid = child.pid;
    if (pid) this.o.children.add(pid);
    child.stdout.on("data", (d: Buffer) => {
      // Output of a reader already given up on must never reach the next one (Gate 2 M2).
      if (this.child !== child) return;
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.wake?.();
    });
    // git writes nothing on stderr in batch mode unless something is wrong; draining it keeps the pipe from filling.
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => undefined);
    const gone = () => {
      if (pid) this.o.children.remove(pid);
      if (this.child === child) {
        this.child = null;
        this.dead = new ReaderBroken("the reader exited");
        this.wake?.();
      }
    };
    child.on("error", gone);
    child.on("close", gone);
    // The pid is dropped on exit too: a launcher's git can hold the pipes open after the launcher has gone.
    child.once("exit", () => {
      if (pid) this.o.children.remove(pid);
    });
  }

  /** Keeps the engine's event loop alive only while a read is waiting. */
  private ref(on: boolean): void {
    const c = this.child;
    if (!c) return;
    const streams = [c.stdin, c.stdout, c.stderr] as unknown as Array<{ ref?(): void; unref?(): void }>;
    if (on) {
      c.ref();
      for (const s of streams) s.ref?.();
    } else {
      c.unref();
      for (const s of streams) s.unref?.();
    }
  }

  private fail(why: string): never {
    throw this.breakOff(`the reader got out of step: ${why}`);
  }

  /** Kills the process; a read waiting on it fails with ReaderBroken (SR-7). */
  private breakOff(why: string): ReaderBroken {
    const c = this.child;
    this.child = null;
    this.buf = Buffer.alloc(0);
    if (c) {
      // Killed before the fallback runs (SR-7). Its input is closed first, so on
      // Windows a real git behind a killed launcher still sees end of input.
      c.stdout.removeAllListeners("data");
      c.stdin.destroy();
      c.kill("SIGKILL");
    }
    this.dead = new ReaderBroken(why);
    this.wake?.();
    return this.dead;
  }

  /** Sends one command and parses the header line; `want` is what the header must name (SR-6). */
  private async ask(cmd: string, want: string): Promise<ReaderObject | null> {
    const c = this.child;
    if (!c) throw this.dead ?? new ReaderBroken("the reader isn't running");
    c.stdin.write(cmd + "\n");
    const line = (await this.takeLine()).toString("utf8");
    if (line === `${want} missing` || line === `${want} ambiguous`) return null;
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit|tag) (\d{1,15})$/.exec(line);
    if (!m) this.fail("an unexpected header");
    if (HEX_RE.test(want) && m[1] !== want) this.fail("a reply for another object");
    return { sha: m[1]!, type: m[2]!, size: Number(m[3]) };
  }

  private async takeLine(): Promise<Buffer> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        if (nl > 4096) this.fail("a header line too long");
        const line = this.buf.subarray(0, nl);
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (this.buf.length > 4096) this.fail("a header line too long");
      await this.more();
    }
  }

  private async take(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private more(): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    if (!this.child) return Promise.reject(new ReaderBroken("the reader isn't running"));
    return new Promise<void>((resolve, reject) => {
      this.wake = () => {
        this.wake = null;
        if (this.dead) reject(this.dead);
        else resolve();
      };
    });
  }
}

function endProcess(c: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => c.kill("SIGKILL"), graceMs);
    c.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    c.stdin.end();
  });
}

/** The body was over the read's limit. Not a broken reader: the read fails as an oversized read does today. */
export class ReaderLimit extends Error {
  override name = "ReaderLimit";
  constructor(readonly object: ReaderObject) {
    super("object over the read limit");
  }
}

function checkName(name: string): string {
  if (!NAME_RE.test(name) || name.includes("..") || name.length > 1024) throw new NotForReader("not a name the reader takes");
  return name;
}

/**
 * Parses a raw tree object (F-014 SR-5). Git doesn't check fetched trees
 * unless fsck runs on fetch, so a crafted one is refused as a whole: an
 * empty, `.`, `..` or `/`-holding name, a repeated name, a mode git
 * wouldn't write, an id of the wrong length, or entries out of git's sort
 * order (names compared as bytes, a folder's as if it ended in `/`). Modes come back as `ls-tree`
 * prints them.
 */
export function parseTree(body: Buffer, idBytes: number): TreeEntry[] {
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  let prev: Buffer | null = null;
  let at = 0;
  while (at < body.length) {
    const sp = body.indexOf(0x20, at);
    const nul = sp < 0 ? -1 : body.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 1 + idBytes > body.length) throw new TreeError("a tree entry is cut short");
    const mode = canonMode(body.subarray(at, sp).toString("latin1"));
    const nameBuf = body.subarray(sp + 1, nul);
    const name = nameBuf.toString("utf8");
    if (!nameBuf.length || name === "." || name === ".." || nameBuf.includes(0x2f) || !Buffer.from(name, "utf8").equals(nameBuf)) {
      throw new TreeError("a tree entry has a name git wouldn't write");
    }
    if (seen.has(name)) throw new TreeError("a tree names the same entry twice");
    seen.add(name);
    // Out of git's order, plain git would miss an entry the engine finds (Gate 2 L2, SR-5 v7).
    const key = mode.type === "tree" ? Buffer.concat([nameBuf, SLASH]) : nameBuf;
    if (prev && Buffer.compare(prev, key) >= 0) throw new TreeError("a tree's entries aren't in git's order");
    prev = key;
    const sha = body.subarray(nul + 1, nul + 1 + idBytes).toString("hex");
    out.push({ mode: mode.mode, type: mode.type, sha, name });
    at = nul + 1 + idBytes;
  }
  return out;
}

const SLASH = Buffer.from("/");

export class TreeError extends Error {
  override name = "TreeError";
}

function canonMode(raw: string): { mode: string; type: string } {
  if (!/^[0-7]{5,6}$/.test(raw)) throw new TreeError("a tree entry has a mode git wouldn't write");
  const m = parseInt(raw, 8);
  switch (m & 0o170000) {
    case 0o100000:
      return { mode: m & 0o100 ? "100755" : "100644", type: "blob" };
    case 0o120000:
      return { mode: "120000", type: "blob" };
    case 0o040000:
      return { mode: "040000", type: "tree" };
    case 0o160000:
      return { mode: "160000", type: "commit" };
    default:
      throw new TreeError("a tree entry has a mode git wouldn't write");
  }
}
