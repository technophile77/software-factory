import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCodeReview, judgeOutcome, judgeQuestions } from "../src/build/review";
import { SEMGREP_VERSION, SemgrepError, parseSemgrep, runSemgrep, semgrepVenv, type Run } from "../src/build/semgrep";
import type { CommandResult } from "../src/build/test-run";
import { tmpdir } from "./helpers";

// F-015 FR-8, FR-9: what blocks at Code Review and where the judge's verdict sends the feature is code.

const STANDARDS = { criteria: new Set(["S1.1", "S6.1"]), severities: ["Critical", "High", "Medium", "Low"] };
const finding = (severity: string, extra: Record<string, unknown> = {}) => ({ criterion: "S6.1", severity, location: "src/a.ts:3", explanation: "x", fix: "y", ...extra });

describe("checkCodeReview", () => {
  it("AC-9: the engine sets blocks from the severity and the repo's maturity, never the reviewer", () => {
    const r = checkCodeReview({ gate: 2, findings: [finding("High", { blocks: false }), finding("Medium"), finding("Critical")] }, STANDARDS, "alpha");
    expect(Array.isArray(r) && r.map((f) => [f.severity, f.blocks])).toEqual([["High", true], ["Medium", false], ["Critical", true]]);
    expect(checkCodeReview({ gate: 2, findings: [finding("High")] }, STANDARDS, "rapid-prototype")).toMatchObject([{ blocks: false }]);
  });

  it("an unknown maturity level blocks every finding (fails closed)", () => {
    expect(checkCodeReview({ gate: 2, findings: [finding("Low")] }, STANDARDS, "")).toMatchObject([{ blocks: true }]);
  });

  it("refuses gate 1, criteria and severities outside the standards, and owner questions", () => {
    expect(checkCodeReview({ gate: 1, findings: [] }, STANDARDS, "alpha")).toMatch(/gate must be 2/);
    expect(checkCodeReview({ gate: 2, findings: [finding("High", { criterion: "S9.9" })] }, STANDARDS, "alpha")).toMatch(/criterion/);
    expect(checkCodeReview({ gate: 2, findings: [finding("Severe")] }, STANDARDS, "alpha")).toMatch(/severity must be one of/);
    expect(checkCodeReview({ gate: 2, findings: [finding("High", { needs_owner: true })] }, STANDARDS, "alpha")).toMatch(/can't ask the owner/);
  });
});

describe("judgeOutcome", () => {
  const met = { area: "Each functional requirement", status: "Met", evidence: "e" };
  const tests = ["test/**"];
  const body = (checklist: unknown[], findings: unknown[] = []) => ({ verdict: "PASS", checklist, findings });

  it("PASS with every line met and only minor findings", () => {
    expect(judgeOutcome(body([met], [{ grade: "Minor", location: "src/a.ts:1", explanation: "x" }]), "release", tests)).toEqual({ action: "pass", verdict: "PASS", reasons: [] });
  });

  it("AC-10: Needs owner wins over everything and goes to the owner", () => {
    const r = judgeOutcome(body([{ ...met, status: "Needs owner" }, { ...met, status: "Not met" }]), "alpha", tests);
    expect(r).toMatchObject({ action: "needs_human", verdict: "NEEDS_HUMAN_REVIEW" });
  });

  it("AC-10: a blocking finding in product code goes to the developer; one in the tests to the test engineer", () => {
    expect(judgeOutcome(body([met], [{ grade: "Blocking", location: "src/a.ts:3", explanation: "x" }]), "alpha", tests)).toMatchObject({ action: "fail_product", verdict: "FAIL" });
    expect(judgeOutcome(body([met], [{ grade: "Blocking", location: "test/a.test.ts:3", explanation: "x" }]), "alpha", tests)).toMatchObject({ action: "fail_tests" });
    expect(judgeOutcome(body([{ ...met, area: "Each acceptance criterion", status: "Not met" }]), "alpha", tests)).toMatchObject({ action: "fail_tests" });
    expect(judgeOutcome(body([{ ...met, status: "Not met" }, { ...met, area: "Test tools", status: "Not met" }]), "alpha", tests)).toMatchObject({ action: "fail_product" });
  });

  it("Major findings pass within the level's allowance (open decision 8) and fail over it", () => {
    const majors = (n: number) => Array.from({ length: n }, (_, i) => ({ grade: "Major", location: `src/a.ts:${i + 1}`, explanation: "x" }));
    expect(judgeOutcome(body([met], majors(9)), "rapid-prototype", tests)).toMatchObject({ action: "pass" });
    expect(judgeOutcome(body([met], majors(3)), "alpha", tests)).toMatchObject({ action: "pass" });
    expect(judgeOutcome(body([met], majors(4)), "alpha", tests)).toMatchObject({ action: "fail_product" });
    expect(judgeOutcome(body([met], majors(1)), "beta", tests)).toMatchObject({ action: "pass" });
    expect(judgeOutcome(body([met], majors(1)), "release", tests)).toMatchObject({ action: "fail_product" });
    expect(judgeOutcome(body([met], majors(1)), "", tests)).toMatchObject({ action: "fail_product" });
  });

  it("the judge's own verdict doesn't decide: a PASS with a line not met is a FAIL", () => {
    expect(judgeOutcome(body([{ ...met, status: "not met" }]), "alpha", tests)).toMatchObject({ verdict: "FAIL" });
  });

  it("refuses an empty checklist and unknown statuses or grades", () => {
    expect(judgeOutcome(body([]), "alpha", tests)).toMatch(/checklist/);
    expect(judgeOutcome(body([{ ...met, status: "Mostly" }]), "alpha", tests)).toMatch(/status must be/);
    expect(judgeOutcome(body([met], [{ grade: "Huge", location: "a", explanation: "x" }]), "alpha", tests)).toMatch(/grade must be/);
  });
});

const result = (o: Partial<CommandResult> = {}): CommandResult => ({ code: 0, signal: null, timedOut: false, output: "", truncated: false, durationMs: 1, ...o });

describe("Semgrep (FR-8, H-0196)", () => {
  it("parses findings and fails closed on errors or non-JSON", () => {
    const doc = { results: [{ check_id: "r1", path: "src/a.ts", start: { line: 4 }, extra: { severity: "ERROR", message: "m" } }], errors: [{ level: "warn" }] };
    expect(parseSemgrep(JSON.stringify(doc))).toEqual([{ rule: "r1", severity: "ERROR", path: "src/a.ts", line: 4, message: "m" }]);
    expect(() => parseSemgrep(JSON.stringify({ results: [], errors: [{ level: "error" }] }))).toThrow(SemgrepError);
    expect(() => parseSemgrep("{")).toThrow(SemgrepError);
    expect(() => parseSemgrep("{}")).toThrow(/no results list/);
  });

  it("installs the venv from the hash-pinned file once, wheels only, and checks the version", async () => {
    const root = path.join(tmpdir(), "semgrep");
    const req = path.join(tmpdir(), "req.txt");
    fs.writeFileSync(req, "semgrep==1.183.0 --hash=sha256:00\n");
    const calls: string[][] = [];
    const run: Run = async (program, args) => {
      calls.push([path.basename(program), ...args]);
      if (args[0] === "--version") return result({ output: `${SEMGREP_VERSION}\n` });
      if (args[1] === "venv") fs.mkdirSync(path.join(args[2]!, process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
      if (args[1] === "pip") fs.writeFileSync(path.join(path.dirname(program), process.platform === "win32" ? "semgrep.exe" : "semgrep"), "");
      return result();
    };
    const o = { root, requirements: req, python: "/usr/bin/python3", platform: process.platform, run };
    const program = await semgrepVenv(o);
    expect(calls.map((c) => c.slice(0, 3))).toEqual([["python3", "-m", "venv"], [process.platform === "win32" ? "python.exe" : "python", "-m", "pip"], [path.basename(program), "--version"]]);
    expect(calls[1]).toEqual(expect.arrayContaining(["--require-hashes", "--only-binary", ":all:", "-r", req]));
    calls.length = 0;
    expect(await semgrepVenv(o)).toBe(program);
    expect(calls).toEqual([[path.basename(program), "--version"]]);
    // A changed requirements file is a new venv.
    fs.writeFileSync(req, "semgrep==1.183.0 --hash=sha256:11\n");
    calls.length = 0;
    expect(await semgrepVenv(o)).not.toBe(program);
    expect(calls).toHaveLength(3);
  });

  it("fails closed when pip fails or the version is wrong", async () => {
    const root = path.join(tmpdir(), "semgrep");
    const req = path.join(tmpdir(), "req.txt");
    fs.writeFileSync(req, "x\n");
    await expect(semgrepVenv({ root, requirements: req, python: "p", platform: "linux", run: async (_p, a) => result({ code: a[1] === "pip" ? 1 : 0 }) })).rejects.toThrow(/pip install exited 1/);
    await expect(semgrepVenv({ root, requirements: req, python: "p", platform: "linux", run: async () => result({ output: "1.0.0" }) })).rejects.toThrow(/doesn't hold Semgrep/);
  });

  it("scans the diff since main with metrics off and nosemgrep ignored, and treats other exits as failure", async () => {
    const out = path.join(tmpdir(), "out.json");
    let seen: string[] = [];
    const ok: Run = async (_p, args) => {
      seen = args;
      fs.writeFileSync(out, JSON.stringify({ results: [], errors: [] }));
      return result({ code: 1 });
    };
    expect(await runSemgrep({ program: "semgrep", worktree: tmpdir(), base: "abc", outFile: out, run: ok })).toEqual([]);
    expect(seen).toEqual(["scan", "--config", "p/default", "--metrics=off", "--disable-nosem", "--baseline-commit", "abc", "--json", "--output", out, "--quiet"]);
    await expect(runSemgrep({ program: "semgrep", worktree: tmpdir(), base: "abc", outFile: out, run: async () => result({ code: 2 }) })).rejects.toThrow(/exit 2/);
    await expect(runSemgrep({ program: "semgrep", worktree: tmpdir(), base: "abc", outFile: out, run: async () => result() })).rejects.toThrow(/wrote no results/);
  });
});

describe("judgeQuestions", () => {
  it("gives the owner the Needs owner lines with their evidence, then the findings", () => {
    const text = judgeQuestions({
      checklist: [{ area: "AC-1", status: "Met", evidence: "ok" }, { area: "SR-5 CI", status: "Needs owner", evidence: "No CI repeats the CVE check." }],
      findings: [{ grade: "Minor", location: "test/a.js:28", explanation: "redundant template literal" }],
    });
    expect(text).toContain("Needs your call: SR-5 CI\nNo CI repeats the CVE check.");
    expect(text).toContain("Minor finding at test/a.js:28\nredundant template literal");
    expect(text).not.toContain("AC-1");
    expect(judgeQuestions({ checklist: [{ area: "x", status: "Needs owner", evidence: "y".repeat(50) }], findings: [] }, 20)).toMatch(/cut; the full report/);
  });
});

