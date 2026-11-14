import * as crypto from "node:crypto";
import { HttpIssues, checkRepo } from "../inbox/github-issues";

/**
 * F-015 SR-2: the owner token reaches only the project's repos and can't
 * write CI workflows. Fine-grained tokens can't report their own
 * permissions, so the workflow check tries a workflow write on a throwaway
 * branch: refused is the pass; if GitHub accepts it, the branch is deleted
 * at once and the project stops.
 */

export interface TokenCheckApi {
  reachableRepos(): Promise<string[]>;
  workflowWriteRefused(repo: string, base: string): Promise<boolean>;
}

/** What is wrong with the token for these repos, in engine words; empty when nothing is. */
export async function tokenProblems(api: TokenCheckApi, project: readonly string[], probe: { repo: string; base: string }): Promise<string[]> {
  const mine = new Set(project.map((r) => r.toLowerCase()));
  const outside = (await api.reachableRepos()).filter((r) => !mine.has(r.toLowerCase()));
  const out: string[] = [];
  if (outside.length) out.push(`the token reaches ${outside.length} repo${outside.length > 1 ? "s" : ""} outside the project (${outside.slice(0, 5).join(", ")})`);
  if (!(await api.workflowWriteRefused(probe.repo, probe.base))) out.push(`the token can write CI workflows in ${probe.repo}`);
  return out;
}

const PROBE = "name: factory-token-probe\non: workflow_dispatch\njobs: {}\n";

export class HttpTokenCheck extends HttpIssues implements TokenCheckApi {
  async reachableRepos(): Promise<string[]> {
    return (await this.list("/user/repos?per_page=100")).map((r) => String(r.full_name ?? "")).filter(Boolean);
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
