import type { Git } from "../git";
import { ConfigError } from "./paths-file";

/**
 * Spec v30: skills, `AGENT.md` and the limit defaults come from the master
 * clone commit that the project's `factory.version` names, read as git
 * blobs, never from a working tree.
 */
export class SourceError extends ConfigError {
  override name = "SourceError";
}

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * Resolves `factory.version` to a commit through `refs/tags/<version>` only.
 * Refused: a name that isn't a plain tag name, a missing tag, a name that is
 * also a branch (ambiguous), and a tag that isn't a commit or an annotated
 * tag of one. One `for-each-ref` answers all of it, since this runs on every
 * engine start.
 */
export async function resolveFactoryVersion(git: Git, masterRepo: string, version: string): Promise<string> {
  if (!VERSION_RE.test(version) || version.includes("..") || version.endsWith(".lock")) {
    throw new SourceError(`factory.version ${JSON.stringify(version.slice(0, 100))} is not a tag name.`);
  }
  const tagRef = `refs/tags/${version}`;
  const branchRef = `refs/heads/${version}`;
  const out = await git.out(masterRepo, ["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)", tagRef, branchRef]);
  // for-each-ref also lists refs below a matching prefix, so only exact names count.
  const refs = new Map(out.split("\n").map((l) => l.split("\0")).filter((f) => f.length === 5).map((f) => [f[0]!, f.slice(1)]));
  const tag = refs.get(tagRef);
  if (!tag || !SHA_RE.test(tag[1]!)) throw new SourceError(`factory.version ${version} is not a tag in the master repo clone.`);
  if (refs.has(branchRef)) throw new SourceError(`factory.version ${version} is ambiguous: the master repo clone has a branch with that name too.`);
  const [type, oid, peeledType, peeled] = tag as [string, string, string, string];
  if (type === "commit") return oid;
  if (type !== "tag") throw new SourceError(`factory.version ${version} is a tag of a ${type}, not of a commit.`);
  if (peeledType === "commit" && SHA_RE.test(peeled)) return peeled;
  // A tag of a tag: rare, so peeling the whole chain can cost a second call.
  const commit = peeledType === "tag" ? await git.revParse(masterRepo, oid) : null;
  if (!commit) throw new SourceError(`factory.version ${version} doesn't resolve to a commit.`);
  return commit;
}

interface SnapshotEntry {
  mode: string;
  type: string;
  sha: string;
  size: number;
}

const isRegular = (e: SnapshotEntry) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755");

/**
 * The listing of a few paths at one commit, from a single `ls-tree`, so the
 * files the engine reads at every start cost one process for the listing and
 * one for the contents rather than several per file. Paths reached through a
 * symbolic link aren't listed, so they read as missing, as with `lsTreeEntry`.
 */
export class TreeSnapshot {
  private constructor(
    private readonly git: Git,
    private readonly repo: string,
    readonly commit: string,
    private readonly entries: Map<string, SnapshotEntry>,
  ) {}

  private readonly cache = new Map<string, Buffer>();

