import { execFileSync } from "node:child_process";
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
import { realPath } from "../src/fsutil";
import { grantWrite } from "./acceptance/support/platform";
import { policyDoc } from "./policy-fixture";
import YAML from "yaml";
import {
  GIT_ENV, GIT_PATH, MASTER_FILES, OWNER_ID, ORG_ID, OTHER_ID, driveClock, RpcClient, World, engineJson, git, initRepo, makeWorld, manifestYaml, start,
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
    const ej = engineJson(w);
    expect(ej).toEqual({ version: SERVED_CHANNEL_VERSION, path: e.projects[0]!.channel, pid: process.pid });
    expect(SERVED_CHANNEL_VERSION).toBe("1.2");
    // POSIX modes only: on Windows the pipe's ACL is read back by the engine itself (SR-15, units: SDDL).
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(ej.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(w.config, ".factory")).mode & 0o077).toBe(0);
    }
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
    // git prints forward slashes on Windows too.
    expect(list).toContain(`worktree ${path.join(w.config, ".factory").replaceAll("\\", "/")}`);
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
        git: new Git({ gitPath: GIT_PATH, homeDir: path.join(w.root, "githome"), children: new Children() }),
        clock: w.clock, log: w.log, io: { say: (l) => void said.push(l), ask: async () => typed },
      });
      return driveClock(w, run, 5000);
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
    expect(new PinStore(w.home).get(realPath(w.config))!.owner.github_id).toBe(OTHER_ID);
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
    const file = path.join(w.master, "factory-projects.local.yaml");
    if (process.platform === "win32") {
      grantWrite(file, ["S-1-5-32-545"]);
      await expect(start(w)).rejects.toThrow(/writable by nobody else/);
    } else {
      fs.chmodSync(file, 0o620);
      await expect(start(w)).rejects.toThrow(/group- or world-writable/);
    }
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
    const ok = await driveClock(w, e.confirmProject(w.config, { say: () => undefined, ask: async () => "acme" }), 5000);
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

describe("limits (H-0087, Project manifest v1.4)", () => {
  const lowered = "limits:\n  analyst:\n    turns: 100\n    cpus: 1.5\n  worktree_commit:\n    max_file_mib: 0.5\n";

  it("a project's lower values replace the defaults key by key; the rest stay", async () => {
    const w = makeWorld({ manifest: manifestYaml({ extra: lowered }) });
    const e = await boot(w);
    expect(e.projects[0]!.state).toBe("running");
    const l = e.limits("acme");
    expect(l.analyst).toMatchObject({ turns: 100, cpus: 1.5, output_tokens: 500000, memory_mib: 2048 });
    expect(l.worktree_commit).toEqual({ max_files: 200, max_total_mib: 5, max_file_mib: 0.5 });
    expect(l.web_reader.turns).toBe(30);
    expect(securityItems(w)).toHaveLength(0);
  });

  it("a value above the default stops the project and files one Security item", async () => {
    const w = makeWorld({ manifest: manifestYaml({ extra: "limits:\n  analyst:\n    turns: 301\n  proxy:\n    pids: 64\n" }) });
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ state: "stopped", reason: expect.stringContaining("analyst.turns") });
    expect(e.projects[0]!.reason).not.toContain("proxy.pids");
    expect(securityItems(w)).toHaveLength(1);
    const item = git(w.config, "show", `factory/state:${securityItems(w)[0]}`);
    expect(item).toContain("category: Security");
    expect(item).toContain("analyst.turns");
    expect(() => e.limits("acme")).toThrow(/No running project/);
  });

  it("an invalid block stops the project with a Security item", async () => {
    const w = makeWorld({ manifest: manifestYaml({ extra: "limits:\n  analyst:\n    turns: many\n" }) });
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ state: "stopped", reason: expect.stringContaining("analyst.turns") });
    expect(securityItems(w)).toHaveLength(1);
  });
});

