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
    this.headCache = null;
    await this.git.run(this.repoRoot, ["worktree", "add", "--no-checkout", this.factoryDir, STATE_BRANCH]);
    await this.git.run(this.factoryDir, ["read-tree", "HEAD"]);
    // Files are written by the engine itself from the blobs, so no checkout
    // filter or attribute from the branch runs on the host.
    // Read through the main checkout, whose reader the engine already has open; the new worktree's HEAD is this ref.
    for (const e of await this.git.lsTree(this.repoRoot, STATE_REF)) {
      try {
        checkStatePath(e.path);
      } catch {
        this.log.warn(`factory/state holds an unsafe path; it was not checked out (${this.repoRoot})`);
        continue;
      }
      if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) continue;
      this.writeWorking(e.path, await this.git.catBlob(this.repoRoot, e.sha));
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

  /**
   * Only the engine writes factory/state while it runs (F-014 A-1), so the
   * commit it last wrote or read stands in for asking git. If something else
   * moved the ref, the next commit's compare-and-swap fails and clears this
   * (SR-8).
   */
  private headCache: string | null = null;

  /** The next head() asks git again: sync() does this, since its job is to see what changed outside the engine (SR-17). */
  forgetHead(): void {
    this.headCache = null;
  }

  async head(): Promise<string> {
    if (this.headCache) return this.headCache;
    const sha = await this.git.revParse(this.repoRoot, STATE_REF);
    if (!sha) throw new GitError("factory/state is missing");
    this.headCache = sha;
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

  /**
   * Commits `changes` on factory/state, one at a time per repo, removing
   * `removes` in the same commit (only the F-011 one-time migration removes
   * files). Resolves to the new commit.
   */
  commit(changes: Change[], message: string, removes: string[] = []): Promise<string> {
    return this.serial(() => this.commitNow(changes, message, removes));
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
  private async commitNow(changes: Change[], message: string, removes: string[]): Promise<string> {
    if (changes.length === 0) throw new GitError("nothing to commit");
    for (const c of [...changes.map((x) => x.path), ...removes]) checkStatePath(c);
    const cached = this.headCache !== null;
    const parent = await this.head();
    try {
      return await this.commitOn(parent, changes, message, removes);
    } catch (e) {
      // A held head that something else moved (A-1): the swap failed, so commit
      // once more on the moved head, as a fresh read would have (SR-8).
      if (!cached || e instanceof SecretFound || e instanceof ScanError) throw e;
      const fresh = await this.head();
      if (fresh === parent) throw e;
      return this.commitOn(fresh, changes, message, removes);
    }
  }

  private async commitOn(parent: string, changes: Change[], message: string, removes: string[] = []): Promise<string> {
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
    // Mode 0 drops a path from the index.
    const entries = blobs.map((b) => `100644 ${b.sha}\t${b.path}\0`).join("") + removes.map((r) => `0 ${"0".repeat(algo === "sha256" ? 64 : 40)}\t${r}\0`).join("");
    let commit: string;
    try {
      if (!reuse) await this.git.run(this.factoryDir, ["read-tree", parent], { indexFile: index });
      await this.git.run(this.factoryDir, ["update-index", "--add", "-z", "--index-info"], { indexFile: index, input: entries });
      const tree = await this.git.out(this.factoryDir, ["write-tree"], { indexFile: index });
      commit = await this.git.out(this.factoryDir, ["commit-tree", tree, "-p", parent, "-F", "-"], { input: message + "\n" });
      // Compare-and-swap: a commit someone else made meanwhile fails this one instead of being lost.
      await this.git.run(this.factoryDir, ["update-ref", STATE_REF, commit, parent]);
    } catch (e) {
      this.headCache = null;
      fs.rmSync(index, { force: true });
      throw e;
    }
    this.headCache = commit;
    this.lastIndex = { file: index, commit };
    // The commit is made. The checked-out copy only mirrors it for people
    // reading .factory, so a failure from here on is logged, not reported
    // as a failed commit.
    try {
      await this.git.run(this.factoryDir, ["update-index", "--add", "-z", "--index-info"], { input: entries, okCodes: [128] });
      for (const b of blobs) this.writeWorking(b.path, b.content);
      for (const r of removes) fs.rmSync(path.join(this.factoryDir, ...r.split("/")), { force: true });
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
  async remoteUrl(base: string, origin?: string | null): Promise<string> {
    // `origin` is the URL the L7 config listing already found (F-014 FR-5); without one, git is asked as before.
    const url = origin ?? (await this.git.out(this.repoRoot, ["remote", "get-url", "origin"]).catch(() => ""));
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.startsWith(base + "/") ? url.slice(base.length + 1) : "");
    if (!m || m[2] === "." || m[2] === "..") throw new GitError(`origin is not a repo under ${base}, so factory/state is not pushed or fetched`);
    return `${base}/${m[1]}/${m[2]}.git`;
  }

  /**
   * Code Review, L7: the clone's own config can still redirect a fetch or
   * push, and the token with it, to another host (`url.*.insteadOf`), send it
   * through a proxy or with extra headers (`http.*`), add a credential helper,
   * or pull in another file (`include*`). The system and global files are
   * already off (GIT_CONFIG_NOSYSTEM, an empty GIT_CONFIG_GLOBAL), and a
   * `-c` can override a key but can't remove `insteadOf` rules or url-scoped
   * `http.<url>.*` keys, so the engine lists every key git would see, without
   * following includes, and refuses the network step if a redirecting one is
   * set anywhere but its own `-c` list. Config it can't read refuses too. The
   * error names the key without its subsection, which can hold a URL.
   *
   * Resolves to the only `remote.origin.url` in the listing, which is what
   * `git remote get-url origin` prints once `url.*` rules are refused, or
   * null when there is none or more than one, so git is asked (F-014 FR-5).
   * Several values, or an empty one (which resets the list from git 2.46),
   * are where git versions differ (Code Review L4).
   */
  async refuseRedirectingConfig(): Promise<string | null> {
    const out = (await this.git.run(this.repoRoot, ["config", "--list", "-z", "--show-scope", "--no-includes"])).stdout.toString("utf8");
    const fields = out.split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0) throw new GitError("the repo's git config couldn't be read, so factory/state is not pushed or fetched");
    const origins: string[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i + 1]!.split("\n", 1)[0]!;
      if (key === "remote.origin.url") origins.push(fields[i + 1]!.slice(key.length + 1).trim());
      if (fields[i] === "command") continue;
      const first = key.indexOf(".");
      const last = key.lastIndexOf(".");
      const section = key.slice(0, first).toLowerCase();
      const name = key.slice(last + 1).toLowerCase();
      if (REDIRECTING_SECTIONS.has(section) || (section === "core" && (name === "gitproxy" || name === "sshcommand")) || (section === "remote" && name.startsWith("proxy"))) {
        const shown = first === last ? `${section}.${name}` : `${section}.<…>.${name}`;
        throw new GitError(`the repo's git config sets ${shown}, which could redirect a push or fetch, so factory/state is not pushed or fetched`);
      }
    }
    return origins.length === 1 && origins[0] ? origins[0] : null;
  }

  /** Pushes factory/state to the GitHub base the engine was given, with the factory token through askpass (SR-1, SR-11). */
  async push(token: string, base: string): Promise<void> {
    const url = await this.remoteUrl(base, await this.refuseRedirectingConfig());
    // A signed push would run the repo's gpg.program on the host.
    await this.git.run(this.repoRoot, [...transport(base), "-c", "push.gpgSign=false", "push", "--no-verify", url, `${STATE_REF}:${STATE_REF}`], { askpassToken: token });
  }

  /** Fetches the remote factory/state into refs/remotes/origin/factory/state and returns it, or null if the remote has none. */
  async fetch(token: string, base: string): Promise<string | null> {
    const url = await this.remoteUrl(base, await this.refuseRedirectingConfig());
    const listed = await this.git.out(this.repoRoot, [...transport(base), "ls-remote", "--heads", url, STATE_REF], { askpassToken: token });
    if (!listed) return null;
    await this.git.run(this.repoRoot, [...transport(base), "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", url, `+${STATE_REF}:${REMOTE_REF}`], { askpassToken: token });
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

  /** Paths the remote changed since it and the local branch last shared a commit, so the engine's own unpushed commits don't count. */
  async remoteChanges(local: string, remote: string): Promise<string[]> {
    const r = await this.git.run(this.repoRoot, ["merge-base", local, remote], { okCodes: [1] });
    const base = r.code === 0 ? r.stdout.toString("utf8").trim() : local;
    return this.changedPaths(base, remote);
  }

  /**
   * Moves factory/state forward to `to` (a descendant of `from`) and writes
   * the changed files from their blobs, as the first checkout does.
   */
  async fastForward(from: string, to: string): Promise<void> {
    const changed = await this.changedPaths(from, to);
    await this.serial(async () => {
      this.headCache = null;
      await this.git.run(this.repoRoot, ["update-ref", STATE_REF, to, from]);
      this.headCache = to;
      await this.git.run(this.factoryDir, ["read-tree", "HEAD"]);
      for (const rel of changed) {
        try {
          checkStatePath(rel);
        } catch {
          continue;
        }
        const e = await this.git.lsTreeEntry(this.repoRoot, to, rel);
        if (!e) fs.rmSync(path.join(this.factoryDir, ...rel.split("/")), { force: true });
        else if (e.type === "blob" && (e.mode === "100644" || e.mode === "100755")) this.writeWorking(rel, await this.git.catBlob(this.repoRoot, e.sha));
      }
    });
  }
}

/** Config sections that steer where a fetch or push goes, how it gets there, or what it sends (L7). */
const REDIRECTING_SECTIONS = new Set(["include", "includeif", "url", "http", "credential", "protocol"]);

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
