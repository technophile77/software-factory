import type { Logger } from "../log";
import { PolicyError, RolePolicy, effectiveRole } from "../policy/role-policy";
import { SessionRefused } from "../agent/analyst";
import type { AgentGroup } from "../agent/sandbox";
import type { AgentSdk, FactoryTool, UserTurn } from "../agent/sdk";
import { remaining } from "../agent/reviewer";
import { FULL_SHELL_ROLES, HostGate, SessionCaps, SessionOutcome, WallTimer, TOOL_SILENCE_MS, runSession, sessionOptions } from "../agent/session";
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
  /** F-015 FR-25: the factory tools the role gets, such as `run_tests`. */
  tools?: FactoryTool[];
  /** F-015 FR-27: aborted when the owner cancels the feature; the session stops at once. */
  signal?: AbortSignal;
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
      if (i.signal?.aborted) throw new SessionRefused("the feature was cancelled");
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
        if (i.signal?.aborted) abort.abort();
        i.signal?.addEventListener("abort", () => abort.abort(), { once: true });
        const opts = sessionOptions({
          policy: i.policy, cwd: agent.cwd, worktree: i.worktree, workspace: agent.workspace, instructions: i.instructions,
          ...(agent.projectMcp ? { projectMcp: agent.projectMcp } : {}),
          factoryServer: i.sdk.createFactoryServer(i.tools ?? []), factoryTools: (i.tools ?? []).map((t) => t.name), caps,
          ...(i.skillsPluginDir ? { skillsPluginDir: i.skillsPluginDir } : {}),
          model: i.model, ...(resume ? { resume } : {}), outputSchema: i.outputSchema,
          host, spawn: agent.spawn, log: i.log,
        }, abort);
        outcome = await runSession(i.sdk, opts, once(turn), caps, {
          onSessionId: i.onSessionId,
          onEntry: (k, t) => i.group.transcript?.(k, t),
          wall: (onExpire) => (timer = new WallTimer(caps.wallTimeMs, onExpire)),
          ...(agent.killCommands
            ? {
              onSilentTool: async () => {
                const n = await agent.killCommands!();
                i.log.warn(`${i.policy.role}: a tool call had no answer for ${TOOL_SILENCE_MS / 60_000} minutes; killed ${n} process(es) the session started (F-015 FR-20)`);
                return n;
              },
            }
            : {}),
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
  stage: string;
  /** Stage 6: the failures to fix, as the engine's data block (SR-10). */
  fix?: string;
  /** What sent the feature back; stage 6 test failures when unset. */
  fixFrom?: FixFrom;
  /** F-015 FR-20: the role has `Monitor` and `TaskStop`, so it is told to run long commands in the background. */
  background?: boolean;
  /** The role's write rules, so the agent knows them before a write is refused. */
  write?: { allow: string[]; deny: string[] };
  /** F-015 FR-22, FR-25: the role has `run_tests`; `single` when the repo can run one test on its own. */
  runTests?: { single: boolean };
  /** F-015 FR-29: how many tests the test engineer listed as CI-only. */
  ciOnly?: number;
}

/** F-015 FR-29: what the build, Code Review and judge sessions are told about tests only CI can run. */
export function ciPendingText(n: number): string {
  return `Some tests are pending on CI: the test engineer listed ${n} test${n === 1 ? "" : "s or test files"} as CI-only, because they can't run on the owner's PC. The pull request's required CI runs them before the PR is marked ready, and a CI failure comes back to the developer or test engineer. Don't report them as untested, don't block on them, and don't ask for a run on another platform. Tests pending on CI, or test changes that only CI can run, are no reason to report your work as partial: when the rest is done, your outcome is complete.`;
}

const CI_ONLY_HOW = "A test that can't run on this PC, for example one that needs Linux, may skip here only with a reason: list it in your report's `ci_only` (a test id, or a whole Python test file, with the reason). The pull request's required CI runs it, and the PR isn't ready until it passes there. Don't list a test that can run here. Tests pending on CI are no reason to report partial: when the rest is done, your outcome is complete.";

/** F-026 FR-1, OQ-2 A: how the test engineer asks for a CI job; it never writes a workflow file. */
export const CI_JOBS_HOW = "When a test or check must run in the code repo's CI and no CI job runs it yet (for example a `ci_only` test, a coverage minimum or a secret or code scan the spec asks for), ask for the job in your report's `ci_jobs`: `repo`, `job` (lower case, digits and dashes), `action` (`add`, `update` or `remove`), `template` (`test-command`, `coverage`, `gitleaks`, `semgrep` or `osv-scanner`), its `params`, `covers` (the test ids and AC ids it runs) and a short `reason`. `test-command` and `coverage` take `runtime` ({language: python or node, version}), `setup` (install commands, each an argument list), `run` (the test command as an argument list), optional `schedule` and `timeout_minutes`; `coverage` also takes `report` (the Cobertura XML path) and `min_percent`. `semgrep` takes `configs`; `osv-scanner` takes `lockfiles`. The engine writes the workflow from a reviewed template and the owner approves it; you can't write `.github/` and must not try. Arguments may not hold `${{` or new lines.";

/**
 * The first turn of a developer or test engineer run: engine text only, with
 * the paths it works with. The feature title is the owner's text, so it goes
 * in as a quoted value.
 */
/** Where a fix comes from besides stage 6 test failures (F-015 AC-9, AC-10). */
export type FixFrom = "code_review" | "validation" | "owner" | "conflict";

export function buildTurn(role: BuildRole, t: TurnFacts): string {
  const common = [
    `Feature ${t.feature} (title, as data: ${JSON.stringify(t.title)}), code repo "${t.repo}".`,
    `You work in ${t.worktree}, a checkout of branch ${t.branch}. The approved spec${t.version !== null ? ` (version ${t.version})` : ""} is ${t.spec}; the interface contracts, when the project has them, are in ${t.folder}. That folder is read-only.`,
    "The engine commits your changes when your session ends. Don't commit, push, add remotes or change git config yourself.",
    `Your report goes back as your structured result, with feature "${t.feature}", stage "${t.stage}" and commit "${t.commit}" (the commit you started from).`,
    ...(t.background
      ? ["Run anything that may take long or may block in the background (`Bash` with `run_in_background`): test runs, servers, and scripts that start threads or wait on events. Watch it with `Monitor` or check its output with `Bash`, stop it with `TaskStop` when it stalls, and don't end your session while a background command of yours is still running. A command that sits silent for 10 minutes is killed."]
      : []),
    ...(t.runTests
      ? [`Run tests only with the factory tool \`run_tests\`, which runs them exactly as the engine's own test run does and returns the results as JSON. With no arguments it runs the whole suite${t.runTests.single ? "; with `test` set to a test id from the criteria map it runs that one test" : ""}.${role === "test-engineer" ? " Pass your criteria map as `criteria_map` so the results are joined to it, as the engine will join them." : ""} A shell command that runs tests is refused. Don't build a test environment of your own or install packages anywhere else.`]
      : []),
    ...(role === "test-engineer" ? [CI_ONLY_HOW, CI_JOBS_HOW] : []),
    ...(t.ciOnly ? [ciPendingText(t.ciOnly)] : []),
    ...(t.write
      ? [`You may create or change only paths, relative to the worktree, that match one of ${JSON.stringify(t.write.allow)} and none of ${JSON.stringify(t.write.deny)}. Anything else, a new file included, is refused, and a change outside them made any other way rejects your whole session. If the spec needs a path outside them, don't work around it: say so in your report.`]
      : []),
  ];
  if (t.fix !== undefined && t.fixFrom === "conflict") {
    // ADR 0013: each role resolves only its own files and keeps the approved behavior of both sides.
    const own = role === "software-developer" ? "product code, lockfiles and generated files" : "tests";
    const task = `A merge into this branch conflicted. The engine committed it with git's conflict markers so that you can resolve the files listed below, which are your ${own}. In each one, keep the approved behavior of both sides, remove every conflict marker, and regenerate a lockfile or generated file instead of editing it by hand. Don't change any other file. In your report's summary, say how you resolved each file.`;
    return [task, ...common, t.fix].join("\n\n");
  }
  if (t.fix !== undefined) {
    const why = t.fixFrom === "code_review" ? "Code Review found security problems that block the feature" : t.fixFrom === "validation" ? "The validation judge failed the feature" : t.fixFrom === "owner" ? "The owner asked for changes" : "Tests fail";
    const fixTask = role === "software-developer"
      ? `${why}${t.fixFrom ? "" : " because of the product code"}. Fix the product code so ${t.fixFrom ? "each finding below is resolved" : "they pass"}; don't change tests, CI workflows or test configuration.`
      : `${why}${t.fixFrom ? "" : " because of the test code"}. Fix those tests so they check what the spec says, and for each test you change name the spec section it follows in your report's summary. Don't change product code.`;
    return [fixTask, ...common, t.fix].join("\n\n");
  }
  const task = role === "software-developer"
    ? "Implement the spec's functional requirements and update the documentation they affect. Don't write or change tests under the test engineer's paths, CI workflows or test configuration. List each spec deviation and anything not done in your report."
    : "Write the tests for every acceptance criterion in the spec, from the spec alone, and map each criterion to its test ids in criteria_map; say which tool each required test type uses in tool_choices. Don't read the developer's branch, reports or transcripts. The engine runs the tests itself after both of you are done.";
  return [task, ...common].join("\n\n");
}
