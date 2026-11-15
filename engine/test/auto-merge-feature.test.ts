import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { type AutoMergeFacts, autoMergeBlockers, autoMergeCovers, orchestratorApproves } from "../src/build/automerge";
import { buildMachine } from "../src/build/lifecycle";
import { validateManifest } from "../src/config/manifest";
import { ConfigError } from "../src/config/paths-file";
import { type MergeApi, autoMergeFeature } from "../src/inbox/auto-merge";
import type { Pull } from "../src/build/pulls";
import { manifestYaml } from "./helpers";

// F-015 FR-18: the parts of auto-merge code decides before any model sees the PR.

const HEAD = "a".repeat(40);
const pr = (o: Partial<Pull> = {}): Pull => ({ number: 2, nodeId: "PR_2", state: "open", draft: false, merged: false, mergeCommit: null, mergedBy: "", head: { sha: HEAD, ref: "feature/F-002", repo: "acme/web" }, url: "", ...o });
const ok = (o: Partial<AutoMergeFacts> = {}): AutoMergeFacts => ({
  pr: pr(), pushed: HEAD, testsPassedAt: HEAD, required: [], runs: [], status: { state: "pending", count: 0 }, unmet: [], ownerHeld: false, ...o,
});
const run = (o: Record<string, unknown> = {}) => ({ name: "ci", status: "completed", conclusion: "success", appId: 15368, headSha: HEAD, summary: "", ...o });

describe("settings.auto_merge_up_to", () => {
  it("covers the level it names and every lower one, and nothing when unset", () => {
    expect(autoMergeCovers("alpha", "rapid-prototype")).toBe(true);
    expect(autoMergeCovers("alpha", "alpha")).toBe(true);
    expect(autoMergeCovers("alpha", "beta")).toBe(false);
    expect(autoMergeCovers(null, "rapid-prototype")).toBe(false);
    expect(autoMergeCovers("alpha", "")).toBe(false);
    expect(autoMergeCovers("alpha", "prototype")).toBe(false);
  });

  it("is read from the manifest: none or a level, anything else refused", () => {
    const m = (v?: string) => validateManifest(YAML.parse(manifestYaml({ extra: v === undefined ? "" : `  auto_merge_up_to: ${v}` })), "c");
    expect(m().autoMergeUpTo).toBeNull();
    expect(m("none").autoMergeUpTo).toBeNull();
    expect(m("beta").autoMergeUpTo).toBe("beta");
    expect(() => m("everything")).toThrow(ConfigError);
    expect(() => m("3")).toThrow(/auto_merge_up_to must be none or one of rapid-prototype, alpha, beta, release, production-ready/);
  });
});

