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

  private async commitNow(changes: Change[], message: string): Promise<string> {
    if (changes.length === 0) throw new GitError("nothing to commit");
    for (const c of changes) checkStatePath(c.path);
    const parent = await this.head();
    const blobs: Array<Blob & { path: string }> = [];
    const fresh: string[] = [];
    for (const c of changes) {
      const sha = await this.git.out(this.factoryDir, ["hash-object", "--no-filters", "--stdin"], { input: c.content });
      const existed = (await this.git.run(this.factoryDir, ["cat-file", "-e", sha], { okCodes: [1, 128] })).code === 0;
      await this.git.run(this.factoryDir, ["hash-object", "-w", "--no-filters", "--stdin"], { input: c.content });
      if (!existed) fresh.push(sha);
      // The scan reads the blob back from git, so it sees exactly what the commit will hold.
      blobs.push({ sha, path: c.path, content: await this.git.catBlob(this.factoryDir, sha) });
    }
    let result;
    try {
      result = await this.scanner.scan(blobs);
    } catch (e) {
      await this.dropObjects(fresh);
      throw e instanceof ScanError ? e : new ScanError("The secrets scan failed.");
    }
    if (!result.clean) {
      const hit = new Set(result.blobs);
      await this.dropObjects(fresh);
      throw new SecretFound(blobs.filter((b) => hit.has(b.sha)).map((b) => b.path), result.rules);
    }
    ensureOwnerDir(this.tmpDir);
    const index = path.join(this.tmpDir, `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      await this.git.run(this.factoryDir, ["read-tree", parent], { indexFile: index });
      for (const b of blobs) {
        await this.git.run(this.factoryDir, ["update-index", "--add", "--cacheinfo", `100644,${b.sha},${b.path}`], { indexFile: index });
      }
      const tree = await this.git.out(this.factoryDir, ["write-tree"], { indexFile: index });
      const commit = await this.git.out(this.factoryDir, ["commit-tree", tree, "-p", parent, "-F", "-"], { input: message + "\n" });
      // Compare-and-swap: a commit someone else made meanwhile fails this one instead of being lost.
      await this.git.run(this.factoryDir, ["update-ref", STATE_REF, commit, parent]);
      for (const b of blobs) {
        await this.git.run(this.factoryDir, ["update-index", "--add", "--cacheinfo", `100644,${b.sha},${b.path}`], { okCodes: [128] });
        this.writeWorking(b.path, b.content);
      }
      return commit;
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  /**
   * Removes the loose objects a refused commit created, so a found secret
   * doesn't stay in .git. Objects that existed before are left alone: other
   * commits may hold them.
   */
  private async dropObjects(shas: string[]): Promise<void> {
    for (const sha of shas) {
      try {
        const rel = await this.git.out(this.factoryDir, ["rev-parse", "--git-path", `objects/${sha.slice(0, 2)}/${sha.slice(2)}`]);
        fs.rmSync(path.isAbsolute(rel) ? rel : path.join(this.factoryDir, rel), { force: true });
      } catch {
        this.log.warn("A refused commit's object could not be removed from .git; run `git gc --prune=now` in the repo.");
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
