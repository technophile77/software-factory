import { buildSync } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentSdk, SdkMessage } from "../src/agent/sdk";
import type { DockerCli } from "../src/docker/cli";
import { FakeDocker } from "./fakes";
import { GitHttp } from "./git-http";
import { FACTORY_TOKEN, OWNER_ID, RpcClient, addProjectFile, git, tmpdir } from "./helpers";
import { FakeIssues } from "./inbox-fake";
import { type Script, boot, entries, interview, runsOf, scriptedSdk, stageOf, until, world } from "./agents-harness";
import { act, analyst, effects, items, orchestrator, pollUntil, reviewer, start } from "./signoff-flow";
import { nodeProgram } from "./acceptance/support/platform";
import type { CheckRun, Pull, PullsApi, RequiredCheck } from "../src/build/pulls";
import type { IssueComment } from "../src/inbox/github-issues";

// F-015 M1 on the engine: a signed-off spec builds through stage 5 on the owner's PC.

let proxyJs = "";
const servers: GitHttp[] = [];
beforeAll(() => {
  proxyJs = path.join(tmpdir(), "proxy.js");
  buildSync({ entryPoints: [path.join(__dirname, "..", "src", "proxy", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: proxyJs, logLevel: "silent" });
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** The owner's PC: Claude Code on the host, the egress proxy as a local process (ADR 0026). */
const onPc = (d: FakeDocker, sdk: AgentSdk): AgentRuntime => ({
  docker: d as unknown as DockerCli, sdk: async () => sdk, dockerDir: path.join(__dirname, "..", "docker"), proxyScript: proxyJs, platform: process.platform,
  host: { node: process.execPath, claude: async () => "/opt/claude" },
});

/** The config repo and the code repo `acme-web` on a loopback git server, as GitHub would serve them. */
async function serve(w: ReturnType<typeof world>): Promise<{ srv: GitHttp; web: string }> {
  const root = path.join(w.root, "remote");
  const bare = (name: string) => path.join(root, "example-org", `${name}.git`);
  fs.mkdirSync(path.join(root, "example-org"), { recursive: true });
  git(w.root, "init", "-q", "--bare", "-b", "main", bare("acme-config"));
  git(w.config, "push", "-q", bare("acme-config"), "main");
  const src = path.join(w.root, "acme-web-src");
  fs.mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(src, "README.md"), "acme web\n");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  git(w.root, "clone", "-q", "--bare", src, bare("acme-web"));
  const srv = await new GitHttp(root, FACTORY_TOKEN).start();
  servers.push(srv);
  git(w.config, "remote", "set-url", "origin", `${srv.base}/example-org/acme-config`);
  w.github.webBase = srv.base;
  // F-023 FR-2: the project file names the config repo on the GitHub the engine is given.
  addProjectFile(w.master, "acme", w.config, `${srv.base}/example-org/acme-config`);
  return { srv, web: src };
}

const turnFact = (text: string, re: RegExp) => re.exec(text)?.[1] ?? "";

/** A developer who writes the export and its docs, and tries to write a test, which its rules refuse. */
function developer(feature: () => string, seen: { refused: string[] }) {
  return async function* (sc: Script): AsyncGenerator<SdkMessage> {
    const first = (await sc.next())!;
    const wt = turnFact(first, /You work in (\S+), a checkout/);
    const commit = turnFact(first, /commit "([0-9a-f]{40})"/);
    const spec = turnFact(first, /The approved spec \(version \d+\) is (\S+);/);
    expect(fs.readFileSync(spec, "utf8")).toContain("Export orders in a date range as CSV.");
    // The developer is told its write rules up front, CI paths included, not only when a write is refused.
    expect(first).toMatch(/You may create or change only paths, relative to the worktree, that match one of \[.+\] and none of \[.*"\.github\/workflows\/\*\*".*\]/);
    // H-0192: the spec folder is for reading; F-015 SR-3: the CI workflows aren't the developer's to change.
    for (const file of [spec, path.join(wt, "test", "sneaky.test.js"), path.join(wt, ".github", "workflows", "ci.yml")]) {
      const r = await sc.options.canUseTool!("Write", { file_path: file, content: "x" }, { signal: new AbortController().signal } as never);
      if (r.behavior === "deny") seen.refused.push(path.basename(file));
    }
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "export.js"), "export const toCsv = (rows) => rows.join('\\n');\n");
    fs.writeFileSync(path.join(wt, "README.md"), "acme web\n\nExports orders as CSV.\n");
    yield {
      type: "result", subtype: "success", session_id: "dev-1", num_turns: 4,
      structured_output: {
        schema: "agent-report/1.0", role: "software-developer", feature: feature(), stage: "build_and_test_prep", commit, outcome: "complete", summary: "Export added.",
        body: { files_changed: ["src/export.js", "README.md"], spec_deviations: [], not_done: [], docs_updated: ["README.md"] },
      },
    } as SdkMessage;
  };
}

function tester(feature: () => string, seen: { first: string }) {
  return async function* (sc: Script): AsyncGenerator<SdkMessage> {
    const first = (await sc.next())!;
    seen.first = first;
    const wt = turnFact(first, /You work in (\S+), a checkout/);
    const commit = turnFact(first, /commit "([0-9a-f]{40})"/);
    // AC-3's starting point: the test engineer's checkout has none of the developer's work.
    expect(fs.existsSync(path.join(wt, "src", "export.js"))).toBe(false);
    fs.mkdirSync(path.join(wt, "test"), { recursive: true });
    fs.writeFileSync(path.join(wt, "test", "export.test.js"), "test('May', () => {});\n");
    yield {
      type: "result", subtype: "success", session_id: "test-1", num_turns: 3,
      structured_output: {
        schema: "agent-report/1.0", role: "test-engineer", feature: feature(), stage: "build_and_test_prep", commit, outcome: "complete", summary: "Tests written.",
        body: { criteria_map: { "AC-1": ["test/export.test.js#May"] }, tool_choices: [{ test_type: "acceptance", tool: "node:test", reason: "no dependency", approval_ref: null }] },
      },
    } as SdkMessage;
  };
}

/** The engine's local clone of acme-web, under the engine home. */
function localClone(home: string): string {
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 5 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === "local.git") found.push(path.join(d, e.name));
      else walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(path.join(home, "build"), 0);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** A feature through the readiness gate and the owner's sign-off on the engine as F-016 runs it, with that engine stopped. */
async function signedOff(manifestExtra?: (yaml: string, root: string) => string, issue?: string) {
  const w = world({}, { orchestrator: true, build: true });
  if (manifestExtra) {
    fs.writeFileSync(path.join(w.config, "factory-project.yaml"), manifestExtra(fs.readFileSync(path.join(w.config, "factory-project.yaml"), "utf8"), w.root));
    git(w.config, "commit", "-qam", "test commands");
  }
  await serve(w);
  const d = new FakeDocker();
  const id = { value: "" };
  const gh = new FakeIssues();
  const opened = { issueOpen: async () => true } as unknown as PullsApi;
  const first = await start(w, d, { analyst: analyst(w, () => id.value), reviewer: reviewer(d, () => id.value), orchestrator: orchestrator(d, () => id.value) }, gh, undefined, issue ? { pulls: () => opened } : {});
  await interview(w, first.e, first.c, () => id.value, (f) => (id.value = f), issue ? { issue } : {});
  await pollUntil(w, "the sign-off issue", () => items(w).some((i) => i.record.kind === "spec") && gh.issues.size === 1);
  await act(w, gh, 1, "approve");
  await pollUntil(w, "build_and_test_prep", () => stageOf(first.e, id.value) === "build_and_test_prep");
  first.c.close();
  await first.e.stop();
  return { w, d, gh, id };
}

describe("F-015 M1: stage 5 on the engine", () => {
  it("AC-1, AC-2, AC-5 (merge), AC-16, AC-24: after sign-off the developer, then the test engineer, run in their own branches and the engine merges both as the owner", async () => {
    const { w, d, gh, id } = await signedOff();
    const feature = id.value;

    // The next start, on the owner's PC, builds.
    const seen = { refused: [] as string[], first: "" };
    const s = scriptedSdk({ analyst: async function* () {}, reviewer: async function* () {}, developer: developer(() => feature, seen), tester: tester(() => feature, seen) });
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh });
    await until("the merged branches", () => e.feature("acme", feature)?.state.build.actions.includes("branches_merged") ?? false, 30_000).catch((err) => {
      throw new Error(`${(err as Error).message}; actions ${JSON.stringify(e.feature("acme", feature)?.state.build.actions)}; last ${JSON.stringify(e.feature("acme", feature)?.state.build.events.at(-1))}; log: ${w.log.lines.slice(-15).map((l) => l.message ?? l.action).join(" | ")}`);
    });

    expect(e.feature("acme", feature)!.state.build.actions).toEqual(["dependencies_merged", "done", "done", "branches_merged"]);
    expect(stageOf(e, feature)).toBe("orchestrator_review");
    expect(s.count.developer).toBe(1);
    expect(s.count.tester).toBe(1);
    const devOpts = s.seen.find((o) => o.systemPrompt === "# Software developer (master)\n")!;
    expect(devOpts.model).toBe("claude-opus-5-5");
    expect(devOpts.maxTurns).toBe(300);
    expect(seen.refused).toEqual(expect.arrayContaining(["sneaky.test.js", "ci.yml", expect.stringMatching(/export\.md$/)]));
    expect(seen.first).toContain("Write the tests for every acceptance criterion");

    // AC-1, AC-24: the branches live in an engine clone with no remote and no credential helper.
    const local = localClone(w.home);
    expect(git(local, "remote")).toBe("");
    expect(git(local, "config", "--get", "credential.helper")).toBe("");
    const branch = e.feature("acme", feature)!.state.branch;
    expect(git(local, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").sort()).toEqual(["feature/" + feature + "/dev", "feature/" + feature + "/test", branch, "main"].sort());
    const head = git(local, "rev-parse", branch);
    expect(git(local, "ls-tree", "-r", "--name-only", head).split("\n").sort()).toEqual(["README.md", "src/export.js", "test/export.test.js"]);

    // AC-16: every engine commit is the owner's, by the profile name and noreply address, and names no AI tool.
    const authors = git(local, "log", "--format=%an <%ae>|%cn <%ce>|%s", `main..${head}`).split("\n");
    expect(authors).toHaveLength(4);
    for (const a of authors) {
      expect(a.startsWith(`Acme Owner <${OWNER_ID}+acme-owner@users.noreply.github.com>|Acme Owner <${OWNER_ID}+acme-owner@users.noreply.github.com>|`)).toBe(true);
      expect(a).not.toMatch(/claude|anthropic|\bAI\b/i);
    }

    // AC-2: reports on factory/state, nothing of the config repo in the code repo.
    const dev = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/build_and_test_prep/software-developer-1.json`));
    expect(dev).toMatchObject({ outcome: "complete", report_via: "structured_output", body: { docs_updated: ["README.md"] } });
    const test = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/build_and_test_prep/test-engineer-1.json`));
    expect(test).toMatchObject({ outcome: "complete", body: { criteria_map: { "AC-1": ["test/export.test.js#May"] } } });
    expect(runsOf(w, feature, "software-developer")[0]).toMatchObject({ status: "complete" });
    expect(entries(w, feature).filter((x) => x.type === "build").map((x) => x.action)).toEqual(["dependencies_merged", "done", "done", "branches_merged"]);
  }, 90_000);
});

