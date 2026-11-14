import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { afterEach, expect } from "vitest";
import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentSdk, FactoryTool, SdkMessage, SessionOptions } from "../src/agent/sdk";
import type { DockerCli } from "../src/docker/cli";
import type { EngineHandle, EngineOptions } from "../src/engine";
import { parseStandards } from "../src/gate1/standards";
import { SECRET_DENIES } from "../src/policy/role-policy";
import { EngineRecord } from "../src/state/record";
import { parseTranscript } from "../src/state/transcript";
import { FakeDocker } from "./fakes";
import { RpcClient, World, approvedSession, engineJson, git, makeWorld, manifestYaml, start } from "./helpers";
import { policyDoc } from "./policy-fixture";

// The engine, fake Docker and scripted SDK that F-008's and F-016's engine tests share.
export const STANDARDS = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "security-standards.md"), "utf8");
export const CHECKLIST = parseStandards(STANDARDS).checklist;
export const ANALYST_MD = "# Requirements analyst (master)\n";
export const REVIEWER_MD = "# Security reviewer (master)\n";
export const ORCHESTRATOR_MD = "# Orchestrator (master)\n";

let engines: EngineHandle[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await e.stop();
  engines = [];
  clients = [];
});

export interface Script {
  options: SessionOptions;
  next(): Promise<string | null>;
  call(tool: string, args: unknown): Promise<unknown>;
}

type RoleScript = (s: Script, n: number) => AsyncGenerator<SdkMessage>;

/** Each session is handed to the script for its role, told apart by its instructions. */
export function scriptedSdk(scripts: { analyst: RoleScript; reviewer: RoleScript; orchestrator?: RoleScript }) {
  const seen: SessionOptions[] = [];
  const prompts: Array<{ role: string; text: string }> = [];
  const count = { analyst: 0, reviewer: 0, orchestrator: 0 };
  let tools: FactoryTool[] = [];
  const sdk: AgentSdk = {
    createFactoryServer: (t) => ((tools = t), { factory: true }),
    query: ({ prompt, options }) => {
      seen.push(options);
      const role = options.systemPrompt === REVIEWER_MD ? "reviewer" : options.systemPrompt === ORCHESTRATOR_MD ? "orchestrator" : "analyst";
      const it = prompt[Symbol.asyncIterator]();
      const own = tools;
      const n = ++count[role];
      const script = scripts[role];
      if (!script) throw new Error(`no script for the ${role}`);
      return script({
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

export function runtime(d: FakeDocker, sdk: AgentSdk): AgentRuntime {
  return {
    docker: d as unknown as DockerCli, sdk: async () => sdk, dockerDir: path.join(__dirname, "..", "docker"),
    proxyScript: "/opt/engine/dist/proxy.js", platform: "linux", sleep: async () => undefined,
  };
}

export async function until(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const REVIEWER = {
  tools: { allow: ["Read", "Grep", "Glob", "Write"] }, read: { allow: ["**"], deny: [...SECRET_DENIES] },
  write: { allow: [".factory/runs/**/security-reviewer-*.json"] }, commands: { allow: [] }, network: { allow: [] },
};
export const POLICY = YAML.stringify({ policy: policyDoc({ "security-reviewer": REVIEWER }).policy });

/** H-0184: the orchestrator reads, and writes only its readiness report. */
export const ORCHESTRATOR = {
  tools: { allow: ["Read", "Grep", "Glob", "Write"] }, read: { allow: ["**"], deny: [...SECRET_DENIES] },
  write: { allow: [".factory/runs/**/orchestrator-*.json"] }, commands: { allow: [] }, network: { allow: [] },
};

/**
 * A world whose pinned factory version has the reviewer's AGENT.md and the
 * security standards; with `orchestrator`, also the orchestrator's AGENT.md
 * and role, so the readiness gate runs a session (F-016).
 */
export function world(masterExtra: Record<string, string | null> = {}, o: { orchestrator?: boolean } = {}): World {
  const policy = o.orchestrator ? YAML.stringify({ policy: policyDoc({ "security-reviewer": REVIEWER, orchestrator: ORCHESTRATOR }).policy }) : POLICY;
  const w = makeWorld({ manifest: manifestYaml({ extra: policy }) });
  const files: Record<string, string | null> = {
    "agents/security-reviewer/AGENT.md": REVIEWER_MD, "docs/security-standards.md": STANDARDS,
    ...(o.orchestrator ? { "agents/orchestrator/AGENT.md": ORCHESTRATOR_MD } : {}), ...masterExtra,
  };
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

export async function boot(w: World, rt: AgentRuntime, extra: Partial<EngineOptions> = {}) {
  const e = await start(w, { agents: rt, ...extra });
  engines.push(e);
  const c = await RpcClient.connect(engineJson(w).path);
  clients.push(c);
  return { e, c };
}

export const runsOf = (w: World, feature: string, role: string) => new EngineRecord(w.home).runs().filter((r) => r.feature === feature && r.role === role);
export const entries = (w: World, feature: string) => parseTranscript(git(w.config, "show", `factory/state:interviews/${feature}/transcript.jsonl`) + "\n");
export const stageOf = (e: EngineHandle, feature: string) => e.feature(feature)?.stage();

/** A spec that passes the readiness gate's structural checks (F-016 FR-7); `frs` adds requirements no criterion covers. */
export function spec(feature: string, version: number, srs: string[] = ["| SR-1 | Inputs are validated. | Analyst | Approved |"], frs: string[] = []): string {
  return [
    "# Feature: Export", "", `- **Id:** ${feature}`, `- **Spec version:** ${version}`, "",
    "## 1. Objective and business purpose", "Owners export their orders as CSV for their accountant.", "",
    "## 2. Expected behavior", "The owner picks a date range and gets a CSV file.", "",
    "## 3. Functional requirements", "| Id | Requirement |", "|---|---|", "| FR-1 | Export orders in a date range as CSV. |", ...frs, "",
    "## 4. Acceptance criteria", "| Id | Given / When / Then | Covers |", "|---|---|---|", "| AC-1 | Given orders in May, when the owner exports May, then the CSV holds them. | FR-1 |", "",
    "## 5. Constraints", "Runs in the existing web app; no new services.", "",
    "## 8. Assumptions", "| Id | Assumption | Decision link | Status |", "|---|---|---|---|", "",
    "## 9. Security considerations", "| Id | Requirement | Source (analyst / Gate 1) | Status |", "|---|---|---|---|", ...srs, "",
  ].join("\n");
}

/** The host folder mounted as the reviewer's report folder, from the container's arguments. */
export function reportDir(d: FakeDocker): string {
  const run = [...d.calls].reverse().find((x) => x.args[0] === "run" && x.args.includes("factory.role=security-reviewer"))!.args;
  const mount = run.filter((a, i) => run[i - 1] === "--mount").find((m) => m.includes("security_gate_1"))!;
  return /source=([^,]+)/.exec(mount)![1]!;
}

export function report(feature: string, commit: string, findings: unknown[] = []): string {
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
export function analyst(w: World, feature: () => string, onGate1?: (s: Script) => Promise<void>) {
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

export async function interview(w: World, e: EngineHandle, c: RpcClient, feature: () => string, set: (f: string) => void): Promise<string> {
  set((await c.ok("feature.start", { request: "Export orders as CSV" })).feature as string);
  await until("the question", () => (e.feature(feature())?.state.items.size ?? 0) > 0);
  const session = await approvedSession(w, c, feature());
  await c.ok("interview.reply", { session, item: "Q-001", revision: 0, reply_id: "r1", kind: "answer", text: "Order id and total." });
  return session;
}