describe("factory.version sources (spec v30)", () => {
  const version = (v: string, extra = "") => manifestYaml({ extra }).replace("version: v0.1.0", `version: ${v}`);
  function commitMaster(w: World, files: Record<string, string | null>, tag?: string) {
    for (const [f, c] of Object.entries(files)) {
      const full = path.join(w.master, f);
      if (c === null) fs.rmSync(full);
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, c);
      }
    }
    git(w.master, "add", "-A");
    git(w.master, "commit", "-qm", "master change");
    if (tag) git(w.master, "tag", tag);
  }

  it("limits come from the tagged commit, never a later commit or the working tree", async () => {
    const w = makeWorld();
    commitMaster(w, { "engine/config/limits.yaml": MASTER_FILES["engine/config/limits.yaml"]!.replace("turns: 300", "turns: 9000") });
    fs.writeFileSync(path.join(w.master, "engine/config/limits.yaml"), "broken: [");
    const e = await boot(w);
    expect(e.limits("acme").analyst.turns).toBe(300);
    expect(e.agentSources("acme").masterCommit).toBe(git(w.master, "rev-parse", "v0.1.0^{commit}"));
  });

  it.each([
    ["a tag that doesn't exist", (_w: World) => "v9.9.9", /not a tag/],
    ["a branch, not a tag", (w: World) => (git(w.master, "branch", "release"), "release"), /not a tag/],
    ["a name that is both a tag and a branch", (w: World) => (git(w.master, "branch", "v0.1.0"), "v0.1.0"), /ambiguous/],
    ["a tag of a tree", (w: World) => (git(w.master, "tag", "-a", "-m", "t", "treetag", "HEAD^{tree}"), "treetag"), /tag of a tree|doesn't resolve/],
    ["a lightweight tag of a tree", (w: World) => (git(w.master, "tag", "treetag", "HEAD^{tree}"), "treetag"), /tag of a tree/],
    ["a revision expression", (_w: World) => "HEAD~1", /not a tag name/],
    ["a tag with an oversized limits.yaml", (w: World) => (commitMaster(w, { "engine/config/limits.yaml": MASTER_FILES["engine/config/limits.yaml"]! + `# ${"x".repeat(70_000)}\n` }, "v0.2.0"), "v0.2.0"), /over 64 KiB/],
    ["a tag without limits.yaml", (w: World) => (commitMaster(w, { "engine/config/limits.yaml": null }, "v0.2.0"), "v0.2.0"), /missing/],
    ["a tag without models.yaml", (w: World) => (commitMaster(w, { "engine/config/models.yaml": null }, "v0.2.0"), "v0.2.0"), /models.yaml is missing/],
    ["a models.yaml naming an unknown role", (w: World) => (commitMaster(w, { "engine/config/models.yaml": MASTER_FILES["engine/config/models.yaml"] + "orchestrator: m\n" }, "v0.2.0"), "v0.2.0"), /not a role the engine runs/],
    ["a models.yaml missing a role", (w: World) => (commitMaster(w, { "engine/config/models.yaml": "requirements-analyst: m\n" }, "v0.2.0"), "v0.2.0"), /'web-reader' needs a model id/],
    ["a models.yaml with an empty model id", (w: World) => (commitMaster(w, { "engine/config/models.yaml": "requirements-analyst: ''\nweb-reader: m\n" }, "v0.2.0"), "v0.2.0"), /'requirements-analyst' needs a model id/],
    ["a models.yaml with a non-string model id", (w: World) => (commitMaster(w, { "engine/config/models.yaml": "requirements-analyst: [a]\nweb-reader: m\n" }, "v0.2.0"), "v0.2.0"), /needs a model id/],
    ["a tag with invalid limits.yaml", (w: World) => (commitMaster(w, { "engine/config/limits.yaml": MASTER_FILES["engine/config/limits.yaml"]!.replace("pids: 64", "pids: 0") }, "v0.2.0"), "v0.2.0"), /proxy.pids/],
  ])("fails closed on %s, with a Security item", async (_name, make, re) => {
    const w0 = makeWorld();
    const v = make(w0);
    fs.writeFileSync(path.join(w0.config, "factory-project.yaml"), version(v));
    git(w0.config, "commit", "-q", "--allow-empty", "-am", "version");
    const e = await boot(w0);
    expect(e.projects[0]).toMatchObject({ state: "stopped", reason: expect.stringMatching(re) });
    expect(securityItems(w0)).toHaveLength(1);
  });

  it("spec v32: the models come from engine/config/models.yaml at the factory.version commit", async () => {
    const w = makeWorld();
    commitMaster(w, { "engine/config/models.yaml": "requirements-analyst: newer\nweb-reader: newer\n" });
    const e = await boot(w);
    expect(e.models("acme")).toEqual({ "requirements-analyst": "claude-opus-5-5", "web-reader": "claude-haiku-5-5", "security-reviewer": "claude-sonnet-5-5" });
  });

  it("follows an annotated tag of an annotated tag to its commit", async () => {
    const w = makeWorld();
    git(w.master, "tag", "-a", "-m", "a", "inner", "v0.1.0^{commit}");
    git(w.master, "tag", "-a", "-m", "b", "outer", "inner");
    fs.writeFileSync(path.join(w.config, "factory-project.yaml"), version("outer"));
    git(w.config, "commit", "-q", "--allow-empty", "-am", "version");
    const e = await boot(w);
    expect(e.agentSources("acme").masterCommit).toBe(git(w.master, "rev-parse", "v0.1.0^{commit}"));
  });

  const policy = YAML.stringify({ policy: policyDoc().policy });

  it("master AGENT.md and skills by default, for every role", async () => {
    const w = makeWorld({ manifest: manifestYaml({ extra: policy }) });
    const e = await boot(w);
    expect(e.instructions("acme", "requirements-analyst")).toEqual({ text: "# Requirements analyst (master)\n", from: "master", path: "agents/requirements-analyst/AGENT.md" });
    // A role with no AGENT.md anywhere may not run.
    expect(() => e.instructions("acme", "orchestrator")).toThrow(/no AGENT.md/);
    const s = e.agentSources("acme").skills.get("requirements-analyst")!;
    expect(s.map((x) => [x.name, x.from, [...x.files.keys()].sort()])).toEqual([
      ["security-review", "master", ["SKILL.md", "checklist.md"]],
      ["style", "master", ["SKILL.md"]],
    ]);
  });

  const blocks = (b: string) => manifestYaml({ extra: `${policy}${b}` });
  const own = {
    "overrides/analyst/AGENT.md": "# Analyst (project)\n",
    "overrides/style/SKILL.md": "---\nname: style\ndescription: project\n---\nOurs.\n",
    "custom/pci/SKILL.md": "---\nname: pci\ndescription: project\n---\nPCI.\n",
  };
  const ownBlocks = [
    "agents:",
    "  override:",
    "    - { name: requirements-analyst, path: overrides/analyst/AGENT.md, reason: ours, decision: D-0042 }",
    "skills:",
    "  override:",
    "    - { name: style, path: overrides/style/SKILL.md, reason: ours }",
    "  custom:",
    "    - { name: pci, path: custom/pci/SKILL.md, agents: [requirements-analyst] }",
    "",
  ].join("\n");

  it("a project's overrides and custom skills, from its config repo's main, win over the master", async () => {
    const w = makeWorld({ manifest: blocks(ownBlocks), configFiles: own });
    // A newer master and an unmerged edit in the config repo change nothing.
    commitMaster(w, { "agents/requirements-analyst/AGENT.md": "# newer master\n", "skills/style/SKILL.md": "newer\n" }, "v0.1.1");
    fs.writeFileSync(path.join(w.config, "overrides/analyst/AGENT.md"), "# unmerged\n");
    const e = await boot(w);
    expect(e.projects[0]!.state).toBe("running");
    expect(e.instructions("acme", "requirements-analyst")).toEqual({ text: "# Analyst (project)\n", from: "project", path: "overrides/analyst/AGENT.md" });
    expect(e.instructions("acme", "web-reader").from).toBe("master");
    const names = (role: string) => e.agentSources("acme").skills.get(role)!.map((x) => `${x.name}:${x.from}`);
    expect(names("requirements-analyst")).toEqual(["pci:project", "security-review:master", "style:project"]);
    expect(names("web-reader")).toEqual(["security-review:master", "style:project"]);
    expect(e.agentSources("acme").skills.get("requirements-analyst")!.find((x) => x.name === "style")!.files.get("SKILL.md")!.content.toString()).toContain("Ours.");
  });

  it("an excluded skill is gone; a protected one can't be excluded", async () => {
    const w = makeWorld({ manifest: blocks("skills:\n  exclude:\n    - { name: style, reason: not needed }\n") });
    const e = await boot(w);
    expect(e.agentSources("acme").skills.get("requirements-analyst")!.map((x) => x.name)).toEqual(["security-review"]);
    const w2 = makeWorld({ manifest: blocks("skills:\n  exclude:\n    - { name: security-review, reason: no }\n") });
    expect((await boot(w2)).projects[0]).toMatchObject({ state: "stopped", reason: expect.stringContaining("protected") });
  });

  function symlinkInConfig(w: World, file: string, target: string) {
    const sha = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: w.config, input: target, env: GIT_ENV, encoding: "utf8" }).trim();
    git(w.config, "update-index", "--add", "--cacheinfo", `120000,${sha},${file}`);
    git(w.config, "commit", "-qm", "link");
  }

  it.each([
    ["an absolute path", "agents:\n  override:\n    - { name: requirements-analyst, path: /etc/passwd, reason: r, decision: D-0001 }\n", null, /relative path/],
    ["a path out of the repo", "agents:\n  override:\n    - { name: requirements-analyst, path: ../x/AGENT.md, reason: r, decision: D-0001 }\n", null, /relative path/],
    ["a path into .git", "skills:\n  custom:\n    - { name: pci, path: .git/SKILL.md }\n", null, /relative path/],
    ["a missing file", "skills:\n  custom:\n    - { name: pci, path: custom/none/SKILL.md }\n", null, /missing/],
    ["a symlinked AGENT.md", "agents:\n  override:\n    - { name: web-reader, path: overrides/link.md, reason: r }\n", "overrides/link.md", /symbolic link/],
    ["a symlink inside a skill", "skills:\n  custom:\n    - { name: pci, path: custom/pci/SKILL.md }\n", "custom/pci/extra.md", /symbolic link/],
    ["a skill folder that is a symlink", "skills:\n  custom:\n    - { name: pci, path: linked/SKILL.md }\n", "linked", /symbolic link/],
    ["a protected agent overridden without a decision", "agents:\n  override:\n    - { name: requirements-analyst, path: overrides/analyst/AGENT.md, reason: r }\n", null, /protected/],
    ["an override of a name the master lacks", "skills:\n  override:\n    - { name: nope, path: custom/pci/SKILL.md, reason: r }\n", null, /not a default/],
    ["a custom skill that shadows a master one", "skills:\n  custom:\n    - { name: style, path: custom/pci/SKILL.md }\n", null, /use override/],
  ])("refuses %s with a Security item", async (_name, block, link, re) => {
    const w = makeWorld({ manifest: blocks(block), configFiles: own });
    if (link) symlinkInConfig(w, link, "/etc/passwd");
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ state: "stopped", reason: expect.stringMatching(re) });
    expect(securityItems(w)).toHaveLength(1);
    expect(git(w.config, "show", `factory/state:${securityItems(w)[0]}`)).toContain("category: Security");
  });
});
