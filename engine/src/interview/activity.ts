import { INTERVIEW_STAGE } from "../constants";
import { READINESS_STAGE } from "../gate1/flow";
import { GATE1_STAGE } from "../gate1/report";
import type { ItemStatus } from "./model";

/**
 * The fixed `activity` code `engine.status` reports for a feature (H-0225,
 * F-018 FR-14). Codes, never engine-written text, so a client can't be made
 * to show an agent's words as status.
 */
export function activityOf(o: { stage: string; paused: boolean; running: boolean; statuses: ItemStatus[] }): string {
  if (o.paused) return "paused";
  const waiting = o.statuses.some((s) => s === "open" || s === "deferred");
  if (!o.running) return waiting ? "waiting_for_owner" : "idle";
  if (o.stage === GATE1_STAGE) return "security_reviewing";
  if (o.stage === READINESS_STAGE) return "readiness_check";
  if (o.stage !== INTERVIEW_STAGE) return "idle";
  if (o.statuses.includes("researching")) return "analyst_researching";
  // With nothing left for the owner, an analyst still at work is writing the spec.
  return waiting ? "analyst_reviewing" : "analyst_writing_spec";
}
