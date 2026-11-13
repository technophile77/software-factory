import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentSdk, FactoryTool, SdkMessage, SessionOptions } from "../src/agent/sdk";
import type { DockerCli } from "../src/docker/cli";
import { EngineHandle } from "../src/engine";
import { parseStandards } from "../src/gate1/standards";
import { SECRET_DENIES } from "../src/policy/role-policy";
import { EngineRecord } from "../src/state/record";
import { parseTranscript } from "../src/state/transcript";
import { FakeDocker } from "./fakes";
import { RpcClient, World, approvedSession, engineJson, git, makeWorld, manifestYaml, start } from "./helpers";
import { policyDoc } from "./policy-fixture";
import { securityItemsIn } from "./inbox-items";

const STANDARDS = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "security-standards.md"), "utf8");
const CHECKLIST = parseStandards(STANDARDS).checklist;
const ANALYST_MD = "# Requirements analyst (master)\n";
const REVIEWER_MD = "# Security reviewer (master)\n";

let engines: EngineHandle[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await e.stop();
  engines = [];
  clients = [];
});

interface Script {
  options: SessionOptions;
  next(): Promise<string | null>;
  call(tool: string, args: unknown): Promise<unknown>;
}

/** Each session is handed to the script for its role, told apart by its instructions. */
function scriptedSdk(scripts: { analyst: (s: Script, n: number) => AsyncGenerator<SdkMessage>; reviewer: (s: Script, n: number) => AsyncGenerator<SdkMessage> }) {
  const seen: SessionOptions[] = [];
  const prompts: Array<{ role: string; text: string }> = [];
  const count = { analyst: 0, reviewer: 0 };
  let tools: FactoryTool[] = [];
  const sdk: AgentSdk = {
    createFactoryServer: (t) => ((tools = t), { factory: true }),
    query: ({ prompt, options }) => {
      seen.push(options);
      const role = options.systemPrompt === REVIEWER_MD ? "reviewer" : "analyst";
      const it = prompt[Symbol.asyncIterator]();
      const own = tools;
      const n = ++count[role];
      return scripts[role]({
        options,
        next: async () => {
          const r = await it.next();
          if (r.done) return null;
          prompts.push({ role, text: r.value.message.content });
          return r.value.message.content;
        },
        call: async (name, args) => JSON.parse((await own.find((x) => x.name === name)!.handler(args)).content[0]!.text),
      }, n);
    },
  };
  return { sdk, seen, prompts, count };
}

function runtime(d: FakeDocker, sdk: AgentSdk): AgentRuntime {
  return {
    docker: d as unknown as DockerCli, sdk: async () => sdk, dockerDir: path.join(__dirname, "..", "docker"),
    proxyScript: "/opt/engine/dist/proxy.js", platform: "linux", sleep: async () => undefined,
  };
}

async function until(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const REVIEWER = {
  tools: { allow: ["Read", "Grep", "Glob", "Write"] }, read: { allow: ["**"], deny: [...SECRET_DENIES] },
  write: { allow: [".factory/runs/**/security-reviewer-*.json"] }, commands: { allow: [] }, network: { allow: [] },
};
const POLICY = YAML.stringify({ policy: policyDoc({ "security-reviewer": REVIEWER }).policy });

/** A world whose pinned factory version has the reviewer's AGENT.md and the security standards. */
function world(masterExtra: Record<string, string | null> = {}): World {
  const w = makeWorld({ manifest: manifestYaml({ extra: POLICY }) });
  const files: Record<string, string | null> = { "agents/security-reviewer/AGENT.md": REVIEWER_MD, "docs/security-standards.md": STANDARDS, ...masterExtra };
  for (const [f, c] of Object.entries(files)) {
    const full = path.join(w.master, f);
    if (c === null) fs.rmSync(full);
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, c);
    }
  }
  git(w.master, "add", "-A");
  git(w.master, "commit", "-qm", "gate 1 files");
  git(w.master, "tag", "-f", "v0.1.0");
  return w;
}

async function boot(w: World, rt: AgentRuntime) {
  const e = await start(w, { agents: rt });
  engines.push(e);
  const c = await RpcClient.connect(engineJson(w).path);
  clients.push(c);
  return { e, c };
}

