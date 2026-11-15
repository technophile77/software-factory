import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JunitError, parseJunit } from "../src/build/junit";
import { type Stage6Limits, afterClassify, afterRun, checkClassification, stage6Counts } from "../src/build/stage6";
import { TestRunError, clearResults, cmdQuote, readResults, resolveProgram, runCommand, runReport, testEnv } from "../src/build/test-run";
import type { BuildEvent } from "../src/interview/model";
import type { Git } from "../src/git";
import { Children } from "../src/proc";
import { tmpdir } from "./helpers";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- vitest -->
<testsuites name="all" tests="4">
  <testsuite name="export">
    <testcase classname="export" name="May &amp; June" time="0.1"/>
    <testcase classname="export" name="empty range"><failure message="expected 0 rows">AssertionError: <![CDATA[got <1>]]></failure><system-out>log line</system-out></testcase>
    <testcase classname="export" name="slow"><skipped message="needs a database"/></testcase>
    <testcase classname="export" name="crash"><error message="boom"/></testcase>
    <properties><property name="x" value="y"/></properties>
  </testsuite>
</testsuites>`;

describe("JUnit results (SR-8, AC-25)", () => {
  it("reads cases, statuses, messages and text", () => {
    const cases = parseJunit(XML);
    expect(cases.map((c) => [c.id, c.status])).toEqual([["export#May & June", "passed"], ["export#empty range", "failed"], ["export#slow", "skipped"], ["export#crash", "error"]]);
    expect(cases[1]).toMatchObject({ message: "expected 0 rows", detail: "AssertionError: got <1>\nlog line" });
  });
  it.each([
    ["a DTD", `<!DOCTYPE x [<!ENTITY e "x">]><testsuite><testcase name="a">&e;</testcase></testsuite>`],
    ["an unknown entity", `<testsuite><testcase name="a&e;"/></testsuite>`],
    ["a bare &", `<testsuite><testcase name="a & b"/></testsuite>`],
    ["bad nesting", `<testsuite><testcase name="a"></testsuite></testcase>`],
    ["deep nesting", `<testsuite>${"<x>".repeat(40)}${"</x>".repeat(40)}</testsuite>`],
    ["not JUnit", `<html/>`],
    ["an unclosed element", `<testsuite><testcase name="a">`],
  ])("refuses %s", (_what, xml) => {
    expect(() => parseJunit(xml)).toThrow(JunitError);
  });
  it("caps text at 8 KiB", () => {
    const cases = parseJunit(`<testsuite><testcase name="a"><failure>${"x".repeat(20000)}</failure></testcase></testsuite>`);
    expect(cases[0]!.detail.length).toBeLessThanOrEqual(8 * 1024 + 1);
  });

  it("refuses a missing file, a symlink, an oversized file and one outside the worktree", () => {
    const wt = tmpdir();
    expect(() => readResults(wt, "reports/junit.xml")).toThrow(/no results file/);
    fs.mkdirSync(path.join(wt, "reports"));
    const outside = path.join(tmpdir(), "x.xml");
    fs.writeFileSync(outside, XML);
    fs.symlinkSync(outside, path.join(wt, "reports", "junit.xml"));
    expect(() => readResults(wt, "reports/junit.xml")).toThrow(/symlink/);
    fs.rmSync(path.join(wt, "reports", "junit.xml"));
    fs.writeFileSync(path.join(wt, "reports", "junit.xml"), Buffer.alloc(5 * 1024 * 1024 + 1, 32));
    expect(() => readResults(wt, "reports/junit.xml")).toThrow(/5 MiB/);
    fs.writeFileSync(path.join(wt, "reports", "junit.xml"), XML);
    expect(readResults(wt, "reports/junit.xml")).toHaveLength(4);
  });

  it("creates a missing results folder before the run, since runners such as node --test don't", async () => {
    const wt = tmpdir();
    const untracked = { out: async () => "" } as unknown as Git;
    const full = await clearResults(untracked, wt, path.join(wt, ".git"), "test-results/junit.xml");
    expect(fs.statSync(path.dirname(full)).isDirectory()).toBe(true);
    expect(fs.existsSync(full)).toBe(false);
  });

  it("refuses a results folder that a symlink takes outside the worktree", async () => {
    const wt = tmpdir();
    fs.symlinkSync(tmpdir(), path.join(wt, "out"));
    const untracked = { out: async () => "" } as unknown as Git;
    await expect(clearResults(untracked, wt, path.join(wt, ".git"), "out/junit.xml")).rejects.toThrow(/outside the worktree/);
  });
});

describe("run report (FR-6, AC-6)", () => {
  const cases = parseJunit(XML);
  it("joins the criteria map and counts", () => {
    const r = runReport("c".repeat(40), cases, { "AC-1": ["export#May & June"], "AC-2": ["export#nope"] });
    expect(r).toMatchObject({ tests_run: 3, passed: 1, failed: 2, skipped: 1, complete: false });
    expect(r.criteria["AC-1"]).toEqual([{ test: "export#May & June", status: "passed" }]);
    expect(r.not_run).toContainEqual({ test: "export#nope", reason: "mapped to a criterion but not in the results file" });
  });
  it("an unexplained skip makes the run incomplete", () => {
    const r = runReport("c".repeat(40), parseJunit(`<testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuite>`), {});
    expect(r.incomplete).toMatch(/skipped with no reason/);
  });
});

describe("test command (SR-9, AC-26)", () => {
  it("resolves the program outside the worktree only", () => {
    const wt = tmpdir();
    const bin = tmpdir();
    fs.writeFileSync(path.join(wt, "npm"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\n");
    expect(resolveProgram("npm", wt, { PATH: `${wt}:.:${bin}` }, "linux")).toBe(path.join(bin, "npm"));
    expect(() => resolveProgram("./npm", wt, { PATH: bin }, "linux")).toThrow(TestRunError);
    expect(() => resolveProgram(path.join(wt, "npm"), wt, { PATH: bin }, "linux")).toThrow(/inside the worktree/);
    expect(() => resolveProgram("npm", wt, { PATH: wt }, "linux")).toThrow(/isn't on PATH/);
  });
  it("passes only the allowlisted environment", () => {
    const env = testEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", HTTPS_PROXY: "http://p", LC_ALL: "C", ANTHROPIC_API_KEY: "k" }, "linux");
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", CI: "true" });
  });
  it("quotes cmd.exe arguments and refuses % and line breaks", () => {
    expect(cmdQuote('a "b" c')).toBe('"a ""b"" c"');
    expect(() => cmdQuote("%PATH%")).toThrow(TestRunError);
    expect(() => cmdQuote("a\nb")).toThrow(TestRunError);
  });
  it.runIf(process.platform !== "win32")("kills the whole tree at the wall-time cap and caps output", async () => {
    const children = new Children();
    const r = await runCommand({ program: "/bin/sh", args: ["-c", "sleep 30 & yes | head -c 100000; sleep 30"], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, wallMs: 500, maxOutput: 1000, platform: "linux", children });
    expect(r.timedOut).toBe(true);
    expect(r.output.length).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });
});

const L: Stage6Limits = { environment_reruns: 2, incomplete_reruns: 1, product_fix_cycles: 3, test_fix_cycles: 3, unclear_investigations: 1, flaky_per_test: 3, disagreements: 2, agent_hours: 4 };
const ev = (action: string, data: Record<string, unknown> = {}): BuildEvent => ({ action, at: "t", ...data });
const report = (o: Partial<ReturnType<typeof runReport>>) => ({ ...runReport("c".repeat(40), [], {}), complete: true, incomplete: null, failed: 0, failures: [], ...o });

describe("stage 6 failure table (FR-7, AC-6, AC-7, AC-8)", () => {
  it("an incomplete run gets 1 rerun, then a Testing item", () => {
    const r = report({ complete: false, incomplete: "no results" });
    expect(afterRun(r, stage6Counts([]), L)).toEqual({ action: "rerun", why: "incomplete" });
    expect(afterRun(r, stage6Counts([ev("rerun", { why: "incomplete" })]), L)).toMatchObject({ action: "escalate", kind: "testing" });
  });
  it("a passing run needs no classifier; a failing one does", () => {
    expect(afterRun(report({}), stage6Counts([]), L)).toEqual({ action: "passed", flaky: [] });
    expect(afterRun(report({ failed: 1, failures: [{ test: "t", expected: "pass", actual: "x", log_ref: "" }] }), stage6Counts([]), L)).toEqual({ action: "tests_failed" });
  });
  it("product code gets 3 fix cycles; the fourth failure is a Testing item", () => {
    const three = [1, 2, 3].map(() => ev("product_code", { causes: { t: "product_code" } }));
    expect(afterClassify({ t: "product_code" }, stage6Counts(three.slice(0, 2)), L)).toEqual({ action: "product_code" });
    expect(afterClassify({ t: "product_code" }, stage6Counts(three), L)).toMatchObject({ action: "escalate", kind: "testing", why: expect.stringContaining("3 fix cycles") });
  });
  it("environment reruns up to 2 times, and a test that then passes is flaky; 3 flaky passes escalate", () => {
    expect(afterClassify({ t: "environment" }, stage6Counts([]), L)).toEqual({ action: "rerun", why: "environment" });
    expect(afterClassify({ t: "environment" }, stage6Counts([ev("rerun", { why: "environment" }), ev("rerun", { why: "environment" })]), L)).toMatchObject({ action: "escalate" });
    const env = ev("rerun", { why: "environment", causes: { t: "environment" } });
    expect(afterRun(report({}), stage6Counts([env]), L)).toEqual({ action: "passed", flaky: ["t"] });
    expect(afterRun(report({}), stage6Counts([ev("passed", { flaky: ["t"] }), ev("passed", { flaky: ["t"] }), env]), L)).toMatchObject({ action: "escalate" });
  });
  it("dependency and still-unclear escalate at once; two disagreements go to the Decision inbox", () => {
    expect(afterClassify({ t: "dependency" }, stage6Counts([]), L)).toMatchObject({ action: "escalate", kind: "testing" });
    expect(afterClassify({ t: "unclear" }, stage6Counts([]), L)).toMatchObject({ action: "escalate" });
    const hist = [ev("product_code", { causes: { t: "product_code" } }), ev("test_code", { causes: { t: "test_code" } })];
    expect(afterClassify({ t: "product_code" }, stage6Counts(hist), L)).toMatchObject({ action: "escalate", kind: "decision" });
  });
  it("4 hours of stage 6 agent time escalates", () => {
    expect(afterClassify({ t: "product_code" }, stage6Counts([ev("done", { ms: 4 * 3_600_000, stage6: true })]), L)).toMatchObject({ action: "escalate" });
  });
  it("an owner's answer starts the counts again", () => {
    const c = stage6Counts([ev("product_code"), ev("product_code"), ev("product_code"), ev("to_developer", { item: "T-0001" })]);
    expect(c.productCycles).toBe(0);
  });
});

describe("classifier report check (SR-10, AC-27)", () => {
  it("accepts exactly the run's failures with known causes", () => {
    expect(checkClassification([{ test: "a", cause: "product_code", evidence: "e" }], ["a"])).toEqual({ causes: { a: "product_code" }, evidence: { a: "e" } });
  });
  it.each([
    [[{ test: "zzz", cause: "product_code", evidence: "e" }], /isn't one of the run's failures/],
    [[{ test: "a", cause: "cosmic rays", evidence: "e" }], /isn't one of/],
    [[{ test: "a", cause: "unclear", evidence: "x".repeat(2049) }], /over 2 KiB/],
    [[], /no cause for a/],
  ])("refuses %j", (failures, re) => {
    expect(checkClassification(failures, ["a"])).toMatch(re);
  });
});
