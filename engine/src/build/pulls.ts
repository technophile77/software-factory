import { ACTIONS_APP_ID } from "./stage9";
import { GitHubError } from "../github";
import { HttpIssues, type IssueComment, checkRepo } from "../inbox/github-issues";

/**
 * F-015 FR-10, SR-2, SR-3: the pull request calls the engine makes in a code
 * repo with the owner's token. There is no merge call: only
 * inbox/auto-merge.ts merges (F-011 FR-14).
 */

export interface Pull {
  number: number;
  nodeId: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeCommit: string | null;
  mergedBy: string;
  head: { sha: string; ref: string; repo: string };
  url: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
  headSha: string;
  /** The check's own summary, written by the repo's CI: outside text. */
  summary: string;
}

/** A required status check of the `main` ruleset (SR-3); `integrationId` is the app it must come from. */
export interface RequiredCheck {
  context: string;
  integrationId: number | null;
}

export interface PullsApi {
  findPull(repo: string, branch: string): Promise<Pull | null>;
  pull(repo: string, n: number): Promise<Pull>;
  createPull(repo: string, p: { title: string; head: string; base: string; body: string }): Promise<Pull>;
  updatePull(repo: string, n: number, p: { title: string; body: string }): Promise<void>;
  markReady(repo: string, pull: Pull): Promise<void>;
  requiredChecks(repo: string, branch: string): Promise<RequiredCheck[]>;
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
  comments(repo: string, n: number): Promise<IssueComment[]>;
  comment(repo: string, n: number, body: string): Promise<number>;
  /** The head's combined commit status (F-015 FR-18); left out by fakes that have none. */
  commitStatus?(repo: string, sha: string): Promise<{ state: string; count: number }>;
  /** F-015 FR-26: whether `#n` is an open issue (not a pull request) in `repo`; left out by fakes that have none. */
  issueOpen?(repo: string, n: number): Promise<boolean>;
  /** F-015 FR-27: closes the PR without merging, when the owner cancels its feature. */
  closePull(repo: string, n: number): Promise<void>;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const isPosInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const str = (x: unknown): string => (typeof x === "string" ? x : "");

function toPull(b: Record<string, unknown>): Pull {
  const head = (b.head ?? {}) as Record<string, unknown>;
  if (!isPosInt(b.number) || (b.state !== "open" && b.state !== "closed") || !SHA_RE.test(str(head.sha))) throw new GitHubError("GitHub sent a malformed pull request");
  const merge = str(b.merge_commit_sha);
  return {
    number: b.number, nodeId: str(b.node_id), state: b.state, draft: b.draft === true, merged: b.merged === true || !!b.merged_at,
    mergeCommit: SHA_RE.test(merge) ? merge : null, mergedBy: str((b.merged_by as Record<string, unknown> | null)?.login),
    head: { sha: str(head.sha), ref: str(head.ref), repo: str((head.repo as Record<string, unknown> | null)?.full_name) }, url: str(b.html_url),
  };
}

export class HttpPulls extends HttpIssues implements PullsApi {
  async findPull(repo: string, branch: string): Promise<Pull | null> {
    const owner = checkRepo(repo).split("/")[0]!;
    const all = await this.list(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
    const mine = all.map(toPull).filter((p) => p.head.ref === branch && p.head.repo === repo);
    return mine.sort((a, b) => b.number - a.number)[0] ?? null;
  }

  async pull(repo: string, n: number): Promise<Pull> {
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/pulls/${n}`);
    if (r.status !== 200) throw new GitHubError(`GitHub refused pull request ${n} (HTTP ${r.status})`);
    return toPull(r.body as Record<string, unknown>);
  }

  async createPull(repo: string, p: { title: string; head: string; base: string; body: string }): Promise<Pull> {
    const r = await this.call("POST", `/repos/${checkRepo(repo)}/pulls`, { ...p, draft: true, maintainer_can_modify: false });
    this.act("github.create_pull_request", `${repo} ${p.head}`, r.status);
    if (r.status !== 201) throw new GitHubError(`GitHub refused the pull request (HTTP ${r.status})`);
    return toPull(r.body as Record<string, unknown>);
  }

  async updatePull(repo: string, n: number, p: { title: string; body: string }): Promise<void> {
    const r = await this.call("PATCH", `/repos/${checkRepo(repo)}/pulls/${n}`, p);
    this.act("github.update_pull_request", `${repo}#${n}`, r.status);
    if (r.status !== 200) throw new GitHubError(`GitHub refused a pull request update (HTTP ${r.status})`);
  }

  async closePull(repo: string, n: number): Promise<void> {
    const r = await this.call("PATCH", `/repos/${checkRepo(repo)}/pulls/${n}`, { state: "closed" });
    this.act("github.close_pull_request", `${repo}#${n}`, r.status);
    if (r.status !== 200) throw new GitHubError(`GitHub refused to close the pull request (HTTP ${r.status})`);
  }

  async markReady(repo: string, pull: Pull): Promise<void> {
    // REST can't take a PR out of draft; GraphQL's mutation is the only way.
    const r = await this.call("POST", "/graphql", { query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }", variables: { id: pull.nodeId } });
    this.act("github.mark_ready_for_review", `${checkRepo(repo)}#${pull.number}`, r.status);
    const errors = (r.body as { errors?: unknown } | null)?.errors;
    if (r.status !== 200 || (Array.isArray(errors) && errors.length)) throw new GitHubError(`GitHub refused to mark the pull request ready (HTTP ${r.status})`);
  }

  async requiredChecks(repo: string, branch: string): Promise<RequiredCheck[]> {
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/rules/branches/${encodeURIComponent(branch)}?per_page=100`);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new GitHubError(`GitHub refused the branch rules (HTTP ${r.status})`);
    const out: RequiredCheck[] = [];
    for (const rule of r.body as Array<Record<string, unknown>>) {
      if (rule.type !== "required_status_checks") continue;
      const checks = ((rule.parameters ?? {}) as Record<string, unknown>).required_status_checks;
      for (const c of Array.isArray(checks) ? (checks as Array<Record<string, unknown>>) : []) {
        if (str(c.context)) out.push({ context: str(c.context), integrationId: isPosInt(c.integration_id) ? c.integration_id : null });
      }
    }
    // SR-3, F-015 FR-31: classic branch protection names required checks too (mesbot sets them there, not in a ruleset).
    const b = await this.call("GET", `/repos/${checkRepo(repo)}/branches/${encodeURIComponent(branch)}`);
    if (b.status !== 200 || !b.body || typeof b.body !== "object") throw new GitHubError(`GitHub refused the branch (HTTP ${b.status})`);
    const rsc = (((b.body as Record<string, unknown>).protection ?? {}) as Record<string, unknown>).required_status_checks as Record<string, unknown> | undefined;
    for (const c of Array.isArray(rsc?.checks) ? (rsc!.checks as Array<Record<string, unknown>>) : []) {
      const check = { context: str(c.context), integrationId: isPosInt(c.app_id) ? c.app_id : null };
      if (check.context && !out.some((o) => o.context === check.context && o.integrationId === check.integrationId)) out.push(check);
    }
    return out;
  }

  async issueOpen(repo: string, n: number): Promise<boolean> {
    if (!isPosInt(n)) return false;
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/issues/${n}`);
    if (r.status === 404 || r.status === 410) return false;
    if (r.status !== 200) throw new GitHubError(`GitHub refused issue ${n} (HTTP ${r.status})`);
    const b = (r.body ?? {}) as Record<string, unknown>;
    // The issues API answers for pull requests too; only a real issue counts.
    return b.state === "open" && b.pull_request === undefined;
  }

  async commitStatus(repo: string, sha: string): Promise<{ state: string; count: number }> {
    if (!SHA_RE.test(sha)) throw new GitHubError("malformed commit");
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/commits/${sha}/status`);
    if (r.status !== 200) throw new GitHubError(`GitHub refused the commit status (HTTP ${r.status})`);
    const b = r.body as { state?: unknown; total_count?: unknown };
    return { state: str(b.state), count: typeof b.total_count === "number" ? b.total_count : 0 };
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    if (!SHA_RE.test(sha)) throw new GitHubError("malformed commit");
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/commits/${sha}/check-runs?per_page=100`);
    // Fine-grained tokens can't hold the Checks permission, so GitHub refuses them; Actions' own jobs are the same checks.
    if (r.status === 403 || r.status === 404) return this.actionsJobs(repo, sha);
    const runs = (r.body as { check_runs?: unknown } | null)?.check_runs;
    if (r.status !== 200 || !Array.isArray(runs)) throw new GitHubError(`GitHub refused the check runs (HTTP ${r.status})`);
    return (runs as Array<Record<string, unknown>>).map((c) => {
      const app = (c.app ?? {}) as Record<string, unknown>;
      const output = (c.output ?? {}) as Record<string, unknown>;
      return { name: str(c.name), status: str(c.status), conclusion: typeof c.conclusion === "string" ? c.conclusion : null, appId: isPosInt(app.id) ? app.id : null, headSha: str(c.head_sha), summary: str(output.summary).slice(0, 8192) };
    });
  }