/** GitHub's pull request API for acme-web: one PR, a required "ci" check that passes on the second look. */
class FakePulls implements PullsApi {
  pr: (Pull & { body: string; title: string }) | null = null;
  created: Array<Record<string, unknown>> = [];
  posted: IssueComment[] = [];
  readyCalls = 0;
  checkCalls = 0;
  commentReads = 0;
  constructor(readonly bare: string) {}
  async findPull(): Promise<Pull | null> {
    return this.pr;
  }
  async pull(): Promise<Pull> {
    return this.pr!;
  }
  async createPull(_repo: string, p: { title: string; head: string; base: string; body: string }): Promise<Pull> {
    this.created.push({ title: p.title, head: p.head, base: p.base, draft: true });
    const sha = git(path.dirname(this.bare), "--git-dir", this.bare, "rev-parse", `refs/heads/${p.head}`);
    this.pr = { number: 1, nodeId: "PR_1", state: "open", draft: true, merged: false, mergeCommit: null, mergedBy: "", head: { sha, ref: p.head, repo: "example-org/acme-web" }, url: "", body: p.body, title: p.title };
    return this.pr;
  }
  async updatePull(_repo: string, _n: number, p: { title: string; body: string }): Promise<void> {
    this.pr = { ...this.pr!, ...p };
  }
  async closePull(): Promise<void> {
    this.pr = { ...this.pr!, state: "closed" };
  }
  async markReady(): Promise<void> {
    this.readyCalls++;
    this.pr = { ...this.pr!, draft: false };
  }
  async requiredChecks(): Promise<RequiredCheck[]> {
    return [{ context: "ci", integrationId: null }];
  }
  async checkRuns(_repo: string, sha: string): Promise<CheckRun[]> {
    this.checkCalls++;
    const other = { name: "ci", status: "completed", conclusion: "success", appId: 1, headSha: sha, summary: "" };
    return this.checkCalls === 1 ? [other] : [other, { ...other, appId: 15368 }];
  }
  async comments(): Promise<IssueComment[]> {
    this.commentReads++;
    return this.posted;
  }
  async comment(_repo: string, _n: number, body: string): Promise<number> {
    this.posted.push({ id: 100 + this.posted.length, body, author: "acme-owner", authorId: OWNER_ID, authorType: "User", createdAt: "", updatedAt: "", url: "" });
    return 100 + this.posted.length - 1;
  }
}

