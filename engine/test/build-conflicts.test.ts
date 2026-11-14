import { describe, expect, it } from "vitest";
import { RESOLVE_CYCLES, conflictOwners, hasConflictMarkers, nextResolveStep } from "../src/build/conflicts";
import type { BuildEvent } from "../src/interview/model";

// ADR 0013: who resolves a conflicted file, and when the resolution is done, is engine code.

const dev = { allow: ["**"], deny: ["test/**", ".github/workflows/**"] };
const tester = { allow: ["test/**"], deny: [".github/workflows/**"] };
const ev = (action: string, o: Record<string, unknown> = {}): BuildEvent => ({ action, at: "t", ...o });
const conflict = (developer: string[], testerFiles: string[]) => ev("conflict", { from: "agents", files: [...developer, ...testerFiles], owners: { developer, tester: testerFiles } });

describe("conflictOwners", () => {
  it("tests go to the test engineer, other writable files to the developer, the rest to the owner", () => {
    expect(conflictOwners(["src/a.ts", "package-lock.json", "test/a.test.ts", ".github/workflows/ci.yml"], dev, tester)).toEqual({
      developer: ["src/a.ts", "package-lock.json"], tester: ["test/a.test.ts"], owner: [".github/workflows/ci.yml"],
    });
  });
});

describe("hasConflictMarkers", () => {
  it("needs an opening and a closing marker line; a Markdown underline alone isn't one", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature/F-1/test\n")).toBe(true);
    expect(hasConflictMarkers("Title\n=======\n")).toBe(false);
    expect(hasConflictMarkers("x <<<<<<< y >>>>>>> z\n")).toBe(false);
  });
});

describe("nextResolveStep", () => {
  it("each owning role runs once, the developer first, then the resolution is finished", () => {
    const events = [conflict(["src/a.ts"], ["test/a.test.ts"])];
    expect(nextResolveStep(events, new Set(["src/a.ts", "test/a.test.ts"]))).toMatchObject({ action: "run", role: "software-developer", files: ["src/a.ts"] });
    events.push(ev("done", { resolver: "software-developer" }));
    expect(nextResolveStep(events, new Set(["test/a.test.ts"]))).toMatchObject({ action: "run", role: "test-engineer", marked: ["test/a.test.ts"] });
    // A role runs once even when git left no marker (a delete against an edit).
    expect(nextResolveStep([conflict([], ["test/a.test.ts"])], new Set())).toMatchObject({ action: "run", role: "test-engineer", marked: [] });
    events.push(ev("done", { resolver: "test-engineer" }));
    expect(nextResolveStep(events, new Set())).toEqual({ action: "finished" });
  });

  it("markers left run the role again, and after three sessions go to the owner", () => {
    const events = [conflict(["src/a.ts"], [])];
    for (let i = 0; i < RESOLVE_CYCLES; i++) {
      expect(nextResolveStep(events, new Set(["src/a.ts"]))).toMatchObject({ action: "run" });
      events.push(ev("done", { resolver: "software-developer" }));
    }
    expect(nextResolveStep(events, new Set(["src/a.ts"]))).toEqual({ action: "escalate", role: "software-developer", marked: ["src/a.ts"] });
  });

  it("only the newest conflict counts", () => {
    const events = [conflict(["src/a.ts"], []), ev("done", { resolver: "software-developer" }), ev("done", { resolver: "software-developer" }), conflict(["src/b.ts"], [])];
    expect(nextResolveStep(events, new Set(["src/b.ts"]))).toMatchObject({ action: "run", files: ["src/b.ts"] });
    expect(nextResolveStep([], new Set())).toBeNull();
  });
});
