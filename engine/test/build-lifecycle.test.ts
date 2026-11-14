import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_MACHINE, STAGE_OF, buildMachine, type BuildAction } from "../src/build/lifecycle";
import { liveness, type MachineSpec } from "../src/machine/machine";

const MACHINES = [BUILD_MACHINE] as unknown as MachineSpec<string, string, string>[];

describe("machine liveness (F-019 FR-3, FR-7)", () => {
  it.each(MACHINES.map((m) => [m.name, m] as const))("%s has no dead end", (_name, spec) => {
    expect(liveness(spec)).toEqual([]);
  });

  const base = BUILD_MACHINE as unknown as MachineSpec<string, string, string>;
  it("names a non-final state with no exits", () => {
    const text = base.text.replace(/^pr_ready .*$/gm, "");
    expect(liveness({ ...base, text })).toEqual(expect.arrayContaining([expect.stringContaining("build: state pr_ready is not final but has no exits")]));
  });
  it("names a state with no actor", () => {
    const actors = { ...base.actors } as Record<string, unknown>;
    delete actors.testing;
    expect(liveness({ ...base, actors } as typeof base)).toContain("build: state testing names no actor");
  });
  it("names a state missing from the typed union", () => {
    const text = `${base.text}\nci_wait 'odd' -> limbo;\nlimbo 'out' -> blocked;`;
    const found = liveness({ ...base, text });
    expect(found.some((p) => p.includes("states differ from the typed union") && p.includes("limbo"))).toBe(true);
    expect(found.some((p) => p.includes("actions differ"))).toBe(true);
  });
  it("names a state nothing enters and a trap with no way to a final state", () => {
    const text = `${base.text}\norphan 'x' -> blocked;\nblocked 'trap' -> pit;\npit 'again' -> pit;`;
    const spec = { ...base, text, states: [...base.states, "orphan", "pit"], actions: [...base.actions, "x", "trap", "again"], actors: { ...base.actors, orphan: { kind: "engine", does: "x" }, pit: { kind: "engine", does: "y" } } };
    const found = liveness(spec as typeof base);
    expect(found).toContain("build: state orphan can't be entered from waiting_dependency");
    expect(found).toContain("build: state pit can never reach a final state");
  });

  it("machine text has no substitutions (F-019 SR-4)", () => {
    for (const f of readdirSync(join(__dirname, "../src/build"))) {
      const src = readFileSync(join(__dirname, "../src/build", f), "utf8");
      const m = /const TEXT = `([^`]*)`/.exec(src);
      if (m) expect(m[1]).not.toContain("${");
    }
  });
});

describe("build lifecycle", () => {
  it("walks the happy path to an owner merge", () => {
    const path: BuildAction[] = ["dependencies_merged", "done", "done", "branches_merged", "passed", "clean", "pass", "opened", "green", "owner_merged"];
    const { machine, refused } = buildMachine(path);
    expect(refused).toBeNull();
    expect(machine.state()).toBe("merged");
    expect(machine.isFinal()).toBe(true);
    expect(machine.actor()).toBeNull();
  });

  it("stage 6 loops back to testing after a fix", () => {
    const { machine } = buildMachine(["dependencies_merged", "done", "done", "branches_merged", "tests_failed", "product_code", "done"]);
    expect(machine.state()).toBe("testing");
    expect(STAGE_OF[machine.state()]).toBe("orchestrator_review");
  });

  it("refuses an action the state doesn't allow and stops replay there", () => {
    const { machine, refused } = buildMachine(["dependencies_merged", "green", "done"]);
    expect(refused).toEqual({ index: 1, action: "green", state: "developer" });
    expect(machine.state()).toBe("developer");
  });

  it("refuses an unknown action", () => {
    expect(buildMachine(["nope"]).refused).toEqual({ index: 0, action: "nope", state: "waiting_dependency" });
  });

  it("every state maps to a workflow.yaml stage", () => {
    const wf = readFileSync(join(__dirname, "../../workflows/feature-development/workflow.yaml"), "utf8");
    for (const s of new Set(Object.values(STAGE_OF))) if (s !== "blocked") expect(wf).toContain(`id: ${s}`);
  });

  it("blocked waits on the owner", () => {
    const { machine } = buildMachine(["dependencies_merged", "failed"]);
    expect(machine.actor()).toEqual({ kind: "owner", waitsOn: expect.any(String) });
  });
});

import { TargetError, specDependencies, targetRepo } from "../src/build/target";

describe("target repo and dependencies (FR-16, H-0198, AC-15)", () => {
  const repos = [{ name: "web" }, { name: "api" }];
  const spec = (header: string, deps = "") => `# Feature: x\n\n- **Id:** F-010\n${header}\n## 1. Objective\nF-099 is mentioned here.\n## 7. Dependencies\n${deps}\n## 8. Assumptions\nF-098\n`;
  it("takes the Repo line, or the only repo", () => {
    expect(targetRepo(spec("- **Repo:** api"), repos)).toEqual({ name: "api" });
    expect(targetRepo(spec("- **Repo:** `web`"), repos)).toEqual({ name: "web" });
    expect(targetRepo(spec(""), [{ name: "only" }])).toEqual({ name: "only" });
  });
  it("refuses a missing or unknown repo when there are several", () => {
    expect(() => targetRepo(spec(""), repos)).toThrow(TargetError);
    expect(() => targetRepo(spec("- **Repo:** other"), repos)).toThrow(TargetError);
  });
  it("a Repo line in the body is not the header", () => {
    expect(() => targetRepo(`# F\n\n## 1. x\n- **Repo:** api\n`, repos)).toThrow(TargetError);
  });
  it("lists section 7's feature ids only, without itself", () => {
    expect(specDependencies(spec("", "Needs F-003 merged, and F-010 itself, then F-003 again and F-012."), "F-010")).toEqual(["F-003", "F-012"]);
    expect(specDependencies("# none", "F-010")).toEqual([]);
  });
});
