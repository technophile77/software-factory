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
export function activityOf(o: { stage: string; paused: boolean; running: boolean; statuses: ItemStatus[]; decisions?: string[] }): string {
  if (o.paused) return "paused";
  const waiting = o.statuses.some((s) => s === "open" || s === "deferred");
  if (!o.running) {
    if (o.decisions?.length) return "waiting_for_decision";
    if (waiting) return "waiting_for_owner";
  }
  if (o.stage === ST_REVIEW_STAGE) return "security_reviewing";
  if (o.stage === READINESS_STAGE) return "readiness_check";
  if (o.stage !== INTERVIEW_STAGE) return "idle";
  if (o.statuses.includes("researching")) return "analyst_researching";
  // With nothing left for the owner, an analyst at work, or about to be, is writing the spec.
  return waiting ? "analyst_reviewing" : "analyst_writing_spec";
}
