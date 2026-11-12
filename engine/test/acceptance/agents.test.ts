// Milestone 2 without Docker: AC-9 and AC-13 against the whole engine,
// started with an `agents` runtime whose Docker client and Agent SDK are
// fakes at their process and API boundaries (support/fake-docker.ts,
// support/agents.ts). See F-007-test-plan.md, "Milestone 2".
import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSdk, fakeRuntime, type FakeSession } from "./support/agents";
import { FakeDocker } from "./support/fake-docker";
import { git, rand, tryGit, waitFor, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

interface Rig {
  w: World;
  docker: FakeDocker;
  sdk: FakeSdk;
}

/** A world whose engine runs agents on the fake Docker and SDK. */
async function rig(): Promise<Rig> {
  w = await World.create([{}], { agentFiles: true });
  const docker = new FakeDocker(join(w.root, "bin"));
  const sdk = new FakeSdk(docker);
  const proxyScript = join(w.root, "bin", "proxy.js");
  writeFileSync(proxyScript, "// stands in for dist/proxy.js; the fake Docker plays the proxy\n");
  w.agents = await fakeRuntime(w.root, docker, sdk, proxyScript);
  await w.boot();
  return { w, docker, sdk };
}

type RunInfo = Awaited<ReturnType<NonNullable<World["engine"]>["runs"]>>[number];

async function analystRun(world: World, feature: string, done: (r: RunInfo) => boolean, what: string): Promise<RunInfo> {
  return waitFor(async () => (await world.engine!.runs()).find((r) => r.feature === feature && r.role === "requirements-analyst" && done(r)), 30_000, what);
}

function featureBranch(world: World, feature: string): string {
  const ref = git(world.project().clone, "for-each-ref", "--format=%(refname)", `refs/heads/feature/${feature}-*`).trim();
  if (!ref) throw new Error(`no branch for ${feature}`);
  return ref;
}

/** Files on a commit, by path. */
function tree(repo: string, ref: string): string[] {
  return (tryGit(repo, "ls-tree", "-r", "--name-only", ref) ?? "").split("\n").filter(Boolean);
}

function specPath(world: World, feature: string): string {
  return `/workspace/docs/features/${featureBranch(world, feature).replace(/^refs\/heads\/feature\//, "")}.md`;
}

describe("AC-13 / FR-8: no Docker, no session", () => {
  it("[AG-1] AC-13: with the Docker daemon stopped, feature.start starts no container and no session, and the owner is told why in the transcript", async () => {
    const r = await rig();
    r.docker.set({ down: true });
    const before = r.docker.calls().length;
    const feature = await r.w.startFeature();
    const run = await analystRun(r.w, feature, (x) => x.status !== "running", "the analyst run to stop waiting");
    // The engine tried Docker, and no container, network or Claude Code process came of it; the SDK was never asked for a session.
    const tried = r.docker.calls().slice(before);
    expect(tried.length).toBeGreaterThan(0);
    expect(tried.filter((c) => c.exit === 0)).toEqual([]);
    expect(r.sdk.sessions).toEqual([]);
    // A run that never started is waiting for Docker, not failed and not a retry (FR-14).
    expect(run.status).toBe("interrupted");
    expect(run.resumes).toBe(0);
    // The owner is told, in their feature's transcript, that no session started and that Docker is why.
    await r.w.settle();
    const transcript = await waitFor(() => {
      const t = r.w.transcriptText(r.w.project(), feature);
      return /analyst_session/.test(t) && t;
    }, 15_000, "an analyst_session entry in the transcript");
    expect(transcript).toMatch(/No analyst session started/i);
    expect(transcript).toMatch(/docker/i);
  });

  it("[AG-2] AC-13 (control): with the daemon running, the same feature.start starts the containers and one analyst session", async () => {
    const r = await rig();
    let started!: () => void;
    const seen = new Promise<void>((res) => (started = res));
    r.sdk.behaviours.analyst = async () => started();
    const feature = await r.w.startFeature();
    await seen;
    expect(r.sdk.of("analyst")).toHaveLength(1);
    const runs = r.docker.commands().filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]);
    expect(runs.some((n) => /proxy/.test(n!))).toBe(true);
    expect(runs.some((n) => /requirements-analyst/.test(n!))).toBe(true);
    await analystRun(r.w, feature, (x) => x.status !== "running", "the run to end");
  });

  it("[AG-3] AC-13: when Docker is back at the next engine start, the same waiting run starts its session", async () => {
    const r = await rig();
    r.docker.set({ down: true });
    const feature = await r.w.startFeature();
    const waiting = await analystRun(r.w, feature, (x) => x.status === "interrupted", "the run to wait for Docker");
    r.docker.set({ down: false });
    let started!: () => void;
    const seen = new Promise<void>((res) => (started = res));
    r.sdk.behaviours.analyst = async () => started();
    await r.w.restart();
    await seen;
    expect(r.sdk.of("analyst")).toHaveLength(1);
    const runs = (await r.w.engine!.runs()).filter((x) => x.feature === feature);
    expect(runs.map((x) => x.id)).toEqual([waiting.id]);
  });
});

