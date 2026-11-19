import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProject } from "../src/config/confirm";
import { readProjectFile, readProjectFiles } from "../src/config/project-files";
import type { EngineHandle, EngineOptions } from "../src/engine";
import { realOsApi } from "../src/os/ffi";
import { liveness, type MachineSpec } from "../src/machine/machine";
import { PROJECT_MACHINE } from "../src/project-life";
import { grantWrite } from "./acceptance/support/platform";
import { ORG_ID, OWNER_ID, RpcClient, type World, addProjectFile, driveClock, engineJson, git, initRepo, makeWorld, manifestYaml, start } from "./helpers";

let engines: EngineHandle[] = [];
const clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const e of engines) await e.stop().catch(() => undefined);
  engines = [];
});

async function boot(w: World, extra: Partial<EngineOptions> = {}): Promise<EngineHandle> {
  const e = await start(w, extra);
  engines.push(e);
  return e;
}

/** Advances the fake clock past each 5-second check until `cond` holds; the checks themselves run git in real time. */
async function until(w: World, cond: () => boolean, realMs = 20_000): Promise<void> {
  const end = Date.now() + realMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    if (w.clock.sleeping > 0) await w.clock.advance(5000);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A second config repo, beta, whose code repo the fake GitHub knows. */
function beta(w: World, o: { pinned?: boolean; token?: boolean } = {}): string {
  const dir = path.join(w.root, "beta-config");
  const m = manifestYaml({ name: "beta" }).replaceAll("acme-web", "beta-web");
  initRepo(dir, { "factory-project.yaml": m }, "https://github.com/example-org/beta-config");
  if (o.pinned !== false) w.pin(dir, m);
  if (o.token !== false) void w.credentials.set("factory-token/beta", "github_pat_placeholder_beta");
  w.github.repos.set("example-org/beta-web", { status: 200, ownerId: ORG_ID, private: true });
  return dir;
}

const statusOf = (e: EngineHandle, name: string) => e.projects.find((p) => p.name === name);

describe("F-023 FR-2, SR-1: project files", () => {
  it("AC-11: a file failing its schema, a link, a path that isn't a Git work tree, a name the manifest doesn't use, or another origin is refused with the reason; the others run", async () => {
    const w = makeWorld();
    const dir = path.join(w.master, "projects");
    fs.writeFileSync(path.join(dir, "extra.yaml"), "schema: project-file/1.0\nname: extra\nconfig_repo:\n  url: https://github.com/example-org/x\n  path: /tmp/x\nsurprise: 1\n", { mode: 0o600 });
    const notGit = path.join(w.root, "plain");
    fs.mkdirSync(notGit);
    addProjectFile(w.master, "plain", notGit);
    const other = beta(w);
    addProjectFile(w.master, "gamma", other);
    const wrongUrl = path.join(w.root, "delta-config");
    initRepo(wrongUrl, { "factory-project.yaml": manifestYaml({ name: "delta" }) }, "https://github.com/example-org/delta-config");
    addProjectFile(w.master, "delta", wrongUrl, "https://github.com/example-org/somewhere-else");
    for (const n of ["plain", "gamma", "delta"]) await w.credentials.set(`factory-token/${n}`, "github_pat_placeholder");
    if (process.platform !== "win32") fs.symlinkSync(path.join(dir, "acme.yaml"), path.join(dir, "linked.yaml"));
    const e = await boot(w);
    expect(statusOf(e, "acme")!.state).toBe("running");
    const reason = (file: string) => e.projects.find((p) => p.path.endsWith(file) || p.name === file.replace(".yaml", ""))?.reason;
    expect(reason("extra.yaml")).toBe("projects/extra.yaml: (top level) is invalid (unknown key 'surprise')");
    expect(reason("plain.yaml")).toMatch(/not a Git work tree/);
    expect(reason("gamma.yaml")).toBe("the project file names the project gamma, but the manifest on main names it beta");
    expect(reason("delta.yaml")).toMatch(/config_repo\.url is https:\/\/github\.com\/example-org\/somewhere-else, but the clone's origin is/);
    // A link is refused before it is read, so it doesn't make acme a duplicate.
    if (process.platform !== "win32") expect(reason("linked.yaml")).toBe("projects/linked.yaml is a symbolic link.");
  });

  it("AC-11: an owner-writable-only check on each file (SR-1)", () => {
    const w = makeWorld();
    const file = path.join(w.master, "projects", "acme.yaml");
    expect(readProjectFile(w.master, "acme.yaml", realOsApi()).project).toMatchObject({ name: "acme", path: w.config });
    if (process.platform === "win32") grantWrite(file, ["S-1-1-0"]);
    else fs.chmodSync(file, 0o602);
    expect(readProjectFile(w.master, "acme.yaml", realOsApi()).error).toMatch(/writable/);
  });

  it("two files naming the same config repo are both refused until one is removed", () => {
    const w = makeWorld();
    addProjectFile(w.master, "acme2", w.config);
    const entries = readProjectFiles(w.master, realOsApi());
    expect(entries.map((e) => e.error)).toEqual([
      "projects/acme.yaml and projects/acme2.yaml name the same config repo; remove one.",
      "projects/acme2.yaml and projects/acme.yaml name the same config repo; remove one.",
    ]);
  });
});

describe("F-023 FR-3: one-time import", () => {
  it("AC-8: the old paths file's projects get a file each, owner-only; a second start doesn't import again", async () => {
    const w = makeWorld();
    const other = beta(w);
    fs.rmSync(path.join(w.master, "projects"), { recursive: true });
    const legacy = path.join(w.master, "factory-projects.local.yaml");
    fs.writeFileSync(legacy, `projects:\n  - path: ${JSON.stringify(w.config)}\n  - path: ${JSON.stringify(other)}\n`, { mode: 0o600 });
    const e = await boot(w);
    expect(e.projects.map((p) => [p.name, p.state])).toEqual([["acme", "running"], ["beta", "running"]]);
    expect(fs.readFileSync(path.join(w.master, "projects", "beta.yaml"), "utf8")).toBe(
      `schema: project-file/1.0\nname: beta\nconfig_repo:\n  url: https://github.com/example-org/beta-config\n  path: ${other}\n`,
    );
    if (process.platform !== "win32") expect(fs.statSync(path.join(w.master, "projects", "acme.yaml")).mode & 0o777).toBe(0o600);
    expect(w.log.lines.some((l) => String(l.message).includes("it is no longer read (F-023 FR-3)"))).toBe(true);
    await e.stop();
    engines = [];
    fs.writeFileSync(legacy, `projects:\n  - path: ${JSON.stringify(w.config)}\n`);
    fs.rmSync(path.join(w.master, "projects", "beta.yaml"));
    const again = await boot(w);
    expect(again.projects.map((p) => p.name)).toEqual(["acme"]);
  });

  it("the old paths file still gets its checks before anything is imported (SR-13)", async () => {
    const w = makeWorld();
    fs.rmSync(path.join(w.master, "projects"), { recursive: true });
    const legacy = path.join(w.master, "factory-projects.local.yaml");
    fs.writeFileSync(legacy, `projects:\n  - path: ${JSON.stringify(w.config)}\n`, { mode: 0o600 });
    if (process.platform === "win32") grantWrite(legacy, ["S-1-5-32-545"]);
    else fs.chmodSync(legacy, 0o620);
    await expect(start(w)).rejects.toThrow(/writable/);
    expect(fs.existsSync(path.join(w.master, "projects"))).toBe(false);
  });

  it("a project whose manifest fails its checks is still imported, so the engine reports the manifest as before", async () => {
    const w = makeWorld({ manifest: "schema: factory-project/1.0\nname: acme\n", pinned: false });
    fs.rmSync(path.join(w.master, "projects"), { recursive: true });
    fs.writeFileSync(path.join(w.master, "factory-projects.local.yaml"), `projects:\n  - path: ${JSON.stringify(w.config)}\n`, { mode: 0o600 });
    const e = await boot(w);
    expect(e.projects[0]).toMatchObject({ name: "acme", state: "stopped" });
    expect(fs.existsSync(path.join(w.master, "projects", "acme.yaml"))).toBe(true);
  });
});

describe("F-023 FR-4: live pick-up", () => {
  it("AC-2: a new project file starts that project within 10 seconds, and the running project's channel isn't interrupted", async () => {
    const w = makeWorld();
    const e = await boot(w, { projectPollMs: 5000 });
    const c = await RpcClient.connect(engineJson(w).path);
    clients.push(c);
    const other = beta(w);
    addProjectFile(w.master, "beta", other);
    await until(w, () => statusOf(e, "beta")?.state === "running");
    expect(fs.existsSync(path.join(other, ".factory", "engine.json"))).toBe(true);
    expect(await c.ok("engine.status")).toMatchObject({ features: [] });
    expect(statusOf(e, "acme")!.state).toBe("running");
  });

  it("a removed file stops only that project: its channel closes and engine.json goes", async () => {
    const w = makeWorld();
    const other = beta(w);
    addProjectFile(w.master, "beta", other);
    const seen: string[] = [];
    const e = await boot(w, { projectPollMs: 5000, onProject: (p) => seen.push(`${p.name}: ${p.state}`) });
    const c = await RpcClient.connect(engineJson(w).path);
    clients.push(c);
    fs.rmSync(path.join(w.master, "projects", "beta.yaml"));
    await until(w, () => !statusOf(e, "beta"));
    expect(fs.existsSync(path.join(other, ".factory", "engine.json"))).toBe(false);
    expect(seen).toContain("beta: stopped");
    expect(await c.ok("engine.status")).toMatchObject({ features: [] });
  });

  it("a changed file is checked again: a fixed manifest name lets the project run", async () => {
    const w = makeWorld();
    const other = beta(w);
    addProjectFile(w.master, "gamma", other);
    await w.credentials.set("factory-token/gamma", "github_pat_placeholder");
    const e = await boot(w, { projectPollMs: 5000 });
    expect(statusOf(e, "gamma")!.state).toBe("stopped");
    fs.rmSync(path.join(w.master, "projects", "gamma.yaml"));
    addProjectFile(w.master, "beta", other);
    await until(w, () => statusOf(e, "beta")?.state === "running");
    expect(statusOf(e, "gamma")).toBeUndefined();
  });
});

describe("F-023 FR-5: setup steps", () => {
  it("AC-3: without a token the project needs setup with the secret command and nothing is written for it; once stored, the confirm step shows", async () => {
    const w = makeWorld();
    const other = beta(w, { token: false, pinned: false });
    addProjectFile(w.master, "beta", other);
    const lines: string[] = [];
    const e = await boot(w, { projectPollMs: 5000, onProject: (p) => lines.push(`${p.name}: ${p.state} ${p.setup?.command ?? ""}`) });
    expect(statusOf(e, "beta")).toMatchObject({ state: "needs_setup", setup: { step: "token", command: "factory-engine secret set factory-token/beta" } });
    expect(fs.existsSync(path.join(other, ".factory"))).toBe(false);
    expect(git(other, "branch", "--list", "factory/state")).toBe("");
    await w.credentials.set("factory-token/beta", "github_pat_placeholder_beta");
    await until(w, () => statusOf(e, "beta")?.setup?.step === "confirm");
    expect(statusOf(e, "beta")!.setup!.command).toBe("factory-engine confirm --project beta");
    expect(lines).toContain("beta: needs_setup factory-engine confirm --project beta");
  });

  it("a project file naming a folder not cloned yet shows the clone step, then moves on once it is cloned", async () => {
    const w = makeWorld();
    const src = beta(w);
    const dir = path.join(w.root, "later", "beta-config");
    addProjectFile(w.master, "beta", dir);
    const e = await boot(w, { projectPollMs: 5000 });
    expect(statusOf(e, "beta")!.setup).toEqual({ step: "clone", command: `git clone https://github.com/example-org/beta-config ${dir}` });
    git(w.root, "clone", "-q", src, dir);
    git(dir, "remote", "set-url", "origin", "https://github.com/example-org/beta-config");
    await until(w, () => !!statusOf(e, "beta") && statusOf(e, "beta")!.setup?.step !== "clone");
    // The pin was for the first clone's path; this clone is a new path to confirm (SR-2).
    expect(statusOf(e, "beta")!.setup!.step).toBe("confirm");
  });

  it("confirm by name: the owner confirms beta while the engine runs, and it starts without a restart", async () => {
    const w = makeWorld();
    const other = beta(w, { pinned: false });
    addProjectFile(w.master, "beta", other);
    const e = await boot(w, { projectPollMs: 5000 });
    expect(statusOf(e, "beta")!.setup!.step).toBe("confirm");
    w.github.approver = OWNER_ID;
    expect(await driveClock(w, e.confirmProject("beta", { say: () => undefined, ask: async () => "beta" }), 5000)).toBe(true);
    w.github.approver = null;
    await until(w, () => statusOf(e, "beta")?.state === "running");
  });

  it("findProject takes a project name or a config repo path named by a project file", () => {
    const w = makeWorld();
    expect(findProject(w.master, "acme", realOsApi())).toBe(w.config);
    expect(findProject(w.master, w.config, realOsApi())).toBe(w.config);
    expect(() => findProject(w.master, "nobody", realOsApi())).toThrow(/No project file in projects\/ is named nobody/);
  });
});

describe("F-023 AC-13: the project's life is a machine", () => {
  it("has no dead end (F-019)", () => {
    expect(liveness(PROJECT_MACHINE as unknown as MachineSpec<string, string, string>)).toEqual([]);
  });
});
