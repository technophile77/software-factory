// F-023 FR-7: a lease on factory/state so only one factory writes to a project.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineHandle, EngineOptions } from "../src/engine";
import { LEASE_PATH, LEASE_RENEW_MS, LEASE_STALE_MS, leaseText } from "../src/state/lease";
import { GitHttp } from "./git-http";
import { RpcClient, type World, driveClock, engineJson, git, start } from "./helpers";
import { forge, remoteWorld } from "./remote-world";

let engines: EngineHandle[] = [];
let servers: GitHttp[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => undefined);
  for (const s of servers) await s.close();
  engines = [];
  servers = [];
});

const OTHER = "f".repeat(32);

async function world() {
  const r = await remoteWorld();
  servers.push(r.srv);
  return r;
}

async function boot(w: World, extra: Partial<EngineOptions> = {}): Promise<EngineHandle> {
  const e = await start(w, { push: true, ...extra });
  engines.push(e);
  return e;
}

const myId = (w: World) => fs.readFileSync(path.join(w.home, "factory-id"), "utf8").trim();
const remoteLease = (bare: string) => JSON.parse(git(bare, "show", `factory/state:${LEASE_PATH}`)) as { factory: string; started: string; renewed: string };
const statusOf = (e: EngineHandle) => e.projects.find((p) => p.name === "acme");

/** Advances the fake clock in `stepMs` steps until `cond` holds; the engine's checks run git in real time. */
async function until(w: World, cond: () => boolean, stepMs = 5000, realMs = 30_000): Promise<void> {
  const end = Date.now() + realMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    if (w.clock.sleeping > 0) await w.clock.advance(stepMs);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Runs acme once so factory/state exists on the remote, then hands the lease to another factory, renewed now. */
async function servedElsewhere(w: World, bare: string): Promise<string> {
  const e = await boot(w);
  await e.stop();
  engines = [];
  const now = new Date(w.clock.now()).toISOString();
  return forge(w, bare, { [LEASE_PATH]: leaseText(OTHER, now, now) });
}

describe("F-023 FR-7: the lease", () => {
  it("FR-7 (a), (b): a running project holds a lease naming this factory on the remote", { timeout: 60_000 }, async () => {
    const { w, bare } = await world();
    const e = await boot(w);
    expect(statusOf(e)?.state).toBe("running");
    const l = remoteLease(bare);
    expect(l.factory).toBe(myId(w));
    expect(l.factory).toMatch(/^[0-9a-f]{32}$/);
    // SR-3: nothing about the PC, user or paths.
    expect(JSON.stringify(l)).not.toContain(w.root);
  });

  it("AC-5: another factory's fresh lease refuses the project; the owner's confirm takes it over and the lease names this factory", { timeout: 90_000 }, async () => {
    const { w, srv, bare } = await world();
    const theirs = await servedElsewhere(w, bare);
    const pushes = srv.pushes.length;
    const e = await boot(w, { projectPollMs: 5000 });
    expect(statusOf(e)?.state).toBe("stopped");
    expect(statusOf(e)?.reason).toContain("served by another factory");
    expect(srv.pushes.length).toBe(pushes);
    expect(git(bare, "rev-parse", "factory/state")).toBe(theirs);

    const said: string[] = [];
    const ok = await driveClock(w, e.confirmProject("acme", { say: (l) => said.push(l), ask: async () => "acme" }), 5000);
    expect(ok).toBe(true);
    expect(said.join("\n")).toContain(`another factory (${OTHER.slice(0, 8)})`);

    await until(w, () => statusOf(e)?.state === "running");
    expect(remoteLease(bare).factory).toBe(myId(w));
    // The other factory's commits are kept: the takeover builds on them.
    expect(git(bare, "merge-base", "--is-ancestor", theirs, "factory/state")).toBe("");
  });

  it("FR-7 (f): a lease unchanged for 30 minutes by this factory's clock is stale and taken, whatever time it says", { timeout: 90_000 }, async () => {
    const { w, bare } = await world();
    await servedElsewhere(w, bare);
    const e = await boot(w, { projectPollMs: 5000 });
    expect(statusOf(e)?.state).toBe("stopped");
    const t0 = w.clock.now();
    await until(w, () => statusOf(e)?.state === "running", LEASE_RENEW_MS / 10);
    expect(w.clock.now() - t0).toBeGreaterThanOrEqual(LEASE_STALE_MS);
    expect(remoteLease(bare).factory).toBe(myId(w));
  });

  it("AC-5b: of two factories racing to take the lease, the one whose push lands first wins; the other stops the project", { timeout: 60_000 }, async () => {
    const { w, srv, bare } = await world();
    const first = await boot(w);
    await first.stop();
    engines = [];
    const before = git(w.config, "rev-parse", "factory/state");
    // The other factory's take lands between this one's fetch and its push.
    let theirs = "";
    srv.beforePush = () => {
      const now = new Date(w.clock.now()).toISOString();
      theirs = forge(w, bare, { [LEASE_PATH]: leaseText(OTHER, now, now) });
    };
    const e = await boot(w);
    expect(theirs).not.toBe("");
    expect(statusOf(e)?.state).toBe("stopped");
    expect(statusOf(e)?.reason).toContain("took the lease first");
    expect(git(bare, "rev-parse", "factory/state")).toBe(theirs);
    expect(remoteLease(bare).factory).toBe(OTHER);
    // The losing take is undone locally, so nothing of it is pushed later.
    expect(git(w.config, "rev-parse", "factory/state")).toBe(before);
  });

  it("AC-5c: a factory whose lease was taken over stops the project at its next push and writes nothing more", { timeout: 60_000 }, async () => {
    const { w, srv, bare } = await world();
    const e = await boot(w);
    expect(statusOf(e)?.state).toBe("running");
    const now = new Date(w.clock.now()).toISOString();
    const theirs = forge(w, bare, { [LEASE_PATH]: leaseText(OTHER, now, now) });

    const c = await RpcClient.connect(engineJson(w).path);
    // The push of the new feature is refused; the channel closes under the request as the project stops.
    void c.call("feature.start", { request: "Export" }).catch(() => undefined);
    await until(w, () => statusOf(e)?.state === "stopped");
    c.close();
    expect(statusOf(e)?.reason).toContain("served by another factory");
    expect(git(bare, "rev-parse", "factory/state")).toBe(theirs);
    const pushes = srv.pushes.length;
    await w.clock.advance(LEASE_RENEW_MS);
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.pushes.length).toBe(pushes);
    expect(git(bare, "rev-parse", "factory/state")).toBe(theirs);
  });
});