/** The repo's test command: a JUnit file whose one test passes once the export is fixed. */
function runner(dir: string): string {
  const file = path.join(dir, "runner.js");
  fs.writeFileSync(file, String.raw`
const fs = require("fs");
const fixed = fs.readFileSync("src/export.js", "utf8").includes("fixed");
const result = fixed ? "" : '<failure message="expected 3 rows, got 1">at toCsv</failure>';
fs.writeFileSync("test-results.xml", '<?xml version="1.0"?><testsuites><testsuite name="export"><testcase classname="test/export.test.js" name="May">' + result + '</testcase></testsuite></testsuites>');
console.log(fixed ? "1 passed" : "1 failed");
process.exit(fixed ? 0 : 1);
`);
  return file;
}

describe("F-015 M2 to M4: the test run, stage 6, Code Review, the judge and the pull request", () => {
  it("AC-6 to AC-10, AC-26: the engine runs the tests, the classifier names the cause, the developer fixes it; a blocking Code Review finding goes back to the developer; the judge's PASS opens a draft PR that goes ready on green CI, and the owner's merge is recorded", async () => {
    const { w, d, gh, id } = await signedOff((yaml, root) => {
      const script = runner(root);
      return yaml.replace("    url: https://github.com/example-org/acme-web\n", `    url: https://github.com/example-org/acme-web\n    commands:\n      test: [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}]\n      test_results: test-results.xml\n`);
    }, "example-org/acme-web#7");
    const feature = id.value;
    const turns = { fix: "", classify: "", review: [] as string[], reviewFix: "", judge: "" };
    const seen = { refused: [] as string[], first: "" };
    const first = developer(() => feature, seen);
    const dev = async function* (sc: Script, n: number): AsyncGenerator<SdkMessage> {
      if (n === 1) {
        yield* first(sc);
        return;
      }
      const turn = (await sc.next())!;
      if (n === 2) turns.fix = turn;
      else turns.reviewFix = turn;
      const wt = turnFact(turn, /You work in (\S+), a checkout/);
      fs.writeFileSync(path.join(wt, "src", "export.js"), n === 2 ? "// fixed\nexport const toCsv = (rows) => rows.join('\\n');\n" : "// fixed, and quoted\nexport const toCsv = (rows) => rows.map(String).join('\\n');\n");
      yield {
        type: "result", subtype: "success", session_id: "dev-2", num_turns: 2,
        structured_output: {
          schema: "agent-report/1.0", role: "software-developer", feature, stage: turnFact(turn, /stage "([a-z_]+)"/), commit: turnFact(turn, /commit "([0-9a-f]{40})"/), outcome: "complete", summary: "Export fixed.",
          body: { files_changed: ["src/export.js"], spec_deviations: [], not_done: [], docs_updated: [] },
        },
      } as SdkMessage;
    };
    const classifier = async function* (sc: Script): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      turns.classify = turn;
      yield {
        type: "result", subtype: "success", session_id: "o-c", num_turns: 2,
        structured_output: {
          schema: "agent-report/1.0", role: "orchestrator", feature, stage: "orchestrator_review", commit: turnFact(turn, /at commit ([0-9a-f]{40})/), outcome: "complete", summary: "One product failure.",
          body: { gate: "failure_classification", checks: [], failures: [{ test: "test/export.test.js#May", cause: "product_code", evidence: "toCsv drops rows." }] },
        },
      } as SdkMessage;
    };
    // Code Review: a Critical finding first, none once the developer has fixed it.
    const codeReviewer = async function* (sc: Script, n: number): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      turns.review.push(turn);
      const findings = n === 1 ? [{ criterion: "S1.1", severity: "Critical", location: "src/export.js:1", explanation: "Rows go out unescaped.", fix: "Quote each field." }] : [];
      yield {
        type: "result", subtype: "success", session_id: `cr-${n}`, num_turns: 2,
        structured_output: { schema: "agent-report/1.0", role: "security-reviewer", feature, stage: "code_review", commit: turnFact(turn, /at commit ([0-9a-f]{40})/), outcome: "complete", summary: n === 1 ? "One critical finding." : "No findings.", body: { gate: 2, findings } },
      } as SdkMessage;
    };
    const judge = async function* (sc: Script): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      turns.judge = turn;
      yield {
        type: "result", subtype: "success", session_id: "j-1", num_turns: 3,
        structured_output: {
          schema: "agent-report/1.0", role: "validation-judge", feature, stage: "validation", commit: turnFact(turn, /at commit ([0-9a-f]{40})/), outcome: "complete", summary: "Meets the spec.",
          body: { verdict: "PASS", checklist: [{ area: "Each acceptance criterion", status: "Met", evidence: "test/export.test.js#May passes." }], findings: [{ grade: "Minor", location: "src/export.js:1", explanation: "Name could be clearer." }] },
        },
      } as SdkMessage;
    };
    const semgrep = nodeProgram(path.join(w.root, "semgrep"), String.raw`
const fs = require("fs");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("1.183.0"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(w.root, "semgrep-args.log"))}, a.join(" ") + "\n");
fs.writeFileSync(a[a.indexOf("--output") + 1], JSON.stringify({ results: [{ check_id: "javascript.lang.eval", path: "src/export.js", start: { line: 1 }, extra: { severity: "WARNING", message: "Detected eval." } }], errors: [] }));
process.exit(1);
`);
    const s = scriptedSdk({ analyst: async function* () {}, reviewer: codeReviewer, orchestrator: classifier, developer: dev, tester: tester(() => feature, seen), judge });
    const pulls = new FakePulls(path.join(w.root, "remote", "example-org", "acme-web.git"));
    const probes: string[] = [];
    const tokenApi = { reachableRepos: async () => [{ name: "example-org/acme-web", private: true }, { name: "example-org/acme-config", private: true }, { name: "someone/public-lib", private: false }], workflowWriteRefused: async (repo: string) => (probes.push(repo), true) };
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh, semgrep: { program: semgrep }, pulls: () => pulls, prPollMs: 50, tokenCheck: () => tokenApi });
    const stopAt = ["green", "failed", "refused"];
    await until("the ready pull request", () => stopAt.some((a) => e.feature("acme", feature)?.state.build.actions.includes(a as never)), 90_000).catch((err) => {
      throw new Error(`${(err as Error).message}; actions ${JSON.stringify(e.feature("acme", feature)?.state.build.actions)}; last ${JSON.stringify(e.feature("acme", feature)?.state.build.events.at(-1))}; log: ${w.log.lines.slice(-4).map((l) => l.message ?? l.action).join(" | ")}`);
    });

    expect(JSON.stringify(e.feature("acme", feature)!.state.build.events.at(-1))).not.toMatch(/"(failed|refused)"/);
    expect(e.feature("acme", feature)!.state.build.actions).toEqual([
      "dependencies_merged", "done", "done", "branches_merged", "tests_failed", "product_code", "done", "passed",
      "blocking_finding", "done", "passed", "clean", "pass", "opened", "green",
    ]);
    expect(stageOf(e, feature)).toBe("pull_request");

    // AC-11: the feature branch, and only it, was pushed with the owner's token; the PR opened as a draft and went ready on green.
    const branch = e.feature("acme", feature)!.state.branch;
    const pushed = git(w.root, "--git-dir", pulls.bare, "rev-parse", `refs/heads/${branch}`);
    expect(git(w.root, "--git-dir", pulls.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").sort()).toEqual([branch, "main"].sort());
    expect(pulls.created).toEqual([{ title: `${feature}: Export orders as CSV`, head: branch, base: "main", draft: true }]);
    expect(pulls.pr!.body).toContain("ready for the owner's review");
    // FR-26: the feature came from acme-web#7, so merging the PR closes it.
    expect(pulls.pr!.body).toContain("\n\nCloses #7");
    expect(pulls.readyCalls).toBe(1);
    // SR-2: the token's reach and its workflow write were checked once, before the push.
    expect(probes).toEqual(["example-org/acme-web"]);
    // AC-28: the check only counted once it passed on the pushed SHA from GitHub Actions.
    expect(pulls.checkCalls).toBeGreaterThanOrEqual(2);
    expect(pulls.posted).toHaveLength(1);
    expect(pulls.posted[0]!.body).toContain(`**Definition of done for ${feature}**`);
    expect(pulls.posted[0]!.body).toContain(`head ${pushed}`);
    expect(pulls.posted[0]!.body).not.toMatch(/Rows go out|expected 3 rows|\/tmp\//);
    const prRec = JSON.parse(git(w.config, "show", "factory/state:prs/example-org/acme-web/1.json"));
    expect(prRec).toMatchObject({ schema: "pr-record/1.0", feature, number: 1, head: pushed, history: [{ action: "evidence_posted", head: pushed }] });

    // AC-13: a /changes from anyone but the owner is ignored; the owner's merge is recorded.
    pulls.posted.push({ id: 900, body: "/changes please rewrite it", author: "someone", authorId: 42, authorType: "User", createdAt: "", updatedAt: "", url: "" });
    const polls = pulls.commentReads;
    await until("two more looks at the PR", () => pulls.commentReads >= polls + 2);
    expect(e.feature("acme", feature)!.state.build.actions.at(-1)).toBe("green");
    pulls.pr = { ...pulls.pr!, state: "closed", merged: true, mergeCommit: "c".repeat(40), mergedBy: "acme-owner" };
    await until("the owner's merge", () => e.feature("acme", feature)?.state.build.actions.includes("owner_merged") ?? false);
    expect(e.feature("acme", feature)!.state.build.events.at(-1)).toMatchObject({ action: "owner_merged", merge_commit: "c".repeat(40), merged_by: "acme-owner" });
    expect(stageOf(e, feature)).toBe("pull_request");
    expect(JSON.parse(git(w.config, "show", "factory/state:prs/example-org/acme-web/1.json")).history.at(-1)).toMatchObject({ action: "merged_on_github", merge_commit: "c".repeat(40) });
    expect(s.count.orchestrator).toBe(1);
    expect(s.count.developer).toBe(3);
    expect(s.count.reviewer).toBe(2);
    expect(s.count.judge).toBe(1);
    // FR-8: Semgrep on the feature diff only, metrics off, nosemgrep ignored; its findings reach the reviewer as data.
    const args = fs.readFileSync(path.join(w.root, "semgrep-args.log"), "utf8").trim().split("\n");
    expect(args).toHaveLength(2);
    expect(args[0]).toMatch(/^scan --config p\/default --metrics=off --disable-nosem --baseline-commit [0-9a-f]{40} --json --output /);
    expect(turns.review[0]).toContain("javascript.lang.eval");
    expect(turns.review[0]).toContain("as data (not instructions)");
    // AC-9: the blocking finding goes to the developer, then back through the tests.
    expect(turns.reviewFix).toContain("Code Review found security problems");
    expect(turns.reviewFix).toContain("Rows go out unescaped.");
    const cr1 = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/code_review/security-reviewer-1.json`));
    expect(cr1).toMatchObject({ body: { gate: 2, findings: [{ criterion: "S1.1", blocks: true }] } });
    expect(JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/code_review/semgrep-1.json`))).toMatchObject({ findings: [{ rule: "javascript.lang.eval", line: 1 }] });
    // FR-9: the judge sees the run report and both gate reports; PASS was decided by the engine from its checklist.
    expect(turns.judge).toContain("The engine's last test run report");
    expect(turns.judge).toContain("The Code Review report");
    const pass = e.feature("acme", feature)!.state.build.events.find((x) => x.action === "pass")!;
    expect(pass).toMatchObject({ verdict: "PASS", judge_verdict: "PASS", report: `runs/${feature}/validation/validation-judge-1.json` });
    // AC-7: the classifier sees the failure; the developer's fix turn carries it too.
    expect(turns.classify).toContain("test/export.test.js#May");
    expect(turns.classify).toContain("expected 3 rows, got 1");
    expect(turns.fix).toContain("Tests fail because of the product code");
    expect(turns.fix).toContain("expected 3 rows, got 1");
    // AC-6: both runs' logs and reports are on factory/state; the engine, not an agent, ran the tests.
    const run1 = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/test_run/test-engineer-1.json`));
    expect(run1).toMatchObject({ outcome: "complete", body: { tests_run: 1, failed: 1, failures: [{ test: "test/export.test.js#May" }] } });
    const run2 = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/test_run/test-engineer-2.json`));
    expect(run2).toMatchObject({ outcome: "complete", body: { tests_run: 1, passed: 1, failed: 0 } });
    expect(git(w.config, "ls-tree", "--name-only", `factory/state:runs/${feature}/test_run/`).split("\n").filter((x) => x.endsWith(".json"))).toHaveLength(3);
    expect(git(w.config, "show", `factory/state:runs/${feature}/test_run/run-1.log`)).toContain("1 failed");
    // The fix is on the feature branch, committed as the owner.
    const local = localClone(w.home);
    expect(git(local, "show", `${e.feature("acme", feature)!.state.branch}:src/export.js`)).toContain("fixed");
  }, 150_000);
});

