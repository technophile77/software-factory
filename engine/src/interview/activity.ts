import { INTERVIEW_STAGE } from "../constants";
import { READINESS_STAGE } from "../st-review/flow";
import { ST_REVIEW_STAGE } from "../st-review/report";
import type { ItemStatus } from "./model";

/**
 * The fixed `activity` code `engine.status` reports for a feature (H-0225,
 * F-018 FR-14). Codes, never engine-written text, so a client can't be made
 * to show an agent's words as status. `decisions` are the inbox items the
 * feature waits on (`waiting_on`).
 *
 * F-021 FR-12: `idle` only when nothing waits on the owner and no work is
 * running or queued. A stage the engine works on with no job yet is queued
 * work (the engine starts it, as `resumeFeature` does), so it reports that
 * stage's work, not idle.
 */
/**
 * F-021 v7 FR-12: a building feature reports what its build is doing,
 * from the build machine's state. Before v7 every build stage fell through
 * to `idle`, so the console called a feature idle while its tests ran.
 */
export const BUILD_ACTIVITY: Readonly<Record<string, string>> = {
  waiting_dependency: "waiting_on_dependency",
  developer: "developer_working",
  fixing_product: "developer_working",
  test_engineer: "test_engineer_working",
  fixing_tests: "test_engineer_working",
  merging: "merging",
  merging_main: "merging",
  resolving: "resolving_conflicts",
  testing: "tests_running",
  classifying: "classifying_failures",
  code_review: "code_reviewing",
  validation: "validating",
  opening_pr: "opening_pr",
  ci_wait: "waiting_for_ci",
  pr_ready: "pr_ready",
  blocked: "build_stopped",
  merged: "merged",
  closed: "closed",
};

export function activityOf(o: { stage: string; paused: boolean; running: boolean; statuses: ItemStatus[]; decisions?: string[]; build?: string; stalled?: boolean }): string {
  if (o.paused) return "paused";
  const waiting = o.statuses.some((s) => s === "open" || s === "deferred");
  if (!o.running && o.decisions?.length) return "waiting_for_decision";
  // Interview items left deferred after sign-off don't make a building feature wait on the owner.
  if (o.build !== undefined) return BUILD_ACTIVITY[o.build] ?? "idle";
  if (!o.running && waiting) return "waiting_for_owner";
  if (o.stage === ST_REVIEW_STAGE) return "security_reviewing";
  if (o.stage === READINESS_STAGE) return "readiness_check";
  if (o.stage !== INTERVIEW_STAGE) return "idle";
  // No analyst job and its last run failed: nothing is queued, so nobody is writing the spec.
  if (o.stalled && !o.running) return "idle";
  if (o.statuses.includes("researching")) return "analyst_researching";
  // With nothing left for the owner, an analyst at work, or about to be, is writing the spec.
  return waiting ? "analyst_reviewing" : "analyst_writing_spec";
}
