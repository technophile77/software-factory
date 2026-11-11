import type { Git } from "../git";
import { allowedBy } from "../policy/glob";
import type { RolePolicy } from "../policy/role-policy";

export interface Breach {
  path: string;
  reason: "not_allowed" | "symlink" | "history";
}

const SHA_RE = /^[0-9a-f]{40,64}$/;
const SYMLINK = "120000";

/**
 * The end-of-session check (FR-9, SR-12): compares the session's branch with
 * where it started. Inside the container the agent can write anywhere in the
 * worktree, so this is where the role's write rules hold. Any changed path the
 * rules don't allow, any new or changed symlink, or a branch that no longer
 * descends from its start rejects the whole session.
 */
export async function writeBreaches(git: Git, repo: string, base: string, head: string, policy: RolePolicy, gitDirArgs: string[] = []): Promise<Breach[]> {
  if (!SHA_RE.test(base) || !SHA_RE.test(head)) throw new Error("bad commit id");
  if (base === head) return [];
  const anc = await git.run(repo, [...gitDirArgs, "merge-base", "--is-ancestor", base, head], { okCodes: [1] });
  if (anc.code !== 0) return [{ path: "", reason: "history" }];
  // Raw output never runs diff drivers or textconv; renames off so both sides of a move are checked.
  const r = await git.run(repo, [...gitDirArgs, "diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-ext-diff", "--no-textconv", base, head]);
  const parts = r.stdout.toString("utf8").split("\0");
  const out: Breach[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const file = parts[i + 1]!;
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!m) throw new Error("unexpected diff-tree output");
    const [, oldMode, newMode, status] = m;
    if (newMode === SYMLINK || (oldMode === SYMLINK && status !== "D")) out.push({ path: file, reason: "symlink" });
    else if (!allowedBy(policy.write, file)) out.push({ path: file, reason: "not_allowed" });
  }
  return out;
}

/**
 * Rejects the session's commits by moving the branch back to its start, but
 * only if it still points at the head that was checked, so a concurrent move
 * isn't overwritten.
 */
export async function rejectSession(git: Git, repo: string, branch: string, base: string, head: string): Promise<void> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes("..")) throw new Error("bad branch name");
  await git.run(repo, ["update-ref", "-m", "factory: session rejected (write rules)", `refs/heads/${branch}`, base, head]);
}