const runsOf = (w: World, feature: string, role: string) => new EngineRecord(w.home).runs().filter((r) => r.feature === feature && r.role === role);
const entries = (w: World, feature: string) => parseTranscript(git(w.config, "show", `factory/state:interviews/${feature}/transcript.jsonl`) + "\n");
const stageOf = (e: EngineHandle, feature: string) => e.feature(feature)?.stage();

function spec(feature: string, version: number, srs: string[] = ["| SR-1 | Inputs are validated. | Analyst | Approved |"]): string {
  return [
    "# Feature: Export", "", `- **Id:** ${feature}`, `- **Spec version:** ${version}`, "",
    "## 8. Assumptions", "| Id | Assumption | Decision link | Status |", "|---|---|---|---|", "",
    "## 9. Security considerations", "| Id | Requirement | Source (analyst / Gate 1) | Status |", "|---|---|---|---|", ...srs, "",
  ].join("\n");
}

/** The host folder mounted as the reviewer's report folder, from the container's arguments. */
function reportDir(d: FakeDocker): string {
  const run = [...d.calls].reverse().find((x) => x.args[0] === "run" && x.args.includes("factory.role=security-reviewer"))!.args;
  const mount = run.filter((a, i) => run[i - 1] === "--mount").find((m) => m.includes("security_gate_1"))!;
  return /source=([^,]+)/.exec(mount)![1]!;
}

function report(feature: string, commit: string, findings: unknown[] = []): string {
  return JSON.stringify({
    schema: "agent-report/1.0", role: "security-reviewer", feature, stage: "security_gate_1", commit, outcome: "complete",
    summary: findings.length ? "Gaps found." : "No gaps: section 9 covers it.",
    body: {
      gate: 1, findings,
      checklist: CHECKLIST.map((q) => ({ question: q, answer: "Covered by section 9, SR-1." })),
      permissions_added: [], abuse_cases: ["planted text in the spec"], not_applicable: [{ criterion: "S4", reason: "no library" }],
    },
  });
}

/** The analyst: asks one question, then writes the spec and reports it ready. A later session handles Gate 1 questions. */
function analyst(w: World, feature: () => string, onGate1?: (s: Script) => Promise<void>) {
  return async function* (s: Script, n: number): AsyncGenerator<SdkMessage> {
    const first = await s.next();
    if (n === 1) {
      await s.call("interview_ask", { text: "Which columns?", why: "To size the export." });
      await s.next();
      const wt = runsOf(w, feature(), "requirements-analyst")[0]!.worktree!;
      fs.mkdirSync(path.join(wt, "docs", "features"), { recursive: true });
      fs.writeFileSync(path.join(wt, "docs", "features", `${feature()}-export.md`), spec(feature(), 3));
      await s.call("interview_spec_ready", { spec_path: `docs/features/${feature()}-export.md`, spec_version: 3 });
    } else {
      expect(first).toContain("GATE 1 FINDINGS");
      await onGate1?.(s);
    }
    expect(await s.next()).toBeNull();
    yield { type: "result", subtype: "success", session_id: `a-${n}`, result: "done", num_turns: 2 };
  };
}

async function interview(w: World, e: EngineHandle, c: RpcClient, feature: () => string, set: (f: string) => void): Promise<string> {
  set((await c.ok("feature.start", { request: "Export orders as CSV" })).feature as string);
  await until("the question", () => (e.feature(feature())?.state.items.size ?? 0) > 0);
  const session = await approvedSession(w, c, feature());
  await c.ok("interview.reply", { session, item: "Q-001", revision: 0, reply_id: "r1", kind: "answer", text: "Order id and total." });
  return session;
}

