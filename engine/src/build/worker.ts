import type { Logger } from "../log";
import { PolicyError, RolePolicy, effectiveRole } from "../policy/role-policy";
import { SessionRefused } from "../agent/analyst";
import type { AgentGroup } from "../agent/sandbox";
import type { AgentSdk, UserTurn } from "../agent/sdk";
import { remaining } from "../agent/reviewer";
import { FULL_SHELL_ROLES, HostGate, SessionCaps, SessionOutcome, WallTimer, runSession, sessionOptions } from "../agent/session";
import type { RunUsed } from "../state/record";
import type { WorktreeCommitResult } from "../agent/worktree-commit";

export type BuildRole = "software-developer" | "test-engineer";

/**
 * The role's policy for a code repo session (Role policy v2.9): the
 * project's rules for the repo, plus the CI and harness paths no agent may
 * change whatever the manifest says (F-015 SR-3).
 */
export function buildPolicy(manifest: unknown, role: BuildRole, repoName: string, testResults?: string): RolePolicy {
  let p: RolePolicy;
  try {
    p = effectiveRole(manifest, role, repoName);
  } catch (e) {
    throw new SessionRefused(e instanceof PolicyError ? `Role policy: ${e.message}` : "the Role policy couldn't be read");
  }
  if (!FULL_SHELL_ROLES.includes(role)) throw new SessionRefused(`${role} isn't a code repo role`);
  const harness = [".github/workflows/**", ".github/actions/**", ...(testResults ? [testResults] : [])];
  return { ...p, write: { allow: p.write.allow, deny: [...p.write.deny, ...harness.filter((h) => !p.write.deny.includes(h))] } };
}

function once(text: string): AsyncIterable<UserTurn> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } satisfies UserTurn;
  })();
}

export interface WorkerRunInput {
  sdk: AgentSdk;
  group: AgentGroup;
  policy: RolePolicy;
  worktree: string;
  instructions: string;
  caps: SessionCaps;
  skillsPluginDir?: string;
  model: string;
  host: HostGate;
  /** The report's JSON Schema; the report is the session's structured result (F-020 FR-9). */
  outputSchema: Record<string, unknown>;
  first: string;
  resume?: string;
  used?: RunUsed;
  onUsed(used: RunUsed): void;
  billingCheck(): string | null;
  /** Null when the report is valid, else the turn that says why; the session is resumed once with it. */
  check(structured: unknown): Promise<string | null>;
  /** ADR 0012: the session's changes committed by the engine, with the write check and the secrets scan. */
  commit(policy: RolePolicy): Promise<WorktreeCommitResult>;
  onSessionId(id: string): void;
  log: Logger;
}

export interface WorkerResult {
  outcome: SessionOutcome;
  /** Null when the run did its work and its report is valid; else why it failed. */
  failure: string | null;
  /** The last commit the engine made for the run, if any. */
  commit: string | null;
  /** Set when the commit was refused; the caller files the Security item and resets the worktree. */
  refused: WorktreeCommitResult | null;
  report: unknown;
  sessions: number;
}

/**
 * One developer or test engineer run (F-015 FR-3, FR-4): a session in its
 * worktree on the owner's PC, the engine's commit of what it changed, then
 * its report; an invalid report gets one resumed session with the reasons.
 */
