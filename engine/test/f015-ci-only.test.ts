import { describe, expect, it } from "vitest";
import { parseJunit } from "../src/build/junit";
import { checksVerdict } from "../src/build/stage9";
import { runReport } from "../src/build/test-run";
import { buildTurn, ciPendingText } from "../src/build/worker";
import { modelReport } from "../src/schemas/agent-report";

const SHA = "c".repeat(40);
const xml = `<testsuite>
  <testcase classname="tests.test_deploy" name="test_lock"><skipped message="needs flock; runs in CI on Ubuntu"/></testcase>
  <testcase classname="tests.test_deploy" name="test_marker[a]"><skipped message="needs flock; runs in CI on Ubuntu"/></testcase>
  <testcase classname="tests.test_alert" name="test_once"><skipped message="needs flock; runs in CI on Ubuntu"/></testcase>
  <testcase classname="tests.test_other" name="test_ok"/>
  <testcase classname="tests.test_other" name="test_skip"><skipped message="slow"/></testcase>
</testsuite>`;
const ciOnly = [
  { test: "tests/test_deploy.py", reason: "needs flock; runs in CI on Ubuntu" },
  { test: "tests/test_alert.py::test_once", reason: "Linux only" },
];

describe("F-015 FR-29: tests only CI can run", () => {
  it("AC-58: listed skips are pending on CI, not not_run, and the run can pass", () => {
    const r = runReport(SHA, parseJunit(xml), { "AC-1": ["tests/test_deploy.py::test_lock"] }, null, "", ciOnly, false);
    expect(r.complete).toBe(true);
    expect(r.ci_pending.map((x) => x.test).sort()).toEqual(["tests.test_alert#test_once", "tests.test_deploy#test_lock", "tests.test_deploy#test_marker[a]"].sort());
    expect(r.ci_pending.find((x) => x.test.endsWith("test_once"))?.reason).toBe("Linux only");
    expect(r.not_run.map((x) => x.test)).toEqual(["tests.test_other#test_skip"]);
    expect(r.failed).toBe(0);
  });

  it("AC-58: a listed test that ran counts as usual, and an unlisted unexplained skip still makes the run incomplete", () => {
    const ran = runReport(SHA, parseJunit(`<testsuite><testcase classname="tests.test_alert" name="test_once"/></testsuite>`), {}, null, "", ciOnly, false);
    expect(ran.ci_pending).toEqual([]);
    expect(ran.passed).toBe(1);
    const bare = runReport(SHA, parseJunit(`<testsuite><testcase classname="t" name="a"><skipped/></testcase></testsuite>`), {}, null, "", ciOnly, false);
    expect(bare.complete).toBe(false);
  });

  it("AC-59: with no required check on main, a CI-only list makes the run incomplete", () => {
    const r = runReport(SHA, parseJunit(xml), {}, null, "", ciOnly, true);
    expect(r.complete).toBe(false);
    expect(r.incomplete).toBe("CI-only tests need a required CI check on main");
    expect(runReport(SHA, parseJunit(xml), {}, null, "", [], true).complete).toBe(true);
  });

  it("AC-60: build sessions are told not to block on tests pending on CI, and the test engineer how to list them", () => {
    const facts = { feature: "F-004", title: "t", repo: "r", branch: "b", worktree: "/w", spec: "s", folder: "f", version: 1, commit: SHA, stage: "build" };
    const dev = buildTurn("software-developer", { ...facts, ciOnly: 2 });
    expect(dev).toContain(ciPendingText(2));
    expect(dev).not.toContain("`ci_only`");
    expect(buildTurn("software-developer", facts)).not.toContain("pending on CI");
    expect(buildTurn("test-engineer", facts)).toContain("`ci_only`");
    expect(ciPendingText(3)).toMatch(/don't block on them, and don't ask for a run on another platform/);
  });

  it("the test engineer's report may carry ci_only, but not the engine's ci_pending", () => {
    const report = { schema: "agent-report/1.0", role: "test-engineer", feature: "F-004", stage: "build", commit: SHA, outcome: "complete", summary: "ok", body: { criteria_map: {}, tool_choices: [], ci_only: ciOnly } };
    expect(modelReport("test-engineer").safeParse(report).success).toBe(true);
    expect(modelReport("test-engineer").safeParse({ ...report, body: { ...report.body, ci_pending: [] } }).success).toBe(false);
  });

  it("AC-61: the PR waits on the required check, and red CI is a failure", () => {
    const req = [{ context: "unit-tests", integrationId: null }];
    const run = (conclusion: string | null, status = "completed") => [{ name: "unit-tests", headSha: SHA, appId: 15368, status, conclusion, summary: "" }];
    expect(checksVerdict(req as never, run(null, "in_progress") as never, SHA).state).toBe("pending");
    expect(checksVerdict(req as never, run("failure") as never, SHA).state).toBe("red");
    expect(checksVerdict(req as never, run("success") as never, SHA).state).toBe("green");
  });
});
