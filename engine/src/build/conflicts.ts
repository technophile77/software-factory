import { allowedBy, type Rules } from "../policy/glob";
import type { BuildEvent } from "../interview/model";

/**
 * ADR 0013: who resolves each conflicted file, and whether a resolution is
 * finished. The engine decides both from the roles' write rules and the files'
 * contents; agents only edit.
 */

export interface ConflictOwners {
  developer: string[];
  tester: string[];
  /** Files neither role may write (CI, the test harness, change-controlled paths): never resolved by an agent. */
  owner: string[];
}

/** A test path goes to the test engineer; anything else the developer may write, lockfiles and generated files included, to the developer. */
export function conflictOwners(files: readonly string[], dev: Rules, tester: Rules): ConflictOwners {
  const out: ConflictOwners = { developer: [], tester: [], owner: [] };
  for (const f of files) {
    const d = allowedBy(dev, f);
    const t = allowedBy(tester, f);
    if (t && !d) out.tester.push(f);
    else if (d) out.developer.push(f);
    else out.owner.push(f);
  }
  return out;
}

/** True when the text still holds a git conflict block: an opening and a closing marker line. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text);
}

/** At most this many sessions per role on one conflict before the owner decides (ADR 0013: three failed cycles). */
export const RESOLVE_CYCLES = 3;

export type ResolveRole = "software-developer" | "test-engineer";

export type ResolveStep =
  | { action: "run"; role: ResolveRole; files: string[]; marked: string[] }
  | { action: "finished" }
  | { action: "escalate"; role: ResolveRole; marked: string[] };

/**
 * The next step of resolving the newest conflict: each owning role runs at
 * least once on its files, and again while any of them still holds markers,
 * the developer first. `marked` is the conflicted files that hold markers now.
 */
export function nextResolveStep(events: readonly BuildEvent[], marked: ReadonlySet<string>): ResolveStep | null {
  let at = -1;
  events.forEach((e, i) => {
    if (e.action === "conflict") at = i;
  });
  if (at < 0) return null;
  const c = events[at]!;
  const owners = (c.owners ?? {}) as { developer?: unknown; tester?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const roles: Array<[ResolveRole, string[]]> = [["software-developer", list(owners.developer)], ["test-engineer", list(owners.tester)]];
  const after = events.slice(at + 1);
  for (const [role, files] of roles) {
    if (!files.length) continue;
    const ran = after.filter((e) => e.action === "done" && e.resolver === role).length;
    const left = files.filter((f) => marked.has(f));
    if (ran > 0 && !left.length) continue;
    if (ran >= RESOLVE_CYCLES) return { action: "escalate", role, marked: left };
    return { action: "run", role, files, marked: left };
  }
  return { action: "finished" };
}
