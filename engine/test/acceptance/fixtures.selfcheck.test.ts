// Self-checks of the fakes and fixtures, which run without the engine. A
// failure here is an environment or test-code problem, never a product one.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drive, FakeClock } from "./support/clock";
import { LEAK_MARKER } from "./support/fake-tools";
import { BASE_PATH, git, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

function run(args: string[], opts: { cwd?: string; env: Record<string, string> }): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn("git", args, { ...opts, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stderr }));
  });
}

const post = (url: string, body: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams(body) }).then((r) => r.json() as Promise<any>);

describe("Fixture self-checks (no engine needed)", () => {
  it("[FX-1] a world has a master repo, a config repo with the manifest on main, and a managed clone with factory/state on its remote", async () => {
    w = await World.create();
    const p = w.project();
    const manifest = git(p.configRepo, "show", "main:factory-project.yaml");
    expect(manifest).toMatch(/^schema: factory-project\/1.0$/m);
    expect(manifest).toMatch(/requirements-analyst:/);
    expect(manifest).toMatch(new RegExp(`github_id: ${p.ownerId}`));
    expect(manifest).not.toMatch(/<[a-z][^>]*>/i);
    expect(git(p.clone, "rev-parse", "--verify", "refs/remotes/origin/factory/state").trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(w.projectsFile, "utf8")).toContain(p.configRepo);
  });

  it("[FX-2] the fake GitHub runs the device flow and answers GET /user and GET /repos", async () => {
    w = await World.create();
    const p = w.project();
    const d = await post(`${w.gh.webBaseUrl}/login/device/code`, { client_id: p.clientId });
    expect(d.verification_uri).toBe("https://github.com/login/device");
    const poll = () =>
      post(`${w!.gh.webBaseUrl}/login/oauth/access_token`, {
        client_id: p.clientId,
        device_code: d.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    expect((await poll()).error).toBe("authorization_pending");
    w.gh.approve(d.user_code, p.ownerId);
    const tok = await poll();
    const user = await fetch(`${w.gh.apiBaseUrl}/user`, { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json() as Promise<any>);
    expect(user.id).toBe(p.ownerId);
    const repo = await fetch(`${w.gh.apiBaseUrl}/repos/${p.repoOwner}/${p.repo}`, {
      headers: { authorization: `Bearer ${w.factoryToken}` },
    }).then((r) => r.json() as Promise<any>);
    expect(repo.owner.id).toBe(p.repoOwnerId);
  });

  it("[FX-3] git over the fake's smart HTTP: clone works, a push needs the factory token through GIT_ASKPASS and is recorded", async () => {
    w = await World.create();
    const p = w.project();
    const dir = join(w.root, "fx3");
    const askpass = join(w.root, "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\necho "${w.factoryToken}"\n`);
    chmodSync(askpass, 0o755);
    const env = { PATH: BASE_PATH, HOME: w.root, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
    // Async on purpose: the fake server runs in this process, so a sync git
    // call talking to it would block its event loop and deadlock.
    expect((await run(["clone", "-q", w.gh.gitUrl(p.repoOwner, p.repo), dir], { env })).status).toBe(0);
    git(dir, "commit", "-q", "--allow-empty", "-m", "x");
    const noAuth = await run(["push", "-q", "origin", "HEAD:refs/heads/fx3"], { cwd: dir, env });
    expect(noAuth.status).not.toBe(0);
    const withAuth = await run(["-c", "credential.helper=", "push", "-q", "origin", "HEAD:refs/heads/fx3"], {
      cwd: dir,
      env: { ...env, GIT_ASKPASS: askpass },
    });
    expect(withAuth.status, withAuth.stderr).toBe(0);
    expect(w.gh.pushes.some((x) => x.password === w!.factoryToken)).toBe(true);
    expect(git(p.bare, "rev-parse", "refs/heads/fx3").trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("[FX-4] the fake gitleaks prints 8.30.1, exits 99 on the leak marker and 0 otherwise, and logs each run", async () => {
    w = await World.create();
    const v = execFileSync(w.gitleaks.path, ["version"], { encoding: "utf8" });
    expect(v.trim()).toBe("8.30.1");
    const stage = join(w.root, "stage");
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(join(stage, "a".repeat(40)), "clean");
    expect(spawnSync(w.gitleaks.path, ["dir", stage]).status).toBe(0);
    writeFileSync(join(stage, "b".repeat(40)), `x ${LEAK_MARKER}123`);
    expect(spawnSync(w.gitleaks.path, ["dir", stage]).status).toBe(99);
    expect(w.gitleaks.scans().length).toBe(2);
  });

  it("[FX-5] the git wrapper logs each call and passes it through", async () => {
    w = await World.create();
    const out = execFileSync(w.gitw.path, ["-c", "core.fsmonitor=false", "--version"], { encoding: "utf8" });
    expect(out).toMatch(/^git version/);
    expect(w.gitw.calls()[0]!.argv).toEqual(["-c", "core.fsmonitor=false", "--version"]);
  });

  it("[FX-6] the fake clock fires timers in order and drive() advances until a promise settles", async () => {
    const c = new FakeClock();
    const seen: number[] = [];
    c.setTimeout(() => seen.push(2), 2000);
    c.setTimeout(() => seen.push(1), 1000);
    await c.advance(1500);
    expect(seen).toEqual([1]);
    const t0 = c.now();
    await drive(c, c.sleep(10_000));
    expect(c.now() - t0).toBeGreaterThanOrEqual(10_000);
    expect(seen).toEqual([1, 2]);
  });
});
