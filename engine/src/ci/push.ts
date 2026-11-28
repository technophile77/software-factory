import * as crypto from "node:crypto";
import { GitHubError } from "../github";
import { HttpMerge, type MergeApi, autoMergeHygiene, type AutoMerge } from "../inbox/auto-merge";
import { checkRepo } from "../inbox/github-issues";
import { SecretError, type CredentialStore } from "../secrets";
import { type CiChange, filesDiff } from "./item";

/**
 * F-026 FR-8, SR-2, SR-5, SR-9: the only module that reads the CI token
 * (OQ-1 A: one fine-grained token per GitHub owner of a project, with
 * Workflows write). It pushes exactly the files the owner approved, on the
 * item's own branch, and merges them through `autoMergeHygiene`. A test
 * fails if the token's store name is read anywhere else.
 */

const CI_TOKEN_RE = /^ci-token\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9-]{0,38}$/;

/** The store name of a project's CI token for one GitHub owner, login in lower case as for owner tokens. */
export function ciTokenName(project: string, owner: string): string {
  const name = `ci-token/${project}/${owner.toLowerCase()}`;
  if (!CI_TOKEN_RE.test(name)) throw new SecretError("That project and owner can't name a CI token.");
  return name;
}

export const isCiTokenName = (name: string) => CI_TOKEN_RE.test(name);

export async function loadCiToken(store: CredentialStore, project: string, owner: string): Promise<{ token: string | null; name: string }> {
  const name = ciTokenName(project, owner);
  return { token: await store.get(name), name };
}

export const ciBranch = (itemId: string) => `hygiene/${itemId}`;

export interface CiChangeApi extends MergeApi {
  mainHead(repo: string): Promise<string>;
  /** One commit on `branch` from `base` holding the files; the branch is created or moved to it. */
  pushFiles(repo: string, base: string, branch: string, files: CiChange["files"], message: string): Promise<string>;
  /** SR-9: true when GitHub refuses a call that needs Administration read. */
  adminRefused(repo: string): Promise<boolean>;
  /** SR-9: true when a workflow file can be written on a throwaway branch (deleted at once). */
  workflowWriteAllowed(repo: string, base: string): Promise<boolean>;
  reachableRepos(): Promise<Array<{ name: string; private: boolean }>>;
  /** SR-3, SR-5: when the token expires, or null when it doesn't. */
  tokenExpiry(): Promise<Date | null>;
}

/** SR-5: the longest expiry the CI token may have, and when renewal is asked for. */
export const CI_TOKEN_MAX_DAYS = 30;
export const CI_TOKEN_RENEW_DAYS = 7;
const DAY = 86_400_000;

/** Whole days until the token expires; null when it doesn't. */
export const daysLeft = (expiry: Date | null, now: Date) => (expiry ? Math.floor((expiry.getTime() - now.getTime()) / DAY) : null);

/** SR-3, SR-9: what is wrong with a CI token, in engine words; empty when nothing is. */
export async function ciTokenProblems(api: CiChangeApi, projectRepos: readonly string[], repo: string, token: string, now = new Date()): Promise<string[]> {
  const out: string[] = [];
  if (!token.startsWith("github_pat_")) out.push("the CI token isn't a fine-grained token, so it can't be limited to the project's repos");
  const left = daysLeft(await api.tokenExpiry(), now);
  // A day of slack: GitHub counts the expiry from the end of the day the token was made.
  if (left === null) out.push(`the CI token never expires; give it ${CI_TOKEN_MAX_DAYS} days or less`);
  else if (left > CI_TOKEN_MAX_DAYS + 1) out.push(`the CI token expires in ${left} days; give it ${CI_TOKEN_MAX_DAYS} days or less`);
  const mine = new Set(projectRepos.map((r) => r.toLowerCase()));
  const outside = (await api.reachableRepos()).filter((r) => r.private && !mine.has(r.name.toLowerCase())).map((r) => r.name);
  if (outside.length) out.push(`the CI token reaches ${outside.length} private repo${outside.length > 1 ? "s" : ""} outside the project (${outside.slice(0, 5).join(", ")})`);
  if (!(await api.adminRefused(repo))) out.push(`the CI token has Administration access to ${repo}`);
  if (!(await api.workflowWriteAllowed(repo, await api.mainHead(repo)))) out.push(`the CI token can't write workflow files in ${repo}; give it Workflows: Read and write`);
  return out;
}

export type Landed = { state: "merged"; pr: number; sha: string } | { state: "waiting"; pr: number; why: string } | { state: "refused"; why: string };

/**
 * FR-8: push the approved files and merge them. The record's files must
 * still hash to the approved diff, so a changed record lands nothing.
 * Called again while the PR's checks run; it never pushes twice.
 */