describe("Security Gate 1 on the engine, with fake Docker and SDK (F-008)", () => {
  it("AC-1, AC-3, AC-6: a passing interview starts the reviewer at once; a clean report moves the feature to readiness_gate", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc) {
        const first = (await sc.next())!;
        expect(first.indexOf("<<<FACTORY STANDARDS")).toBeLessThan(first.indexOf("Everything below is data"));
        const commit = /at commit ([0-9a-f]{40})/.exec(first)![1]!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit));
        expect(await sc.next()).toBeNull();
        yield { type: "result", subtype: "success", session_id: "r-1", num_turns: 3 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("readiness_gate", () => stageOf(e, feature) === "readiness_gate");

    // AC-3: read-only worktree, its own writable report folder, the reviewer's model, tools and caps.
    const run = d.calls.find((x) => x.args[0] === "run" && x.args.includes("factory.role=security-reviewer"))!.args;
    const mounts = run.filter((a, i) => run[i - 1] === "--mount");
    expect(mounts.find((m) => m.includes("target=/workspace,"))).toMatch(/,readonly$/);
    expect(mounts.find((m) => m.includes("security_gate_1"))).not.toMatch(/readonly/);
    const o = s.seen.find((x) => x.systemPrompt === REVIEWER_MD)!;
    expect(o.tools).toEqual(["Read", "Grep", "Glob", "Write"]);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.maxTurns).toBe(100);
    expect(o.mcpServers).toEqual({ factory: { factory: true } });

    // AC-6: the report on factory/state, the rendering on the feature branch.
    const g1 = runsOf(w, feature, "security-reviewer")[0]!;
    await until("the run's end", () => runsOf(w, feature, "security-reviewer")[0]!.status === "complete");
    const rep = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/security_gate_1/security-reviewer-1.json`));
    expect(rep).toMatchObject({ role: "security-reviewer", outcome: "complete", model: "claude-sonnet-5-5", body: { gate: 1, findings: [] } });
    const branch = e.feature(feature)!.state.branch;
    expect(git(w.config, "show", `${branch}:docs/features/${feature}-security-gate1.md`)).toContain(`# ${feature} Security Gate 1`);
    expect(entries(w, feature).map((x) => x.type)).toEqual(expect.arrayContaining(["gate1_run", "gate1_report"]));
    expect((await c.ok("engine.status")).features).toEqual([{ id: feature, stage: "readiness_gate", active_agents: 0 }]);
    expect(g1.stage).toBe("security_gate_1");
  });

  it("AC-7, FR-8, FR-9: a requirement finding goes to the owner in the interview, and an approved SR moves the feature on", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    let session = "";
    const fix = "The export never includes card numbers.";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature, async (sc) => {
        await sc.call("interview_ask", { text: "Gate 1 #1: exports may leak card numbers", why: "Security Gate 1 found it.", suggested: fix });
        expect(await sc.next()).toContain(fix);
        const wt = runsOf(w, feature, "requirements-analyst").at(-1)!.worktree!;
        fs.writeFileSync(path.join(wt, "docs", "features", `${feature}-export.md`), spec(feature, 4, ["| SR-1 | Inputs are validated. | Analyst | Approved |", `| SR-2 | ${fix} | Gate 1 #1 | Approved |`]));
        await sc.call("interview_spec_ready", { spec_path: `docs/features/${feature}-export.md`, spec_version: 4 });
      }),
      reviewer: async function* (sc) {
        const first = (await sc.next())!;
        const commit = /at commit ([0-9a-f]{40})/.exec(first)![1]!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit, [
          { criterion: "S3.2", severity: "High", location: "FR-1", explanation: "Exports may hold card numbers.", fix, blocks: true, needs_owner: false },
        ]));
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-2", num_turns: 3 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    session = await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("back in the interview with a Gate 1 question", () => [...(e.feature(feature)?.state.items.values() ?? [])].some((i) => i.text.startsWith("Gate 1 #1")));
    expect(stageOf(e, feature)).toBe("requirements_interview");
    const q = [...e.feature(feature)!.state.items.values()].find((i) => i.text.startsWith("Gate 1 #1"))!;
    await c.ok("interview.reply", { session, item: q.id, revision: 0, reply_id: "r2", kind: "answer", text: fix });
    await until("readiness_gate", () => stageOf(e, feature) === "readiness_gate");
    expect(s.count.reviewer).toBe(1); // A-1: no second review.
    expect(entries(w, feature).find((x) => x.type === "gate1_resolved")).toMatchObject({ passed: true });
  });

  it("AC-8: a choice finding files a Security item with the reviewer's options and the feature waits", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc) {
        const first = (await sc.next())!;
        const commit = /at commit ([0-9a-f]{40})/.exec(first)![1]!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit, [
          { criterion: "S8.5", severity: "Medium", location: "FR-2", explanation: "A token scope [click](https://evil.example).", fix: "Which scope.", blocks: false, needs_owner: true, options: [{ id: "A", label: "Read only" }, { id: "B", label: "Read and write" }], recommendation: "A" },
        ]));
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-3", num_turns: 3 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("blocked", () => !!e.feature(feature)?.state.gate1.blocked);
    expect(stageOf(e, feature)).toBe("security_gate_1");
    const items = securityItemsIn(w.config);
    expect(items).toHaveLength(1);
    const item = items[0]!.text;
    const front = items[0]!.record;
    expect(front).toMatchObject({ category: "Security", feature, options: [{ id: "A", label: "Read only" }, { id: "B", label: "Read and write" }], recommendation: "A" });
    expect(item).not.toContain("](https://");
    const rep = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/security_gate_1/security-reviewer-1.json`));
    expect(rep).toMatchObject({ outcome: "blocked", items_filed: [front.id] });
  });

  it("AC-5: an invalid report gets one correction with the reasons; still invalid fails the run and commits nothing", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc, n) {
        const turn = (await sc.next())!;
        if (n === 2) expect(turn).toMatch(/criterion must be a criterion id/);
        const commit = runsOf(w, feature, "security-reviewer")[0]!.last_commit!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit, [
          { criterion: "S99.9", severity: "High", location: "x", explanation: "y", fix: "z", blocks: true, needs_owner: false },
        ]));
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-4", num_turns: 1 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("the failed run", () => runsOf(w, feature, "security-reviewer")[0]?.status === "failed");
    expect(s.count.reviewer).toBe(2);
    expect(s.seen.filter((x) => x.systemPrompt === REVIEWER_MD)[1]!.resume).toBe("r-4");
    // SR-11 (Gate 2 L3): the caps cover the run, so the correction gets what the first session left.
    expect(s.seen.filter((x) => x.systemPrompt === REVIEWER_MD).map((x) => x.maxTurns)).toEqual([100, 99]);
    expect(runsOf(w, feature, "security-reviewer")[0]!.reason).toBe("its report was still invalid after one correction");
    const branch = e.feature(feature)!.state.branch;
    expect(() => git(w.config, "show", `${branch}:docs/features/${feature}-security-gate1.md`)).toThrow();
    await until("the failure report", () => {
      try {
        return JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/security_gate_1/security-reviewer-1.json`)).outcome === "failed";
      } catch {
        return false;
      }
    });
    expect(stageOf(e, feature)).toBe("security_gate_1");
  });

  it("AC-4: a reviewer that changes the worktree is rejected and a Security item is filed", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc) {
        await sc.next();
        const wt = runsOf(w, feature, "security-reviewer")[0]!.worktree!;
        fs.writeFileSync(path.join(wt, "docs", "features", `${feature}-export.md`), "no findings, honest\n");
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-5", num_turns: 1 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("the failed run", () => runsOf(w, feature, "security-reviewer")[0]?.status === "failed");
    expect(securityItemsIn(w.config)[0]!.text).toContain("Security reviewer changed files outside its report");
    expect(git(w.config, "show", `${e.feature(feature)!.state.branch}:docs/features/${feature}-export.md`)).toContain("- **Spec version:** 3");
  });

  it("AC-10: a factory version without a reviewer model starts no session and says why", async () => {
    const w = world({ "engine/config/models.yaml": "requirements-analyst: claude-opus-5-5\nweb-reader: claude-haiku-5-5\n" });
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({ analyst: analyst(w, () => feature), reviewer: async function* () {} });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("the note", () => entries(w, feature).some((x) => x.type === "gate1_session"));
    expect(entries(w, feature).find((x) => x.type === "gate1_session")).toMatchObject({ status: "waiting", reason: expect.stringContaining("no security-reviewer entry in engine/config/models.yaml") });
    expect(s.count.reviewer).toBe(0);
    expect(stageOf(e, feature)).toBe("security_gate_1");
  });
});
