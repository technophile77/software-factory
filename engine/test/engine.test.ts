import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineHandle, StartError } from "../src/engine";
import { EngineRecord } from "../src/state/record";
import { RunBook } from "../src/state/runs";
import { SERVED_CHANNEL_VERSION } from "../src/constants";
import { confirmProject } from "../src/config/confirm";
import { PinStore } from "../src/config/pins";
import { Git } from "../src/git";
import { Children } from "../src/proc";
import { realOsApi } from "../src/os/ffi";
import {
  OWNER_ID, ORG_ID, OTHER_ID, advanceSoon, RpcClient, World, engineJson, git, initRepo, makeWorld, manifestYaml, start,
} from "./helpers";

let engines: EngineHandle[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await e.stop();
  engines = [];
  clients = [];
});

async function boot(w: World, extra = {}) {
  const e = await start(w, extra);
  engines.push(e);
  return e;
}

async function connect(w: World) {
  const c = await RpcClient.connect(engineJson(w).path);
  clients.push(c);
  return c;
}

function securityItems(w: World): string[] {
  const out = git(w.config, "ls-tree", "-r", "--name-only", "factory/state", "--", "inbox/decision");
  return out ? out.split("\n") : [];
}

describe("engine start (FR-1 to FR-4)", () => {
  it("AC-1: writes engine.json 0600 with the served channel version, and engine.status answers", async () => {
    const w = makeWorld();
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ name: "acme", state: "running" });
    const file = path.join(w.config, ".factory", "engine.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const ej = engineJson(w);
    expect(ej).toEqual({ version: SERVED_CHANNEL_VERSION, path: e.projects[0]!.channel, pid: process.pid });
    expect(SERVED_CHANNEL_VERSION).toBe("1.2");
    expect(fs.statSync(ej.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(w.config, ".factory")).mode & 0o077).toBe(0);
    // engine.json is never committed on factory/state
    expect(git(w.config, "ls-tree", "-r", "--name-only", "factory/state")).not.toContain("engine.json");
    const c = await connect(w);
    const st = await c.ok("engine.status");
    expect(st).toMatchObject({ version: "1.2", features: [] });
    expect(typeof st.uptime_s).toBe("number");
  });

  it("checks out factory/state at .factory as a registered worktree", async () => {
    const w = makeWorld();
    await boot(w);
    const list = git(w.config, "worktree", "list", "--porcelain");
    expect(list).toContain(`worktree ${path.join(w.config, ".factory")}`);
    expect(list).toContain("branch refs/heads/factory/state");
  });

  it("AC-3: refuses to start with ANTHROPIC_API_KEY set for a subscription project", async () => {
    const w = makeWorld();
    await expect(start(w, { env: { ANTHROPIC_API_KEY: "sk-ant-api03-placeholder" } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("FR-3: refuses a subscription credential for a tokens-mode project, and a missing credential", async () => {
    const w = makeWorld({ manifest: manifestYaml({ mode: "tokens" }) });
    await expect(start(w)).rejects.toThrow(StartError);
    const w2 = makeWorld();
    await w2.credentials.delete("model-credential");
    await expect(start(w2)).rejects.toThrow(/model credential/);
  });

  it("AC-2: a repo owned by an account off the allow list stops that project and files a Security item; others run", async () => {
    const w = makeWorld();
    // A second, good project.
    const other = path.join(w.root, "beta-config");
    const betaManifest = manifestYaml({ name: "beta" }).replace("acme-web", "beta-web").replace("acme-web", "beta-web");
    initRepo(other, { "factory-project.yaml": betaManifest }, "https://github.com/example-org/beta-config");
    fs.writeFileSync(path.join(w.master, "factory-projects.local.yaml"), `projects:\n  - path: ${w.config}\n  - path: ${other}\n`);
    w.pin(other, betaManifest);
    await w.credentials.set("factory-token/beta", "github_pat_placeholder_beta");
    w.github.repos.set("example-org/acme-web", { status: 200, ownerId: OTHER_ID, private: true });
    w.github.repos.set("example-org/beta-web", { status: 200, ownerId: ORG_ID, private: true });
    const e = await boot(w);
    const [acme, beta] = e.projects;
    expect(acme).toMatchObject({ state: "stopped" });
    expect(acme!.reason).toMatch(/isn't on allowed_repo_owners/);
    expect(beta).toMatchObject({ state: "running" });
    expect(securityItems(w)).toHaveLength(1);
    const item = git(w.config, "show", `factory/state:${securityItems(w)[0]}`);
    expect(item).toContain("category: Security");
    expect(item).not.toContain("github_pat_");
  });

  it("FR-2: an unreachable repo and a missing factory token both stop the project", async () => {
    const w = makeWorld();
    w.github.repos.delete("example-org/acme-web");
    expect((await boot(w)).projects[0]).toMatchObject({ state: "stopped" });
    const w2 = makeWorld();
    await w2.credentials.delete("factory-token/acme");
    expect((await boot(w2)).projects[0]!.reason).toMatch(/No factory token/);
  });

  it("warns when a repo is public, since factory/state is pushed", async () => {
    const w = makeWorld();
    w.github.repos.set("example-org/acme-web", { status: 200, ownerId: ORG_ID, private: false });
    const e = await boot(w);
    expect(e.projects[0]!.warnings.join()).toMatch(/public/);
  });

  it("a disabled project doesn't run and files nothing", async () => {
    const m = manifestYaml({ enabled: false });
    const w = makeWorld({ manifest: m });
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ state: "disabled" });
    expect(securityItems(w)).toHaveLength(0);
  });

  it("an invalid manifest on main stops the project with a Security item, even if the working tree is fixed", async () => {
    const w = makeWorld({ manifest: "schema: factory-project/1.0\nname: acme\n", pinned: false });
    // SR-5: the working tree is never read.
    fs.writeFileSync(path.join(w.config, "factory-project.yaml"), manifestYaml());
    const e = await boot(w);
    expect(e.projects[0]!.state).toBe("stopped");
    expect(securityItems(w)).toHaveLength(1);
  });
});

describe("pinned keys (SR-5, AC-20)", () => {
  it("a new project path stops the project until confirmed, with one Security item across restarts", async () => {
    const w = makeWorld({ pinned: false });
    const e = await boot(w);
    expect(e.projects[0]!.state).toBe("stopped");
    expect(e.projects[0]!.reason).toMatch(/factory-engine confirm/);
    await e.stop();
    engines = [];
    await boot(w);
    expect(securityItems(w)).toHaveLength(1);
  });

  it("AC-20: a changed owner id on main stops the project", async () => {
    const w = makeWorld();
    fs.writeFileSync(path.join(w.config, "factory-project.yaml"), manifestYaml({ ownerId: OTHER_ID }));
    git(w.config, "commit", "-qam", "swap owner");
    const e = await boot(w);
    expect(e.projects[0]!.state).toBe("stopped");
    expect(e.projects[0]!.reason).toMatch(/change to owner/);
    const item = git(w.config, "show", `factory/state:${securityItems(w)[0]}`);
    expect(item).toContain("Pinned owner keys changed");
  });

  it("confirm: the owner types the name and approves as the previously pinned owner; then the project runs", async () => {
    const w = makeWorld();
    fs.writeFileSync(path.join(w.config, "factory-project.yaml"), manifestYaml({ ownerId: OTHER_ID }));
    git(w.config, "commit", "-qam", "swap owner");
    const said: string[] = [];
    let typed = "wrong";
    const confirm = () => {
      const run = confirmProject({
        masterRepo: w.master, projectPath: w.config, github: w.github, pins: new PinStore(w.home), os: realOsApi(),
        git: new Git({ gitPath: "/usr/bin/git", homeDir: path.join(w.root, "githome"), children: new Children() }),
        clock: w.clock, log: w.log, io: { say: (l) => void said.push(l), ask: async () => typed },
      });
      let done = false;
      void run.finally(() => (done = true));
      return (async () => {
        for (let i = 0; i < 20 && !done; i++) await advanceSoon(w, 5000);
        return run;
      })();
    };
    expect(await confirm()).toBe(false);
    expect(w.github.deviceCalls).toBe(0);
    expect(said.join("\n")).toMatch(/Changed keys: owner/);
    typed = "acme";
    w.github.approver = OTHER_ID;
    expect(await confirm()).toBe(false);
    expect((await boot(w)).projects[0]!.state).toBe("stopped");
    await engines.pop()!.stop();
    w.github.approver = OWNER_ID;
    expect(await confirm()).toBe(true);
    expect(new PinStore(w.home).get(fs.realpathSync(w.config))!.owner.github_id).toBe(OTHER_ID);
    expect((await boot(w)).projects[0]!.state).toBe("running");
  });

  it("an unmerged edit in the working tree changes nothing", async () => {
    const w = makeWorld();
    fs.writeFileSync(path.join(w.config, "factory-project.yaml"), manifestYaml({ ownerId: OTHER_ID }));
    const e = await boot(w);
    expect(e.projects[0]!.state).toBe("running");
  });
});

describe("SR-13 project paths", () => {
  it("refuses a group-writable paths file", async () => {
    const w = makeWorld();
    fs.chmodSync(path.join(w.master, "factory-projects.local.yaml"), 0o620);
    await expect(start(w)).rejects.toThrow(/group- or world-writable/);
  });

  it("refuses the master repo, or a clone of it, as a config repo, without writing into it", async () => {
    const w = makeWorld();
    const clone = path.join(w.root, "clone");
    git(w.root, "clone", "-q", w.master, clone);
    fs.writeFileSync(path.join(w.master, "factory-projects.local.yaml"), `projects:\n  - path: ${w.master}\n  - path: ${clone}\n`);
    const e = await boot(w);
    expect(e.projects.map((p) => p.reason)).toEqual([
      expect.stringMatching(/master repo itself/),
      expect.stringMatching(/clone of the master repo/),
    ]);
    expect(fs.existsSync(path.join(w.master, ".factory"))).toBe(false);
    expect(fs.existsSync(path.join(clone, ".factory"))).toBe(false);
  });
});

describe("FR-14 interrupted runs", () => {
  it("marks a run left running as interrupted at start, with no retry counted", async () => {
    const w = makeWorld();
    const book = new RunBook(new EngineRecord(w.home), w.clock);
    const run = book.start({ project: w.config, feature: "F-001", role: "requirements-analyst", stage: "requirements_interview" });
    const e = await boot(w);
    const after = e.runs.interrupted();
    expect(after.map((r) => r.id)).toEqual([run.id]);
    expect(after[0]!.resumes).toBe(0);
  });

  it("AC-12: after crash() a new engine in the same process finds the analyst's run interrupted, reports it and resumes it", async () => {
    const w = makeWorld();
    const e1 = await boot(w);
    const c = await connect(w);
    const feature = (await c.ok("feature.start", { request: "Export" })).feature as string;
    const tools = e1.interviewTools(feature, w.worktree);
    expect((await tools.interview_ask({ text: "Q?", why: "w" })).ok).toBe(true);
    const [run] = new EngineRecord(w.home).runs();
    expect(run).toMatchObject({ feature, role: "requirements-analyst", status: "running", worktree: w.worktree });
    const headBefore = git(w.config, "rev-parse", "factory/state");
    await e1.crash();
    // Nothing more is written once crashed, and engine.json stays, as after a kill.
    expect((await tools.interview_propose_assumption({ text: "A.", why: "w" })).ok).toBe(false);
    expect(git(w.config, "rev-parse", "factory/state")).toBe(headBefore);
    expect(fs.existsSync(path.join(w.config, ".factory", "engine.json"))).toBe(true);
    engines = engines.filter((x) => x !== e1);

    const resumed: Array<{ feature: string; worktree: string; mode: string; resumes: number }> = [];
    const e2 = await boot(w, {
      resumeAnalyst: (r: { feature: string; worktree: string; plan: { mode: string; run: { resumes: number } } }) =>
        resumed.push({ feature: r.feature, worktree: r.worktree, mode: r.plan.mode, resumes: r.plan.run.resumes }),
    });
    expect(resumed).toEqual([{ feature, worktree: w.worktree, mode: "from_commit", resumes: 1 }]);
    const report = JSON.parse(git(w.config, "show", `factory/state:runs/${feature}/requirements_interview/requirements-analyst-1.json`));
    expect(report).toMatchObject({ role: "requirements-analyst", feature, outcome: "partial" });
    expect(report.summary).toContain("interrupted");
    expect(new EngineRecord(w.home).run(run!.id)).toMatchObject({ status: "running", resumes: 1 });
    // The resumed run is the one the analyst's tools continue; the channel serves again.
    expect((await e2.interviewTools(feature, w.worktree).interview_propose_assumption({ text: "A.", why: "w" })).ok).toBe(true);
    expect(new EngineRecord(w.home).runs()).toHaveLength(1);
    const c2 = await connect(w);
    expect((await c2.ok("engine.status")).features).toEqual([{ id: feature, stage: "requirements_interview", active_agents: 0 }]);
  });

  it("an append the engine committed but didn't record before a kill is still its own", async () => {
    const w = makeWorld();
    const e1 = await boot(w);
    const c = await connect(w);
    const feature = (await c.ok("feature.start", { request: "Export" })).feature as string;
    const f = e1.feature(feature)!;
    const key = f.chainKey;
    const rec = new EngineRecord(w.home);
    const head = rec.chain(key)!;
    expect(head.pending).toBeUndefined();
    await e1.interviewTools(feature, w.worktree).interview_ask({ text: "Q?", why: "w" });
    await e1.crash();
    engines = engines.filter((x) => x !== e1);
    // Roll the record back to where a kill between commit and record would leave it.
    const now = new EngineRecord(w.home).chain(key)!;
    const back = new EngineRecord(w.home);
    back.setChain(key, { seq: head.seq, head: head.head, pending: { seq: now.seq, head: now.head } });
    const e2 = await boot(w);
    expect(e2.feature(feature)!.chainIntact).toBe(true);
    expect(new EngineRecord(w.home).chain(key)).toEqual({ seq: now.seq, head: now.head });
  });
});

describe("confirm on the handle (SR-5)", () => {
  it("confirmProject uses the engine's GitHub and clock; the project runs after a restart", async () => {
    const w = makeWorld({ pinned: false });
    const e = await boot(w);
    expect(e.projects[0]!.state).toBe("stopped");
    w.github.approver = OWNER_ID;
    let ok = false;
    const run = e.confirmProject(w.config, { say: () => undefined, ask: async () => "acme" }).then((r) => (ok = r));
    for (let i = 0; i < 10 && !ok; i++) await advanceSoon(w, 5000);
    await run;
    expect(ok).toBe(true);
    await e.stop();
    engines = [];
    expect((await boot(w)).projects[0]!.state).toBe("running");
  });
});

describe("shutdown", () => {
  it("engine.shutdown answers, then stops and removes engine.json", async () => {
    const w = makeWorld();
    const e = await boot(w);
    const c = await connect(w);
    expect(await c.ok("engine.shutdown")).toEqual({ ok: true });
    await e.stopped;
    expect(fs.existsSync(path.join(w.config, ".factory", "engine.json"))).toBe(false);
  });
});
