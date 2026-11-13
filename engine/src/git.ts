import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir, writeFileAtomic } from "./fsutil";
import { CatFileReader, NotForReader, ReaderBroken, ReaderLimit, TreeEntry, TreeError, parseTree } from "./git-reader";
import { Children, RunResult, baseEnv, runFixed } from "./proc";

export class GitError extends Error {
  override name = "GitError";
}

/**
 * Overrides on every git command the engine runs (SR-11). Repo config can
 * otherwise make git run programs on the host: hooks (including husky's
 * hooksPath), fsmonitor, and remote helpers. Filters and textconv only run
 * from porcelain that converts content, which the engine avoids: it writes
 * with `hash-object --no-filters`, `update-index --cacheinfo`, `commit-tree`
 * and `update-ref`, and reads with `cat-file blob` and `ls-tree`.
 */
export function overrideArgs(hooksDir: string, attributesFile: string): string[] {
  return [
    "-c", `core.hooksPath=${hooksDir}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.attributesFile=${attributesFile}`,
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.file.allow=never",
    "-c", "credential.helper=",
    "-c", "core.askPass=",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "core.pager=cat",
  ];
}

/** The git subcommand in `args`, past leading global options, for the process counts. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "-C") i++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

export interface GitOptions {
  gitPath: string;
  /** Engine-owned folder for the empty hooks dir, empty config and askpass helper. */
  homeDir: string;
  children: Children;
  env?: NodeJS.ProcessEnv;
  /** How long a repo's reader stays open after its last read (F-014 OQ-1). */
  readerIdleMs?: number;
  /** False reads with plain git calls only, as before F-014 (tests compare the two). */
  readers?: boolean;
}

/** The most a single read returns, as `runFixed` caps a git call's output. */
const READ_LIMIT = 64 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
type Entry = { mode: string; type: string; sha: string };

export interface GitRunOptions {
  input?: Buffer | string;
  indexFile?: string;
  /** Exit codes that are answers rather than failures (for example 1 from show-ref). */
  okCodes?: number[];
  askpassToken?: string;
  timeoutMs?: number;
}

export class Git {
  readonly hooksDir: string;
  private readonly attributesFile: string;
  private readonly globalConfig: string;
  private readonly askpass: string;
  private readonly readers = new Map<string, CatFileReader>();
  /** Readers that broke without ever answering, by repo: after three, that repo reads with plain git calls. */
  private readonly readerFailures = new Map<string, number>();
  /** Git processes started, by subcommand (F-014 FR-7). */
  readonly spawns = new Map<string, number>();

