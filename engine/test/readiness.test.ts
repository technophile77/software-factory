import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineHandle } from "../src/engine";
import { InterviewState } from "../src/interview/model";
import { readinessChecks, remoteContentLines, specAssumptions } from "../src/interview/readiness";
import { makeEntry } from "../src/state/transcript";
import { canSymlink, linkDir, needsSymlinks } from "./acceptance/support/platform";
import { RpcClient, World, approvedSession, engineJson, git, initRepo, makeWorld, start } from "./helpers";

let engines: EngineHandle[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await e.stop();
  engines = [];
  clients = [];
});

function spec(feature: string, assumptions: string[] = [], extra = ""): string {
  return [
    `# Feature: Export`,
    "",
    `- **Id:** ${feature}`,
    "- **Spec version:** 3",
    "",
    "## 8. Assumptions",
    "| Id | Assumption | Decision link | Status |",
    "|---|---|---|---|",
    ...assumptions,
    "",
    "## 9. Security considerations",
    extra,
  ].join("\n");
}

async function setup() {
  const w = makeWorld();
  const e = await start(w);
  engines.push(e);
  const c = await RpcClient.connect(engineJson(w).path);
  clients.push(c);
  const feature = (await c.ok("feature.start", { request: "Export" })).feature as string;
  git(w.root, "init", "-q", w.worktree);
  return { w, e, c, feature, tools: e.interviewTools(feature, w.worktree, { model: "claude-test", effort: "high" }) };
}

function writeSpec(w: World, feature: string, text: string, name = "export"): string {
  const rel = `docs/features/${feature}-${name}.md`;
  fs.mkdirSync(path.join(w.worktree, "docs", "features"), { recursive: true });
  fs.writeFileSync(path.join(w.worktree, rel), text);
  return rel;
}

type Checks = Array<{ name: string; passed: boolean; evidence: string }>;
const byName = (checks: Checks, n: string) => checks.find((c) => c.name === n)!;