export async function runWorkerSessions(i: WorkerRunInput): Promise<WorkerResult> {
  let turn = i.first;
  let resume = i.resume;
  let total: SessionOutcome | null = null;
  let used: RunUsed = i.used ?? { turns: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
  let commit: string | null = null;
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
      const result = (failure: string, outcome?: SessionOutcome, refused: WorktreeCommitResult | null = null, report: unknown = undefined): WorkerResult => ({
        outcome: outcome ?? total ?? { status: "cap", reason: failure, turns: 0, outputTokens: 0, inputTokens: 0, costUsd: 0, durationMs: 0 },
        failure, commit, refused, report, sessions: n,
      });
      if (typeof caps === "string") return { ...result(`it reached the run's ${caps} cap`), sessions: n - 1 };
      let outcome: SessionOutcome;
      let timer: WallTimer | null = null;
      // Role policy v2.7: the owner's time on an ask-rule item is off the session's clock.
      const host: HostGate = {
        ...i.host,
        ask: async (command, matched) => {
          const release = timer?.hold();
          try {
            return await i.host.ask(command, matched);
          } finally {
            release?.();
          }
        },
      };
      const agent = await i.group.startAgent(i.policy, i.worktree, { sessionVolume: "run" });
      try {
        const abort = new AbortController();
        const opts = sessionOptions({
          policy: i.policy, cwd: agent.cwd, worktree: i.worktree, workspace: agent.workspace, instructions: i.instructions,
          factoryServer: i.sdk.createFactoryServer([]), factoryTools: [], caps,
          ...(i.skillsPluginDir ? { skillsPluginDir: i.skillsPluginDir } : {}),
          model: i.model, ...(resume ? { resume } : {}), outputSchema: i.outputSchema,
          host, spawn: agent.spawn, log: i.log,
        }, abort);
        outcome = await runSession(i.sdk, opts, once(turn), caps, {
          onSessionId: i.onSessionId,
          wall: (onExpire) => (timer = new WallTimer(caps.wallTimeMs, onExpire)),
        });
      } finally {
        // The agent's processes must be gone before the engine reads and commits the worktree.
        await i.group.stopAgent(agent);
      }
      total = total ? add(total, outcome) : outcome;
      used = { turns: used.turns + outcome.turns, outputTokens: used.outputTokens + outcome.outputTokens, costUsd: used.costUsd + outcome.costUsd, durationMs: used.durationMs + outcome.durationMs };
      i.onUsed(used);
      const c = await i.commit(i.policy);
      if (c.status === "committed") commit = c.commit;
      if (c.status === "rejected") return result("it wrote outside the role's rules (Security item filed)", total, c);
      if (c.status === "over_limit") return result(`its change went over the worktree ${c.cap} cap`, total, c);
      if (outcome.status === "cap") return result(`it reached the ${outcome.reason} cap`, total);
      if (outcome.status === "error" && outcome.reason === "error_max_structured_output_retries") return result("no report", total);
      if (outcome.status === "error") return result(`the session failed (${String(outcome.reason).slice(0, 200)})`, total);
      if (outcome.structured === undefined) return result("no report", total);
      const correction = await i.check(outcome.structured);
      if (correction === null) return { outcome: total, failure: null, commit, refused: null, report: outcome.structured, sessions: n };
      if (n === 2 || !outcome.sessionId) return result("its report was still invalid after one correction", total);
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

/** Manifest v1.7 `repos[].commands.test_results` for the repo, if set (H-0193). */
export function buildTestResults(manifest: unknown, repoName: string): string | undefined {
  const repos = manifest && typeof manifest === "object" ? (manifest as { repos?: unknown }).repos : undefined;
  if (!Array.isArray(repos)) return undefined;
  const repo = repos.find((r) => r && typeof r === "object" && (r as { name?: unknown }).name === repoName) as { commands?: { test_results?: unknown } } | undefined;
  const v = repo?.commands?.test_results;
  return typeof v === "string" ? v : undefined;
}

export interface TurnFacts {
  feature: string;
  title: string;
  repo: string;
  branch: string;
  worktree: string;
  spec: string;
  folder: string;
  version: number | null;
  commit: string;
}

/**
 * The first turn of a developer or test engineer run: engine text only, with
 * the paths it works with. The feature title is the owner's text, so it goes
 * in as a quoted value.
 */
export function buildTurn(role: BuildRole, t: TurnFacts): string {
  const common = [
    `Feature ${t.feature} (title, as data: ${JSON.stringify(t.title)}), code repo "${t.repo}".`,
    `You work in ${t.worktree}, a checkout of branch ${t.branch}. The approved spec${t.version !== null ? ` (version ${t.version})` : ""} is ${t.spec}; the interface contracts, when the project has them, are in ${t.folder}. That folder is read-only.`,
    "The engine commits your changes when your session ends. Don't commit, push, add remotes or change git config yourself.",
    `Your report goes back as your structured result, with feature "${t.feature}", stage "build_and_test_prep" and commit "${t.commit}" (the commit you started from).`,
  ];
  const task = role === "software-developer"
    ? "Implement the spec's functional requirements and update the documentation they affect. Don't write or change tests under the test engineer's paths, CI workflows or test configuration. List each spec deviation and anything not done in your report."
    : "Write the tests for every acceptance criterion in the spec, from the spec alone, and map each criterion to its test ids in criteria_map; say which tool each required test type uses in tool_choices. Don't read the developer's branch, reports or transcripts. The engine runs the tests itself after both of you are done.";
  return [task, ...common].join("\n\n");
}
