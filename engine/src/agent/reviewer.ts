import type { Logger } from "../log";
import { PolicyError, RolePolicy, effectiveRole } from "../policy/role-policy";
import type { DockerCli } from "../docker/cli";
import { SessionRefused } from "./analyst";
import type { SessionGroup } from "./sandbox";
import type { AgentSdk, UserTurn } from "./sdk";
import { SessionCaps, SessionOutcome, WORKSPACE, containerSpawn, runSession, sessionOptions } from "./session";
import type { RunUsed } from "../state/record";
import type { WorktreeCommitResult } from "./worktree-commit";
import type { Breach } from "./write-check";

/** SR-1, AC-3: the most a Gate 1 reviewer may have, whatever the project's policy says. */
const REVIEWER_TOOLS = new Set(["Read", "Grep", "Glob", "Write", "Skill"]);
/** F-016 SR-11: the readiness orchestrator gets the reviewer's rules, without skills. */
const ORCHESTRATOR_TOOLS = new Set(["Read", "Grep", "Glob", "Write"]);

/**
 * The project's `security-reviewer` policy, narrowed for one Gate 1 run:
 * refused if it has a tool, command or network host beyond SR-1, and its
 * write rule replaced by the run's one report path (SR-12).
 */
export function reviewerPolicy(manifest: unknown, repoName: string | undefined, reportPath: string): RolePolicy {
  return reportOnlyPolicy(manifest, "security-reviewer", REVIEWER_TOOLS, "Gate 1", repoName, reportPath);
}

/** The project's `orchestrator` policy narrowed the same way for one readiness run (F-016 FR-7, SR-11). */
export function orchestratorPolicy(manifest: unknown, reportPath: string): RolePolicy {
  return reportOnlyPolicy(manifest, "orchestrator", ORCHESTRATOR_TOOLS, "the readiness gate", undefined, reportPath);
}

function reportOnlyPolicy(manifest: unknown, role: string, allowed: Set<string>, what: string, repoName: string | undefined, reportPath: string): RolePolicy {
  let p: RolePolicy;
  try {
    p = effectiveRole(manifest, role, repoName);
  } catch (e) {
    throw new SessionRefused(e instanceof PolicyError ? `Role policy: ${e.message}` : "the Role policy couldn't be read");
  }
  const extra = p.tools.filter((t) => !allowed.has(t));
  if (extra.length) throw new SessionRefused(`the ${role} role has tools ${what} doesn't allow (${extra.join(", ")})`);
  if (p.commands.length || p.network.length) throw new SessionRefused(`the ${role} role has commands or network hosts, which ${what} doesn't allow`);
  return { ...p, write: { allow: [reportPath], deny: [...p.write.deny] } };
}

function once(text: string): AsyncIterable<UserTurn> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } satisfies UserTurn;
  })();
}

export interface ReviewerRunInput {
  sdk: AgentSdk;
  docker: DockerCli;
  group: SessionGroup;
  policy: RolePolicy;
  worktree: string;
  /** The engine-owned folder the report is written to, and where it appears in the container. */
  reportDir: { source: string; target: string };
  instructions: string;
  caps: SessionCaps;
  skillsPluginDir?: string;
  model: string;
  /** F-013: the model endpoint the session's requests go to; the group must have a router for it. Default: Claude. */
  upstream?: string;
  first: string;
  /** Resume from an SDK session on the run's volume (FR-10). */
  resume?: string;
  /** What the run's earlier sessions used: the caps cover the whole run, restarts included (SR-11). */
  used?: RunUsed;
  onUsed(used: RunUsed): void;
  billingCheck(): string | null;
  /**
   * FR-5: called after each session, with the container gone. Returns null
   * when the report is valid, else the turn that tells the reviewer why; the
   * session is resumed once with it.
   */
  check(): Promise<string | null>;
  /** AC-4: the worktree must be unchanged; the engine's check of it. */
  verify(policy: RolePolicy): Promise<WorktreeCommitResult>;
  onBreach(breaches: Breach[]): Promise<void>;
  onSessionId(id: string): void;
  log: Logger;
}

export interface ReviewerResult {
  outcome: SessionOutcome;
  /** Null when the report is valid; else why the run failed. */
  invalid: string | null;
  breach: boolean;
  sessions: number;
}

/**
 * One Gate 1 run's sessions (F-008 FR-2 to FR-5): the reviewer in its
 * container with a read-only worktree and its report folder, then the
 * worktree check and the report check; an invalid report gets one resumed
 * session with the reasons. Every failure before a session starts means no
 * session.
 */
