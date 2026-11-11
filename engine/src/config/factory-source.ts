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
 * tag of one.
 */
export async function resolveFactoryVersion(git: Git, masterRepo: string, version: string): Promise<string> {
  if (!VERSION_RE.test(version) || version.includes("..") || version.endsWith(".lock")) {
    throw new SourceError(`factory.version ${JSON.stringify(version.slice(0, 100))} is not a tag name.`);
  }
  const ref = `refs/tags/${version}`;
  const r = await git.run(masterRepo, ["rev-parse", "--verify", "--quiet", ref], { okCodes: [1] });
  const oid = r.stdout.toString().trim();
  if (r.code !== 0 || !SHA_RE.test(oid)) throw new SourceError(`factory.version ${version} is not a tag in the master repo clone.`);
  const branch = await git.run(masterRepo, ["rev-parse", "--verify", "--quiet", `refs/heads/${version}`], { okCodes: [1] });
  if (branch.code === 0) throw new SourceError(`factory.version ${version} is ambiguous: the master repo clone has a branch with that name too.`);
  const type = await git.out(masterRepo, ["cat-file", "-t", oid]);
  if (type !== "tag" && type !== "commit") throw new SourceError(`factory.version ${version} is a tag of a ${type}, not of a commit.`);
  const commit = await git.revParse(masterRepo, oid);
  if (!commit) throw new SourceError(`factory.version ${version} doesn't resolve to a commit.`);
  return commit;
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

/** The names of the folders directly under `dir` at `commit`. */
export async function subfolders(git: Git, repo: string, commit: string, dir: string): Promise<string[]> {
  const r = await git.run(repo, ["ls-tree", "-z", "--full-tree", commit, "--", `${dir}/`]);
  const out: string[] = [];
  for (const line of r.stdout.toString("utf8").split("\0")) {
    const m = /^(\d{6}) (\w+) [0-9a-f]{40,64}\t(.*)$/s.exec(line);
    if (m && m[2] === "tree") out.push(m[3]!.slice(dir.length + 1));
  }
  return out;
}
