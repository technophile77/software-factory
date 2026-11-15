import { MATURITY_LEVELS } from "../constants";
import type { CheckRun, Pull, RequiredCheck } from "./pulls";
import { checksVerdict } from "./stage9";

/**
 * F-015 FR-18 (owner, 2026-11-15): when the engine may merge a feature PR
 * itself. Code decides every condition here before any model sees the PR;
 * the orchestrator's approval comes only after all of them hold.
 */

/** Whether `settings.auto_merge_up_to` covers a repo at `level`: that level and every lower one. */
export function autoMergeCovers(upTo: string | null, level: string): boolean {
  if (!upTo) return false;
  const top = (MATURITY_LEVELS as readonly string[]).indexOf(upTo);
  const at = (MATURITY_LEVELS as readonly string[]).indexOf(level);
  return top >= 0 && at >= 0 && at <= top;
}

const PASSING = new Set(["success", "neutral", "skipped"]);

export interface AutoMergeFacts {
  pr: Pull;
  /** The head the engine pushed and marked ready. */
  pushed: string;
  /** The commit of the engine's newest complete, all-passing test run, if any. */
  testsPassedAt: string | null;
  required: readonly RequiredCheck[];
  runs: readonly CheckRun[];
  /** The combined commit status of the head: its state and how many statuses it has. */
  status: { state: string; count: number };
  /** Definition-of-done items not met at the head. */
  unmet: readonly number[];
  /** The owner commented `/hold` or `/changes` on the PR since it went ready. */
  ownerHeld: boolean;
}

/**
 * Every reason the PR may not be auto-merged, empty when none. With no CI
 * at all (no check runs, no statuses, no required checks) the engine's own
 * test run is enough (owner, 2026-11-15 decision card).
 */
export function autoMergeBlockers(x: AutoMergeFacts): string[] {
  const out: string[] = [];
  const sha = x.pr.head.sha;
  if (x.pr.state !== "open" || x.pr.merged) out.push("the pull request isn't open");
  if (x.pr.draft) out.push("the pull request is a draft");
  if (sha !== x.pushed) out.push(`the head is ${sha}, not the ${x.pushed} the engine pushed`);
  if (x.testsPassedAt !== sha) out.push("the engine's newest passing test run isn't at the head");
  const onHead = x.runs.filter((r) => r.headSha === sha);
  if (onHead.some((r) => r.status !== "completed")) out.push("a check on the head hasn't finished");
  else if (onHead.some((r) => !PASSING.has(r.conclusion ?? ""))) out.push("a check on the head didn't pass");
  if (checksVerdict(x.required, x.runs, sha).state !== "green") out.push("the required checks aren't green");
  if (x.status.count > 0 && x.status.state !== "success") out.push(`the head's commit status is ${x.status.state}`);
  if (x.unmet.length) out.push(`definition of done item${x.unmet.length > 1 ? "s" : ""} ${x.unmet.join(", ")} ${x.unmet.length > 1 ? "aren't" : "isn't"} met`);
  if (x.ownerHeld) out.push("the owner asked to hold or change it");
  return out;
}

/** The orchestrator's verdict, from its report's checks: approve only when it gave at least one and every one passed. */
export function orchestratorApproves(body: unknown): { approve: boolean; reason: string } {
  const b = body as { gate?: unknown; checks?: Array<{ name?: unknown; passed?: unknown; evidence?: unknown }> };
  if (b?.gate !== "auto_merge" || !Array.isArray(b.checks) || !b.checks.length) return { approve: false, reason: "the orchestrator's report had no auto-merge checks" };
  const failed = b.checks.filter((c) => c.passed !== true);
  if (!failed.length) return { approve: true, reason: b.checks.map((c) => String(c.name ?? "")).join(", ") };
  return { approve: false, reason: failed.map((c) => `${String(c.name ?? "")}: ${String(c.evidence ?? "")}`).join("\n").slice(0, 4000) };
}
