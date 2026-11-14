// SR-11 (Security and Testability Review #6): every git command the engine runs has hooks, fsmonitor,
// filters, textconv, file protocol, credential helpers and SSH commands
// neutralised; pushes use the factory token through GIT_ASKPASS only.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerOne } from "./support/flows";
import { gitOverrides } from "./support/fake-tools";
import { git, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const HOOKS = [
  "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push", "post-checkout",
  "post-merge", "reference-transaction", "post-index-change", "pre-auto-gc", "post-rewrite", "push-to-checkout",
];

function evilScript(world: World, path: string, name: string) {
  writeFileSync(path, `#!/bin/sh\ntouch "${world.markers}/${name}-$$"\ncat >/dev/null 2>&1 || true\nexit 0\n`);
  chmodSync(path, 0o755);
}

/** A repo and owner config that try every way of running code on the host. */
function poison(world: World, variant: "absolute" | "husky") {
  const p = world.project();
  const evil = join(world.root, "evil");
  mkdirSync(join(evil, "hooks"), { recursive: true });

  // factory/state on the remote carries attributes and a husky hook, so the
  // .factory worktree the engine commits in has them. Done first, while the
  // fixture's own git calls are still safe to run.
  const tmp = join(world.root, "poison-state");
  git(world.root, "clone", "-q", "-b", "factory/state", p.bare, tmp);
  writeFileSync(join(tmp, ".gitattributes"), "* filter=evil diff=evil\n");
  mkdirSync(join(tmp, ".husky"), { recursive: true });
  evilScript(world, join(tmp, ".husky", "pre-commit"), "husky-pre-commit");
  evilScript(world, join(tmp, ".husky", "commit-msg"), "husky-commit-msg");
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", "state with attributes and husky");
  git(tmp, "push", "-q", "origin", "factory/state");
  git(p.clone, "fetch", "-q", p.bare, "+refs/heads/*:refs/remotes/origin/*");

  for (const h of HOOKS) {
    evilScript(world, join(evil, "hooks", h), `hooksPath-${h}`);
    evilScript(world, join(p.clone, ".git", "hooks", h), `githooks-${h}`);
  }
  for (const n of ["fsmonitor", "clean", "smudge", "textconv", "credential", "ssh", "global-credential"]) {
    evilScript(world, join(evil, n), n);
  }
  const evilBare = join(evil, "exfil.git");
  git(world.root, "init", "-q", "--bare", evilBare);

  const cfg = (k: string, v: string) => git(p.clone, "config", k, v);
  cfg("core.hooksPath", variant === "absolute" ? join(evil, "hooks") : ".husky");
  cfg("core.fsmonitor", join(evil, "fsmonitor"));
  cfg("filter.evil.clean", join(evil, "clean"));
  cfg("filter.evil.smudge", join(evil, "smudge"));
  cfg("filter.evil.required", "true");
  cfg("diff.evil.textconv", join(evil, "textconv"));
  cfg("credential.helper", `!${join(evil, "credential")}`);
  cfg("core.sshCommand", join(evil, "ssh"));
  cfg("remote.origin.pushurl", `file://${evilBare}`);

  // The owner's global config has a helper too; the engine must not use it (S9.6).
  writeFileSync(
    join(world.home, ".gitconfig"),
    `[user]\n\tname = Owner\n\temail = owner@example.invalid\n[credential]\n\thelper = !${join(evil, "global-credential")}\n[core]\n\thooksPath = ${join(evil, "hooks")}\n`,
  );
  return { evilBare };
}

async function exercise(world: World) {
  const r = await answerOne(world, "A plain answer that the engine must commit.");
  await world.settle();
  await new Promise((res) => setTimeout(res, 1000));
  return r;
}

describe("SR-11: nothing from the repo or the owner's git config runs on the host", () => {
  it.each(["absolute", "husky"] as const)(
    "[GS-1] SR-11 / AC-18 abuse case (%s hooksPath): no hook, fsmonitor, filter, textconv, credential helper or SSH command runs, and nothing goes to a file:// push URL",
    async (variant) => {
      w = await World.create(undefined, { logGit: true });
      const { evilBare } = poison(w, variant);
      await exercise(w);
      expect(w.gitw.calls().length, "the engine ran git through the given path").toBeGreaterThan(0);
      expect(readdirSync(w.markers), "code from the repo ran on the host").toEqual([]);
      expect(git(evilBare, "for-each-ref").trim()).toBe("");
    },
  );

  it("[GS-2] SR-11: every git call carries the overrides: empty hooksPath outside every repo, fsmonitor off, file protocol never, no credential helper", async () => {
    w = await World.create(undefined, { logGit: true });
    await exercise(w);
    const calls = w.gitw.calls();
    expect(calls.length).toBeGreaterThan(0);
    const repos = [w.master, ...w.projects.flatMap((p) => [p.clone, p.configRepo])];
    for (const c of calls) {
      const { config } = gitOverrides(c);
      const where = `git ${c.argv.join(" ")}`;
      const hp = config.get("core.hookspath");
      expect(hp, `${where}: core.hooksPath`).toBeTruthy();
      for (const r of repos) expect(hp!.startsWith(r), `${where}: hooksPath inside a repo`).toBe(false);
      if (existsSync(hp!)) expect(readdirSync(hp!), `${where}: hooksPath not empty`).toEqual([]);
      expect(config.get("core.fsmonitor"), `${where}: core.fsmonitor`).toBe("false");
      expect(config.get("protocol.file.allow"), `${where}: protocol.file.allow`).toBe("never");
      expect(config.get("credential.helper"), `${where}: credential.helper`).toBe("");
    }
  });

  it("[GS-3] SR-11: commits and pushes pass --no-verify", async () => {
    w = await World.create(undefined, { logGit: true });
    await exercise(w);
    for (const c of w.gitw.calls()) {
      const { subcommand, rest } = gitOverrides(c);
      if (subcommand === "commit" || subcommand === "push") {
        expect(rest, `git ${c.argv.join(" ")}`).toContain("--no-verify");
      }
    }
  });

  it("[GS-4] SR-1 / SR-11: the factory token never appears in a git argument or URL; pushes authenticate through GIT_ASKPASS over HTTPS", async () => {
    w = await World.create(undefined, { logGit: true });
    await exercise(w);
    const calls = w.gitw.calls();
    for (const c of calls) {
      expect(c.argv.join(" ")).not.toContain(w.factoryToken);
      for (const a of c.argv) expect(a).not.toMatch(/^[a-z]+:\/\/[^/\s]*@/i);
    }
    const pushes = calls.filter((c) => gitOverrides(c).subcommand === "push");
    expect(pushes.length, "the engine pushed factory/state or the feature branch").toBeGreaterThan(0);
    for (const c of pushes) {
      expect(c.env.GIT_ASKPASS, "push without GIT_ASKPASS").toBeTruthy();
      expect(c.env.SSH_ASKPASS ?? "").not.toContain(w.factoryToken);
    }
    expect(w.gh.pushes.length).toBeGreaterThan(0);
    for (const p of w.gh.pushes) expect(p.password === w.factoryToken || p.user === w.factoryToken).toBe(true);
  });
});
