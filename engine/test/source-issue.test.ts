// F-015 FR-26: a feature started from a code repo issue records it, and its PR closes it; and feature.start leaves nothing behind when it fails.
import { afterEach, describe, expect, it } from "vitest";
import type { PullsApi } from "../src/build/pulls";
import { prText } from "../src/build/stage9";
import { RPC, parseSourceIssue } from "../src/constants";
import { EngineHandle } from "../src/engine";
import { ScanError } from "../src/gitleaks";
import { parseTranscript } from "../src/state/transcript";
import { RpcClient, git, engineJson, makeWorld, start } from "./helpers";

let engines: EngineHandle[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await e.stop();
  engines = [];
  clients = [];
});

/** GitHub's answer for issues in acme-web: #7 is open, #8 closed, anything else missing. */
async function setup(checks: string[]) {
  const w = makeWorld();
  const issueOpen = async (repo: string, n: number) => (checks.push(`${repo}#${n}`), n === 7);
  const e = await start(w, { pulls: () => ({ issueOpen }) as unknown as PullsApi });
  engines.push(e);
  const c = await RpcClient.connect(engineJson(w).path);
  clients.push(c);
  return { w, e, c };
}

describe("source issues (F-015 FR-26, channel v1.8)", () => {
  it("parses only owner/repo#number", () => {
    expect(parseSourceIssue("example-org/acme-web#25")).toEqual({ repo: "example-org/acme-web", number: 25 });
    expect(parseSourceIssue(" example-org/acme.web_2#1 ")).toEqual({ repo: "example-org/acme.web_2", number: 1 });
    for (const bad of ["acme-web#25", "example-org/acme-web#0", "example-org/acme-web", "example-org/acme-web#25 x", "a/b#1234567890", "../x/y#1", 25, null]) {
      expect(parseSourceIssue(bad), String(bad)).toBeNull();
    }
  });

  it("puts Closes #n last in the PR description, only for a checked number", () => {
    const f = { id: "F-001", title: "Export", specVersion: 3, specCommit: "a".repeat(40), configRepo: "example-org/acme-config", specPath: "docs/features/F-001-export.md" };
    expect(prText(f, true).body).not.toContain("Closes");
    expect(prText({ ...f, closes: 25 }, false).body.split("\n").slice(-2)).toEqual(["", "Closes #25"]);
    expect(prText({ ...f, closes: 0 }, true).body).not.toContain("Closes");
  });

  it("records an open issue in a project repo, and refuses any other without starting anything", async () => {
    const checks: string[] = [];
    const { w, c } = await setup(checks);
    const refused = async (issue: unknown) => (await c.call("feature.start", { request: "Export orders", issue })).error as { code: number; message: string };

    expect((await refused("not an issue")).code).toBe(RPC.invalidParams);
    expect(await refused("someone/other-repo#7")).toMatchObject({ code: RPC.invalidParams, message: expect.stringContaining("isn't one of acme's code repos") });
    expect(await refused("example-org/acme-web#8")).toMatchObject({ code: RPC.invalidParams, message: expect.stringContaining("isn't an open issue") });
    expect(checks).toEqual(["example-org/acme-web#8"]);
    expect(git(w.config, "branch", "--list", "feature/*")).toBe("");

    // The repo is named as the manifest names it, whatever case the owner typed.
    const feature = (await c.ok("feature.start", { request: "Export orders", issue: "Example-Org/ACME-web#7" })).feature as string;
    const started = parseTranscript(git(w.config, "show", `factory/state:interviews/${feature}/transcript.jsonl`) + "\n")[0]!;
    expect(started).toMatchObject({ type: "feature_started", issue: { repo: "example-org/acme-web", number: 7 } });
  });
});

describe("feature.start is all or nothing", () => {
  it("a secrets scan that doesn't finish leaves no branch and no feature, and the retry takes the same id", async () => {
    const w = makeWorld();
    let failing = true;
    const scanner = { scan: async () => { if (failing) throw new ScanError("The secrets scan didn't finish."); return { clean: true as const }; } };
    const e = await start(w, { scanner });
    engines.push(e);
    const c = await RpcClient.connect(engineJson(w).path);
    clients.push(c);

    expect((await c.call("feature.start", { request: "Deploy main" })).error).toBeTruthy();
    expect(git(w.config, "branch", "--list", "feature/*")).toBe("");
    expect((await c.ok("engine.status")).features).toEqual([]);

    failing = false;
    expect((await c.ok("feature.start", { request: "Deploy main" })).feature).toBe("F-001");
  });
});