export async function runReviewerSessions(i: ReviewerRunInput): Promise<ReviewerResult> {
  let turn = i.first;
  let resume = i.resume;
  let total: SessionOutcome | null = null;
  let used: RunUsed = i.used ?? { turns: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
  const why = i.billingCheck();
  if (why) throw new SessionRefused(why);
  await i.group.open();
  try {
    for (let n = 1; n <= 2; n++) {
      if (n > 1) {
        const again = i.billingCheck();
        if (again) throw new SessionRefused(again);
      }
      const caps = remaining(i.caps, used);
      if (typeof caps === "string") {
        return { outcome: total ?? { status: "cap", reason: caps, turns: 0, outputTokens: 0, inputTokens: 0, costUsd: 0, durationMs: 0 }, invalid: `it reached the run's ${caps} cap`, breach: false, sessions: n - 1 };
      }
      let outcome: SessionOutcome;
      const agent = await i.group.startAgent(i.policy, i.worktree, { sessionVolume: "run", reportDir: i.reportDir, ...(i.upstream !== undefined ? { upstream: i.upstream } : {}) });
      try {
        const abort = new AbortController();
        const opts = sessionOptions({
          policy: i.policy, worktree: i.worktree, instructions: i.instructions,
          factoryServer: i.sdk.createFactoryServer([]), factoryTools: [], caps,
          ...(i.skillsPluginDir ? { skillsPluginDir: i.skillsPluginDir } : {}),
          model: i.model, ...(resume ? { resume } : {}),
          spawn: containerSpawn(i.docker, agent.name, WORKSPACE), log: i.log,
        }, abort);
        outcome = await runSession(i.sdk, opts, once(turn), caps, { onSessionId: i.onSessionId });
      } finally {
        // The container must be gone before the worktree and the report are read, so nothing changes under the checks.
        await i.group.stopAgent(agent);
      }
      total = total ? add(total, outcome) : outcome;
      used = { turns: used.turns + outcome.turns, outputTokens: used.outputTokens + outcome.outputTokens, costUsd: used.costUsd + outcome.costUsd, durationMs: used.durationMs + outcome.durationMs };
      i.onUsed(used);
      const v = await i.verify(i.policy);
      if (v.status !== "unchanged") {
        if (v.status === "rejected") await i.onBreach(v.breaches);
        // Over a size limit is still a change outside the report, so the owner hears of it as of any other (AC-4).
        if (v.status === "over_limit") await i.onBreach([{ path: `(${v.cap} limit)`, reason: "not_allowed" }]);
        return { outcome: total, invalid: "it changed files outside its report", breach: true, sessions: n };
      }
      if (outcome.status === "cap") return { outcome: total, invalid: `it reached the ${outcome.reason} cap`, breach: false, sessions: n };
      if (outcome.status === "error") return { outcome: total, invalid: `the session failed (${String(outcome.reason).slice(0, 200)})`, breach: false, sessions: n };
      const correction = await i.check();
      if (correction === null) return { outcome: total, invalid: null, breach: false, sessions: n };
      if (n === 2 || !outcome.sessionId) return { outcome: total, invalid: "its report was still invalid after one correction", breach: false, sessions: n };
      turn = correction;
      resume = outcome.sessionId;
    }
  } finally {
    await i.group.close();
  }
  throw new Error("unreachable");
}

/** The caps left for the next session, or the name of the cap the run has used up. */
export function remaining(c: SessionCaps, u: RunUsed): SessionCaps | string {
  const turns = c.maxTurns - u.turns;
  const wall = c.wallTimeMs - u.durationMs;
  const tokens = c.maxOutputTokens !== undefined ? c.maxOutputTokens - u.outputTokens : undefined;
  const dollars = c.maxBudgetUsd !== undefined ? c.maxBudgetUsd - u.costUsd : undefined;
  if (turns < 1) return "turns";
  if (wall <= 0) return "wall time";
  if (tokens !== undefined && tokens < 1) return "output tokens";
  if (dollars !== undefined && dollars <= 0) return "dollars";
  return {
    maxTurns: Math.floor(turns), wallTimeMs: wall,
    ...(tokens !== undefined ? { maxOutputTokens: Math.floor(tokens) } : {}),
    ...(dollars !== undefined ? { maxBudgetUsd: dollars } : {}),
  };
}

function add(a: SessionOutcome, b: SessionOutcome): SessionOutcome {
  return {
    ...b,
    turns: a.turns + b.turns,
    outputTokens: a.outputTokens + b.outputTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    costUsd: a.costUsd + b.costUsd,
    durationMs: a.durationMs + b.durationMs,
  };
}
