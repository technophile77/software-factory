import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir } from "../fsutil";
import type { Git } from "../git";
import type { SecretsScanner } from "../gitleaks";
import type { RolePolicy } from "../policy/role-policy";
import { SecretFound } from "../state/state-repo";
import { Breach, pathBreach, writeBreaches } from "./write-check";

/** H-0087: caps on what one session may change. */
export interface WorktreeLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export type WorktreeCap = "files changed" | "total size" | "largest file";

export interface WorktreeCommitInput {
  git: Git;
  /** The worktree's own git dir, given explicitly: the agent can rewrite the worktree's `.git` file, so git never reads it. */
  gitDir: string;
  worktree: string;
  branch: string;
  base: string;
  policy: RolePolicy;
  scanner: SecretsScanner;
  tmpDir: string;
  message: string;
  limits: WorktreeLimits;
}

export type WorktreeCommitResult =
  | { status: "unchanged" }
  | { status: "committed"; commit: string; paths: string[] }
  | { status: "rejected"; breaches: Breach[] }
  /** Nothing is committed; `cap` says which limit the change went over (SR-18). */
  | { status: "over_limit"; cap: WorktreeCap };

interface BaseEntry {
  mode: string;
  sha: string;
  size: number;
}

interface Changed {
  path: string;
  mode: string;
  sha: string;
  content: Buffer;
}

export class WorktreeError extends Error {
  override name = "WorktreeError";
}

function blobSha(content: Buffer, algo: "sha1" | "sha256"): string {
  return crypto.createHash(algo).update(`blob ${content.length}\0`).update(content).digest("hex");
}

function readNoFollow(full: string): Buffer {
  const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads the worktree as the container left it, without following a link and
 * without git, so no attribute, filter or config from the worktree applies
 * (SR-11). Links are taken as links; anything else that isn't a file or a
 * folder is a breach.
 *
 * The H-0087 caps count changed files only. A file whose size or mode differs
 * from its base entry has changed, so it meets the caps before it is read;
 * once a cap is passed nothing more is read, which bounds the engine's memory
 * whatever the agent wrote. The walk still finishes, so a breach anywhere is
 * still found.
 */
function walk(root: string, base: Map<string, BaseEntry>, format: "sha1" | "sha256", limits: WorktreeLimits, breaches: Breach[]) {
  const seen = new Set<string>();
  const changed: Changed[] = [];
  // Every changed path, kept past a cap so the write rules still see them all.
  const touched: Array<{ path: string; mode: string }> = [];
  let total = 0;
  let over: WorktreeCap | null = null;
  const change = (r: string, mode: string, size: number, read: () => Buffer) => {
    const count = touched.push({ path: r, mode });
    total += size;
    if (!over && size > limits.maxFileBytes) over = "largest file";
    if (!over && count > limits.maxFiles) over = "files changed";
    if (!over && total > limits.maxTotalBytes) over = "total size";
    if (over) return;
    const content = read();
    changed.push({ path: r, mode, sha: blobSha(content, format), content });
  };
  const visit = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (rel === "" && name === ".git") continue;
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        visit(full, r);
        continue;
      }
      let mode: string;
      let size: number;
      let read: () => Buffer;
      if (st.isSymbolicLink()) {
        const target = Buffer.from(fs.readlinkSync(full), "utf8");
        [mode, size, read] = ["120000", target.length, () => target];
      } else if (st.isFile()) {
        [mode, size, read] = [process.platform !== "win32" && st.mode & 0o111 ? "100755" : "100644", st.size, () => readNoFollow(full)];
      } else {
        breaches.push({ path: r, reason: "not_allowed" });
        continue;
      }
      seen.add(r);
      const was = base.get(r);
      if (!was || was.mode !== mode || was.size !== size) {
        change(r, mode, size, read);
        continue;
      }
      // Same size and mode: only the content tells, and it is no bigger than the base blob.
      const content = read();
      if (blobSha(content, format) !== was.sha) change(r, mode, size, () => content);
    }
  };
  visit(root, "");
  const removed = [...base.keys()].filter((p) => !seen.has(p) && base.get(p)!.mode !== "160000");
  if (!over && touched.length + removed.length > limits.maxFiles) over = "files changed";
  return { changed, touched, removed, over: over as WorktreeCap | null };
}

