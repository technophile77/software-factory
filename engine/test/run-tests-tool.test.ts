// F-015 FR-25: build agents run tests only through run_tests, which the engine runs as stage 6 does.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runsTests, toolGate } from "../src/agent/session";
import { runTestsTool } from "../src/build/run-tests-tool";
import { testEnv } from "../src/build/test-run";
import { Git } from "../src/git";
import { MemoryLogger } from "../src/log";
import { type RolePolicy, SECRET_DENIES } from "../src/policy/role-policy";
import { Children } from "../src/proc";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";

// A test runner stand-in: writes a JUnit file with a passing test, a failing one, and two cases of a parametrized one; with an argument, only that test.
const RUNNER = `
const fs = require("fs");
const all = [["tests.test_a", "test_ok", ""], ["tests.test_a", "test_bad", "assert 1 == 2"], ["tests.test_a", "test_p[x]", ""], ["tests.test_a", "test_p[y]", ""]];
const want = process.argv[2];
const pick = want ? all.filter(([c, n]) => want.endsWith("::" + n.split("[")[0])) : all;
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/junit.xml", "<testsuites><testsuite>" + pick.map(([c, n, f]) => '<testcase classname="' + c + '" name="' + n + '">' + (f ? '<failure message="' + f + '"/>' : "") + "</testcase>").join("") + "</testsuite></testsuites>");
`;

function setup(testOne = true) {
  const root = tmpdir();
  initRepo(root, { "README.md": "r\n", "runner.js": RUNNER });
  const children = new Children();
  const map = { "AC-1": ["tests/test_a.py::test_ok", "tests/test_a.py::test_p"], "AC-2": ["tests/test_a.py::test_bad"] };
  const tool = runTestsTool({
    git: new Git({ gitPath: GIT_PATH, homeDir: tmpdir(), children }), worktree: root, gitDir: git(root, "rev-parse", "--absolute-git-dir"),
    commands: { build: null, test: [process.execPath, "runner.js"], testOne: testOne ? [process.execPath, "runner.js", "{test}"] : null, results: "out/junit.xml" },
    env: testEnv(process.env, process.platform), platform: process.platform, wallMs: 60_000, maxOutput: 1 << 20, children,
    criteria: () => map, scrub: async (t) => t,
  });
  const call = async (args: unknown) => {
    const r = await tool.handler(args);
    return { error: r.isError === true, body: JSON.parse(r.content[0]!.text) };
  };
  return { root, call };
}

describe("run_tests (F-015 FR-25, Build tools v1.0)", () => {
  it("AC-47, AC-48: runs the whole suite as stage 6 does, joined to the reported map, and leaves no results file", async () => {
    const { root, call } = setup();
    const { error, body } = await call({});
    expect(error).toBe(false);
    expect(body).toMatchObject({ tests_run: 4, passed: 3, failed: 1, complete: true, failures: [{ test: "tests.test_a#test_bad", message: "assert 1 == 2" }] });
    expect(body.criteria).toEqual({
      "AC-1": [{ test: "tests/test_a.py::test_ok", status: "passed" }, { test: "tests/test_a.py::test_p", status: "passed" }],
      "AC-2": [{ test: "tests/test_a.py::test_bad", status: "failed" }],
    });
    expect(fs.existsSync(path.join(root, "out", "junit.xml"))).toBe(false);
    // The test engineer's own map, passed with the call, is the one joined.
    const own = await call({ criteria_map: { "AC-9": ["tests/test_a.py::test_gone"] } });
    expect(own.body.criteria).toEqual({ "AC-9": [{ test: "tests/test_a.py::test_gone", status: "missing" }] });
    expect(own.body.not_run[0].reason).toMatch(/^mapped to a criterion but not in the results file/);
  });

  it("AC-47: runs one test from the map through commands.test_one, and refuses any other id", async () => {
    const { call } = setup();
    const one = await call({ test: "tests/test_a.py::test_p" });
    expect(one.body).toMatchObject({ tests_run: 2, passed: 2, failed: 0, criteria: { "AC-1": [{ test: "tests/test_a.py::test_p", status: "passed" }] } });
    expect(await call({ test: "--rootdir=/etc" })).toMatchObject({ error: true, body: { error: "not_in_map" } });
    const none = setup(false);
    expect(await none.call({ test: "tests/test_a.py::test_ok" })).toMatchObject({ error: true, body: { error: "no_single_test_command" } });
    expect(await none.call({ criteria_map: "x" })).toMatchObject({ error: true, body: { error: "bad_args" } });
  });
});

describe("test runs in a shell are refused (Role policy v2.12, AC-49)", () => {
  const sig = { signal: new AbortController().signal };
  const policy: RolePolicy = { role: "test-engineer", tools: ["Bash", "Monitor"], read: { allow: ["**"], deny: [...SECRET_DENIES] }, write: { allow: ["tests/**"], deny: [] }, commands: [], network: [], mayRequest: [] };

  it("matches test runners where a command starts, and the repo's own test command", () => {
    for (const c of ["pytest -q", "python -m pytest tests", "E:/v/Scripts/python.exe -m pytest", "npm test", "npm run test", "npx vitest run", "node --test", "cd x && pytest", "PYTHONPATH=. pytest", "go test ./...", "cargo test"]) expect(runsTests(c), c).toBe(true);
    for (const c of ["ls src", "git status", "grep -r pytest src", "pip install pytest", "python smoke.py", "echo test", "cat tap.txt"]) expect(runsTests(c), c).toBe(false);
    expect(runsTests("./run.sh --suite all", ["./run.sh", "--suite", "all"])).toBe(true);
  });

  it("refuses them only in a session with run_tests, naming it", async () => {
    const wt = tmpdir();
    const host = { ask: async () => true, askExtra: [], testCommand: ["python", "-m", "pytest", "--junitxml=out.xml"] };
    const gate = toolGate(policy, wt, ["run_tests"], new MemoryLogger(), wt, false, host);
    const denied = await gate("Bash", { command: "python -m pytest tests/test_a.py" }, sig);
    expect(denied).toMatchObject({ behavior: "deny", message: expect.stringMatching(/run_tests/) });
    expect((await gate("Monitor", { description: "t", timeout_ms: 1, command: "pytest -x" }, sig)).behavior).toBe("deny");
    expect((await gate("Bash", { command: "ls tests" }, sig)).behavior).toBe("allow");
    expect((await gate("mcp__factory__run_tests", {}, sig)).behavior).toBe("allow");
    const without = toolGate(policy, wt, [], new MemoryLogger(), wt, false, host);
    expect((await without("Bash", { command: "pytest -q" }, sig)).behavior).toBe("allow");
  });
});
