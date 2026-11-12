import type { Logger } from "../log";
import { PolicyError, RolePolicy, effectiveRole } from "../policy/role-policy";
import type { DockerCli } from "../docker/cli";
import { SessionRefused } from "./analyst";
import type { SessionGroup } from "./sandbox";
import type { AgentSdk, UserTurn } from "./sdk";
import { SessionCaps, SessionOutcome, WORKSPACE, containerSpawn, runSession, sessionOptions } from "./session";
import type { WorktreeCommitResult } from "./worktree-commit";
import type { Breach } from "./write-check";

/** SR-1, AC-3: the most a Gate 1 reviewer may have, whatever the project's policy says. */
const REVIEWER_TOOLS = new Set(["Read", "Grep", "Glob", "Write", "Skill"]);

/**
 * The project's `security-reviewer` policy, narrowed for one Gate 1 run:
 * refused if it has a tool, command or network host beyond SR-1, and its
 * write rule replaced by the run's one report path (SR-12).
 */
export function reviewerPolicy(manifest: unknown, repoName: string | undefined, reportPath: string): RolePolicy {
  let p: RolePolicy;
  try {
    p = effectiveRole(manifest, "security-reviewer", repoName);
  } catch (e) {
    throw new SessionRefused(e instanceof PolicyError ? `Role policy: ${e.message}` : "the Role policy couldn't be read");
  }
  const extra = p.tools.filter((t) => !REVIEWER_TOOLS.has(t));
  if (extra.length) throw new SessionRefused(`the security-reviewer role has tools Gate 1 doesn't allow (${extra.join(", ")})`);
  if (p.commands.length || p.network.length) throw new SessionRefused("the security-reviewer role has commands or network hosts, which Gate 1 doesn't allow");
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
  first: string;
  /** Resume from an SDK session on the run's volume (FR-10). */
  resume?: string;
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
  const why = i.billingCheck();
  if (why) throw new SessionRefused(why);
  await i.group.open();
  try {
    for (let n = 1; n <= 2; n++) {
      if (n > 1) {
        const again = i.billingCheck();
        if (again) throw new SessionRefused(again);
      }
      let outcome: SessionOutcome;
      const agent = await i.group.startAgent(i.policy, i.worktree, { sessionVolume: "run", reportDir: i.reportDir });
      try {
        const abort = new AbortController();
        const opts = sessionOptions({
          policy: i.policy, worktree: i.worktree, instructions: i.instructions,
          factoryServer: i.sdk.createFactoryServer([]), factoryTools: [], caps: i.caps,
          ...(i.skillsPluginDir ? { skillsPluginDir: i.skillsPluginDir } : {}),
          model: i.model, ...(resume ? { resume } : {}),
          spawn: containerSpawn(i.docker, agent.name, WORKSPACE), log: i.log,
        }, abort);
        outcome = await runSession(i.sdk, opts, once(turn), i.caps, { onSessionId: i.onSessionId });
      } finally {
        // The container must be gone before the worktree and the report are read, so nothing changes under the checks.
        await i.group.stopAgent(agent);
      }
      total = total ? add(total, outcome) : outcome;
      const v = await i.verify(i.policy);
      if (v.status !== "unchanged") {
        if (v.status === "rejected") await i.onBreach(v.breaches);
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