/** What the analyst does in its container, then its session ends. */
async function analystWrites(r: Rig, actions: (feature: string) => Parameters<FakeSession["exec"]>[0]): Promise<{ feature: string; run: RunInfo; before: string; exec: number | null }> {
  let feature = "";
  let exec: number | null = -1;
  let go!: () => void;
  const ready = new Promise<void>((res) => (go = res));
  r.sdk.behaviours.analyst = async (s) => {
    await ready;
    exec = await s.exec(actions(feature));
  };
  feature = await r.w.startFeature();
  const before = git(r.w.project().clone, "rev-parse", featureBranch(r.w, feature)).trim();
  go();
  const run = await analystRun(r.w, feature, (x) => x.status !== "running", "the analyst run to end");
  await r.w.settle();
  return { feature, run, before, exec };
}

function breachItems(world: World, path: string) {
  return world.securityItems().filter((i) => i.text.includes(path));
}

/** Distinct Security items: the same item is seen locally and, once pushed, on the remote. */
const securityIds = (world: World) => [...new Set(world.securityItems().map((i) => i.id))].sort();

const head = (repo: string, ref: string) => tryGit(repo, "rev-parse", "--verify", "--quiet", ref)?.trim() ?? null;

describe("AC-9 / FR-9: the end-of-session write check", () => {
  it("[AG-4] AC-9 (control): a session that writes only its own spec gets it committed to the feature branch, with no Security item", async () => {
    const r = await rig();
    const items = securityIds(r.w);
    let spec = "";
    const { feature, before } = await analystWrites(r, (f) => [{ write: (spec = specPath(r.w, f)), content: "# Feature: CSV export\n\nDraft.\n" }]);
    const branch = featureBranch(r.w, feature);
    expect(head(r.w.project().clone, branch)).not.toBe(before);
    expect(tree(r.w.project().clone, branch)).toContain(spec.slice("/workspace/".length));
    expect(securityIds(r.w)).toEqual(items);
    // SR-10: the agent process ran in its container, started by docker exec, not on the host.
    expect(r.docker.commands().filter((c) => c[0] === "exec").map((c) => c.find((a) => /^factory-.*requirements-analyst/.test(a)))).toEqual([expect.any(String)]);
  });

  const outside = [
    ".github/workflows/release.yml",
    "agents/requirements-analyst/AGENT.md",
    ".claude/settings.json",
    "CLAUDE.md",
    "src/app.ts",
  ];
  it.each(outside)("[AG-5] AC-9: a session that writes %s besides its spec has nothing committed, and a Security item names the path", async (bad) => {
    const r = await rig();
    const { feature, run, before, exec } = await analystWrites(r, (f) => [
      { write: specPath(r.w, f), content: "# Feature: CSV export\n" },
      { write: `/workspace/${bad}`, content: `planted ${rand(6)}\n` },
    ]);
    expect(exec).toBe(0);
    const branch = featureBranch(r.w, feature);
    // Rejected means none of the session's changes land, the allowed spec included, locally or on the remote.
    expect(head(r.w.project().clone, branch)).toBe(before);
    expect(tree(r.w.project().clone, branch)).not.toContain(bad);
    const remote = head(r.w.project().bare, branch);
    if (remote) expect(remote).toBe(before);
    expect(run.status).toBe("failed");
    expect(breachItems(r.w, bad).length).toBeGreaterThan(0);
  });

  it("[AG-6] AC-9: a session that deletes a file outside its write rules has nothing committed, and a Security item is filed", async () => {
    const r = await rig();
    const { feature, run, before } = await analystWrites(r, () => [{ remove: "/workspace/README.md" }]);
    const branch = featureBranch(r.w, feature);
    expect(head(r.w.project().clone, branch)).toBe(before);
    expect(tree(r.w.project().clone, branch)).toContain("README.md");
    expect(run.status).toBe("failed");
    expect(breachItems(r.w, "README.md").length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("[AG-7] AC-9 / SR-12: a session that adds a symlink, even inside docs/features, has nothing committed, and a Security item is filed (skipped on Windows: needs symbolic links)", async () => {
    const r = await rig();
    let link = "";
    const { feature, run, before } = await analystWrites(r, (f) => [{ symlink: (link = specPath(r.w, f)), target: "/etc/passwd" }]);
    expect(head(r.w.project().clone, featureBranch(r.w, feature))).toBe(before);
    expect(run.status).toBe("failed");
    expect(breachItems(r.w, link.slice("/workspace/".length)).length).toBeGreaterThan(0);
  });
});
