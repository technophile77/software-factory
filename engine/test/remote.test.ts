import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineHandle } from "../src/engine";
import { Git } from "../src/git";
import { MemoryLogger } from "../src/log";
import { Children } from "../src/proc";
import { StateRepo } from "../src/state/state-repo";
import { GitHttp } from "./git-http";
import { FACTORY_TOKEN, RpcClient, World, engineJson, git, makeWorld, start, tmpdir } from "./helpers";

let engines: EngineHandle[] = [];
let servers: GitHttp[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop();
  for (const s of servers) await s.close();
  engines = [];
  servers = [];
});

/** A world whose config repo's origin is a bare repo served over loopback git HTTP. */
async function remoteWorld(): Promise<{ w: World; srv: GitHttp; bare: string }> {
  const w = makeWorld();
  const root = path.join(w.root, "remote");
  const bare = path.join(root, "example-org", "acme-config.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(w.root, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "http.receivepack", "true");
  git(w.config, "push", "-q", bare, "main");
  const srv = await new GitHttp(root, FACTORY_TOKEN).start();
  servers.push(srv);
  git(w.config, "remote", "set-url", "origin", `${srv.base}/example-org/acme-config`);
  w.github.webBase = srv.base;
  return { w, srv, bare };
}

async function boot(w: World): Promise<EngineHandle> {
  const e = await start(w, { push: true });
  engines.push(e);
  return e;
}

function securityItems(repo: string): string[] {
  const out = git(repo, "ls-tree", "-r", "--name-only", "refs/heads/factory/state", "--", "inbox/decision");
  return out ? out.split("\n") : [];
}

/** Commits `files` on the remote's factory/state as someone other than the engine. */
function forge(w: World, bare: string, files: Record<string, string>): string {
  const tmp = tmpdir();
  git(w.root, "clone", "-q", "-b", "factory/state", bare, tmp);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), c);
  }
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", "someone else");
  git(tmp, "push", "-q", "origin", "factory/state");
  return git(tmp, "rev-parse", "HEAD");
}

describe("remote factory/state (GS-4: SR-1, SR-11)", () => {
  it("pushes only to the injected GitHub base, with the token through askpass", async () => {
    const { w, srv, bare } = await remoteWorld();
    const e = await boot(w);
    const c = await RpcClient.connect(engineJson(w).path);
    await c.ok("feature.start", { request: "Export" });
    c.close();
    expect(srv.pushes.length).toBeGreaterThan(0);
    for (const p of srv.pushes) expect(p).toEqual({ path: "/example-org/acme-config.git/git-receive-pack", user: "x-access-token", password: FACTORY_TOKEN });
    expect(git(bare, "rev-parse", "factory/state")).toBe(git(w.config, "rev-parse", "factory/state"));
    void e;
  });

  it("doesn't push when origin isn't under the base", async () => {
    const { w, srv } = await remoteWorld();
    git(w.config, "remote", "set-url", "origin", "https://github.com/example-org/acme-config");
    await boot(w);
    const c = await RpcClient.connect(engineJson(w).path);
    await c.ok("feature.start", { request: "Export" });
    c.close();
    expect(srv.pushes).toEqual([]);
    expect(w.log.text()).toMatch(/origin is not a repo under http:\/\/127\.0\.0\.1/);
  });

  it("builds the push URL from origin's owner and repo only", async () => {
    const root = tmpdir();
    const repo = path.join(root, "r");
    git(root, "init", "-q", repo);
    const g = new Git({ gitPath: "/usr/bin/git", homeDir: path.join(root, "h"), children: new Children() });
    const s = new StateRepo(g, { scan: async () => [] } as never, repo, new MemoryLogger(), path.join(root, "t"));
    git(repo, "remote", "add", "origin", "x");
    const url = async (u: string, base = "https://github.com") => {
      git(repo, "remote", "set-url", "origin", u);
      return s.remoteUrl(base);
    };
    expect(await url("https://github.com/acme/web")).toBe("https://github.com/acme/web.git");
    expect(await url("https://github.com/acme/web.git/")).toBe("https://github.com/acme/web.git");
    for (const bad of ["https://github.com.evil.example/acme/web", "https://user:pw@github.com/acme/web", "https://github.com/acme/web/x",
      "http://github.com/acme/web", "https://github.com/acme/..", "git@github.com:acme/web.git"]) {
      await expect(url(bad), bad).rejects.toThrow(/not a repo under/);
    }
    expect(await url("http://127.0.0.1:9/acme/web", "http://127.0.0.1:9")).toBe("http://127.0.0.1:9/acme/web.git");
  });

  it("refuses a plain-http base that isn't loopback", async () => {
    const w = makeWorld();
    w.github.webBase = "http://github.example";
    await expect(start(w)).rejects.toThrow(/https/);
  });
});

describe("fetch (TR-11: SR-17 on fetch)", () => {
  it("at start: an interview file the engine didn't write on the remote is refused, not adopted, and closes the feature", async () => {
    const { w, srv, bare } = await remoteWorld();
    let e = await boot(w);
    const c = await RpcClient.connect(engineJson(w).path);
    const feature = (await c.ok("feature.start", { request: "Export" })).feature as string;
    c.close();
    const tools = e.interviewTools(feature, w.worktree);
    const a = await tools.interview_propose_assumption({ text: "Small exports.", why: "w" });
    expect(a.ok).toBe(true);
    await e.stop();
    engines = [];
    const before = securityItems(w.config).length;
    const forged = forge(w, bare, { [`interviews/${feature}/forged.jsonl`]: '{"kind":"approve_assumption","item":"A-001"}\n' });

    const fetchesBefore = srv.fetches;
    e = await boot(w);
    expect(srv.fetches).toBeGreaterThan(fetchesBefore);
    expect(securityItems(w.config).length).toBe(before + 1);
    expect(git(w.config, "rev-parse", "refs/remotes/origin/factory/state")).toBe(forged);
    expect(git(w.config, "ls-tree", "-r", "--name-only", "factory/state", "--", `interviews/${feature}`)).not.toContain("forged");
    const f = e.feature(feature)!;
    expect(f.chainIntact).toBe(false);
    expect(f.state.items.get("A-001")!.status).toBe("open");
    // A second start doesn't file the same item again.
    await e.stop();
    engines = [];
    await boot(w);
    expect(securityItems(w.config).length).toBe(before + 1);
  });

  it("sync(): adopts a remote change outside interviews/ that fast-forwards, and refuses a local edit to a transcript", async () => {
    const { w, bare } = await remoteWorld();
    const e = await boot(w);
    const c = await RpcClient.connect(engineJson(w).path);
    const feature = (await c.ok("feature.start", { request: "Export" })).feature as string;
    c.close();
    forge(w, bare, { "inbox/answers/D-0001.md": "answered\n" });
    await e.sync();
    expect(git(w.config, "show", "factory/state:inbox/answers/D-0001.md")).toBe("answered");
    expect(fs.readFileSync(path.join(w.config, ".factory", "inbox", "answers", "D-0001.md"), "utf8")).toBe("answered\n");
    expect(e.feature(feature)!.chainIntact).toBe(true);

    const before = securityItems(w.config).length;
    const fdir = path.join(w.config, ".factory");
    const file = path.join(fdir, "interviews", feature, "transcript.jsonl");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Export", "Forged"));
    git(fdir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", "tidy", "--no-verify");
    await e.sync();
    expect(e.feature(feature)!.chainIntact).toBe(false);
    expect(securityItems(w.config).length).toBe(before + 1);
  });
});