describe("interview_spec_ready (FR-12, AC-10)", () => {
  it("passes a clean spec, writes the agent report (FR-13) and moves the stage on", async () => {
    const { w, e, c, feature, tools } = await setup();
    await tools.interview_propose_assumption({ text: "CSV is enough.", why: "w" });
    await tools.interview_ask({ text: "Q?", why: "w" });
    const session = await approvedSession(w, c, feature);
    await c.ok("interview.reply", { session, item: "A-001", revision: 0, reply_id: "a", kind: "approve_assumption", text: "" });
    await c.ok("interview.reply", { session, item: "Q-001", revision: 0, reply_id: "q", kind: "answer", text: "ok" });
    const rel = writeSpec(w, feature, spec(feature, ["| A-1 | CSV is  enough. | Interview A-001, owner 2026-11-11 | Approved |"]));
    // Gate 2, L2: the worktree's .git is the agent's to rewrite; the report's commit doesn't come from it.
    const decoy = path.join(w.root, "decoy");
    initRepo(decoy, { "x.md": "decoy" });
    fs.rmSync(path.join(w.worktree, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(w.worktree, ".git"), `gitdir: ${path.join(decoy, ".git")}\n`);
    const r = await tools.interview_spec_ready({ spec_path: rel, spec_version: 3 });
    expect(r.ok).toBe(true);
    const checks = (r as { result: { checks: Checks } }).result.checks;
    expect(checks.every((x) => x.passed)).toBe(true);
    const report = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/requirements_interview/requirements-analyst-1.json`));
    expect(report).toMatchObject({
      schema: "agent-report/1.0", role: "requirements-analyst", feature, stage: "requirements_interview", outcome: "complete",
      model: "claude-test", effort: "high", body: { spec_path: rel, spec_version: 3, open_assumptions: [] },
    });
    const branch = e.feature(feature)!.state.branch;
    expect(report.commit).toBe(git(w.config, "rev-parse", `refs/heads/${branch}`));
    expect(report.commit).not.toBe(git(decoy, "rev-parse", "HEAD"));
    expect((await c.ok("engine.status")).features).toEqual([{ id: feature, stage: "security_gate_1", active_agents: 0 }]);
    void e;
  });

  it("AC-10: check 6 fails while a question is deferred", async () => {
    const { w, c, feature, tools } = await setup();
    await tools.interview_ask({ text: "Q?", why: "w" });
    const session = await approvedSession(w, c, feature);
    await c.ok("interview.reply", { session, item: "Q-001", revision: 0, reply_id: "d", kind: "defer", text: "" });
    const rel = writeSpec(w, feature, spec(feature));
    const r = (await tools.interview_spec_ready({ spec_path: rel, spec_version: 3 })) as { result: { checks: Checks } };
    expect(byName(r.result.checks, "check_6_blocking_decisions")).toMatchObject({ passed: false, evidence: "Questions not answered: Q-001 (deferred)." });
    const report = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/requirements_interview/requirements-analyst-1.json`));
    expect(report.outcome).toBe("partial");
  });

  it("AC-10: check 5 fails for an approved assumption with no approve_assumption entry, and for a pending one", async () => {
    const { w, feature, tools } = await setup();
    await tools.interview_propose_assumption({ text: "Pending one.", why: "w" });
    const rel = writeSpec(w, feature, spec(feature, ["| A-1 | Never asked. | owner | Approved |", "| A-2 | Pending one. | | Pending |"]));
    const r = (await tools.interview_spec_ready({ spec_path: rel, spec_version: 3 })) as { result: { checks: Checks } };
    const c5 = byName(r.result.checks, "check_5_assumptions");
    expect(c5.passed).toBe(false);
    expect(c5.evidence).toContain("pending assumptions: A-001");
    expect(c5.evidence).toMatch(/line 9: marked approved, but no approve_assumption entry matches it/);
    expect(c5.evidence).toMatch(/line 10: .*matches A-001, which the owner didn't approve/);
    expect(c5.evidence).not.toContain("Never asked");
  });

  it.skipIf(!canSymlink())(needsSymlinks("AC-19: a symlinked spec is refused and reveals nothing of the target"), async () => {
    const { w, feature, tools } = await setup();
    const secret = path.join(w.root, "id_ed25519");
    fs.writeFileSync(secret, "PRIVATE KEY MATERIAL");
    fs.mkdirSync(path.join(w.worktree, "docs", "features"), { recursive: true });
    fs.symlinkSync(secret, path.join(w.worktree, "docs", "features", `${feature}-x.md`));
    const r = await tools.interview_spec_ready({ spec_path: `docs/features/${feature}-x.md`, spec_version: 1 });
    expect(r).toEqual({ ok: false, error: { code: "invalid", message: "spec_path must be this feature's own docs/features spec, as a regular file." } });
    expect(JSON.stringify(r)).not.toContain("PRIVATE");
  });

  it("AC-19: a link in a parent folder of the spec is refused (a junction on Windows)", async () => {
    const { w, feature, tools } = await setup();
    fs.rmSync(path.join(w.worktree, "docs"), { recursive: true, force: true });
    fs.mkdirSync(path.join(w.root, "elsewhere", "features"), { recursive: true });
    fs.writeFileSync(path.join(w.root, "elsewhere", "features", `${feature}-x.md`), "- **Spec version:** 1\n");
    linkDir(path.join(w.root, "elsewhere"), path.join(w.worktree, "docs"));
    expect((await tools.interview_spec_ready({ spec_path: `docs/features/${feature}-x.md`, spec_version: 1 })).ok).toBe(false);
  });

  it("SR-12: refuses another feature's spec, other folders, traversal and odd paths", async () => {
    const { w, feature, tools } = await setup();
    writeSpec(w, "F-999", spec("F-999"));
    for (const p of ["docs/features/F-999-export.md", "../x.md", `docs/features/../features/${feature}-a.md`, `/etc/${feature}-a.md`,
      `docs/features/${feature}-a.txt`, `docs\\features\\${feature}-a.md`, `docs/features/${feature}-missing.md`]) {
      expect(await tools.interview_spec_ready({ spec_path: p, spec_version: 1 })).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
    expect(await tools.interview_spec_ready({ spec_path: 1, spec_version: 1 })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await tools.interview_spec_ready({ spec_path: "x", spec_version: -1 })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await tools.interview_spec_ready({ spec_path: "x", spec_version: 1, feature: "F-999" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("SR-22: flags remote images and raw HTML, and the spec version must match", async () => {
    const { w, feature, tools } = await setup();
    const rel = writeSpec(w, feature, spec(feature, [], "![t](https://evil.example/x.png)\n<img src=x>\n`<b>code</b>`\n```\n<div>\n```"));
    const r = (await tools.interview_spec_ready({ spec_path: rel, spec_version: 4 })) as { result: { checks: Checks } };
    expect(byName(r.result.checks, "no_remote_images_or_html")).toMatchObject({ passed: false, evidence: expect.stringContaining("lines 11, 12;") });
    expect(byName(r.result.checks, "spec_version").passed).toBe(false);
  });
});

describe("readiness helpers", () => {
  it("reads the assumptions table, skipping the header and empty template rows", () => {
    const rows = specAssumptions(spec("F-001", ["| A-1 | | | Pending |", "| A-2 | Uses a \\| pipe | link | Approved by owner |"]));
    expect(rows).toEqual([{ line: 10, id: "A-2", text: "Uses a | pipe", status: "approved by owner" }]);
  });

  it("finds reference-style remote images", () => {
    expect(remoteContentLines("![a][r]\n\n[r]: https://x.example/i.png\n")).toEqual([3]);
    expect(remoteContentLines("[link](https://x.example)\n")).toEqual([]);
  });

  it("only an approve_assumption at the item's current revision counts", () => {
    const s = new InterviewState();
    let prev = makeEntry(null, { type: "item_created", item: { id: "A-001", kind: "assumption", text: "T", why: "w" } }, "t");
    s.apply(prev);
    prev = makeEntry(prev, { type: "reply", item: "A-001", revision: 0, reply_id: "r", kind: "reject_assumption", text: "", status: "rejected" }, "t");
    s.apply(prev);
    const checks = readinessChecks({ spec: spec("F-001", ["| A-1 | T | x | Approved |"]), specVersion: 3, state: s, chainIntact: true });
    expect(checks.find((c) => c.name === "check_5_assumptions")!.passed).toBe(false);
  });
});