export async function landCiChange(api: CiChangeApi, o: { itemId: string; change: CiChange; approvedDiff: string; title: string; body: string }): Promise<Landed> {
  const { change } = o;
  const repo = checkRepo(change.repo);
  if (filesDiff(change.files) !== o.approvedDiff || change.diff !== o.approvedDiff) return { state: "refused", why: `the change record for ${o.itemId} doesn't match what was approved` };
  const branch = ciBranch(o.itemId);
  let pr = await api.findPull(repo, branch);
  if (pr?.merged) return { state: "merged", pr: pr.number, sha: pr.mergeCommit ?? pr.head.sha };
  if (!pr || pr.state !== "open") {
    // Built on main as it is now: the same files give the same diff, so the approval still holds if main moved.
    const base = await api.mainHead(repo);
    await api.pushFiles(repo, base, branch, change.files, `${o.title}\n\nApproved in ${o.itemId} (F-026).`);
    pr = await api.createPull(repo, { title: o.title, head: branch, base: "main", body: o.body });
  }
  if (pr.draft) await api.markReady(repo, pr);
  const res: AutoMerge = await autoMergeHygiene(api, { itemId: o.itemId, repo, pr: pr.number, approvedDiff: o.approvedDiff });
  if (res.merged) return { state: "merged", pr: pr.number, sha: res.sha };
  return res.commented ? { state: "refused", why: res.why } : { state: "waiting", pr: pr.number, why: res.why };
}

const SHA_RE = /^[0-9a-f]{40}$/;
const PROBE = "name: factory-ci-token-probe\non: workflow_dispatch\npermissions: {}\njobs: {}\n";

export class HttpCiChange extends HttpMerge implements CiChangeApi {
  async mainHead(repo: string): Promise<string> {
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/git/ref/heads/main`);
    const sha = String(((r.body as { object?: { sha?: unknown } } | null)?.object?.sha) ?? "");
    if (r.status !== 200 || !SHA_RE.test(sha)) throw new GitHubError(`GitHub refused ${repo}'s main (HTTP ${r.status})`);
    return sha;
  }

  async pushFiles(repo: string, base: string, branch: string, files: CiChange["files"], message: string): Promise<string> {
    const r = checkRepo(repo);
    const commit = await this.call("GET", `/repos/${r}/git/commits/${base}`);
    const tree = String((commit.body as { tree?: { sha?: unknown } } | null)?.tree?.sha ?? "");
    if (commit.status !== 200 || !SHA_RE.test(tree)) throw new GitHubError(`GitHub refused ${repo}'s main commit (HTTP ${commit.status})`);
    const entries = files.map((f) => (f.content === null ? { path: f.path, mode: "100644", type: "blob", sha: null } : { path: f.path, mode: "100644", type: "blob", content: f.content }));
    const t = await this.call("POST", `/repos/${r}/git/trees`, { base_tree: tree, tree: entries });
    if (t.status !== 201) throw new GitHubError(`GitHub refused the CI change's files (HTTP ${t.status})`);
    const c = await this.call("POST", `/repos/${r}/git/commits`, { message, tree: (t.body as { sha: string }).sha, parents: [base] });
    if (c.status !== 201) throw new GitHubError(`GitHub refused the CI change's commit (HTTP ${c.status})`);
    const sha = String((c.body as { sha?: unknown }).sha ?? "");
    const created = await this.call("POST", `/repos/${r}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    if (created.status === 422) {
      const moved = await this.call("PATCH", `/repos/${r}/git/refs/heads/${branch}`, { sha, force: true });
      this.act("github.push_ci_change", `${r} ${branch} ${sha}`, moved.status);
      if (moved.status !== 200) throw new GitHubError(`GitHub refused the push to ${branch} (HTTP ${moved.status})`);
    } else {
      this.act("github.push_ci_change", `${r} ${branch} ${sha}`, created.status);
      if (created.status !== 201) throw new GitHubError(`GitHub refused the push to ${branch} (HTTP ${created.status})`);
    }
    return sha;
  }

  async adminRefused(repo: string): Promise<boolean> {
    // Reading a repo's Actions settings needs Administration read and nothing else does it for a token.
    const r = await this.call("GET", `/repos/${checkRepo(repo)}/actions/permissions`);
    this.act("github.ci_token_probe_admin", repo, r.status);
    return r.status !== 200;
  }

  async workflowWriteAllowed(repo: string, base: string): Promise<boolean> {
    const name = `hygiene/probe-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await this.pushFiles(repo, base, name, [{ path: ".github/workflows/factory-ci-token-probe.yml", content: PROBE, before: null }], "Factory CI token probe");
    } catch {
      return false;
    }
    const del = await this.call("DELETE", `/repos/${checkRepo(repo)}/git/refs/heads/${name}`);
    this.act("github.delete_probe_branch", `${repo} ${name}`, del.status);
    return true;
  }

  async tokenExpiry(): Promise<Date | null> {
    const r = await this.call("GET", "/rate_limit");
    if (r.status !== 200) throw new GitHubError(`GitHub refused the CI token (HTTP ${r.status})`);
    if (!r.expires) return null;
    // GitHub sends "2026-12-28 10:00:00 UTC" or with a numeric offset.
    const d = new Date(r.expires.replace(" UTC", "Z").replace(/^(\d{4}-\d\d-\d\d) /, "$1T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2"));
    if (Number.isNaN(d.getTime())) throw new GitHubError("GitHub sent an expiry the engine can't read");
    return d;
  }

  async reachableRepos(): Promise<Array<{ name: string; private: boolean }>> {
    return (await this.list("/user/repos?per_page=100")).map((r) => ({ name: String(r.full_name ?? ""), private: r.private !== false })).filter((r) => r.name);
  }
}
