// feature.start and interview.list (AC-5, FR-5), feature ids unique across
// projects and per-project session state (SR-16, OQ-10).
import { afterEach, describe, expect, it } from "vitest";
import { drive } from "./support/clock";
import { expectRpcError } from "./support/flows";
import { ERR } from "./support/rpc";
import { git, tryGit, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

function featureBranch(repo: string, feature: string): string | undefined {
  const refs = tryGit(repo, "for-each-ref", "--format=%(refname:short) %(objectname)", `refs/heads/feature/${feature}-*`);
  return refs?.trim().split("\n").filter(Boolean)[0];
}

describe("AC-5 / FR-5: feature.start", () => {
  it("[FS-1] AC-5: feature.start gives a feature id, a feature/F-nnn-name branch from main exists, and interview.list shows the feature", async () => {
    w = await World.create();
    await w.boot();
    const p = w.project();
    const f = await w.startFeature("Let people export their data as CSV");
    expect(f).toMatch(/^F-\d{3,}$/);
    const local = featureBranch(p.clone, f);
    const remote = featureBranch(p.bare, f);
    const found = local ?? remote;
    expect(found, "feature branch in the clone or on the remote").toBeDefined();
    const [name, sha] = found!.split(" ");
    expect(name).toMatch(new RegExp(`^feature/${f}-[a-z0-9][a-z0-9-]*$`));
    expect(sha).toBe(git(local ? p.clone : p.bare, "rev-parse", "refs/heads/main").trim());
    const list = await w.ok("interview.list");
    const entry = list.features.find((x: any) => x.id === f);
    expect(entry).toBeDefined();
    expect(typeof entry.title).toBe("string");
    expect(entry).toMatchObject({ open: 0, deferred: 0, pending_assumptions: 0 });
  });

  it("[FS-2] FR-5: two feature.start calls give two different ids and branches", async () => {
    w = await World.create();
    await w.boot();
    const a = await w.startFeature("First");
    const b = await w.startFeature("Second");
    expect(a).not.toBe(b);
    expect(featureBranch(w.project().clone, b) ?? featureBranch(w.project().bare, b)).toBeDefined();
  });

  it.each([
    ["missing request", {}],
    ["non-string request", { request: 42 }],
    ["empty request", { request: "" }],
  ])("[FS-3] FR-5: feature.start with %s is -32602 and creates nothing", async (_n, params) => {
    w = await World.create();
    await w.boot();
    const before = git(w.project().clone, "for-each-ref", "refs/heads/feature/");
    expectRpcError(await w.rpc("feature.start", params), ERR.invalidParams);
    expect(git(w.project().clone, "for-each-ref", "refs/heads/feature/")).toBe(before);
  });

  it("[FS-4] channel v1.1: interview.open and interview.state on an unknown or malformed feature are -32003 / -32602", async () => {
    w = await World.create();
    await w.boot();
    expectRpcError(await w.rpc("interview.open", { feature: "F-999" }), ERR.unknown);
    const bad = await w.rpc("interview.open", { feature: "../../etc/passwd" });
    expect([ERR.unknown, ERR.invalidParams]).toContain(bad.error?.code);
    const long = await w.rpc("interview.state", { feature: "F-" + "1".repeat(70), item: "x" });
    expect([ERR.unknown, ERR.invalidParams]).toContain(long.error?.code);
  });
});

describe("SR-16 / OQ-10: one engine, several projects", () => {
  it("[FS-5] SR-16: a new feature id is unique across all projects, including ids already used in another project", async () => {
    w = await World.create([
      { name: "a", existingFeatures: ["F-003"] },
      { name: "b", existingFeatures: ["F-012"] },
    ]);
    await w.boot();
    const ids = [await w.startFeature("One"), await w.startFeature("Two")];
    for (const id of ids) {
      expect(["F-003", "F-012"]).not.toContain(id);
      expect(parseInt(id.slice(2), 10)).toBeGreaterThan(12);
    }
    expect(new Set(ids).size).toBe(2);
  });

  it("[FS-6] SR-16: the device sign-in uses the feature's own project's client id and owner; the other project's owner can't approve it", async () => {
    w = await World.create([{ name: "a" }, { name: "b" }]);
    await w.boot();
    const f = await w.startFeature();
    const mine = w.projectOf(f)!;
    expect(mine).toBeDefined();
    const other = w.projects.find((p) => p !== mine)!;
    const open = await w.ok("interview.open", { feature: f });
    expect(w.gh.device(open.approval.user_code).clientId).toBe(mine.clientId);
    w.gh.approve(open.approval.user_code, other.ownerId);
    const r = await drive(w.clock, w.rpc("interview.awaitApproval", { session: open.session, wait_s: 900 }, 120_000));
    expectRpcError(r, ERR.approvalFailed);
    // The right owner, on a new session, is accepted.
    const s = await w.approvedSession(f, mine.ownerId);
    expect(s).toMatch(/^[0-9a-f]{32}$/i);
  });
});