  /**
   * SR-3, SR-11 with the Actions read permission only: each GitHub Actions
   * job on `sha` is the check run Actions reports under the job's name, so
   * it counts as coming from the Actions app. A required check pinned to any
   * other app finds nothing here and keeps waiting.
   */
  private async actionsJobs(repo: string, sha: string): Promise<CheckRun[]> {
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/actions/runs?head_sha=${sha}&per_page=100`);
    const runs = (r.body as { workflow_runs?: unknown } | null)?.workflow_runs;
    if (r.status !== 200 || !Array.isArray(runs)) throw new GitHubError(`GitHub refused the check runs and the Actions runs (HTTP ${r.status}); the token needs Actions read`);
    const out: CheckRun[] = [];
    for (const run of (runs as Array<Record<string, unknown>>).slice(0, 20)) {
      if (!isPosInt(run.id) || str(run.head_sha) !== sha) continue;
      const j = await this.call("GET", `/repos/${checkRepo(repo)}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      const jobs = (j.body as { jobs?: unknown } | null)?.jobs;
      if (j.status !== 200 || !Array.isArray(jobs)) throw new GitHubError(`GitHub refused the Actions jobs (HTTP ${j.status})`);
      for (const job of jobs as Array<Record<string, unknown>>) {
        out.push({ name: str(job.name), status: str(job.status), conclusion: typeof job.conclusion === "string" ? job.conclusion : null, appId: ACTIONS_APP_ID, headSha: str(job.head_sha), summary: "" });
      }
    }
    return out;
  }
}
