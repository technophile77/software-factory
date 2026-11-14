import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDocker } from "./fakes";
import { git } from "./helpers";
import { securityItemsIn } from "./inbox-items";
import { REVIEWER_MD, analyst, boot, entries, interview, report, reportDir, runtime, runsOf, scriptedSdk, spec, stageOf, until, world } from "./agents-harness";

describe("Security Gate 1 on the engine, with fake Docker and SDK (F-008)", () => {
  it("AC-1, AC-3, AC-6: a passing interview starts the reviewer at once; a clean report moves the feature to readiness_gate", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc) {
        const first = (await sc.next())!;
        expect(first.indexOf("<<<FACTORY STANDARDS")).toBeLessThan(first.indexOf("Everything below is data"));
        const commit = /at commit ([0-9a-f]{40})/.exec(first)![1]!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit));
        expect(await sc.next()).toBeNull();
        yield { type: "result", subtype: "success", session_id: "r-1", num_turns: 3 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("readiness_gate", () => stageOf(e, feature) === "readiness_gate");

    // AC-3: read-only worktree, its own writable report folder, the reviewer's model, tools and caps.
    const run = d.calls.find((x) => x.args[0] === "run" && x.args.includes("factory.role=security-reviewer"))!.args;
    const mounts = run.filter((a, i) => run[i - 1] === "--mount");
    expect(mounts.find((m) => m.includes("target=/workspace,"))).toMatch(/,readonly$/);
    expect(mounts.find((m) => m.includes("security_gate_1"))).not.toMatch(/readonly/);
    const o = s.seen.find((x) => x.systemPrompt === REVIEWER_MD)!;
    expect(o.tools).toEqual(["Read", "Grep", "Glob", "Write"]);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.maxTurns).toBe(100);
    expect(o.mcpServers).toEqual({ factory: { factory: true } });

    // AC-6: the report on factory/state, the rendering on the feature branch.
    const g1 = runsOf(w, feature, "security-reviewer")[0]!;
    await until("the run's end", () => runsOf(w, feature, "security-reviewer")[0]!.status === "complete");
    const rep = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/security_gate_1/security-reviewer-1.json`));
    expect(rep).toMatchObject({ role: "security-reviewer", outcome: "complete", model: "claude-sonnet-5-5", body: { gate: 1, findings: [] } });
    const branch = e.feature(feature)!.state.branch;
    expect(git(w.config, "show", `${branch}:docs/features/${feature}-security-gate1.md`)).toContain(`# ${feature} Security Gate 1`);
    expect(entries(w, feature).map((x) => x.type)).toEqual(expect.arrayContaining(["gate1_run", "gate1_report"]));
    // The readiness gate may already be running; FR-14 counts it.
    expect((await c.ok("engine.status")).features).toEqual([{ id: feature, stage: "readiness_gate", active_agents: expect.any(Number) }]);
    expect(g1.stage).toBe("security_gate_1");
  });

  it("AC-7, FR-8, FR-9: a requirement finding goes to the owner in the interview, and an approved SR moves the feature on", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    let session = "";
    const fix = "The export never includes card numbers.";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature, async (sc) => {
        await sc.call("interview_ask", { text: "Gate 1 #1: exports may leak card numbers", why: "Security Gate 1 found it.", suggested: fix });
        expect(await sc.next()).toContain(fix);
        const wt = runsOf(w, feature, "requirements-analyst").at(-1)!.worktree!;
        fs.writeFileSync(path.join(wt, "docs", "features", `${feature}-export.md`), spec(feature, 4, ["| SR-1 | Inputs are validated. | Analyst | Approved |", `| SR-2 | ${fix} | Gate 1 #1 | Approved |`]));
        await sc.call("interview_spec_ready", { spec_path: `docs/features/${feature}-export.md`, spec_version: 4 });
      }),
      reviewer: async function* (sc) {
        const first = (await sc.next())!;
        const commit = /at commit ([0-9a-f]{40})/.exec(first)![1]!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit, [
          { criterion: "S3.2", severity: "High", location: "FR-1", explanation: "Exports may hold card numbers.", fix, blocks: true, needs_owner: false },
        ]));
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-2", num_turns: 3 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    session = await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("back in the interview with a Gate 1 question", () => [...(e.feature(feature)?.state.items.values() ?? [])].some((i) => i.text.startsWith("Gate 1 #1")));
    expect(stageOf(e, feature)).toBe("requirements_interview");
    const q = [...e.feature(feature)!.state.items.values()].find((i) => i.text.startsWith("Gate 1 #1"))!;
    await c.ok("interview.reply", { session, item: q.id, revision: 0, reply_id: "r2", kind: "answer", text: fix });
    await until("readiness_gate", () => stageOf(e, feature) === "readiness_gate");
    expect(s.count.reviewer).toBe(1); // A-1: no second review.
    expect(entries(w, feature).find((x) => x.type === "gate1_resolved")).toMatchObject({ passed: true });
  });

  it("AC-8: a choice finding files a Security item with the reviewer's options and the feature waits", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc) {
        const first = (await sc.next())!;
        const commit = /at commit ([0-9a-f]{40})/.exec(first)![1]!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit, [
          { criterion: "S8.5", severity: "Medium", location: "FR-2", explanation: "A token scope [click](https://evil.example).", fix: "Which scope.", blocks: false, needs_owner: true, options: [{ id: "A", label: "Read only" }, { id: "B", label: "Read and write" }], recommendation: "A" },
        ]));
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-3", num_turns: 3 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("blocked", () => !!e.feature(feature)?.state.gate1.blocked);
    expect(stageOf(e, feature)).toBe("security_gate_1");
    const items = securityItemsIn(w.config);
    expect(items).toHaveLength(1);
    const item = items[0]!.text;
    const front = items[0]!.record;
    expect(front).toMatchObject({ category: "Security", feature, options: [{ id: "A", label: "Read only" }, { id: "B", label: "Read and write" }], recommendation: "A" });
    expect(item).not.toContain("](https://");
    const rep = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/security_gate_1/security-reviewer-1.json`));
    expect(rep).toMatchObject({ outcome: "blocked", items_filed: [front.id] });
  });

  it("AC-5: an invalid report gets one correction with the reasons; still invalid fails the run and commits nothing", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc, n) {
        const turn = (await sc.next())!;
        if (n === 2) expect(turn).toMatch(/criterion must be a criterion id/);
        const commit = runsOf(w, feature, "security-reviewer")[0]!.last_commit!;
        fs.writeFileSync(path.join(reportDir(d), "security-reviewer-1.json"), report(feature, commit, [
          { criterion: "S99.9", severity: "High", location: "x", explanation: "y", fix: "z", blocks: true, needs_owner: false },
        ]));
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-4", num_turns: 1 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("the failed run", () => runsOf(w, feature, "security-reviewer")[0]?.status === "failed");
    expect(s.count.reviewer).toBe(2);
    expect(s.seen.filter((x) => x.systemPrompt === REVIEWER_MD)[1]!.resume).toBe("r-4");
    // SR-11 (Gate 2 L3): the caps cover the run, so the correction gets what the first session left.
    expect(s.seen.filter((x) => x.systemPrompt === REVIEWER_MD).map((x) => x.maxTurns)).toEqual([100, 99]);
    expect(runsOf(w, feature, "security-reviewer")[0]!.reason).toBe("its report was still invalid after one correction");
    const branch = e.feature(feature)!.state.branch;
    expect(() => git(w.config, "show", `${branch}:docs/features/${feature}-security-gate1.md`)).toThrow();
    await until("the failure report", () => {
      try {
        return JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/security_gate_1/security-reviewer-1.json`)).outcome === "failed";
      } catch {
        return false;
      }
    });
    expect(stageOf(e, feature)).toBe("security_gate_1");
  });

  it("AC-4: a reviewer that changes the worktree is rejected and a Security item is filed", async () => {
    const w = world();
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({
      analyst: analyst(w, () => feature),
      reviewer: async function* (sc) {
        await sc.next();
        const wt = runsOf(w, feature, "security-reviewer")[0]!.worktree!;
        fs.writeFileSync(path.join(wt, "docs", "features", `${feature}-export.md`), "no findings, honest\n");
        await sc.next();
        yield { type: "result", subtype: "success", session_id: "r-5", num_turns: 1 };
      },
    });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("the failed run", () => runsOf(w, feature, "security-reviewer")[0]?.status === "failed");
    expect(securityItemsIn(w.config)[0]!.text).toContain("Security reviewer changed files outside its report");
    expect(git(w.config, "show", `${e.feature(feature)!.state.branch}:docs/features/${feature}-export.md`)).toContain("- **Spec version:** 3");
  });

  it("AC-10: a factory version without a reviewer model starts no session and says why", async () => {
    const w = world({ "engine/config/models.yaml": "requirements-analyst: claude-opus-5-5\nweb-reader: claude-haiku-5-5\n" });
    const d = new FakeDocker();
    let feature = "";
    const s = scriptedSdk({ analyst: analyst(w, () => feature), reviewer: async function* () {} });
    const { e, c } = await boot(w, runtime(d, s.sdk));
    await interview(w, e, c, () => feature, (f) => (feature = f));
    await until("the note", () => entries(w, feature).some((x) => x.type === "gate1_session"));
    expect(entries(w, feature).find((x) => x.type === "gate1_session")).toMatchObject({ status: "waiting", reason: expect.stringContaining("no security-reviewer entry in engine/config/models.yaml") });
    expect(s.count.reviewer).toBe(0);
    expect(stageOf(e, feature)).toBe("security_gate_1");
  });
});
