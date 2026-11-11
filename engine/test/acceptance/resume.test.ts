// AC-12 / FR-14, bookkeeping part (milestone 1): an engine killed
// mid-session marks the run interrupted, resumes it, and counts no retry.
// Resuming the real Agent SDK session in its container is milestone 2.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askAndFetch, interviewReady } from "./support/flows";
import { listFiles, waitFor, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

function reports(world: World, feature: string): any[] {
  const dir = join(world.project().clone, ".factory", "runs", feature);
  return listFiles(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(f, "utf8")));
}

describe("AC-12 / FR-14 / ADR 0012: interrupted runs", () => {
  it("[RS-1] AC-12: after a crash mid-session the analyst's run is recorded as interrupted, the run resumes on restart, and no retry is counted", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    await askAndFetch(w, feature, session);
    const runsBefore = (await w.engine!.runs()).filter((r) => r.feature === feature);
    expect(runsBefore.map((r) => [r.role, r.status])).toEqual([["requirements-analyst", "running"]]);
    const run = runsBefore[0]!;
    const startsBefore = w.analyst.starts.filter((s) => s.feature === feature).length;
    await w.engine!.crash();
    w.engine = undefined;
    await w.boot({ confirm: false });
    await waitFor(
      () => w!.analyst.starts.filter((s) => s.feature === feature).length > startsBefore,
      15_000,
      "the analyst run to resume",
    );
    // The run is recorded `interrupted` in the engine record (FR-14), not in
    // the Agent report, whose v1.1 outcomes have no such value. The engine
    // only resumes a run whose record says `interrupted`, and the resume
    // flips it back to `running`, so the resume of this same run, counted
    // as a resume, is what shows it was interrupted.
    const resumed = w.analyst.resumes.filter((r) => r.feature === feature);
    expect(resumed.length, "the engine handed the interrupted run back to resume").toBe(1);
    expect(["session", "from_commit"]).toContain(resumed[0]!.plan.mode);
    expect(resumed[0]!.plan.run).toMatchObject({ id: run.id, role: "requirements-analyst", resumes: run.resumes + 1 });
    const runsAfter = (await w.engine!.runs()).filter((r) => r.feature === feature);
    expect(runsAfter.map((r) => r.id), "a resume, not a new run").toEqual([run.id]);
    for (const r of runsAfter) {
      for (const k of ["retries", "retry", "retry_count", "attempt_retries"]) {
        if (k in r) expect(r[k], `${k} counted for an interruption`).toBe(0);
      }
    }
    const all = await waitFor(() => {
      const r = reports(w!, feature);
      return r.length ? r : undefined;
    }, 15_000, "an agent report under .factory/runs/<feature>/");
    const mine = all.filter((r) => r.feature === feature);
    expect(mine.length, "the engine reports the interrupted run").toBeGreaterThan(0);
    for (const r of all) {
      for (const k of ["retries", "retry", "retry_count", "attempt_retries"]) {
        if (k in r) expect(r[k], `${k} counted for an interruption`).toBe(0);
      }
    }
    expect(mine[0].role).toBe("requirements-analyst");
    expect(mine[0].schema).toMatch(/^agent-report\//);
  });
});
