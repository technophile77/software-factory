import * as crypto from "node:crypto";
import { HttpIssues, checkRepo } from "../inbox/github-issues";

/**
 * F-015 SR-2: the owner token is fine-grained, reaches no private repo
 * outside the project and can't write CI workflows. Every token can read
 * every public repo, and GitHub's repo list includes them, so only private
 * repos show what the token was given (owner, 2026-11-15). Fine-grained tokens can't report their own
 * permissions, so the workflow check tries a workflow write on a throwaway
 * branch: refused is the pass; if GitHub accepts it, the branch is deleted
 * at once and the project stops.
 */

export interface TokenCheckApi {
  reachableRepos(): Promise<Array<{ name: string; private: boolean }>>;
  workflowWriteRefused(repo: string, base: string): Promise<boolean>;
}

/** What is wrong with the token for these repos, in engine words; empty when nothing is. */
export async function tokenProblems(api: TokenCheckApi, project: readonly string[], probe: { repo: string; base: string }, token: string): Promise<string[]> {
  const out: string[] = [];
  // Only a fine-grained token can be limited to chosen repos; the prefix is all that is read of it.
  if (!token.startsWith("github_pat_")) out.push("the token isn't a fine-grained token, so it can't be limited to the project's repos");
  const mine = new Set(project.map((r) => r.toLowerCase()));
  const outside = (await api.reachableRepos()).filter((r) => r.private && !mine.has(r.name.toLowerCase())).map((r) => r.name);
  if (outside.length) out.push(`the token reaches ${outside.length} private repo${outside.length > 1 ? "s" : ""} outside the project (${outside.slice(0, 5).join(", ")})`);
  if (!(await api.workflowWriteRefused(probe.repo, probe.base))) out.push(`the token can write CI workflows in ${probe.repo}`);
  return out;
}

/**
 * F-015 FR-19: the tokens to check before a code push, each with the repo it is
 * probed on: the code repo's token there, and the config repo's token on the
 * config repo when it is a different token. Checked tokens are skipped.
 */
export function tokensToCheck(code: { token: string; name: string; repo: string }, config: { token: string | null; name: string; repo: string }, checked: (token: string) => boolean): Array<{ token: string; name: string; repo: string }> {
  const out = [code];
  if (config.token && config.token !== code.token) out.push({ token: config.token, name: config.name, repo: config.repo });
  return out.filter((c) => !checked(c.token));
}

const PROBE = "name: factory-token-probe\non: workflow_dispatch\njobs: {}\n";

export class HttpTokenCheck extends HttpIssues implements TokenCheckApi {
  async reachableRepos(): Promise<Array<{ name: string; private: boolean }>> {
    // A repo whose visibility isn't a plain false counts as private, so a changed response can't hide one.
    return (await this.list("/user/repos?per_page=100")).map((r) => ({ name: String(r.full_name ?? ""), private: r.private !== false })).filter((r) => r.name);
  }

  async workflowWriteRefused(repo: string, base: string): Promise<boolean> {
    const r = checkRepo(repo);
    const commit = await this.call("GET", `/repos/${r}/git/commits/${base}`);
    const tree = String((commit.body as { tree?: { sha?: unknown } } | null)?.tree?.sha ?? "");
    if (commit.status !== 200 || !/^[0-9a-f]{40}$/.test(tree)) return true;
    const t = await this.call("POST", `/repos/${r}/git/trees`, { base_tree: tree, tree: [{ path: ".github/workflows/factory-token-probe.yml", mode: "100644", type: "blob", content: PROBE }] });
    if (t.status !== 201) return true;
    const c = await this.call("POST", `/repos/${r}/git/commits`, { message: "Factory token probe", tree: (t.body as { sha: string }).sha, parents: [base] });
    if (c.status !== 201) return true;
    const name = `factory-token-probe-${crypto.randomBytes(6).toString("hex")}`;
    const ref = await this.call("POST", `/repos/${r}/git/refs`, { ref: `refs/heads/${name}`, sha: (c.body as { sha: string }).sha });
    this.act("github.token_probe_workflow_write", r, ref.status);
    if (ref.status !== 201) return true;
    const del = await this.call("DELETE", `/repos/${r}/git/refs/heads/${name}`);
    this.act("github.delete_probe_branch", `${r} ${name}`, del.status);
    return false;
  }
}
