import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineHandle, StartError } from "../src/engine";
import { EngineRecord } from "../src/state/record";
import { RunBook } from "../src/state/runs";
import { SERVED_CHANNEL_VERSION } from "../src/constants";
import {
  ORG_ID, OTHER_ID, RpcClient, World, engineJson, git, initRepo, makeWorld, manifestYaml, start,
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
