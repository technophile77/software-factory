import * as crypto from "node:crypto";
import { GitHubError } from "../github";
import { HttpPulls, type PullsApi } from "../build/pulls";
import { checksVerdict } from "../build/stage9";
import { checkRepo } from "./github-issues";

/**
 * F-011 FR-10, F-015 FR-14, SR-12: the one place the engine merges a pull
 * request. A hygiene approval covers its change once: the engine merges the
 * PR it opened for that item only if the PR's changes are exactly the
 * approved ones and the required checks passed on the compared head. Any
 * difference merges nothing and says so on the PR. engine/test/inbox-calls.test.ts
 * fails if a merge call appears in any other file.
 */

export interface ChangedFile {
  filename: string;
  status: string;
  /** The file's blob after the change, so an edited line changes it. */
  sha: string;
}

export interface MergeApi extends PullsApi {
  files(repo: string, n: number): Promise<ChangedFile[]>;
  /** Merges only if the head is still `sha`; false when GitHub refuses. */
  merge(repo: string, n: number, sha: string): Promise<boolean>;
}

/** The approved change's identity: every changed path with its status and resulting blob, in path order. */
export function diffHash(files: readonly ChangedFile[]): string {
  const lines = [...files].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)).map((f) => `${f.status} ${f.sha} ${f.filename}`);
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The branch the engine opens a hygiene item's PR from; a PR from anywhere else isn't the item's. */
export const hygieneBranch = (itemId: string) => `hygiene/${itemId}`;

export type AutoMerge = { merged: true; sha: string } | { merged: false; why: string; commented: boolean };

export async function autoMergeHygiene(api: MergeApi, o: { itemId: string; repo: string; pr: number; approvedDiff: string }): Promise<AutoMerge> {
  const repo = checkRepo(o.repo);
  const pr = await api.pull(repo, o.pr);
  // SR-12: never a feature branch, never a fork, only the item's own branch.
  if (pr.head.ref !== hygieneBranch(o.itemId) || pr.head.repo !== repo) return { merged: false, why: `${repo}#${o.pr} isn't the pull request the engine opened for ${o.itemId}`, commented: false };
  if (pr.state !== "open" || pr.merged) return { merged: false, why: `${repo}#${o.pr} is ${pr.merged ? "already merged" : "closed"}`, commented: false };
  const sha = pr.head.sha;
  const differs = async (why: string): Promise<AutoMerge> => {
    await api.comment(repo, o.pr, `The changes in this pull request differ from the ones approved in ${o.itemId}, so the engine merged nothing. Merge or close it here if you want it.`);
    return { merged: false, why, commented: true };
  };
  if (diffHash(await api.files(repo, o.pr)) !== o.approvedDiff) return differs(`the changes in ${repo}#${o.pr} aren't the ones approved in ${o.itemId}`);
  const checks = checksVerdict(await api.requiredChecks(repo, "main"), await api.checkRuns(repo, sha), sha);
  if (checks.state !== "green") return { merged: false, why: `the required checks on ${sha} are ${checks.state === "red" ? "red" : "not finished"}`, commented: false };
  // The head SHA goes with the merge, so GitHub refuses it if the head moved after the comparison.
  if (!(await api.merge(repo, o.pr, sha))) return differs(`GitHub refused to merge ${repo}#${o.pr} at ${sha}`);
  return { merged: true, sha };
}

const SHA_RE = /^[0-9a-f]{40}$/;

export class HttpMerge extends HttpPulls implements MergeApi {
  async files(repo: string, n: number): Promise<ChangedFile[]> {
    const all = await this.list(`/repos/${checkRepo(repo)}/pulls/${n}/files?per_page=100`);
    if (all.length >= 3000) throw new GitHubError("the pull request changes too many files to compare");
    return all.map((f) => {
      const sha = typeof f.sha === "string" && SHA_RE.test(f.sha) ? f.sha : "";
      return { filename: String(f.filename ?? ""), status: String(f.status ?? ""), sha };
    });
  }

  async merge(repo: string, n: number, sha: string): Promise<boolean> {
    const r = await this.call("PUT", `/repos/${checkRepo(repo)}/pulls/${n}/merge`, { sha, merge_method: "squash" });
    this.act("github.merge_pull_request", `${repo}#${n} ${sha}`, r.status);
    return r.status === 200;
  }
}
