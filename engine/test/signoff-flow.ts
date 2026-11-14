import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "vitest";
import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentSdk, SdkMessage } from "../src/agent/sdk";
import { FakeDocker } from "./fakes";
import { World } from "./helpers";
import { FakeIssues, OWNER } from "./inbox-fake";
import { inboxItems } from "./inbox-items";
import { Script, boot, orchestratorDir, report, reportDir, runtime, runsOf, scriptedSdk, spec } from "./agents-harness";

// The F-016 flow from a request to a signed-off spec, shared by F-016's and F-015's engine tests.

export const JUDGED = ["clear_objective", "expected_behavior_defined", "acceptance_criteria_testable", "constraints_documented"];

/** The host folder mounted as the orchestrator's report folder. */
export function readiness(feature: string, commit: string, failed: string | null = null): string {
  return JSON.stringify({
    schema: "agent-report/1.0", role: "orchestrator", feature, stage: "readiness_gate", commit, outcome: "complete", summary: "Judged.",
    body: { gate: "readiness", checks: JUDGED.map((name) => ({ name, passed: name !== failed, evidence: name === failed ? "Section 5 names no time limit." : "Section ok." })) },
  });
}

/** A reviewer that reports `findings` once. */
export function reviewer(d: FakeDocker, feature: () => string, findings: unknown[] = []) {
  return async function* (sc: Script): AsyncGenerator<SdkMessage> {
    const commit = /at commit ([0-9a-f]{40})/.exec((await sc.next())!)![1]!;
    fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature(), commit, findings));
    await sc.next();
    yield { type: "result", subtype: "success", session_id: "r-1", num_turns: 3 };
  };
}

/** An orchestrator that writes the report `make` returns for each session, or nothing. */
export function orchestrator(d: FakeDocker, feature: () => string, make: (commit: string, n: number) => string | null = (c) => readiness(feature(), c)) {
  // The engine's one correction is a resumed session whose first message names no commit, so the last one seen is kept.
  let commit = "";
  let run = 0;
  return async function* (sc: Script, n: number): AsyncGenerator<SdkMessage> {
    const first = (await sc.next())!;
    const named = /at commit ([0-9a-f]{40})/.exec(first)?.[1];
    if (named) [commit, run] = [named, n];
    for (let turn = 0; ; turn++) {
      const text = make(commit, n);
      if (text !== null) fs.writeFileSync(path.join(orchestratorDir(d), `orchestrator-${run}.json`), text);
      const next = await sc.next();
      if (next === null) break;
      if (turn > 2) throw new Error("too many turns");
    }
    yield { type: "result", subtype: "success", session_id: `o-${n}`, num_turns: 2 };
  };
}

/** The first analyst session writes `first`'s spec; later sessions are handed to `later` with their first input. */
export function analyst(w: World, feature: () => string, later: (s: Script, first: string, n: number) => Promise<void> = async () => undefined, first = (f: string) => spec(f, 3)) {
  return async function* (s: Script, n: number): AsyncGenerator<SdkMessage> {
    const input = (await s.next())!;
    if (n === 1) {
      await s.call("interview_ask", { text: "Which columns?", why: "To size the export." });
      await s.next();
      writeSpec(w, feature(), first(feature()));
      await s.call("interview_spec_ready", { spec_path: `docs/features/${feature()}-export.md`, spec_version: 3 });
    } else {
      await later(s, input, n);
    }
    expect(await s.next()).toBeNull();
    yield { type: "result", subtype: "success", session_id: `a-${n}`, result: "done", num_turns: 2 };
  };
}

export function writeSpec(w: World, feature: string, text: string): void {
  const wt = runsOf(w, feature, "requirements-analyst").at(-1)!.worktree!;
  fs.mkdirSync(path.join(wt, "docs", "features"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs", "features", `${feature}-export.md`), text);
}

/** Lets the inbox poll until `cond` holds: each step is one poll interval on the fake clock. */
export async function pollUntil(w: World, what: string, cond: () => boolean, polls = 12): Promise<void> {
  for (let i = 0; i < polls; i++) {
    if (cond()) return;
    await w.clock.advance(60_000);
    const end = Date.now() + 1500;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}; engine log: ${w.log.lines.slice(-12).map((l) => l.message ?? l.action).join(" | ")}`);
}

/** The owner takes an action with 👍 and, when the engine asks, confirms with 🚀. */
export async function act(w: World, gh: FakeIssues, issue: number, action: string, confirm = true): Promise<void> {
  gh.react(gh.actionComment(issue, action).id, "+1");
  if (!confirm) return;
  const ask = () => (gh.comments_.get(issue) ?? []).filter((c) => c.authorId === OWNER && c.body.startsWith("Confirm:")).pop();
  await pollUntil(w, "the confirm request", () => !!ask());
  gh.react(ask()!.id, "rocket");
}

export const items = (w: World) => inboxItems(w.config);
export const effects = (w: World, id: string) => (items(w).find((i) => i.id === id)?.record.history ?? []).filter((h: any) => h.action === "effect_done");

export async function start(w: World, d: FakeDocker, scripts: Parameters<typeof scriptedSdk>[0], gh = new FakeIssues(), rt: (d: FakeDocker, sdk: AgentSdk) => AgentRuntime = runtime) {
  const s = scriptedSdk(scripts);
  const { e, c } = await boot(w, rt(d, s.sdk), { issues: () => gh });
  return { e, c, s, gh };
}
