// Engine start: config and manifest loading, projects file (H-0081, SR-13),
// authorization (FR-2), billing mode (FR-3), engine.json (FR-4).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, renameSync, symlinkSync, chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grantWrite } from "./support/platform";
import { git, mode, REPO_ROOT, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const isRoot = process.getuid?.() === 0;
// Windows has no mode bits; the engine protects its files and pipe with ACLs
// there (channel/windows.ts, config/paths-file.ts).
const isWindows = process.platform === "win32";

/** Passes when the engine refuses to start, or starts with no project running. */
async function expectNothingRuns(world: World) {
  let started = false;
  try {
    await world.boot();
    started = true;
  } catch (e) {
    if (/engine not available/.test((e as Error).message)) throw e;
    expect((e as Error).message.trim().length).toBeGreaterThan(0);
  }
  if (started) {
    for (const p of world.projects) expect(await world.isRunning(p), `${p.name} must not run`).toBe(false);
  }
}

describe("AC-1 / FR-1 / FR-4: start with a valid master config and one enabled project", () => {
  it("[ST-1] AC-1: engine.json exists with mode 0600, the reported channel version 1.2, the listener pid, and engine.status answers", async () => {
    w = await World.create();
    await w.boot();
    const p = w.project();
    expect(await w.isRunning(p)).toBe(true);
    const ej = w.engineJsonPath(p);
    expect(existsSync(ej)).toBe(true);
    if (!isWindows) expect(mode(ej)).toBe(0o600);
    const j = w.engineJson(p);
    // FR-4 (spec v22): the engine serves v1.3 but reports 1.2 until the
    // advisor increment, so the skill doesn't offer the advisor.
    expect(j.version).toBe("1.2");
    expect(j.pid).toBe(process.pid);
    if (isWindows) expect(j.path.startsWith("\\\\.\\pipe\\")).toBe(true);
    else expect(lstatSync(j.path).isSocket()).toBe(true);
    const st = await w.ok("engine.status");
    expect(st.version).toBe("1.2");
    expect(typeof st.uptime_s).toBe("number");
    expect(st.uptime_s).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(st.features)).toBe(true);
  });

  it("[ST-2] FR-1 / ADR 0009: factory/state is checked out at .factory/, which is not group- or world-writable", async () => {
    w = await World.create();
    await w.boot();
    const fdir = join(w.project().clone, ".factory");
    expect(git(fdir, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("factory/state");
    if (!isWindows) expect(mode(fdir) & 0o022).toBe(0);
  });

  it("[ST-3] FR-2: the master repo ships no owner values; the projects file is git-ignored and untracked (H-0081)", () => {
    const ignored = git(REPO_ROOT, "check-ignore", "-v", "factory-projects.local.yaml");
    expect(ignored).toMatch(/factory-projects\.local\.yaml/);
    expect(git(REPO_ROOT, "ls-files", "--", "factory-projects.local.yaml").trim()).toBe("");
  });
});

describe("AC-2 / FR-2: authorization against the allow list, per project", () => {
  it("[ST-4] AC-2: a project whose repo owner (by GitHub's answer) is not on the allow list doesn't run, a Security item is filed, the other project runs", async () => {
    w = await World.create([{ name: "bad" }, { name: "good" }]);
    await w.boot();
    const [bad, good] = [w.project(0), w.project(1)];
    expect(await w.isRunning(bad)).toBe(true);
    await w.stop();
    const before = w.securityItems().length;
    // GitHub now reports a different owner id for the repo. The URL text and
    // the manifest are unchanged, so only GitHub's answer can reveal it.
    w.gh.addRepo(bad.repoOwner, bad.repo, 999_999);
    await w.boot({ confirm: false });
    expect(await w.isRunning(bad)).toBe(false);
    expect(await w.isRunning(good)).toBe(true);
    expect(w.securityItems().length).toBeGreaterThan(before);
  });

  it("[ST-5] FR-2: the repo owner is checked by id, not by login (same login, other id is refused)", async () => {
    w = await World.create([{ name: "p", allowed: [{ login: "org0", id: 424242 }] }]);
    await expectNothingRuns(w);
  });

  it("[ST-6] FR-2: a repo the factory token can't reach doesn't run and a Security item is filed", async () => {
    w = await World.create([{ name: "gone" }, { name: "ok" }]);
    await w.boot();
    await w.stop();
    const before = w.securityItems().length;
    w.gh.repos.clear();
    w.gh.addRepo(w.project(1).repoOwner, w.project(1).repo, w.project(1).repoOwnerId);
    await w.boot({ confirm: false });
    expect(await w.isRunning(w.project())).toBe(false);
    expect(await w.isRunning(w.project(1))).toBe(true);
    expect(w.securityItems().length).toBeGreaterThan(before);
  });

  it("[ST-7] FR-2 / SR-2: a manifest that fails validation stops only that project and files a Security item", async () => {
    w = await World.create([
      { name: "broken", editManifest: (t) => t.replace("schema: factory-project/1.0", "schema: factory-project/9.9") },
      { name: "fine" },
    ]);
    await w.boot();
    expect(await w.isRunning(w.project())).toBe(false);
    expect(await w.isRunning(w.project(1))).toBe(true);
    expect(w.securityItems().length).toBeGreaterThan(0);
  });

  it.each([
    ["placeholder owner id", (t: string) => t.replace(/github_id: \d+/, "github_id: <numeric id>")],
    ["owner id zero", (t: string) => t.replace(/github_id: \d+/, "github_id: 0")],
    ["owner id negative", (t: string) => t.replace(/github_id: \d+/, "github_id: -5")],
    ["owner id as a string", (t: string) => t.replace(/github_id: (\d+)/, 'github_id: "$1"')],
    ["owner id fractional", (t: string) => t.replace(/github_id: (\d+)/, "github_id: $1.5")],
    ["placeholder client id", (t: string) => t.replace(/oauth_client_id: \S+/, "oauth_client_id: <client id>")],
    ["empty client id", (t: string) => t.replace(/oauth_client_id: \S+/, 'oauth_client_id: ""')],
    ["no owner block", (t: string) => t.replace(/owner:\n  github_id: \d+\n  oauth_client_id: \S+\n/, "")],
    ["no enabled key", (t: string) => t.replace(/enabled: true\n/, "")],
    ["enabled as a string", (t: string) => t.replace(/enabled: true/, 'enabled: "yes"')],
    ["placeholder allow-list id", (t: string) => t.replace(/id: (\d+) }/, "id: <numeric id> }")],
  ])("[ST-8] FR-2 / Project manifest v1.3: %s is refused; the project doesn't run", async (_name, edit) => {
    w = await World.create([{ name: "p", editManifest: edit }]);
    await expectNothingRuns(w);
  });

  it("[ST-9] ADR 0012: a project with enabled: false doesn't run", async () => {
    w = await World.create([{ name: "off", enabled: false }]);
    await expectNothingRuns(w);
  });
});

describe("AC-3 / FR-3: model credential against the billing mode", () => {
  it("[ST-10] AC-3: ANTHROPIC_API_KEY in the environment with a subscription project: the engine refuses to start, with a clear message that doesn't echo the key", async () => {
    w = await World.create([{ budgetMode: "subscription" }]);
    const key = "sk-ant-api03-ENVKEY" + "x".repeat(20);
    w.envOverrides.ANTHROPIC_API_KEY = key;
    let err: Error | undefined;
    try {
      await w.boot();
    } catch (e) {
      err = e as Error;
    }
    expect(err, "the engine must refuse to start").toBeDefined();
    if (/engine not available/.test(err!.message)) throw err;
    expect(err!.message).toMatch(/ANTHROPIC_API_KEY/);
    expect(err!.message).toMatch(/subscription/i);
    expect(err!.message).not.toContain(key);
    expect(existsSync(w.engineJsonPath())).toBe(false);
  });

  it("[ST-11] FR-3: the same setup without the variable starts (control for ST-10)", async () => {
    w = await World.create([{ budgetMode: "subscription" }]);
    await w.boot();
    expect(await w.isRunning(w.project())).toBe(true);
  });
});

describe("SR-13: the project paths file and the paths it lists", () => {
  it("[ST-12] SR-13: a projects file that is a symlink is refused", async () => {
    w = await World.create();
    const real = join(w.root, "outside", "projects.yaml");
    renameSync(w.projectsFile, real);
    symlinkSync(real, w.projectsFile);
    await expectNothingRuns(w);
  });

  // On Windows the same files are made by granting write to Users (S-1-5-32-545)
  // and Everyone (S-1-1-0).
  it.each([
    ["group-writable", 0o620, ["S-1-5-32-545"]],
    ["world-writable", 0o602, ["S-1-1-0"]],
    ["group- and world-writable", 0o666, ["S-1-5-32-545", "S-1-1-0"]],
  ])("[ST-13] SR-13: a %s projects file is refused", async (_n, m, sids) => {
    w = await World.create();
    if (isWindows) grantWrite(w.projectsFile, sids);
    else chmodSync(w.projectsFile, m);
    await expectNothingRuns(w);
  });

  it.runIf(isRoot)("[ST-14] SR-13: a projects file not owned by the owner is refused (needs root to chown)", async () => {
    w = await World.create();
    chownSync(w.projectsFile, 65534, 65534);
    await expectNothingRuns(w);
  });

  it("[ST-15] SR-13: a relative listed path is refused; the other listed project runs", async () => {
    w = await World.create([{ name: "rel" }, { name: "abs" }]);
    const rel = join("..", "config", "rel");
    w.writeProjectsFile([rel, w.project(1).configRepo]);
    await w.boot();
    expect(await w.isRunning(w.project())).toBe(false);
    expect(await w.isRunning(w.project(1))).toBe(true);
  });

  it("[ST-16] SR-13: a listed path that is a symlink is refused", async () => {
    w = await World.create([{ name: "linked" }, { name: "plain" }]);
    const link = join(w.root, "outside", "link-to-config");
    symlinkSync(w.project().configRepo, link);
    w.writeProjectsFile([link, w.project(1).configRepo]);
    await w.boot();
    const all = await w.engine!.projects();
    expect(all.some((x) => x.path === link && x.state === "running")).toBe(false);
    expect(await w.isRunning(w.project())).toBe(false);
    expect(await w.isRunning(w.project(1))).toBe(true);
  });

  it("[ST-17] SR-13: a listed path that isn't a Git work tree is refused", async () => {
    w = await World.create([{ name: "ok" }]);
    const notGit = join(w.root, "outside", "not-a-repo");
    mkdirSync(notGit);
    writeFileSync(join(notGit, "factory-project.yaml"), w.manifestText(w.project()));
    w.writeProjectsFile([notGit, w.project().configRepo]);
    await w.boot();
    const all = await w.engine!.projects();
    expect(all.some((x) => x.path === notGit && x.state === "running")).toBe(false);
    expect(await w.isRunning(w.project())).toBe(true);
  });

  it("[ST-18] SR-13: the master repo itself listed as a project is refused, even with a valid manifest on main", async () => {
    w = await World.create([{ name: "ok" }]);
    writeFileSync(join(w.master, "factory-project.yaml"), w.manifestText(w.project()));
    git(w.master, "add", "factory-project.yaml");
    git(w.master, "commit", "-q", "-m", "owner values in the master repo");
    w.writeProjectsFile([w.master, w.project().configRepo]);
    await w.boot();
    const all = await w.engine!.projects();
    expect(all.some((x) => x.path === w!.master && x.state === "running")).toBe(false);
    expect(await w.isRunning(w.project())).toBe(true);
  });

  it("[ST-19] SR-13: a clone of the master repo (same root commit) listed as a project is refused", async () => {
    w = await World.create([{ name: "ok" }]);
    const clone = join(w.root, "outside", "master-clone");
    git(w.root, "clone", "-q", w.master, clone);
    writeFileSync(join(clone, "factory-project.yaml"), w.manifestText(w.project()));
    git(clone, "add", "factory-project.yaml");
    git(clone, "-c", "user.name=x", "-c", "user.email=x@x.invalid", "commit", "-q", "-m", "manifest");
    git(clone, "remote", "set-url", "origin", "https://github.com/someone/innocent-name");
    w.writeProjectsFile([clone, w.project().configRepo]);
    await w.boot();
    const all = await w.engine!.projects();
    expect(all.some((x) => x.path === clone && x.state === "running")).toBe(false);
    expect(await w.isRunning(w.project())).toBe(true);
  });

  it("[ST-20] SR-5 / FR-2: the manifest is read from the config repo's main commit, never the working tree or another branch", async () => {
    w = await World.create();
    const p = w.project();
    await w.boot();
    await w.stop();
    const before = w.securityItems().length;
    // Uncommitted garbage in the working tree, then another branch checked out
    // with a different owner: neither is main, so neither counts.
    writeFileSync(join(p.configRepo, "factory-project.yaml"), "this: [is not: a manifest\n");
    git(p.configRepo, "stash", "-q");
    git(p.configRepo, "checkout", "-q", "-b", "other");
    git(p.configRepo, "commit", "-q", "--allow-empty", "-m", "noop");
    writeFileSync(
      join(p.configRepo, "factory-project.yaml"),
      w.manifestText(p).replace(/github_id: \d+/, "github_id: 7777777"),
    );
    git(p.configRepo, "commit", "-q", "-am", "other owner on a side branch");
    writeFileSync(join(p.configRepo, "factory-project.yaml"), "also: [garbage\n");
    await w.boot({ confirm: false });
    expect(await w.isRunning(p)).toBe(true);
    expect(w.securityItems().length).toBe(before);
  });
});
