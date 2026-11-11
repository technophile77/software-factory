import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_BRANCH } from "../constants";
import { ensureOwnerDir, realPath, writeFileAtomic } from "../fsutil";
import { Git, GitError } from "../git";
import { Blob, ScanError, SecretsScanner } from "../gitleaks";
import { Logger } from "../log";

const STATE_REF = `refs/heads/${STATE_BRANCH}`;
const ZERO = "0".repeat(40);
const REMOTE_REF = `refs/remotes/origin/${STATE_BRANCH}`;

export class SecretFound extends Error {
  override name = "SecretFound";
  constructor(readonly paths: string[], readonly rules: string[]) {
    super("The secrets scan found a secret; nothing was committed.");
  }
}

export interface Change {
  /** Path relative to the `.factory` worktree, `/`-separated. */
  path: string;
  content: Buffer | string;
}

/** The id git gives a blob: the hash of `blob <size>\0` and the content, in the repo's object format. */
export function blobId(algo: "sha1" | "sha256", content: Buffer): string {
  return crypto.createHash(algo).update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** A path the engine writes on factory/state: plain segments, never into .git. */
export function checkStatePath(p: string): void {
  const segs = p.split("/");
  if (
    p.length === 0 || p.length > 400 || p.includes("\\") || p.includes("\0") || path.isAbsolute(p) ||
    segs.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")
  ) {
    throw new GitError(`unsafe state path ${JSON.stringify(p)}`);
  }
}

/**
 * The engine's view of one repo's `factory/state` branch, checked out at
 * `.factory/` (ADR 0009). Reads come from the branch's commit, never the
 * working files; writes are plumbing commits made only after the secrets
 * scan passes on the exact blobs (FR-11, SR-11, SR-12).
 */
export class StateRepo {
  readonly factoryDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly git: Git,
    private readonly scanner: SecretsScanner,
    readonly repoRoot: string,
    private readonly log: Logger,
    private readonly tmpDir: string,
  ) {
    this.factoryDir = path.join(repoRoot, ".factory");
  }

  /** Checks out factory/state at .factory where missing, and checks an existing one is that worktree. */
  async ensureWorktree(): Promise<void> {
    let exists = false;
    try {
      const st = fs.lstatSync(this.factoryDir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new GitError(".factory is not a plain folder");
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (exists) {
      await this.checkRegistered();
    } else {
      await this.createWorktree();
    }
    if (process.platform !== "win32") fs.chmodSync(this.factoryDir, 0o700);
  }

  private async checkRegistered(): Promise<void> {
    const out = await this.git.out(this.repoRoot, ["worktree", "list", "--porcelain", "-z"]);
    const real = realPath(this.factoryDir);
    let wt: string | null = null;
    for (const field of out.split("\0")) {
      if (field.startsWith("worktree ")) wt = field.slice(9);
      else if (field === `branch ${STATE_REF}` && wt && safeReal(wt) === real) return;
    }
    throw new GitError(".factory is not this repo's factory/state worktree");
  }

  private async createWorktree(): Promise<void> {
    if (!(await this.git.revParse(this.repoRoot, STATE_REF))) {
      const remote = await this.git.revParse(this.repoRoot, `refs/remotes/origin/${STATE_BRANCH}`);
      if (remote) {
        await this.git.run(this.repoRoot, ["update-ref", STATE_REF, remote, ZERO]);
      } else {
        const tree = await this.git.out(this.repoRoot, ["mktree"], { input: "" });
        const commit = await this.git.out(this.repoRoot, ["commit-tree", tree, "-F", "-"], { input: "factory/state: start\n" });
        await this.git.run(this.repoRoot, ["update-ref", STATE_REF, commit, ZERO]);
      }
    }
    await this.git.run(this.repoRoot, ["worktree", "add", "--no-checkout", this.factoryDir, STATE_BRANCH]);
    await this.git.run(this.factoryDir, ["read-tree", "HEAD"]);
    // Files are written by the engine itself from the blobs, so no checkout
    // filter or attribute from the branch runs on the host.
    for (const e of await this.git.lsTree(this.factoryDir, "HEAD")) {
      try {
        checkStatePath(e.path);
      } catch {
        this.log.warn(`factory/state holds an unsafe path; it was not checked out (${this.repoRoot})`);
        continue;
      }
      if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) continue;
      this.writeWorking(e.path, await this.git.catBlob(this.factoryDir, e.sha));
    }
  }

  private writeWorking(rel: string, content: Buffer): void {
    const file = path.join(this.factoryDir, ...rel.split("/"));
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const real = realPath(dir);
    const root = realPath(this.factoryDir);
    if (real !== root && !real.startsWith(root + path.sep)) throw new GitError("state path leaves .factory");
    writeFileAtomic(file, content);
  }

  async head(): Promise<string> {
    const sha = await this.git.revParse(this.repoRoot, STATE_REF);
    if (!sha) throw new GitError("factory/state is missing");
    return sha;
  }

  async read(rel: string, commit?: string): Promise<Buffer | null> {
    checkStatePath(rel);
    return this.git.readBlob(this.repoRoot, commit ?? (await this.head()), rel);
  }

  async list(dir: string, commit?: string): Promise<Array<{ path: string; sha: string; mode: string; type: string }>> {
    checkStatePath(dir);
    return this.git.lsTree(this.repoRoot, commit ?? (await this.head()), dir);
  }

  /** Commits `changes` on factory/state, one at a time per repo. Resolves to the new commit. */
  commit(changes: Change[], message: string): Promise<string> {
    return this.serial(() => this.commitNow(changes, message));
  }

  /** Every change to the factory/state ref goes through one queue, so none sees another half done. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One commit on factory/state. Every git process counts here (a transcript
   * commit runs on each owner reply and tool call, and process starts are
   * slow on Windows), so the blobs are hashed in-process and scanned before
   * any is written: refused text never becomes a git object, and nothing has
   * to be removed again. The id git returns on writing must match the one
   * scanned, so the scan saw exactly what the commit holds.
   */
  private async commitNow(changes: Change[], message: string): Promise<string> {
    if (changes.length === 0) throw new GitError("nothing to commit");
    for (const c of changes) checkStatePath(c.path);
    const parent = await this.head();
    const algo = parent.length === 64 ? "sha256" : "sha1";
    const blobs: Array<Blob & { path: string }> = changes.map((c) => {
      const content = typeof c.content === "string" ? Buffer.from(c.content, "utf8") : c.content;
      return { sha: blobId(algo, content), path: c.path, content };
    });
    let result;
    try {
      result = await this.scanner.scan(blobs);
    } catch (e) {
      throw e instanceof ScanError ? e : new ScanError("The secrets scan failed.");
    }
    if (!result.clean) {
      const hit = new Set(result.blobs);
      throw new SecretFound(blobs.filter((b) => hit.has(b.sha)).map((b) => b.path), result.rules);
    }
    const written = await this.writeBlobs(blobs);
    if (written.some((sha, i) => sha !== blobs[i]!.sha)) throw new GitError("git stored a different blob than the one scanned");
    ensureOwnerDir(this.tmpDir);
    // The index of the last commit made here is still that commit's tree, so the next commit on top skips read-tree.
    const reuse = this.lastIndex?.commit === parent ? this.lastIndex.file : null;
    if (this.lastIndex && !reuse) fs.rmSync(this.lastIndex.file, { force: true });
    this.lastIndex = null;
    const index = reuse ?? path.join(this.tmpDir, `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const entries = blobs.map((b) => `100644 ${b.sha}\t${b.path}\0`).join("");
    let commit: string;
    try {
      if (!reuse) await this.git.run(this.factoryDir, ["read-tree", parent], { indexFile: index });
      await this.git.run(this.factoryDir, ["update-index", "--add", "-z", "--index-info"], { indexFile: index, input: entries });
      const tree = await this.git.out(this.factoryDir, ["write-tree"], { indexFile: index });
      commit = await this.git.out(this.factoryDir, ["commit-tree", tree, "-p", parent, "-F", "-"], { input: message + "\n" });
      // Compare-and-swap: a commit someone else made meanwhile fails this one instead of being lost.
      await this.git.run(this.factoryDir, ["update-ref", STATE_REF, commit, parent]);
    } catch (e) {
      fs.rmSync(index, { force: true });
      throw e;
    }
    this.lastIndex = { file: index, commit };
    // The commit is made. The checked-out copy only mirrors it for people
    // reading .factory, so a failure from here on is logged, not reported
    // as a failed commit.
    try {
      await this.git.run(this.factoryDir, ["update-index", "--add", "-z", "--index-info"], { input: entries, okCodes: [128] });
      for (const b of blobs) this.writeWorking(b.path, b.content);
    } catch (e) {
      this.log.warn(`factory/state: commit ${commit.slice(0, 12)} is made, but its files in .factory weren't all updated (${(e as Error).message})`);
    }
    return commit;
  }

  private lastIndex: { file: string; commit: string } | null = null;

  /** Writes the blobs in one git process; resolves to their ids in order. */
  private async writeBlobs(blobs: Blob[]): Promise<string[]> {
    if (blobs.length === 1) {
      return [await this.git.out(this.factoryDir, ["hash-object", "-w", "--no-filters", "--stdin"], { input: blobs[0]!.content })];
    }
    ensureOwnerDir(this.tmpDir);
    const dir = fs.mkdtempSync(path.join(this.tmpDir, "blobs-"));
    try {
      const files = blobs.map((b, i) => {
        const f = path.join(dir, String(i));
        fs.writeFileSync(f, b.content, { mode: 0o600, flag: "wx" });
        return f;
      });
      const out = await this.git.out(this.factoryDir, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: files.join("\n") + "\n" });
      return out.split("\n");
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Clean text already scanned, in the engine's own folder; removed with it.
      }
    }
  }

  /**
   * The URL of `origin` when it is a repo under `base`, rebuilt from its
   * parts so that nothing but owner and repo comes from the repo's config.
   */
  async remoteUrl(base: string): Promise<string> {
    const url = await this.git.out(this.repoRoot, ["remote", "get-url", "origin"]).catch(() => "");
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.startsWith(base + "/") ? url.slice(base.length + 1) : "");
    if (!m || m[2] === "." || m[2] === "..") throw new GitError(`origin is not a repo under ${base}, so factory/state is not pushed or fetched`);
    return `${base}/${m[1]}/${m[2]}.git`;
  }

  /** Pushes factory/state to the GitHub base the engine was given, with the factory token through askpass (SR-1, SR-11). */
  async push(token: string, base: string): Promise<void> {
    const url = await this.remoteUrl(base);
    await this.git.run(this.repoRoot, [...transport(base), "push", "--no-verify", url, `${STATE_REF}:${STATE_REF}`], { askpassToken: token });
  }

  /** Fetches the remote factory/state into refs/remotes/origin/factory/state and returns it, or null if the remote has none. */
  async fetch(token: string, base: string): Promise<string | null> {
    const url = await this.remoteUrl(base);
    const listed = await this.git.out(this.repoRoot, [...transport(base), "ls-remote", "--heads", url, STATE_REF], { askpassToken: token });
    if (!listed) return null;
    await this.git.run(this.repoRoot, [...transport(base), "fetch", "--no-tags", "--no-write-fetch-head", url, `+${STATE_REF}:${REMOTE_REF}`], { askpassToken: token });
    return this.git.revParse(this.repoRoot, REMOTE_REF);
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.git.run(this.repoRoot, ["merge-base", "--is-ancestor", a, b], { okCodes: [1] });
    return r.code === 0;
  }

  /** Paths that differ between two commits. Names only, so no diff driver or textconv runs. */
  async changedPaths(a: string, b: string): Promise<string[]> {
    const out = await this.git.out(this.repoRoot, ["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--name-only", a, b]);
    return out.split("\0").filter(Boolean);
  }

  /**
   * Moves factory/state forward to `to` (a descendant of `from`) and writes
   * the changed files from their blobs, as the first checkout does.
   */
  async fastForward(from: string, to: string): Promise<void> {
    const changed = await this.changedPaths(from, to);
    await this.serial(async () => {
      await this.git.run(this.repoRoot, ["update-ref", STATE_REF, to, from]);
      await this.git.run(this.factoryDir, ["read-tree", "HEAD"]);
      for (const rel of changed) {
        try {
          checkStatePath(rel);
        } catch {
          continue;
        }
        const e = await this.git.lsTreeEntry(this.factoryDir, "HEAD", rel);
        if (!e) fs.rmSync(path.join(this.factoryDir, ...rel.split("/")), { force: true });
        else if (e.type === "blob" && (e.mode === "100644" || e.mode === "100755")) this.writeWorking(rel, await this.git.catBlob(this.factoryDir, e.sha));
      }
    });
  }
}

/** Plain http only for a loopback base, which only the in-process options can give (tests). */
function transport(base: string): string[] {
  return base.startsWith("http://") ? ["-c", "protocol.http.allow=always"] : [];
}

function safeReal(p: string): string | null {
  try {
    return realPath(p);
  } catch {
    return null;
  }
}