  constructor(private readonly opts: GitOptions) {
    if (!path.isAbsolute(opts.gitPath)) throw new GitError("git must be named by absolute path");
    ensureOwnerDir(opts.homeDir);
    this.hooksDir = path.join(opts.homeDir, "hooks-empty");
    ensureOwnerDir(this.hooksDir);
    for (const f of fs.readdirSync(this.hooksDir)) fs.rmSync(path.join(this.hooksDir, f), { recursive: true, force: true });
    this.attributesFile = path.join(opts.homeDir, "attributes-empty");
    this.globalConfig = path.join(opts.homeDir, "gitconfig-empty");
    writeFileAtomic(this.attributesFile, "");
    writeFileAtomic(this.globalConfig, "");
    // The token reaches git through the environment of this one helper, never
    // an argument or URL (SR-11). Git for Windows runs it through its own sh.
    this.askpass = path.join(opts.homeDir, "askpass.sh");
    writeFileAtomic(this.askpass, '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' x-access-token ;;\n  *) printf \'%s\\n\' "$FACTORY_GIT_TOKEN" ;;\nesac\n');
    if (process.platform !== "win32") fs.chmodSync(this.askpass, 0o700);
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...baseEnv(this.opts.env),
      HOME: this.opts.homeDir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: this.globalConfig,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Software Factory Engine",
      GIT_AUTHOR_EMAIL: "engine@software-factory.invalid",
      GIT_COMMITTER_NAME: "Software Factory Engine",
      GIT_COMMITTER_EMAIL: "engine@software-factory.invalid",
      ...extra,
    };
  }

  args(cwd: string, args: string[]): string[] {
    return ["-C", cwd, ...overrideArgs(this.hooksDir, this.attributesFile), ...args];
  }

  async run(cwd: string, args: string[], o: GitRunOptions = {}): Promise<RunResult> {
    const extra: NodeJS.ProcessEnv = {};
    if (o.indexFile) extra.GIT_INDEX_FILE = o.indexFile;
    let full = this.args(cwd, args);
    if (o.askpassToken !== undefined) {
      extra.GIT_ASKPASS = this.askpass;
      extra.FACTORY_GIT_TOKEN = o.askpassToken;
      full = full.map((a) => (a === "core.askPass=" ? `core.askPass=${this.askpass}` : a));
    }
    this.count(subcommand(args));
    const res = await runFixed(this.opts.gitPath, full, {
      cwd,
      env: this.env(extra),
      input: o.input,
      timeoutMs: o.timeoutMs ?? 120_000,
    }, this.opts.children);
    if (res.code !== 0 && !(res.code !== null && o.okCodes?.includes(res.code))) {
      // stderr can quote paths and refs but never secrets: tokens only travel in the askpass env.
      throw new GitError(`git ${args[0]} failed (${res.timedOut ? "timeout" : res.code ?? res.signal}): ${res.stderr.trim().split("\n")[0] ?? ""}`);
    }
    return res;
  }

  async out(cwd: string, args: string[], o: GitRunOptions = {}): Promise<string> {
    return (await this.run(cwd, args, o)).stdout.toString("utf8").trim();
  }

  /** Git processes every `Git` in this engine process has started, for the budget tests (FR-7). */
  static processes = 0;

  private count(sub: string): void {
    Git.processes++;
    this.spawns.set(sub, (this.spawns.get(sub) ?? 0) + 1);
  }

  /** Total git processes started so far (FR-7). */
  spawnCount(): number {
    let n = 0;
    for (const v of this.spawns.values()) n += v;
    return n;
  }

  /** Every `Git` with readers, so a test can close them all before deleting its folders. */
  private static readonly withReaders = new Set<Git>();

  /** Closes every reader and resolves when their processes are gone, as the engine does when it stops. */
  async closeReaders(): Promise<void> {
    const all = [...this.readers.values()];
    this.readers.clear();
    Git.withReaders.delete(this);
    await Promise.all(all.map((r) => r.close()));
  }

  /** Closes the readers of every `Git` in this process (tests, before removing their folders). */
  static async closeAllReaders(): Promise<void> {
    await Promise.all([...Git.withReaders].map((g) => g.closeReaders()));
  }

  private reader(cwd: string): CatFileReader | null {
    if (this.opts.readers === false || (this.readerFailures.get(cwd) ?? 0) >= 3) return null;
    let r = this.readers.get(cwd);
    if (!r) {
      r = new CatFileReader({
        gitPath: this.opts.gitPath,
        args: this.args(cwd, []),
        cwd,
        env: this.env(),
        children: this.opts.children,
        idleMs: this.opts.readerIdleMs ?? 2000,
        timeoutMs: 120_000,
        onSpawn: () => this.count("cat-file --batch-command"),
      });
      this.readers.set(cwd, r);
      Git.withReaders.add(this);
    }
    return r;
  }

  /**
   * Runs `viaReader`; if the reader breaks, makes the same read with plain
   * git calls (`plain`), so a read never fails or lies because of the
   * reader (F-014 FR-2).
   */
  private async read<T>(cwd: string, viaReader: (r: CatFileReader) => Promise<T>, plain: () => Promise<T>): Promise<T> {
    const r = this.reader(cwd);
    if (!r) return plain();
    try {
      const v = await viaReader(r);
      this.readerFailures.delete(cwd);
      return v;
    } catch (e) {
      if (!(e instanceof ReaderBroken)) throw e;
      if (!(e instanceof NotForReader)) this.readerFailures.set(cwd, (this.readerFailures.get(cwd) ?? 0) + 1);
      return plain();
    }
  }

  async revParse(cwd: string, ref: string): Promise<string | null> {
    return this.read(
      cwd,
      async (r) => {
        const o = await r.info(`${ref}^{commit}`);
        // Git peels to a commit or says missing; anything else is a reader out of step.
        if (o && o.type !== "commit") throw new ReaderBroken("a peeled commit came back as another type");
        return o ? o.sha : null;
      },
      async () => {
        const r = await this.run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { okCodes: [1] });
        const sha = r.stdout.toString().trim();
        return r.code === 0 && SHA_RE.test(sha) ? sha : null;
      },
    );
  }

  /** The blob at `spec` (`<commit>:<path>`), refusing anything but a regular file entry. */
  async readBlob(cwd: string, commit: string, file: string): Promise<Buffer | null> {
    const entry = await this.lsTreeEntry(cwd, commit, file);
    if (!entry) return null;
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new GitError(`${file} is not a regular file in git`);
    }
    return this.catBlob(cwd, entry.sha);
  }

  async catBlob(cwd: string, sha: string): Promise<Buffer> {
    if (!SHA_RE.test(sha)) throw new GitError("bad blob id");
    return this.read(
      cwd,
      async (r) => {
        const o = await this.contents(r, sha);
        if (!o || o.type !== "blob") throw new GitError(`blob ${sha.slice(0, 12)} couldn't be read`);
        return o.body;
      },
      // `cat-file blob` applies no textconv, filters or attributes.
      async () => (await this.run(cwd, ["cat-file", "blob", sha])).stdout,
    );
  }

  /**
   * Several blobs, read through the repo's reader, or from one plain
   * `cat-file --batch` if the reader breaks. Neither applies textconv or
   * filters.
   */
  async catBlobs(cwd: string, shas: string[]): Promise<Map<string, Buffer>> {
    const want = [...new Set(shas)];
    if (!want.every((s) => SHA_RE.test(s))) throw new GitError("bad blob id");
    if (!want.length) return new Map();
    return this.read(
      cwd,
      async (r) => {
        const out = new Map<string, Buffer>();
        for (const sha of want) {
          const o = await this.contents(r, sha);
          if (!o || o.type !== "blob") throw new GitError(`blob ${sha.slice(0, 12)} couldn't be read`);
          out.set(sha, o.body);
        }
        return out;
      },
      () => this.catBlobsPlain(cwd, want),
    );
  }

  private async catBlobsPlain(cwd: string, want: string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const buf = (await this.run(cwd, ["cat-file", "--batch"], { input: want.join("\n") + "\n" })).stdout;
    let at = 0;
    for (const sha of want) {
      const nl = buf.indexOf(0x0a, at);
      const m = nl < 0 ? null : /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(buf.subarray(at, nl).toString("utf8"));
      if (!m || m[1] !== sha || m[2] !== "blob") throw new GitError(`blob ${sha.slice(0, 12)} couldn't be read`);
      const end = nl + 1 + Number(m[3]);
      if (end > buf.length) throw new GitError(`blob ${sha.slice(0, 12)} was cut short`);
      out.set(sha, Buffer.from(buf.subarray(nl + 1, end)));
      at = end + 1;
    }
    return out;
  }

  /** A body through the reader; an object over the read limit fails the read, as an oversized git call does. */
  private async contents(r: CatFileReader, name: string) {
    try {
      return await r.contents(name, READ_LIMIT);
    } catch (e) {
      if (e instanceof ReaderLimit) throw new GitError("output over the limit");
      throw e;
    }
  }

  /** The entries of the tree that `name` resolves to (a commit or tree), parsed with the checks of SR-5. */
  private async treeEntries(r: CatFileReader, name: string): Promise<TreeEntry[] | null> {
    const o = await this.contents(r, name);
    if (!o) return null;
    if (o.type !== "tree") {
      // A tree entry can name a non-tree in a crafted repo, as plain ls-tree would refuse; `^{tree}` can't peel to one.
      if (SHA_RE.test(name)) throw new GitError("a tree in git couldn't be read (not a tree)");
      throw new ReaderBroken("a peeled tree came back as another type");
    }
    try {
      return parseTree(o.body, o.sha.length / 2);
    } catch (e) {
      if (e instanceof TreeError) throw new GitError(`a tree in git couldn't be read (${e.message})`);
      throw e;
    }
  }

  /** Walks from `commit`'s root tree to `file`; null when any part is missing or isn't a folder. */
  private async walk(r: CatFileReader, commit: string, file: string): Promise<Entry | null> {
    const parts = file.split("/");
    if (parts.some((p) => !p)) return null;
    let tree = `${commit}^{tree}`;
    for (let i = 0; i < parts.length; i++) {
      const entries = await this.treeEntries(r, tree);
      if (!entries) throw new GitError(`${commit.slice(0, 40)} isn't a commit`);
      const e = entries.find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return { mode: e.mode, type: e.type, sha: e.sha };
      if (e.type !== "tree") return null;
      tree = e.sha;
    }
    return null;
  }

  async lsTreeEntry(cwd: string, commit: string, file: string): Promise<Entry | null> {
    return this.read(cwd, (r) => this.walk(r, commit, file), () => this.lsTreeEntryPlain(cwd, commit, file));
  }

  private async lsTreeEntryPlain(cwd: string, commit: string, file: string): Promise<Entry | null> {
    const r = await this.run(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", file]);
    const line = r.stdout.toString("utf8").split("\0").find((l) => l.length > 0);
    if (!line) return null;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
    if (!m || m[4] !== file) return null;
    return { mode: m[1]!, type: m[2]!, sha: m[3]! };
  }

  /** Every entry under `dir` (recursively), as `{ mode, type, sha, path }`, in `ls-tree -r` order. */
  async lsTree(cwd: string, commit: string, dir?: string): Promise<Array<Entry & { path: string }>> {
    return this.read(
      cwd,
      async (r) => {
        const out: Array<Entry & { path: string }> = [];
        const under = async (tree: string, prefix: string): Promise<void> => {
          const entries = await this.treeEntries(r, tree);
          if (!entries) throw new GitError(`${commit.slice(0, 40)} isn't a commit, or a tree in it is missing`);
          for (const e of entries) {
            const p = prefix + e.name;
            if (e.type === "tree") await under(e.sha, p + "/");
            else out.push({ mode: e.mode, type: e.type, sha: e.sha, path: p });
          }
        };
        if (!dir) {
          await under(`${commit}^{tree}`, "");
          return out;
        }
        const top = await this.walk(r, commit, dir);
        if (!top) return out;
        if (top.type === "tree") await under(top.sha, dir + "/");
        else out.push({ ...top, path: dir });
        return out;
      },
      () => this.lsTreePlain(cwd, commit, dir),
    );
  }

  /**
   * The entries `ls-tree -r -t -l -- <paths>` lists: every entry at or under
   * each path, and the folders leading to them, in tree order, with blob
   * sizes (0 for trees and submodules). Sizes come from object headers, so
   * no blob is read.
   */
  async lsTreeSized(cwd: string, commit: string, paths: string[]): Promise<Array<Entry & { path: string; size: number }>> {
    return this.read(
      cwd,
      async (r) => {
        const out: Array<Entry & { path: string; size: number }> = [];
        const visit = async (tree: string, prefix: string, all: boolean): Promise<void> => {
          const entries = await this.treeEntries(r, tree);
          if (!entries) throw new GitError(`${commit.slice(0, 40)} isn't a commit, or a tree in it is missing`);
          for (const e of entries) {
            const p = prefix + e.name;
            const hit = all || paths.some((x) => x === p || x.startsWith(p + "/") || p.startsWith(x + "/"));
            if (!hit) continue;
            const inside = all || paths.some((x) => x === p || p.startsWith(x + "/"));
            let size = 0;
            if (e.type === "blob") {
              const o = await r.info(e.sha);
              if (!o || o.type !== "blob") throw new GitError(`blob ${e.sha.slice(0, 12)} couldn't be read`);
              size = o.size;
            }
            out.push({ mode: e.mode, type: e.type, sha: e.sha, path: p, size });
            if (e.type === "tree") await visit(e.sha, p + "/", inside);
          }
        };
        await visit(`${commit}^{tree}`, "", false);
        return out;
      },
      async () => {
        const res = await this.run(cwd, ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit, "--", ...paths]);
        const out: Array<Entry & { path: string; size: number }> = [];
        for (const line of res.stdout.toString("utf8").split("\0")) {
          const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t(.*)$/s.exec(line);
          if (m) out.push({ mode: m[1]!, type: m[2]!, sha: m[3]!, path: m[5]!, size: m[4] === "-" ? 0 : Number(m[4]) });
        }
        return out;
      },
    );
  }

  private async lsTreePlain(cwd: string, commit: string, dir?: string): Promise<Array<Entry & { path: string }>> {
    const args = ["ls-tree", "-r", "-z", "--full-tree", commit];
    if (dir) args.push("--", dir);
    const r = await this.run(cwd, args);
    const out = [];
    for (const line of r.stdout.toString("utf8").split("\0")) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
      if (m) out.push({ mode: m[1]!, type: m[2]!, sha: m[3]!, path: m[4]! });
    }
    return out;
  }
}
