import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_BRANCH } from "../constants";
import { ensureOwnerDir, writeFileAtomic } from "../fsutil";
import { Git, GitError } from "../git";
import { Blob, ScanError, SecretsScanner } from "../gitleaks";
import { Logger } from "../log";

const STATE_REF = `refs/heads/${STATE_BRANCH}`;
const ZERO = "0".repeat(40);

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
    const real = fs.realpathSync(this.factoryDir);
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
    const real = fs.realpathSync(dir);
    const root = fs.realpathSync(this.factoryDir);
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
    const run = this.queue.then(() => this.commitNow(changes, message));
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

  /** Pushes factory/state over HTTPS with the factory token through askpass (SR-11). */
  async push(token: string): Promise<void> {
    const url = await this.git.out(this.repoRoot, ["remote", "get-url", "origin"]);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/.test(url)) {
      throw new GitError("origin is not an https://github.com/ URL, so factory/state is not pushed");
    }
    await this.git.run(this.repoRoot, ["push", "--no-verify", "origin", `${STATE_REF}:${STATE_REF}`], { askpassToken: token });
  }
}

function safeReal(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
