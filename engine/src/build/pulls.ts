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
    return out;
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    if (!SHA_RE.test(sha)) throw new GitHubError("malformed commit");
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/commits/${sha}/check-runs?per_page=100`);
    const runs = (r.body as { check_runs?: unknown } | null)?.check_runs;
    if (r.status !== 200 || !Array.isArray(runs)) throw new GitHubError(`GitHub refused the check runs (HTTP ${r.status})`);
    return (runs as Array<Record<string, unknown>>).map((c) => {
      const app = (c.app ?? {}) as Record<string, unknown>;
      const output = (c.output ?? {}) as Record<string, unknown>;
      return { name: str(c.name), status: str(c.status), conclusion: typeof c.conclusion === "string" ? c.conclusion : null, appId: isPosInt(app.id) ? app.id : null, headSha: str(c.head_sha), summary: str(output.summary).slice(0, 8192) };
    });
  }
}
