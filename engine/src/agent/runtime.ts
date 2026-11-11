import * as fs from "node:fs";
import * as path from "node:path";
import type { DockerCli } from "../docker/cli";
import { ensureOwnerDir, realPath } from "../fsutil";
import type { Git } from "../git";
import type { FeatureInterview } from "../interview/feature";
import type { Logger } from "../log";
import type { AgentSdk, UserTurn } from "./sdk";

/**
 * What the engine needs to run agents. The CLI builds the real one; tests
 * pass fakes. Without it the engine serves interviews but starts no agent.
 */
export interface AgentRuntime {
  docker: DockerCli;
  sdk(): Promise<AgentSdk>;
  /** The engine's own `docker/` folder (the agent image's fixed files). */
  dockerDir: string;
  /** The bundled proxy, `dist/proxy.js`. */
  proxyScript: string;
  platform?: NodeJS.Platform;
  sleep?(ms: number): Promise<void>;
}

const turn = (content: string): UserTurn => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" });

/**
 * The analyst's user turns: an opening message, then each batch of owner
 * replies the moment it is recorded, framed by `takeTurn` (Interview tools
 * v1.0). Nothing is handed over while the feature is paused. Ends on close().
 */
export class TurnQueue implements AsyncIterable<UserTurn> {
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(private readonly f: FeatureInterview, private readonly first: string | null) {}

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<UserTurn> {
    if (this.first) yield turn(this.first);
    while (!this.closed) {
      if (!this.f.paused && this.f.state.undelivered.length) {
        const t = await this.f.takeTurn().catch(() => null);
        if (t && !this.closed) {
          yield turn(t.message);
          continue;
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          this.f.changed.off("change", done);
          this.f.changed.off("resumed", done);
          this.wake = null;
          resolve();
        };
        this.wake = done;
        this.f.changed.on("change", done);
        this.f.changed.on("resumed", done);
      });
    }
  }
}

/**
 * Writes `commit`'s tree into the worktree from git objects, after removing
 * everything but `.git`, and restores the `.git` link. No checkout runs, so
 * no filter, attribute or hook of the repo applies (SR-11). Links are written
 * as links where the OS allows, as git would.
 */
export async function populateWorktree(git: Git, repo: string, commit: string, wt: string, gitDir: string): Promise<void> {
  for (const name of fs.readdirSync(wt)) if (name !== ".git") fs.rmSync(path.join(wt, name), { recursive: true, force: true });
  fs.rmSync(path.join(wt, ".git"), { recursive: true, force: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir.split("\\").join("/")}\n`);
  for (const e of await git.lsTree(repo, commit)) {
    const dest = path.join(wt, ...e.path.split("/"));
    if (!dest.startsWith(wt + path.sep)) throw new Error("a tree path leaves the worktree");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (e.mode === "160000") fs.mkdirSync(dest, { recursive: true });
    else if (e.mode === "120000") {
      const target = (await git.catBlob(repo, e.sha)).toString("utf8");
      if (process.platform === "win32") fs.writeFileSync(dest, target);
      else fs.symlinkSync(target, dest);
    } else fs.writeFileSync(dest, await git.catBlob(repo, e.sha), { mode: e.mode === "100755" ? 0o755 : 0o644 });
  }
  await git.run(wt, ["--git-dir", gitDir, "--work-tree", wt, "read-tree", commit]);
}

/**
 * The analyst's checkout of its feature branch, in an engine-owned folder
 * outside every repo. Its git dir is taken when the worktree is made, before
 * an agent can touch its `.git` file, and kept in the run record.
 */
export async function prepareWorktree(git: Git, repo: string, dir: string, branch: string, gitDir?: string): Promise<{ path: string; gitDir: string }> {
  ensureOwnerDir(path.dirname(dir));
  const common = realPath(path.resolve(repo, await git.out(repo, ["rev-parse", "--git-common-dir"])));
  if (gitDir && fs.existsSync(dir) && fs.existsSync(gitDir)) {
    if (!realPath(gitDir).startsWith(path.join(common, "worktrees") + path.sep)) throw new Error("the run's git dir isn't one of the repo's worktrees");
    return { path: dir, gitDir };
  }
  await git.run(repo, ["worktree", "prune"]);
  fs.rmSync(dir, { recursive: true, force: true });
  await git.run(repo, ["worktree", "add", "--no-checkout", dir, branch]);
  const link = fs.readFileSync(path.join(dir, ".git"), "utf8").trim();
  const m = /^gitdir: (.+)$/.exec(link);
  if (!m) throw new Error("git made a worktree without a gitdir link");
  const made = path.resolve(dir, m[1]!);
  if (!realPath(made).startsWith(path.join(common, "worktrees") + path.sep)) throw new Error("the new worktree's git dir isn't under the repo");
  const head = await git.revParse(repo, `refs/heads/${branch}`);
  if (!head) throw new Error(`no branch ${branch}`);
  await populateWorktree(git, repo, head, dir, made);
  return { path: dir, gitDir: made };
}

const NAME_RE = /^factory-[a-z0-9-]{1,200}$/;

/**
 * At engine start: containers and networks left by an engine that didn't
 * shut down are removed, found by the `factory.run` label. A session volume
 * stays while its run can still resume (`keep`); any other goes, since its
 * files are sensitive.
 */
export async function sweepLeftovers(docker: DockerCli, keep: Set<string>, log: Logger): Promise<void> {
  const list = async (args: string[]) => (await docker.out(args)).split("\n").map((s) => s.trim()).filter((s) => NAME_RE.test(s));
  for (const c of await list(["ps", "--all", "--filter", "label=factory.run", "--format", "{{.Names}}"])) {
    await docker.run(["rm", "--force", c], { okCodes: [1] });
    log.info(`removed leftover container ${c}`);
  }
  for (const n of await list(["network", "ls", "--filter", "label=factory.run", "--format", "{{.Name}}"])) {
    await docker.run(["network", "rm", n], { okCodes: [1] });
    log.info(`removed leftover network ${n}`);
  }
  for (const v of await list(["volume", "ls", "--filter", "label=factory.run", "--format", "{{.Name}}"])) {
    if (keep.has(v)) continue;
    await docker.run(["volume", "rm", "--force", v], { okCodes: [1] });
    log.info(`removed leftover volume ${v}`);
  }
}
