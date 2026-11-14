import { describe, expect, it } from "vitest";
import type { CheckRun, Pull, RequiredCheck } from "../src/build/pulls";
import { tokenProblems } from "../src/build/token-check";
import { type ChangedFile, type MergeApi, autoMergeHygiene, diffHash, hygieneBranch } from "../src/inbox/auto-merge";
import type { IssueComment } from "../src/inbox/github-issues";

// F-011 FR-10 / F-015 SR-12: the hygiene auto-merge; F-015 SR-2: the token's scope.

const SHA = "a".repeat(40);
const FILES: ChangedFile[] = [{ filename: "docs/a.md", status: "modified", sha: "b".repeat(40) }, { filename: "agents/x/AGENT.md", status: "modified", sha: "c".repeat(40) }];

class Api implements MergeApi {
  merged: Array<[number, string]> = [];
  posted: string[] = [];
  files_ = FILES;
  checks: CheckRun[] = [{ name: "ci", status: "completed", conclusion: "success", appId: 15368, headSha: SHA, summary: "" }];
  mergeOk = true;
  pr: Pull = { number: 7, nodeId: "n", state: "open", draft: false, merged: false, mergeCommit: null, mergedBy: "", head: { sha: SHA, ref: hygieneBranch("H-0300"), repo: "o/r" }, url: "" };
  async pull(): Promise<Pull> { return this.pr; }
  async files(): Promise<ChangedFile[]> { return this.files_; }
  async requiredChecks(): Promise<RequiredCheck[]> { return [{ context: "ci", integrationId: null }]; }
  async checkRuns(): Promise<CheckRun[]> { return this.checks; }
  async merge(_r: string, n: number, sha: string): Promise<boolean> { if (this.mergeOk) this.merged.push([n, sha]); return this.mergeOk; }
  async comment(_r: string, _n: number, body: string): Promise<number> { this.posted.push(body); return 1; }
  async findPull(): Promise<Pull | null> { return null; }
  async createPull(): Promise<Pull> { throw new Error("no"); }
  async updatePull(): Promise<void> {}
  async markReady(): Promise<void> {}
  async comments(): Promise<IssueComment[]> { return []; }
}

const item = { itemId: "H-0300", repo: "o/r", pr: 7, approvedDiff: diffHash(FILES) };

describe("autoMergeHygiene (AC-14, AC-29)", () => {
  it("merges the identical change at the compared head SHA", async () => {
    const api = new Api();
    expect(await autoMergeHygiene(api, item)).toEqual({ merged: true, sha: SHA });
    expect(api.merged).toEqual([[7, SHA]]);
  });

  it("the file order doesn't change the hash; one changed line does, and then nothing is merged and the PR says why", async () => {
    expect(diffHash([...FILES].reverse())).toBe(item.approvedDiff);
    const api = new Api();
    api.files_ = [FILES[0]!, { ...FILES[1]!, sha: "d".repeat(40) }];
    expect(await autoMergeHygiene(api, item)).toMatchObject({ merged: false, commented: true });
    expect(api.merged).toEqual([]);
    expect(api.posted[0]).toContain("differ from the ones approved in H-0300");
  });

  it("AC-29: a PR from another branch, a feature branch or a fork, or a closed one, merges nothing", async () => {
    for (const head of [{ ref: "feature/F-001-x", repo: "o/r" }, { ref: hygieneBranch("H-0301"), repo: "o/r" }, { ref: hygieneBranch("H-0300"), repo: "fork/r" }]) {
      const api = new Api();
      api.pr = { ...api.pr, head: { ...api.pr.head, ...head } };
      expect(await autoMergeHygiene(api, item)).toMatchObject({ merged: false, commented: false });
      expect(api.merged).toEqual([]);
    }
    const api = new Api();
    api.pr = { ...api.pr, state: "closed" };
    expect(await autoMergeHygiene(api, item)).toMatchObject({ merged: false });
  });

  it("AC-29: checks not green on the head merge nothing; a head that moved is refused by GitHub and commented", async () => {
    const api = new Api();
    api.checks = [{ ...api.checks[0]!, conclusion: "failure" }];
    expect(await autoMergeHygiene(api, item)).toMatchObject({ merged: false, commented: false });
    const moved = new Api();
    moved.mergeOk = false;
    expect(await autoMergeHygiene(moved, item)).toMatchObject({ merged: false, commented: true });
  });
});

describe("tokenProblems (SR-2, AC-19)", () => {
  const project = ["o/web", "o/config"];
  it("passes a token that reaches only the project and can't write workflows", async () => {
    expect(await tokenProblems({ reachableRepos: async () => ["O/Web", "o/config"], workflowWriteRefused: async () => true }, project, { repo: "o/web", base: SHA })).toEqual([]);
  });
  it("names repos outside the project and a workflow write that went through", async () => {
    const r = await tokenProblems({ reachableRepos: async () => ["o/web", "o/other"], workflowWriteRefused: async () => false }, project, { repo: "o/web", base: SHA });
    expect(r).toEqual([expect.stringContaining("outside the project (o/other)"), expect.stringContaining("can write CI workflows in o/web")]);
  });
});