describe("AC-33: code's checks before the orchestrator", () => {
  it("passes a ready PR at the pushed head with its tests passed there and no CI at all (owner, 2026-11-15)", () => {
    expect(autoMergeBlockers(ok())).toEqual([]);
  });

  it("passes when every check run and commit status on the head succeeded", () => {
    expect(autoMergeBlockers(ok({ required: [{ context: "ci", integrationId: null }], runs: [run(), run({ name: "lint", conclusion: "skipped" })], status: { state: "success", count: 2 } }))).toEqual([]);
  });

  it.each([
    ["a draft", { pr: pr({ draft: true }) }, /draft/],
    ["a closed PR", { pr: pr({ state: "closed" }) }, /isn't open/],
    ["a moved head", { pushed: "b".repeat(40) }, /not the b{40} the engine pushed/],
    ["no passing run at the head", { testsPassedAt: "b".repeat(40) }, /test run isn't at the head/],
    ["no passing run at all", { testsPassedAt: null }, /test run isn't at the head/],
    ["a running check", { runs: [run({ status: "in_progress", conclusion: null })] }, /hasn't finished/],
    ["a failed check", { runs: [run({ conclusion: "failure" })] }, /didn't pass/],
    ["a missing required check", { required: [{ context: "ci", integrationId: null }] }, /required checks/],
    ["a failed commit status", { status: { state: "failure", count: 1 } }, /commit status is failure/],
    ["a pending commit status", { status: { state: "pending", count: 1 } }, /commit status is pending/],
    ["an unmet definition-of-done item", { unmet: [8] }, /item 8 isn't met/],
    ["the owner's hold", { ownerHeld: true }, /hold or change/],
  ] as const)("blocks on %s", (_what, change, why) => {
    const out = autoMergeBlockers(ok(change as Partial<AutoMergeFacts>));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(why);
  });

  it("ignores a check run on another commit", () => {
    expect(autoMergeBlockers(ok({ runs: [run({ headSha: "b".repeat(40), conclusion: "failure" })] }))).toEqual([]);
  });
});

describe("AC-34: the orchestrator's verdict", () => {
  it("approves only an auto_merge report whose every check passed", () => {
    expect(orchestratorApproves({ gate: "auto_merge", checks: [{ name: "spec", passed: true, evidence: "ok" }, { name: "diff", passed: true, evidence: "ok" }] })).toEqual({ approve: true, reason: "spec, diff" });
    expect(orchestratorApproves({ gate: "auto_merge", checks: [{ name: "spec", passed: true, evidence: "ok" }, { name: "docs", passed: false, evidence: "README not updated" }] })).toEqual({ approve: false, reason: "docs: README not updated" });
    expect(orchestratorApproves({ gate: "auto_merge", checks: [] }).approve).toBe(false);
    expect(orchestratorApproves({ gate: "readiness", checks: [{ name: "spec", passed: true, evidence: "" }] }).approve).toBe(false);
    expect(orchestratorApproves(null).approve).toBe(false);
  });
});

describe("FR-18: the merge itself", () => {
  const api = (p: Pull, merges: string[], accept = true): MergeApi => ({
    pull: async () => (merges.length ? { ...p, state: "closed", merged: true, mergeCommit: "c".repeat(40) } : p),
    merge: async (_r: string, _n: number, sha: string) => (merges.push(sha), accept),
  }) as unknown as MergeApi;

  it("merges the feature's own PR at the checked head and returns the merge commit", async () => {
    const merges: string[] = [];
    expect(await autoMergeFeature(api(pr(), merges), { repo: "acme/web", pr: 2, branch: "feature/F-002", sha: HEAD })).toEqual({ merged: true, sha: "c".repeat(40) });
    expect(merges).toEqual([HEAD]);
  });

  it.each([
    ["another branch", pr({ head: { sha: HEAD, ref: "other", repo: "acme/web" } }), /isn't the feature's own/],
    ["a fork", pr({ head: { sha: HEAD, ref: "feature/F-002", repo: "someone/web" } }), /isn't the feature's own/],
    ["a draft", pr({ draft: true }), /isn't open and ready/],
    ["a moved head", pr({ head: { sha: "b".repeat(40), ref: "feature/F-002", repo: "acme/web" } }), /moved to b{40}/],
  ])("merges nothing for %s", async (_what, p, why) => {
    const merges: string[] = [];
    const r = await autoMergeFeature(api(p, merges), { repo: "acme/web", pr: 2, branch: "feature/F-002", sha: HEAD });
    expect(r).toMatchObject({ merged: false });
    expect((r as { why: string }).why).toMatch(why);
    expect(merges).toEqual([]);
  });

  it("reports GitHub's refusal, as when the head moved after the check", async () => {
    const merges: string[] = [];
    expect(await autoMergeFeature(api(pr(), merges, false), { repo: "acme/web", pr: 2, branch: "feature/F-002", sha: HEAD })).toMatchObject({ merged: false, why: expect.stringMatching(/GitHub refused/) });
  });
});

describe("FR-18 in the build lifecycle", () => {
  const ready = ["dependencies_merged", "done", "done", "branches_merged", "passed", "clean", "pass", "opened", "green"] as const;
  it("an engine merge ends the build; a hold leaves the PR waiting for the owner", () => {
    expect(buildMachine([...ready, "engine_merged"]).machine.state()).toBe("merged");
    expect(buildMachine([...ready, "auto_held"]).machine.state()).toBe("pr_ready");
    expect(buildMachine([...ready, "auto_held", "changes"]).machine.state()).toBe("fixing_product");
    expect(buildMachine([...ready, "auto_held", "owner_merged"]).machine.state()).toBe("merged");
  });
});
