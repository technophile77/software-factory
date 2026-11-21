import * as fs from "node:fs";
import * as path from "node:path";
import type { CallToolResult, FactoryTool } from "../agent/sdk";
import type { Git } from "../git";
import type { Children } from "../proc";
import { runReport, runSuite } from "./test-run";

/** F-015 FR-25: what `run_tests` needs from the engine for one build session. */
export interface RunTestsDeps {
  git: Git;
  worktree: string;
  gitDir: string;
  commands: { build: string[] | null; test: string[]; testOne: string[] | null; results: string };
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  wallMs: number;
  maxOutput: number;
  children: Children;
  /** The test engineer's newest reported criteria map, for a call that passes none. */
  criteria(): Record<string, string[]>;
  /** SR-9: failure text passes the secrets scan before an agent sees it. */
  scrub(text: string): Promise<string>;
}

const MAX_ID = 500;
const MAX_MESSAGE = 2048;
const MAX_TESTS = 2000;

const err = (code: string, message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] });

function criteriaArg(v: unknown): Record<string, string[]> | null | "bad" {
  if (v === undefined) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "bad";
  const out: Record<string, string[]> = {};
  let n = 0;
  for (const [ac, tests] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(ac) || !Array.isArray(tests)) return "bad";
    if (!tests.every((t) => typeof t === "string" && t.length > 0 && t.length <= MAX_ID)) return "bad";
    n += tests.length;
    out[ac] = tests as string[];
  }
  return n > MAX_TESTS ? "bad" : out;
}

/**
 * Build tools v1.0: `run_tests` runs the whole suite, or one test the
 * criteria map names through `commands.test_one`, the way stage 6 runs it,
 * on the session's worktree; the results file is deleted after it is read,
 * so it is never committed.
 */
export function runTestsTool(d: RunTestsDeps): FactoryTool {
  let busy = false;
  return {
    name: "run_tests",
    description: "Run the repo's tests the way the engine does: the whole suite, or one test from the criteria map with `test`. Returns counts, failures, what didn't run and why, and the criteria map joined to the results. This is the only way to run tests.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        test: { type: "string", minLength: 1, maxLength: MAX_ID },
        criteria_map: { type: "object", additionalProperties: { type: "array", items: { type: "string", minLength: 1, maxLength: MAX_ID } } },
      },
    },
    handler: async (args) => {
      const a = (args ?? {}) as { test?: unknown; criteria_map?: unknown };
      if (a.test !== undefined && (typeof a.test !== "string" || !a.test || a.test.length > MAX_ID)) return err("bad_args", "test must be a test id from the criteria map");
      const given = criteriaArg(a.criteria_map);
      if (given === "bad") return err("bad_args", "criteria_map must map criterion ids to lists of test ids");
      const map = given ?? d.criteria();
      let test = d.commands.test;
      let joined = map;
      if (typeof a.test === "string") {
        const id = a.test;
        if (!d.commands.testOne) return err("no_single_test_command", "This repo has no commands.test_one, so only the whole suite can run: call run_tests without `test`.");
        if (!Object.values(map).some((ts) => ts.includes(id))) return err("not_in_map", "Only a test id in the criteria map can run on its own; pass your criteria_map, or run the whole suite.");
        test = d.commands.testOne.map((x) => (x === "{test}" ? id : x));
        joined = Object.fromEntries(Object.entries(map).map(([ac, ts]) => [ac, ts.filter((t) => t === id)]).filter(([, ts]) => (ts as string[]).length));
      }
      if (busy) return err("busy", "A run_tests call is already running in this session.");
      busy = true;
      try {
        const run = await runSuite({ git: d.git, worktree: d.worktree, gitDir: d.gitDir, build: d.commands.build, test, results: d.commands.results, env: d.env, platform: d.platform, wallMs: d.wallMs, maxOutput: d.maxOutput, children: d.children });
        const report = runReport("", run.cases, joined, run.problem);
        const failures = await Promise.all(report.failures.map(async (f) => ({ test: f.test, message: (await d.scrub(f.actual)).slice(0, MAX_MESSAGE) })));
        const body = {
          complete: report.complete, incomplete: report.incomplete, tests_run: report.tests_run, passed: report.passed, failed: report.failed, skipped: report.skipped,
          failures, not_run: report.not_run, criteria: report.criteria,
          ...(run.problem ? { output: (await d.scrub(run.out.join("\n"))).slice(-MAX_MESSAGE * 4) } : {}),
        };
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      } finally {
        fs.rmSync(path.join(d.worktree, ...d.commands.results.split(/[\\/]/)), { force: true });
        busy = false;
      }
    },
  };
}
