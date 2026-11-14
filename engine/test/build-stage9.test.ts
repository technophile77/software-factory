import { describe, expect, it } from "vitest";
import type { CheckRun } from "../src/build/pulls";
import { ACTIONS_APP_ID, checksVerdict, doneComment, prText, prWorkflowProblems, verbatimMatch } from "../src/build/stage9";

// F-015 stage 9 rules: green CI, pull request workflows, and what never leaves the PC.

const SHA = "a".repeat(40);
const run = (o: Partial<CheckRun> = {}): CheckRun => ({ name: "test", status: "completed", conclusion: "success", appId: ACTIONS_APP_ID, headSha: SHA, summary: "", ...o });

describe("checksVerdict (SR-3, SR-11)", () => {
  const required = [{ context: "test", integrationId: null }];

  it("green only when every required check passed on the pushed SHA from its app", () => {
    expect(checksVerdict(required, [run()], SHA)).toEqual({ state: "green" });
    expect(checksVerdict([], [], SHA)).toEqual({ state: "green" });
  });

  it("AC-28: a pass on another SHA or from another app doesn't count", () => {
    expect(checksVerdict(required, [run({ headSha: "b".repeat(40) })], SHA)).toEqual({ state: "pending", waiting: ["test"] });
    expect(checksVerdict(required, [run({ appId: 1 })], SHA)).toEqual({ state: "pending", waiting: ["test"] });
    expect(checksVerdict([{ context: "test", integrationId: 99 }], [run()], SHA)).toMatchObject({ state: "pending" });
    expect(checksVerdict([{ context: "test", integrationId: 99 }], [run({ appId: 99 })], SHA)).toEqual({ state: "green" });
  });

  it("red on a failed required check; a check still running waits", () => {
    expect(checksVerdict(required, [run({ conclusion: "failure" })], SHA)).toMatchObject({ state: "red", failed: [{ name: "test" }] });
    expect(checksVerdict(required, [run(), run({ status: "in_progress", conclusion: null })], SHA)).toMatchObject({ state: "pending" });
    expect(checksVerdict(required, [run({ name: "lint", conclusion: "failure" })], SHA)).toMatchObject({ state: "pending" });
  });
});

describe("prWorkflowProblems (SR-13, AC-30)", () => {
  const wf = (s: string) => [{ path: ".github/workflows/ci.yml", text: s }];

  it("accepts a pull_request workflow with read-only permissions", () => {
    expect(prWorkflowProblems(wf("on: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n"))).toEqual([]);
    expect(prWorkflowProblems(wf("on: push\njobs:\n  deploy:\n    environment: prod\n    steps: []\n"))).toEqual([]);
  });

  it("refuses secrets, write permissions, environments, no permissions and pull_request_target", () => {
    expect(prWorkflowProblems(wf("on: pull_request\npermissions: read-all\njobs:\n  t:\n    steps:\n      - run: echo ${{ secrets.NPM_TOKEN }}\n"))).toEqual([expect.stringMatching(/secret other than GITHUB_TOKEN/)]);
    expect(prWorkflowProblems(wf("on: pull_request\npermissions: read-all\njobs:\n  t:\n    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}\n"))).toEqual([]);
    expect(prWorkflowProblems(wf("on: pull_request\npermissions:\n  contents: write\njobs:\n  t:\n    steps: []\n"))).toEqual([expect.stringMatching(/write permissions/)]);
    expect(prWorkflowProblems(wf("on: pull_request\njobs:\n  t:\n    steps: []\n"))).toEqual([expect.stringMatching(/doesn't declare permissions/)]);
    expect(prWorkflowProblems(wf("on: pull_request\npermissions: {}\njobs:\n  t:\n    environment: prod\n    steps: []\n"))).toEqual([expect.stringMatching(/deploy environment/)]);
    expect(prWorkflowProblems(wf("on:\n  pull_request_target:\njobs: {}\n"))).toEqual([expect.stringMatching(/pull_request_target/)]);
    expect(prWorkflowProblems(wf("on: [pull_request\n"))).toEqual([expect.stringMatching(/isn't valid YAML/)]);
  });
});

describe("verbatimMatch (SR-4, AC-21)", () => {
  const spec = "Lorem ipsum dolor sit amet. ".repeat(20);

  it("finds 200 or more shared characters, whitespace folded, anywhere in the text", () => {
    const text = `+ // ${spec.slice(37, 260).replace(/ /g, "\n  ")}\n+ more`;
    expect(verbatimMatch(text, ["unrelated", spec])?.length).toBeGreaterThanOrEqual(200);
  });

  it("ignores shorter stretches", () => {
    expect(verbatimMatch(`x ${spec.slice(0, 150)} y`, [spec])).toBeNull();
    expect(verbatimMatch(spec, ["short"])).toBeNull();
  });
});

describe("PR text (SR-4) and the definition-of-done comment (F-011 FR-9)", () => {
  it("holds only the feature id, title, spec version and links", () => {
    const t = prText({ id: "F-001", title: "Export\norders", specVersion: 3, specCommit: SHA, configRepo: "o/acme-config", specPath: "docs/features/F-001-export.md" }, true);
    expect(t.title).toBe("F-001: Export orders");
    expect(t.body).toContain(`https://github.com/o/acme-config/blob/${SHA}/docs/features/F-001-export.md`);
    const c = doneComment({ feature: "F-001", specVersion: 3, head: SHA, configRepo: "o/acme-config", fork: false, items: [{ n: 1, label: "Requirements approved", met: true }, { n: 7, label: "Final security review passed", met: true, ref: "runs/F-001/code_review/security-reviewer-2.json" }] });
    expect(c).toContain("| 1 | Requirements approved | Met | - |");
    expect(c).toContain("(https://github.com/o/acme-config/blob/factory/state/runs/F-001/code_review/security-reviewer-2.json)");
  });
});