/**
 * FR-11 with the FR-9 check in front: the agent's changes become one commit
 * on its branch only if every changed path is within the role's write rules,
 * no symlink is new or changed, the worktree's `.git` link is untouched, the
 * change is within the H-0087 caps, and the secrets scan is clean. Otherwise
 * nothing is committed.
 */
export async function commitWorktree(i: WorktreeCommitInput): Promise<WorktreeCommitResult> {
  const g = (args: string[]) => ["--git-dir", i.gitDir, "--work-tree", i.worktree, ...args];
  const breaches: Breach[] = [];
  const dotGit = path.join(i.worktree, ".git");
  const slash = (s: string) => s.split("\\").join("/");
  const expected = slash(`gitdir: ${i.gitDir}`);
  try {
    const st = fs.lstatSync(dotGit);
    if (!st.isFile() || slash(fs.readFileSync(dotGit, "utf8").trim()) !== expected) breaches.push({ path: ".git", reason: "not_allowed" });
  } catch {
    breaches.push({ path: ".git", reason: "not_allowed" });
  }
  const format = (await i.git.out(i.worktree, g(["rev-parse", "--show-object-format"]))) === "sha256" ? "sha256" : "sha1";
  const base = new Map<string, BaseEntry>();
  const tree = await i.git.run(i.worktree, g(["ls-tree", "-r", "-z", "-l", "--full-tree", i.base]));
  for (const line of tree.stdout.toString("utf8").split("\0")) {
    const m = /^(\d{6}) \w+ ([0-9a-f]{40,64}) +(\d+|-)\t(.*)$/s.exec(line);
    if (m) base.set(m[4]!, { mode: m[1]!, sha: m[2]!, size: m[3] === "-" ? -1 : Number(m[3]) });
  }
  const { changed, touched, removed, over } = walk(i.worktree, base, format, i.limits, breaches);
  if (touched.length === 0 && removed.length === 0 && breaches.length === 0) return { status: "unchanged" };
  if (over) {
    // No commit to check, so the rules are checked on the paths: a breach still files its Security item (AC-9).
    for (const t of touched) {
      const b = pathBreach(t.path, base.get(t.path)?.mode ?? "000000", t.mode, i.policy);
      if (b) breaches.push(b);
    }
    for (const p of removed) {
      const b = pathBreach(p, base.get(p)!.mode, null, i.policy);
      if (b) breaches.push(b);
    }
  }
  if (breaches.length) return { status: "rejected", breaches };
  if (over) return { status: "over_limit", cap: over };

  const result = await i.scanner.scan(changed.filter((c) => c.mode !== "120000").map((c) => ({ sha: c.sha, content: c.content })));
  if (!result.clean) {
    const hit = new Set(result.blobs);
    throw new SecretFound(changed.filter((c) => hit.has(c.sha)).map((c) => c.path), result.rules);
  }
  ensureOwnerDir(i.tmpDir);
  const index = path.join(i.tmpDir, `wt-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await i.git.run(i.worktree, g(["read-tree", i.base]), { indexFile: index });
    for (const c of changed) {
      const sha = await i.git.out(i.worktree, g(["hash-object", "-w", "--no-filters", "--stdin"]), { input: c.content });
      if (sha !== c.sha) throw new WorktreeError("git and the engine disagree on a blob id");
      await i.git.run(i.worktree, g(["update-index", "--add", "--cacheinfo", `${c.mode},${c.sha},${c.path}`]), { indexFile: index });
    }
    for (const p of removed) await i.git.run(i.worktree, g(["update-index", "--force-remove", "--", p]), { indexFile: index });
    const written = await i.git.out(i.worktree, g(["write-tree"]), { indexFile: index });
    const commit = await i.git.out(i.worktree, g(["commit-tree", written, "-p", i.base, "-F", "-"]), { input: `${i.message}\n` });
    const found = await writeBreaches(i.git, i.worktree, i.base, commit, i.policy, ["--git-dir", i.gitDir]);
    if (found.length) return { status: "rejected", breaches: found };
    await i.git.run(i.worktree, g(["update-ref", `refs/heads/${i.branch}`, commit, i.base]));
    return { status: "committed", commit, paths: [...changed.map((c) => c.path), ...removed] };
  } finally {
    fs.rmSync(index, { force: true });
  }
}
