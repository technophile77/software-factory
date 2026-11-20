import * as fs from "node:fs";
import * as path from "node:path";
import { DockerError, type DockerCli } from "../docker/cli";
import { ensureOwnerDir, realPath } from "../fsutil";
import type { Git } from "../git";
import type { FeatureInterview } from "../interview/feature";
import type { Logger } from "../log";
import type { HostRuntime } from "./host";
import type { AgentSdk, UserTurn } from "./sdk";
import { caseInsensitiveAt, checkTree, writeNew } from "./worktree-populate";

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
  /**
   * ADR 0026, H-0204: run Claude Code on the owner's PC, not in containers.
   * Docker is then used only for runs on a model endpoint (F-013).
   */
  host?: HostRuntime;
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
  private started = false;
  private busy = false;

  /** `onIdle` hears each change of `idle`, so the run record can say whether a restart would cut off work. */
  constructor(private readonly f: FeatureInterview, private readonly first: string | null, private readonly onIdle?: (idle: boolean) => void) {}

  /**
   * The session finished a turn (its `result` message). Claude Code can fold
   * a reply handed over mid-turn into that turn, so one result can end
   * several handed-over turns; counting them left the analyst "working" forever.
   */
  turnEnded(): void {
    if (!this.busy) return;
    this.busy = false;
    this.onIdle?.(true);
  }

  /** The session is producing output, so a turn handed over earlier is being worked on. */
  working(): void {
    if (!this.started || this.busy) return;
    this.busy = true;
    this.onIdle?.(false);
  }

  /** Issue #124: the session finished its work and waits for the owner. */
  get idle(): boolean {
    return this.started && !this.busy;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  private handOver(): void {
    this.started = true;
    this.busy = true;
    this.onIdle?.(false);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<UserTurn> {
    if (this.first) {
      this.handOver();
      yield turn(this.first);
    }
    while (!this.closed) {
      if (!this.f.paused && this.f.state.undelivered.length) {
        const t = await this.f.takeTurn().catch(() => null);
        if (t && !this.closed) {
          this.handOver();
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
 * no filter, attribute or hook of the repo applies (SR-11). The whole tree
 * is checked first (H2): no links or submodules, no name the file system
 * would read as another, and each file is created new under folders this
 * writer made, never through a link.
 */
export async function populateWorktree(git: Git, repo: string, commit: string, wt: string, gitDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const entries = await git.lsTree(repo, commit);
  checkTree(entries, caseInsensitiveAt(wt), platform);
  for (const name of fs.readdirSync(wt)) if (name !== ".git") fs.rmSync(path.join(wt, name), { recursive: true, force: true });
  fs.rmSync(path.join(wt, ".git"), { recursive: true, force: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir.split("\\").join("/")}\n`);
  // Blobs in batches, so a large repo neither starts a process per file nor holds every file in memory at once.
  for (let i = 0; i < entries.length; i += 256) {
    const batch = entries.slice(i, i + 256);
    const blobs = await git.catBlobs(repo, batch.map((e) => e.sha)).catch(() => null);
    for (const e of batch) writeNew(wt, e.path, blobs?.get(e.sha) ?? (await git.catBlob(repo, e.sha)), e.mode === "100755");
  }
  await git.run(wt, ["--git-dir", gitDir, "--work-tree", wt, "read-tree", commit]);
}

/**
 * The analyst's checkout of its feature branch, in an engine-owned folder
 * outside every repo. Its git dir is taken when the worktree is made, before
 * an agent can touch its `.git` file, and kept in the run record. With
 * `detachAt`, the worktree is detached at that commit instead: git allows a
 * branch in one worktree only, and the analyst's keeps it.
 */
export async function prepareWorktree(git: Git, repo: string, dir: string, branch: string, gitDir?: string, detachAt?: string): Promise<{ path: string; gitDir: string }> {
  ensureOwnerDir(path.dirname(dir));
  const common = realPath(path.resolve(repo, await git.out(repo, ["rev-parse", "--git-common-dir"])));
  if (gitDir && fs.existsSync(dir) && fs.existsSync(gitDir)) {
    if (!realPath(gitDir).startsWith(path.join(common, "worktrees") + path.sep)) throw new Error("the run's git dir isn't one of the repo's worktrees");
    return { path: dir, gitDir };
  }
  // The folder goes first: prune forgets only worktrees whose folder is missing, and a stale registration makes `add` fail.
  fs.rmSync(dir, { recursive: true, force: true });
  await git.run(repo, ["worktree", "prune"]);
  const add = () => git.run(repo, detachAt ? ["worktree", "add", "--no-checkout", "--detach", dir, detachAt] : ["worktree", "add", "--no-checkout", dir, branch]);
  try {
    await add();
  } catch (e) {
    // A run of an older engine can hold the branch in a worktree at a path the engine no longer derives (F-023 moved them).
    if (detachAt || !(await dropStaleCheckout(git, repo, path.dirname(path.dirname(dir)), dir, branch))) throw e;
    await add();
  }
  const link = fs.readFileSync(path.join(dir, ".git"), "utf8").trim();
  const m = /^gitdir: (.+)$/.exec(link);
  if (!m) throw new Error("git made a worktree without a gitdir link");
  const made = path.resolve(dir, m[1]!);
  if (!realPath(made).startsWith(path.join(common, "worktrees") + path.sep)) throw new Error("the new worktree's git dir isn't under the repo");
  const head = detachAt ?? (await git.revParse(repo, `refs/heads/${branch}`));
  if (!head) throw new Error(`no branch ${branch}`);
  await populateWorktree(git, repo, head, dir, made);
  return { path: dir, gitDir: made };
}

/**
 * Removes another worktree that has `branch` checked out, only when it is
 * one of the engine's own (under `root`), so git lets `dir` take the branch.
 * True when one was removed.
 */
async function dropStaleCheckout(git: Git, repo: string, root: string, dir: string, branch: string): Promise<boolean> {
  const list = await git.out(repo, ["worktree", "list", "--porcelain"]);
  const want = `branch refs/heads/${branch}`;
  let rootReal: string;
  try {
    rootReal = realPath(root);
  } catch {
    return false;
  }
  let dropped = false;
  for (const block of list.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim());
    const at = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!at || !lines.includes(want)) continue;
    let real: string;
    try {
      real = realPath(at);
    } catch {
      continue;
    }
    if (path.resolve(at) === path.resolve(dir) || !real.startsWith(rootReal + path.sep)) continue;
    await git.run(repo, ["worktree", "remove", "--force", at]);
    dropped = true;
  }
  return dropped;
}

const NAME_RE = /^factory-[a-z0-9-]{1,200}$/;

/**
 * At engine start: containers and networks left by an engine that didn't
 * shut down are removed, found by the `factory.run` label. A session volume
 * stays while its run can still resume (`keep`); any other goes, since its
 * files are sensitive.
 */
export async function sweepLeftovers(docker: DockerCli, keep: Set<string>, log: Logger): Promise<void> {
  const list = async (args: string[], o: { timeoutMs?: number } = {}) => (await docker.out(args, o)).split("\n").map((s) => s.trim()).filter((s) => NAME_RE.test(s));
  let containers: string[];
  try {
    // A list answers in well under a second; a Docker Desktop stuck starting accepts the pipe but never answers a filtered list.
    containers = await list(["ps", "--all", "--filter", "label=factory.run", "--format", "{{.Names}}"], { timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof DockerError && /\(timeout\)/.test(e.message)) {
      throw new DockerError("Docker didn't answer a container list within 15 s. Docker Desktop may be stuck starting: restart it, then restart the engine. Agent sessions fail until it answers.");
    }
    throw e;
  }
  for (const c of containers) {
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