/** acme-web's main moves on GitHub the moment the first PR opens, changing the README the developer also changed. */
class MovingMainPulls extends FakePulls {
  moved = "";
  constructor(bare: string, readonly root: string) {
    super(bare);
  }
  override async createPull(repo: string, p: { title: string; head: string; base: string; body: string }): Promise<Pull> {
    const pr = await super.createPull(repo, p);
    const clone = path.join(this.root, "someone-else");
    git(this.root, "clone", "-q", this.bare, clone);
    fs.writeFileSync(path.join(clone, "README.md"), "acme web\n\nNow with a changelog.\n");
    git(clone, "commit", "-qam", "Another feature merged");
    git(clone, "push", "-q", "origin", "main");
    this.moved = git(clone, "rev-parse", "HEAD");
    return pr;
  }
  override async pull(): Promise<Pull> {
    this.pr = { ...this.pr!, head: { ...this.pr!.head, sha: git(this.root, "--git-dir", this.bare, "rev-parse", `refs/heads/${this.pr!.head.ref}`) } };
    return this.pr;
  }
  override async findPull(): Promise<Pull | null> {
    return this.pr ? this.pull() : null;
  }
}

describe("ADR 0013: main moves while the pull request waits", () => {
  it("the engine merges main in, the developer resolves the conflict in its own file, and the feature is tested, reviewed and pushed again", async () => {
    const { w, d, gh, id } = await signedOff((yaml, root) => {
      const script = path.join(root, "pass.js");
      fs.writeFileSync(script, `require("fs").writeFileSync("test-results.xml", '<?xml version="1.0"?><testsuites><testsuite name="export"><testcase classname="test/export.test.js" name="May"/></testsuite></testsuites>');\n`);
      return yaml.replace("    url: https://github.com/example-org/acme-web\n", `    url: https://github.com/example-org/acme-web\n    commands:\n      test: [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}]\n      test_results: test-results.xml\n`);
    });
    const feature = id.value;
    const seen = { refused: [] as string[], first: "" };
    const first = developer(() => feature, seen);
    let resolveTurn = "";
    let marked = "";
    const dev = async function* (sc: Script, n: number): AsyncGenerator<SdkMessage> {
      if (n === 1) {
        yield* first(sc);
        return;
      }
      const turn = (await sc.next())!;
      resolveTurn = turn;
      const wt = turnFact(turn, /You work in (\S+), a checkout/);
      marked = fs.readFileSync(path.join(wt, "README.md"), "utf8");
      fs.writeFileSync(path.join(wt, "README.md"), "acme web\n\nExports orders as CSV.\n\nNow with a changelog.\n");
      yield {
        type: "result", subtype: "success", session_id: "dev-r", num_turns: 2,
        structured_output: {
          schema: "agent-report/1.0", role: "software-developer", feature, stage: turnFact(turn, /stage "([a-z_]+)"/), commit: turnFact(turn, /commit "([0-9a-f]{40})"/), outcome: "complete", summary: "README.md: kept both paragraphs.",
          body: { files_changed: ["README.md"], spec_deviations: [], not_done: [], docs_updated: ["README.md"] },
        },
      } as SdkMessage;
    };
    const report = (role: string, stage: string, body: unknown) => async function* (sc: Script, n: number): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      yield { type: "result", subtype: "success", session_id: `${role}-${n}`, num_turns: 2, structured_output: { schema: "agent-report/1.0", role, feature, stage, commit: turnFact(turn, /at commit ([0-9a-f]{40})/), outcome: "complete", summary: "Fine.", body } } as SdkMessage;
    };
    const codeReviewer = report("security-reviewer", "code_review", { gate: 2, findings: [] });
    const judge = report("validation-judge", "validation", { verdict: "PASS", checklist: [{ area: "Each acceptance criterion", status: "Met", evidence: "passes" }], findings: [] });
    const semgrep = nodeProgram(path.join(w.root, "semgrep"), String.raw`
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("1.183.0"); process.exit(0); }
require("fs").writeFileSync(a[a.indexOf("--output") + 1], JSON.stringify({ results: [], errors: [] }));
`);
    const s = scriptedSdk({ analyst: async function* () {}, reviewer: codeReviewer, developer: dev, tester: tester(() => feature, seen), judge });
    const pulls = new MovingMainPulls(path.join(w.root, "remote", "example-org", "acme-web.git"), w.root);
    const tokenApi = { reachableRepos: async () => [{ name: "example-org/acme-web", private: true }, { name: "example-org/acme-config", private: true }, { name: "someone/public-lib", private: false }], workflowWriteRefused: async () => true };
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh, semgrep: { program: semgrep }, pulls: () => pulls, prPollMs: 50, tokenCheck: () => tokenApi });
    await until("the ready pull request", () => ["green", "failed", "refused", "escalate"].some((a) => e.feature("acme", feature)?.state.build.actions.includes(a as never)), 90_000).catch((err) => {
      throw new Error(`${(err as Error).message}; actions ${JSON.stringify(e.feature("acme", feature)?.state.build.actions)}; last ${JSON.stringify(e.feature("acme", feature)?.state.build.events.at(-1))}; log: ${w.log.lines.slice(-6).map((l) => l.message ?? l.action).join(" | ")}`);
    });

    expect(e.feature("acme", feature)!.state.build.actions).toEqual([
      "dependencies_merged", "done", "done", "branches_merged", "passed", "clean", "pass", "opened",
      "main_moved", "conflict", "done", "resolved", "passed", "clean", "pass", "opened", "green",
    ]);
    const conflict = e.feature("acme", feature)!.state.build.events.find((x) => x.action === "conflict")!;
    expect(conflict).toMatchObject({ from: "main", files: ["README.md"], owners: { developer: ["README.md"], tester: [] } });
    expect(marked).toMatch(/^<{7} [\s\S]*Exports orders as CSV[\s\S]*Now with a changelog[\s\S]*^>{7} /m);
    expect(resolveTurn).toContain("A merge into this branch conflicted");
    expect(resolveTurn).toContain('"files":["README.md"]');
    // Main was merged in, never rebased: the pushed head holds the moved main and the resolution.
    const pushed = git(w.root, "--git-dir", pulls.bare, "rev-parse", `refs/heads/${e.feature("acme", feature)!.state.branch}`);
    expect(git(w.root, "--git-dir", pulls.bare, "merge-base", "--is-ancestor", pulls.moved, pushed)).toBe("");
    expect(git(w.root, "--git-dir", pulls.bare, "show", `${pushed}:README.md`)).toBe("acme web\n\nExports orders as CSV.\n\nNow with a changelog.");
    expect(pulls.created).toHaveLength(1);
    expect(s.count.developer).toBe(2);
    expect(s.count.reviewer).toBe(2);
    expect(s.count.judge).toBe(2);
  }, 150_000);
});

