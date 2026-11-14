import { buildSync } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentSdk, SdkMessage } from "../src/agent/sdk";
import type { DockerCli } from "../src/docker/cli";
import { FakeDocker } from "./fakes";
import { GitHttp } from "./git-http";
import { FACTORY_TOKEN, OWNER_ID, git, tmpdir } from "./helpers";
import { FakeIssues } from "./inbox-fake";
import { type Script, boot, entries, interview, runsOf, scriptedSdk, stageOf, until, world } from "./agents-harness";
import { act, analyst, items, orchestrator, pollUntil, reviewer, start } from "./signoff-flow";

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

describe("F-015 M1: stage 5 on the engine", () => {
  it("AC-1, AC-2, AC-5 (merge), AC-16, AC-24: after sign-off the developer, then the test engineer, run in their own branches and the engine merges both as the owner", async () => {
    const w = world({}, { orchestrator: true, build: true });
    await serve(w);
    const d = new FakeDocker();
    let feature = "";
    const gh = new FakeIssues();
    // Through the readiness gate and the owner's sign-off on the engine as F-016 runs it.
    const first = await start(w, d, { analyst: analyst(w, () => feature), reviewer: reviewer(d, () => feature), orchestrator: orchestrator(d, () => feature) }, gh);
    await interview(w, first.e, first.c, () => feature, (f) => (feature = f));
    await pollUntil(w, "the sign-off issue", () => items(w).some((i) => i.record.kind === "spec") && gh.issues.size === 1);
    await act(w, gh, 1, "approve");
    await pollUntil(w, "build_and_test_prep", () => stageOf(first.e, feature) === "build_and_test_prep");
    first.c.close();
    await first.e.stop();

    // The next start, on the owner's PC, builds.
    const seen = { refused: [] as string[], first: "" };
    const s = scriptedSdk({ analyst: async function* () {}, reviewer: async function* () {}, developer: developer(() => feature, seen), tester: tester(() => feature, seen) });
    const { e } = await boot(w, onPc(d, s.sdk), { issues: () => gh });
    await until("the merged branches", () => e.feature(feature)?.state.build.actions.includes("branches_merged") ?? false, 30_000).catch((err) => {
      throw new Error(`${(err as Error).message}; actions ${JSON.stringify(e.feature(feature)?.state.build.actions)}; log: ${w.log.lines.slice(-15).map((l) => l.message ?? l.action).join(" | ")}`);
    });

    expect(e.feature(feature)!.state.build.actions).toEqual(["dependencies_merged", "done", "done", "branches_merged"]);
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
    const branch = e.feature(feature)!.state.branch;
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