  static async read(git: Git, repo: string, commit: string, paths: string[]): Promise<TreeSnapshot> {
    const r = await git.run(repo, ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit, "--", ...paths]);
    const entries = new Map<string, SnapshotEntry>();
    for (const line of r.stdout.toString("utf8").split("\0")) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t(.*)$/s.exec(line);
      if (m) entries.set(m[5]!, { mode: m[1]!, type: m[2]!, sha: m[3]!, size: m[4] === "-" ? 0 : Number(m[4]) });
    }
    return new TreeSnapshot(git, repo, commit, entries);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  entry(path: string): { sha: string; size: number; regular: boolean } | undefined {
    const e = this.entries.get(path);
    return e && { sha: e.sha, size: e.size, regular: isRegular(e) };
  }

  /** The names of the folders directly under `dir`. */
  subfolders(dir: string): string[] {
    const pre = `${dir}/`;
    return [...this.entries].filter(([p, e]) => e.type === "tree" && p.startsWith(pre) && !p.slice(pre.length).includes("/")).map(([p]) => p.slice(pre.length));
  }

  /** The blob of one regular file, checked against `maxBytes` before it is read. */
  fileSha(file: string, maxBytes: number, what: string): string {
    const e = this.entries.get(file);
    if (!e) throw new SourceError(`${what} ${file} is missing at ${this.commit.slice(0, 12)}, or is reached through a symbolic link.`);
    if (!isRegular(e)) throw new SourceError(`${what} ${file} is a symbolic link or not a regular file.`);
    if (e.size > maxBytes) throw new SourceError(`${what} ${file} is over ${maxBytes} bytes.`);
    return e.sha;
  }

  /**
   * Every file under `dir` as `[path inside dir, sha, executable]`. Any link
   * or submodule inside refuses the whole folder, as does going over the file
   * or byte bounds; sizes come from the listing, so nothing is read first.
   */
  dirFiles(dir: string, bounds: { files: number; bytes: number }, what: string): Array<[string, string, boolean]> {
    const top = this.entries.get(dir);
    if (!top) throw new SourceError(`${what} ${dir} is missing at ${this.commit.slice(0, 12)}, or is reached through a symbolic link.`);
    if (top.type !== "tree") throw new SourceError(`${what} ${dir} is a symbolic link or not a folder.`);
    const out: Array<[string, string, boolean]> = [];
    let bytes = 0;
    for (const [p, e] of this.entries) {
      if (!p.startsWith(`${dir}/`) || e.type === "tree") continue;
      if (!isRegular(e)) throw new SourceError(`${what} ${p} is a symbolic link or not a regular file.`);
      if (out.length >= bounds.files) throw new SourceError(`${what} ${dir} has more than ${bounds.files} files.`);
      bytes += e.size;
      if (bytes > bounds.bytes) throw new SourceError(`${what} ${dir} is over ${bounds.bytes} bytes.`);
      out.push([p.slice(dir.length + 1), e.sha, e.mode === "100755"]);
    }
    return out;
  }

  /** The contents of blobs listed here; those not already read come from one `cat-file --batch`. */
  async blobs(shas: string[]): Promise<Map<string, Buffer>> {
    const missing = shas.filter((s) => !this.cache.has(s));
    for (const [sha, b] of await this.git.catBlobs(this.repo, missing)) this.cache.set(sha, b);
    return new Map(shas.map((s) => [s, this.cache.get(s)!]));
  }

  /**
   * Reads the regular files among `paths` that are at most `maxBytes`, in one
   * batch, so the small defaults files that follow cost no process each.
   * Anything missing, irregular or oversized is left for its reader to refuse.
   */
  async prefetch(paths: string[], maxBytes: number): Promise<void> {
    const shas = paths.map((p) => this.entry(p)).filter((e) => e && e.regular && e.size <= maxBytes).map((e) => e!.sha);
    await this.blobs(shas);
  }
}

/**
 * A project path from the manifest: relative, `/`-separated, inside the repo,
 * and never into `.git`. Symlinks are refused where the tree is read.
 */
export function checkRepoPath(p: unknown, what: string): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 500) throw new SourceError(`${what} must be a relative path.`);
  const segs = p.split("/");
  if (p.startsWith("/") || p.includes("\\") || p.includes(":") || p.includes("\0") || segs.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")) {
    throw new SourceError(`${what} must be a relative path inside the config repo (no '..', '.git', absolute or drive paths).`);
  }
  return p;
}

export interface TreeFile {
  content: Buffer;
  executable: boolean;
}

/** One regular file at `commit`; a link, a submodule or a path through a link is refused. */
export async function readFileAt(git: Git, repo: string, commit: string, file: string, maxBytes: number, what: string): Promise<Buffer> {
  const e = await git.lsTreeEntry(repo, commit, file);
  if (!e) throw new SourceError(`${what} ${file} is missing at ${commit.slice(0, 12)}, or is reached through a symbolic link.`);
  if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) throw new SourceError(`${what} ${file} is a symbolic link or not a regular file.`);
  const content = await git.catBlob(repo, e.sha);
  if (content.length > maxBytes) throw new SourceError(`${what} ${file} is over ${maxBytes} bytes.`);
  return content;
}

/**
 * Every file under `dir` at `commit`, keyed by its path inside `dir`. Any
 * link or submodule inside refuses the whole folder, as does going over the
 * file or byte bounds.
 */
export async function readDirAt(git: Git, repo: string, commit: string, dir: string, bounds: { files: number; bytes: number }, what: string): Promise<Map<string, TreeFile>> {
  const top = await git.lsTreeEntry(repo, commit, dir);
  if (!top) throw new SourceError(`${what} ${dir} is missing at ${commit.slice(0, 12)}, or is reached through a symbolic link.`);
  if (top.type !== "tree") throw new SourceError(`${what} ${dir} is a symbolic link or not a folder.`);
  const out = new Map<string, TreeFile>();
  let bytes = 0;
  for (const e of await git.lsTree(repo, commit, dir)) {
    if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) throw new SourceError(`${what} ${e.path} is a symbolic link or not a regular file.`);
    if (out.size >= bounds.files) throw new SourceError(`${what} ${dir} has more than ${bounds.files} files.`);
    const content = await git.catBlob(repo, e.sha);
    bytes += content.length;
    if (bytes > bounds.bytes) throw new SourceError(`${what} ${dir} is over ${bounds.bytes} bytes.`);
    out.set(e.path.slice(dir.length + 1), { content, executable: e.mode === "100755" });
  }
  return out;
}
