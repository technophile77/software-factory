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
  const dir = join(world.projects[0].clone, ".factory", "runs", feature);
  return listFiles(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(f, "utf8")));
}

const values = (o: unknown): unknown[] =>
  o && typeof o === "object" ? Object.values(o as object).flatMap((v) => [v, ...values(v)]) : [];

describe("AC-12 / FR-14 / ADR 0012: interrupted runs", () => {
  it("[RS-1] AC-12: after a crash mid-session the analyst's run is recorded as interrupted, the run resumes on restart, and no retry is counted", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    await askAndFetch(w, feature, session);
    const startsBefore = w.analyst.starts.filter((s) => s.feature === feature).length;
    await w.engine!.crash();
    w.engine = undefined;
    await w.boot({ confirm: false });
    await waitFor(
      () => w!.analyst.starts.filter((s) => s.feature === feature).length > startsBefore,
      15_000,
      "the analyst run to resume",
    );
    const all = await waitFor(() => {
      const r = reports(w!, feature);
      return r.length ? r : undefined;
    }, 15_000, "an agent report under .factory/runs/<feature>/");
    const interrupted = all.filter((r) => r.feature === feature && values(r).includes("interrupted"));
    expect(interrupted.length, "a report marks the run interrupted").toBeGreaterThan(0);
    for (const r of all) {
      for (const k of ["retries", "retry", "retry_count", "attempt_retries"]) {
        if (k in r) expect(r[k], `${k} counted for an interruption`).toBe(0);
      }
    }
    expect(interrupted[0].role).toBe("requirements-analyst");
    expect(interrupted[0].schema).toMatch(/^agent-report\//);
  });
});