describe("a developer that reports blocked", () => {
  it("keeps the agent's own summary and body in its report and the stop item's private detail", async () => {
    const { w, d, gh, id } = await signedOff();
    const feature = id.value;
    const dev = async function* (sc: Script): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      yield {
        type: "result", subtype: "success", session_id: "dev-b", num_turns: 2,
        structured_output: {
          schema: "agent-report/1.0", role: "software-developer", feature, stage: "build_and_test_prep", commit: turnFact(turn, /commit "([0-9a-f]{40})"/), outcome: "blocked",
          summary: "Blocked: the spec leaves the runtime to an architecture decision that isn't recorded.",
          body: { files_changed: [], spec_deviations: [], not_done: ["everything: no runtime decision"], docs_updated: [] },
        },
      } as SdkMessage;
    };
    const s = scriptedSdk({ analyst: async function* () {}, reviewer: async function* () {}, developer: dev, tester: async function* () {} });
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh });
    await until("the stop", () => e.feature("acme", feature)?.state.build.actions.includes("failed") ?? false, 30_000);
    const rep = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/build_and_test_prep/software-developer-1.json`));
    expect(rep.summary).toMatch(/stopped: it reported blocked\. The agent's summary: Blocked: the spec leaves the runtime/);
    expect(rep.body).toMatchObject({ not_done: ["everything: no runtime decision"] });
    await until("the stop item", () => items(w).some((i) => String(i.record.title).includes("developer for") && String(i.record.title).includes("stopped")));
  }, 90_000);
});


describe("F-015 FR-21: no answer leaves a build at a dead end", () => {
  const twoPolls = async (w: Parameters<typeof items>[0]) => {
    for (let i = 0; i < 2; i++) {
      await w.clock.advance(60_000);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  it("AC-42, AC-43: a request for changes on a stopped step files one What next item, and sending it to the developer runs the developer with the note", async () => {
    const { w, d, gh, id } = await signedOff();
    const feature = id.value;
    const turns: string[] = [];
    const dev = async function* (sc: Script, n: number): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      turns.push(turn);
      const commit = turnFact(turn, /commit "([0-9a-f]{40})"/);
      const wt = turnFact(turn, /You work in (\S+), a checkout/);
      if (n > 1 && wt) {
        fs.mkdirSync(path.join(wt, "src"), { recursive: true });
        fs.writeFileSync(path.join(wt, "src", "export.js"), "export const toCsv = (rows) => rows.join('\\n');\n");
      }
      yield {
        type: "result", subtype: "success", session_id: `dev-${n}`, num_turns: 2,
        structured_output: {
          schema: "agent-report/1.0", role: "software-developer", feature, stage: turnFact(turn, /stage "([a-z_]+)"/), commit, outcome: n > 1 ? "complete" : "blocked",
          summary: n > 1 ? "Export added." : "Blocked: may I add a helper module?",
          body: { files_changed: n > 1 ? ["src/export.js"] : [], spec_deviations: [], not_done: n > 1 ? [] : ["everything"], docs_updated: [] },
        },
      } as SdkMessage;
    };
    const s = scriptedSdk({ analyst: async function* () {}, reviewer: async function* () {}, developer: dev, tester: async function* () {} });
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh });
    await until("the stop", () => e.feature("acme", feature)?.state.build.actions.includes("failed") ?? false, 30_000);
    const stop = () => items(w).find((i) => i.record.effect?.type === "buildstop");
    await pollUntil(w, "the stop item's issue", () => stop()?.record.issue !== undefined);
    expect(stop()!.record.options.map((o: { label: string }) => o.label)).toEqual(["Run the developer again", "Keep the feature stopped", "Send it to the developer", "Send it to the test engineer"]);

    gh.say(stop()!.record.issue, "/changes Add the helper module src/csv.js.");
    const next = () => items(w).filter((i) => i.record.effect?.type === "whatnext");
    await pollUntil(w, "the What next item", () => next().length === 1 && next()[0]!.record.issue !== undefined);
    expect(next()[0]!.record).toMatchObject({ feature, title: `What next for ${feature}?` });
    // Filed once: more polls file no second one while it is open.
    await twoPolls(w);
    expect(next()).toHaveLength(1);

    await act(w, gh, next()[0]!.record.issue, "choose:A");
    await pollUntil(w, "the developer's second run", () => turns.length === 2);
    await until("the tests after it", () => e.feature("acme", feature)?.state.build.actions.slice(-2).join() === "to_developer,done", 30_000);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toContain("The owner sent the feature to you with this note");
    expect(turns[1]).toContain("Add the helper module src/csv.js.");
    expect(e.feature("acme", feature)!.state.build.events.find((x) => x.action === "to_developer")).toMatchObject({ note: "Add the helper module src/csv.js." });
  }, 120_000);

  it("AC-43: keeping the feature stopped files no What next item", async () => {
    const { w, d, gh, id } = await signedOff();
    const feature = id.value;
    const dev = async function* (sc: Script): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      yield {
        type: "result", subtype: "success", session_id: "dev-1", num_turns: 2,
        structured_output: { schema: "agent-report/1.0", role: "software-developer", feature, stage: "build_and_test_prep", commit: turnFact(turn, /commit "([0-9a-f]{40})"/), outcome: "blocked", summary: "Blocked.", body: { files_changed: [], spec_deviations: [], not_done: ["everything"], docs_updated: [] } },
      } as SdkMessage;
    };
    const s = scriptedSdk({ analyst: async function* () {}, reviewer: async function* () {}, developer: dev, tester: async function* () {} });
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh });
    await until("the stop", () => e.feature("acme", feature)?.state.build.actions.includes("failed") ?? false, 30_000);
    const stop = () => items(w).find((i) => i.record.effect?.type === "buildstop");
    await pollUntil(w, "the stop item's issue", () => stop()?.record.issue !== undefined);
    await act(w, gh, stop()!.record.issue, "choose:B");
    await pollUntil(w, "the answer acted on", () => effects(w, stop()!.id).length > 0);
    await twoPolls(w);
    expect(items(w).filter((i) => i.record.effect?.type === "whatnext")).toHaveLength(0);
  }, 120_000);
});

/** FakePulls with the merge API, merging only at the head it is given. */
class MergingPulls extends FakePulls {
  merges: string[] = [];
  async files(): Promise<never[]> {
    return [];
  }
  async merge(_repo: string, _n: number, sha: string): Promise<boolean> {
    this.merges.push(sha);
    if (sha !== this.pr!.head.sha) return false;
    this.pr = { ...this.pr!, state: "closed", merged: true, mergeCommit: "d".repeat(40), mergedBy: "acme-owner" };
    return true;
  }
}

describe("F-015 FR-18: auto-merge up to a maturity level", () => {
  async function toReady(approve: boolean, upTo = "alpha", beforeBoot?: () => void) {
    const { w, d, gh, id } = await signedOff((yaml, root) => {
      const script = path.join(root, "pass.js");
      fs.writeFileSync(script, `require("fs").writeFileSync("test-results.xml", '<?xml version="1.0"?><testsuites><testsuite name="export"><testcase classname="test/export.test.js" name="May"/></testsuite></testsuites>');\n`);
      return yaml
        .replace("    url: https://github.com/example-org/acme-web\n", `    url: https://github.com/example-org/acme-web\n    maturity: alpha\n    commands:\n      test: [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}]\n      test_results: test-results.xml\n`)
        .replace(/(\n    mode: \w+\n)/, `$1  auto_merge_up_to: ${upTo}\n`);
    });
    const feature = id.value;
    const seen = { refused: [] as string[], first: "" };
    const turns: string[] = [];
    const report = (role: string, stage: string, body: unknown) => async function* (sc: Script, n: number): AsyncGenerator<SdkMessage> {
      const turn = (await sc.next())!;
      if (role === "orchestrator") turns.push(turn);
      yield { type: "result", subtype: "success", session_id: `${role}-${n}`, num_turns: 2, structured_output: { schema: "agent-report/1.0", role, feature, stage, commit: turnFact(turn, /at commit ([0-9a-f]{40})/), outcome: "complete", summary: "Fine.", body } } as SdkMessage;
    };
    const checks = [{ name: "Matches the spec", passed: true, evidence: "AC-1 is covered." }, { name: "Docs", passed: approve, evidence: approve ? "README updated." : "The README doesn't mention the export." }];
    const semgrep = nodeProgram(path.join(w.root, "semgrep"), String.raw`
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("1.183.0"); process.exit(0); }
require("fs").writeFileSync(a[a.indexOf("--output") + 1], JSON.stringify({ results: [], errors: [] }));
`);
    const s = scriptedSdk({
      analyst: async function* () {}, developer: developer(() => feature, seen), tester: tester(() => feature, seen),
      reviewer: report("security-reviewer", "code_review", { gate: 2, findings: [] }),
      judge: report("validation-judge", "validation", { verdict: "PASS", checklist: [{ area: "Each acceptance criterion", status: "Met", evidence: "passes" }], findings: [] }),
      orchestrator: report("orchestrator", "auto_merge", { gate: "auto_merge", checks }),
    });
    const pulls = new MergingPulls(path.join(w.root, "remote", "example-org", "acme-web.git"));
    const tokenApi = { reachableRepos: async () => [{ name: "example-org/acme-web", private: true }, { name: "example-org/acme-config", private: true }], workflowWriteRefused: async () => true };
    beforeBoot?.();
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh, semgrep: { program: semgrep }, pulls: () => pulls, merge: () => pulls, prPollMs: 50, tokenCheck: () => tokenApi });
    return { w, gh, e, s, feature, pulls, turns };
  }
  const settled = ["engine_merged", "auto_held", "failed", "refused"];

  it("AC-32: with every check met and the orchestrator approving, the engine merges at the pushed head and records it", async () => {
    const { w, e, s, feature, pulls, turns } = await toReady(true);
    await until("the auto-merge", () => settled.some((a) => e.feature("acme", feature)?.state.build.actions.includes(a as never)), 90_000);
    expect(e.feature("acme", feature)!.state.build.actions.slice(-3)).toEqual(["opened", "green", "engine_merged"]);
    const pushed = git(w.root, "--git-dir", pulls.bare, "rev-parse", `refs/heads/${e.feature("acme", feature)!.state.branch}`);
    expect(pulls.merges).toEqual([pushed]);
    expect(e.feature("acme", feature)!.state.build.events.at(-1)).toMatchObject({ action: "engine_merged", pr: 1, merge_commit: "d".repeat(40), report: `runs/${feature}/auto_merge/orchestrator-1.json` });
    expect(JSON.parse(git(w.config, "show", "factory/state:prs/example-org/acme-web/1.json")).history.at(-1)).toMatchObject({ action: "merged_by_engine", merge_commit: "d".repeat(40) });
    expect(JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/auto_merge/orchestrator-1.json`))).toMatchObject({ role: "orchestrator", body: { gate: "auto_merge" } });
    expect(pulls.posted.at(-1)!.body).toMatch(/^The factory engine merged this pull request/);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain(`at commit ${pushed}`);
    expect(turns[0]).toContain("The feature diff from");
    expect(s.count.orchestrator).toBe(1);
  }, 150_000);

  it("AC-34: the orchestrator's hold merges nothing and asks the owner; B sends its reason to the developer", async () => {
    const { w, gh, e, feature, pulls } = await toReady(false);
    await until("the hold", () => settled.some((a) => e.feature("acme", feature)?.state.build.actions.includes(a as never)), 90_000);
    expect(e.feature("acme", feature)!.state.build.actions.at(-1)).toBe("auto_held");
    expect(pulls.merges).toEqual([]);
    const held = items(w).find((i) => i.record.effect?.type === "automergehold")!;
    expect(held.record).toMatchObject({ kind: "decision", feature, effect: { note: "Docs: The README doesn't mention the export." } });
    // One review per head: more looks at the PR start no second session.
    const polls = pulls.commentReads;
    await until("two more looks at the PR", () => pulls.commentReads >= polls + 2);
    expect(items(w).filter((i) => i.record.effect?.type === "automergehold")).toHaveLength(1);
    const mirrored = () => [...gh.issues.entries()].find(([, i]) => i.title.includes("auto-merge held"))?.[0];
    await pollUntil(w, "the hold's issue", () => mirrored() !== undefined);
    const issue = mirrored()!;
    await act(w, gh, issue, "choose:B", false);
    await pollUntil(w, "the owner's B", () => e.feature("acme", feature)?.state.build.actions.includes("changes") ?? false);
    expect(e.feature("acme", feature)!.state.build.events.find((x) => x.action === "changes")).toMatchObject({ note: "Docs: The README doesn't mention the export." });
  }, 150_000);

  it("FR-19, FR-21: a push GitHub refuses names the token problem in an item, not an internal error", async () => {
    const { w, e, feature } = await toReady(true, "alpha", () => {
      servers.at(-1)!.refusePushTo = "acme-web";
    });
    await until("the refusal", () => e.feature("acme", feature)?.state.build.actions.includes("refused") ?? false, 90_000);
    await until("the refusal's item", () => items(w).some((i) => String(i.record.title).includes("GitHub refused")));
    const item = items(w).find((i) => String(i.record.title).includes("GitHub refused"))!;
    expect(item.record).toMatchObject({ title: `GitHub refused ${feature}'s push to example-org/acme-web`, feature, effect: { action: "to_pull_request" } });
    expect(JSON.stringify(item.record)).not.toMatch(/internal error/);
    expect(items(w).filter((i) => i.record.effect?.type === "buildretry")).toHaveLength(0);
  }, 150_000);

  it("AC-32: a repo above the setting is never auto-merged and no model sees it", async () => {
    const { e, s, feature, pulls } = await toReady(true, "rapid-prototype");
    await until("the ready pull request", () => e.feature("acme", feature)?.state.build.actions.includes("green") ?? false, 90_000);
    const polls = pulls.commentReads;
    await until("two more looks at the PR", () => pulls.commentReads >= polls + 2);
    expect(e.feature("acme", feature)!.state.build.actions.at(-1)).toBe("green");
    expect(pulls.merges).toEqual([]);
    expect(s.count.orchestrator ?? 0).toBe(0);
  }, 150_000);

  it("FR-27, AC-51, AC-53: the owner's cancel closes the waiting PR with the reason and keeps the branch; a merge would have been closed", async () => {
    const { w, e, feature, pulls } = await toReady(true, "rapid-prototype");
    await until("the ready pull request", () => e.feature("acme", feature)?.state.build.actions.includes("green") ?? false, 90_000);
    const c = await RpcClient.connect(e.projects[0]!.channel!);
    try {
      expect(await c.ok("feature.cancel", { feature, reason: "not needed any more" })).toEqual({ ok: true });
      expect(pulls.pr!.state).toBe("closed");
      expect(pulls.posted.at(-1)!.body).toBe(`The owner cancelled ${feature}: not needed any more The branch is kept.`);
      const f = e.feature("acme", feature)!;
      expect(f.state.cancelled).toMatchObject({ reason: "not needed any more", from: "pull_request" });
      expect(stageOf(e, feature)).toBe("cancelled");
      expect(((await c.ok("engine.status")).features as Array<{ id: string; activity: string }>).find((x) => x.id === feature)!.activity).toBe("cancelled");
      expect(git(w.root, "--git-dir", pulls.bare, "rev-parse", "--verify", `refs/heads/${f.state.branch}`)).toMatch(/^[0-9a-f]{40}$/);
      expect(JSON.parse(git(w.config, "show", "factory/state:prs/example-org/acme-web/1.json")).history.at(-1)).toMatchObject({ action: "closed_on_github" });
      // Final: a second cancel is refused, and the build looks at the PR no more.
      expect((await c.call("feature.cancel", { feature })).error).toMatchObject({ message: `${feature} is already cancelled.` });
      const polls = pulls.commentReads;
      await new Promise((r) => setTimeout(r, 300));
      expect(pulls.commentReads).toBe(polls);
    } finally {
      c.close();
    }
  }, 150_000);

  it("FR-27, AC-53: a PR closed on GitHub without merging ends the feature as cancelled", async () => {
    const { e, feature, pulls } = await toReady(true, "rapid-prototype");
    await until("the ready pull request", () => e.feature("acme", feature)?.state.build.actions.includes("green") ?? false, 90_000);
    pulls.pr = { ...pulls.pr!, state: "closed" };
    await until("the cancel", () => e.feature("acme", feature)?.state.cancelled !== null, 30_000);
    expect(e.feature("acme", feature)!.state.build.actions.at(-1)).toBe("owner_closed");
    expect(e.feature("acme", feature)!.state.cancelled).toMatchObject({ reason: "the pull request was closed without merging" });
    expect(stageOf(e, feature)).toBe("cancelled");
  }, 150_000);
});
