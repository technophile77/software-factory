import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir } from "../fsutil";
import type { Git } from "../git";
import type { SecretsScanner } from "../gitleaks";
import type { RolePolicy } from "../policy/role-policy";
import { SecretFound } from "../state/state-repo";
import { Breach, writeBreaches } from "./write-check";

export interface WorktreeLimits {
  maxFiles: number;
  maxBytes: number;
}

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
  | { status: "rejected"; breaches: Breach[] };

interface Entry {
  mode: string;
  content: Buffer;
}

export class WorktreeError extends Error {
  override name = "WorktreeError";
}

function blobSha(content: Buffer, algo: "sha1" | "sha256"): string {
  return crypto.createHash(algo).update(`blob ${content.length}\0`).update(content).digest("hex");
}

/**
 * Reads the worktree as the container left it, without following a link and
 * without git, so no attribute, filter or config from the worktree applies
 * (SR-11). Links are taken as links; anything else that isn't a file or a
 * folder is a breach.
 */
function walk(root: string, limits: WorktreeLimits, breaches: Breach[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  let bytes = 0;
  const visit = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (rel === "" && name === ".git") continue;
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) visit(full, r);
      else if (st.isSymbolicLink()) out.set(r, { mode: "120000", content: Buffer.from(fs.readlinkSync(full), "utf8") });
      else if (st.isFile()) {
        bytes += st.size;
        if (out.size >= limits.maxFiles || bytes > limits.maxBytes) throw new WorktreeError("the worktree is over its size limits");
        const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          out.set(r, { mode: process.platform !== "win32" && st.mode & 0o111 ? "100755" : "100644", content: fs.readFileSync(fd) });
        } finally {
          fs.closeSync(fd);
        }
      } else breaches.push({ path: r, reason: "not_allowed" });
    }
  };
  visit(root, "");
  return out;
}

/**
 * FR-11 with the FR-9 check in front: the agent's changes become one commit
 * on its branch only if every changed path is within the role's write rules,
 * no symlink is new or changed, the worktree's `.git` link is untouched, and
 * the secrets scan is clean. Otherwise nothing is committed.
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
  const files = walk(i.worktree, i.limits, breaches);
  const base = new Map<string, { mode: string; sha: string }>();
  const tree = await i.git.run(i.worktree, g(["ls-tree", "-r", "-z", "--full-tree", i.base]));
  for (const line of tree.stdout.toString("utf8").split("\0")) {
    const m = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
    if (m) base.set(m[3]!, { mode: m[1]!, sha: m[2]! });
  }

  const changed: Array<{ path: string; mode: string; sha: string; content: Buffer }> = [];
  for (const [p, e] of files) {
    const sha = blobSha(e.content, format);
    const was = base.get(p);
    if (!was || was.sha !== sha || was.mode !== e.mode) changed.push({ path: p, mode: e.mode, sha, content: e.content });
  }
  const removed = [...base.keys()].filter((p) => !files.has(p) && base.get(p)!.mode !== "160000");
  if (changed.length === 0 && removed.length === 0 && breaches.length === 0) return { status: "unchanged" };
  if (breaches.length) return { status: "rejected", breaches };

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
