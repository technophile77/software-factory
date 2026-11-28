import type { CiChange } from "./item";
import { coveredCiOnly } from "./plan";

/**
 * F-026 FR-9, FR-11, SR-10, OQ-3 A: whether a feature's pull request must
 * wait for its CI jobs before it is marked ready. Code decides from facts:
 * the items' states, what merged, main's required checks and the feature's
 * CI-only tests.
 */

export interface CiItem {
  id: string;
  /** The inbox record's status. */
  status: string;
  change: CiChange | null;
  /** The engine found its pull request merged. */
  merged: boolean;
}

export type CiHold =
  | { kind: "none" }
  /** Waits on the owner's answer to an item, or on the engine landing an approved one. */
  | { kind: "wait"; why: string; land: string[] }
  /** Waits on the owner marking checks required on main (OQ-3 A). */
  | { kind: "mark_required"; why: string; checks: string[] }
  /** A rejected or missing job leaves CI-only tests with nothing to run them; the owner decides. */
  | { kind: "stuck"; why: string };

const WAITING = new Set(["open", "deferred", "changes_requested", "research_requested"]);

export function ciHold(o: {
  items: readonly CiItem[];
  ciOnly: ReadonlyArray<{ test: string }>;
  required: readonly string[];
  /** FR-11: jobs the spec's configuration changes table names for this repo, and the factory jobs on main. */
  specJobs: readonly string[];
  mainJobs: readonly string[];
}): CiHold {
  const waiting = o.items.filter((i) => WAITING.has(i.status));
  const landing = o.items.filter((i) => i.status === "approved" && !i.merged);
  if (waiting.length || landing.length) {
    const why = [
      ...waiting.map((i) => `${i.id} waits for your answer`),
      ...landing.map((i) => `${i.id} is approved and its pull request hasn't merged yet`),
    ].join("; ");
    return { kind: "wait", why, land: landing.map((i) => i.id) };
  }
  const merged = o.items.filter((i) => i.merged && i.change);
  const landedJobs = new Set([...o.mainJobs, ...merged.flatMap((i) => i.change!.jobs.filter((j) => j.action !== "remove").map((j) => j.job))]);
  const missingSpec = o.specJobs.filter((j) => !landedJobs.has(j));
  // A request the engine replaced or withdrew closes without the owner's answer; only the owner's rejection leaves tests orphaned.
  const rejected = o.items.filter((i) => !i.merged && i.change && i.status === "rejected");
  const landedCover = new Set(merged.flatMap((i) => i.change!.jobs.filter((j) => j.action !== "remove").flatMap((j) => j.covers)));
  const orphaned = rejected.flatMap((i) => i.change!.jobs.flatMap((j) => coveredCiOnly(j.covers, o.ciOnly))).filter((t) => !landedCover.has(t));
  if (missingSpec.length || orphaned.length) {
    return {
      kind: "stuck",
      why: [
        ...(missingSpec.length ? [`the spec needs CI job${missingSpec.length > 1 ? "s" : ""} ${missingSpec.join(", ")}, which ${missingSpec.length > 1 ? "aren't" : "isn't"} on main and wasn't requested and approved`] : []),
        ...(orphaned.length ? [`${rejected.map((i) => i.id).join(", ")} ${rejected.length > 1 ? "were" : "was"} rejected, so CI-only tests ${[...new Set(orphaned)].slice(0, 10).join(", ")} have no CI job to run them`] : []),
      ].join("; "),
    };
  }
  // OQ-3 A: a job that runs CI-only tests counts only once the owner has made its check required.
  const need = merged.flatMap((i) => i.change!.jobs.filter((j) => j.action !== "remove" && coveredCiOnly(j.covers, o.ciOnly).length).map((j) => j.check));
  const unmarked = [...new Set(need)].filter((c) => !o.required.includes(c));
  if (unmarked.length) return { kind: "mark_required", why: `mark ${unmarked.join(", ")} required on main: ${unmarked.length > 1 ? "they run" : "it runs"} this feature's CI-only tests`, checks: unmarked };
  return { kind: "none" };
}

/** FR-29 with F-026: CI-only tests stay pending, not incomplete, while a requested job will run them. */
export function ciOnlyCovered(items: readonly CiItem[], ciOnly: ReadonlyArray<{ test: string }>): boolean {
  if (!ciOnly.length) return false;
  const live = items.filter((i) => i.change && (WAITING.has(i.status) || i.status === "approved" || i.merged));
  const covered = new Set(live.flatMap((i) => i.change!.jobs.flatMap((j) => coveredCiOnly(j.covers, ciOnly))));
  return ciOnly.every((t) => covered.has(t.test));
}
