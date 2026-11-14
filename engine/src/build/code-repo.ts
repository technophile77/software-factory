import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir } from "../fsutil";
import type { Git } from "../git";
import type { AccountInfo } from "../github";

export class CodeRepoError extends Error {
  override name = "CodeRepoError";
}

export interface Identity {
  name: string;
  email: string;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// Control characters, and the angle brackets that would end git's name field early.
const BAD_NAME_RE = /[\u0000-\u001f\u007f-\u009f<>]/;

export function validCommitName(name: string): boolean {
  return name.trim().length >= 1 && name.length <= 100 && !BAD_NAME_RE.test(name);
}

/**
 * F-015 FR-17, SR-15: the owner's commit identity, from their GitHub account
 * and the project's own manifest; nothing about it lives in engine code. The
 * manifest's `commit_name` is the owner's own setting, so a bad one stops the
 * project (AC-31); a bad profile name falls back to the login with a Notice.
 */
export function commitIdentity(account: AccountInfo, pinnedId: number, commitName?: string): { identity: Identity; notice: string | null } {
  if (account.id !== pinnedId) throw new CodeRepoError("the GitHub account the token reads isn't the project's pinned owner.github_id");
  if (!LOGIN_RE.test(account.login)) throw new CodeRepoError("GitHub returned a malformed login");
  const email = `${account.id}+${account.login}@users.noreply.github.com`;
  if (commitName !== undefined) {
    if (!validCommitName(commitName)) throw new CodeRepoError("owner.commit_name in the project manifest has control characters, < or >, or is over 100 characters");
    return { identity: { name: commitName, email }, notice: null };
  }
  const profile = account.name ?? "";
  if (profile === "") return { identity: { name: account.login, email }, notice: null };
  if (validCommitName(profile)) return { identity: { name: profile, email }, notice: null };
  return { identity: { name: account.login, email }, notice: "Your GitHub profile name can't be used as a commit name (control characters, < or >, or over 100 characters), so code-repo commits use your login." };
}

/**
 * Where the engine fetches and pushes a manifest repo: its owner and name
 * (already checked by the manifest reader) under the GitHub base the engine
 * was given, never a URL the manifest spells out.
 */
export function codeRepoUrl(r: { owner: string; repo: string }, base: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(r.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(r.repo) || r.repo === "." || r.repo === "..") {
    throw new CodeRepoError("the repo isn't <owner>/<name>");
  }
  return `${base}/${r.owner}/${r.repo}.git`;
}

export interface FeatureBranches {
  feature: string;
  dev: string;
  test: string;
}

/** ADR 0005 names, from the feature's config-repo branch `feature/F-nnn-name`. */
export function featureBranches(fid: string, configBranch: string): FeatureBranches {
  if (!configBranch.startsWith(`feature/${fid}-`) && configBranch !== `feature/${fid}`) throw new CodeRepoError(`branch ${configBranch} isn't ${fid}'s`);
  return { feature: configBranch, dev: `feature/${fid}/dev`, test: `feature/${fid}/test` };
}

const MAIN = "refs/heads/main";

/**
 * The engine's two clones of one code repo (SR-7). `push.git` talks to
 * GitHub with the owner's token. `local.git` has no remote and an empty
 * credential helper; agent worktrees come from it, so an agent's
 * `git push` has nowhere to go and no stored credential to use. Code
 * crosses between the two only by the engine fetching from a path.
 */
export class CodeRepo {
  readonly pushDir: string;
  readonly localDir: string;

  constructor(private readonly git: Git, readonly root: string, readonly remote: { url: string; base: string }) {
    this.pushDir = path.join(root, "push.git");
    this.localDir = path.join(root, "local.git");
  }

  private transport(): string[] {
    if (path.isAbsolute(this.remote.url)) return ["-c", "protocol.file.allow=always"];
    return this.remote.base.startsWith("http://") ? ["-c", "protocol.http.allow=always"] : [];
  }

  async init(): Promise<void> {
    ensureOwnerDir(this.root);
    for (const dir of [this.pushDir, this.localDir]) {
      if (!fs.existsSync(path.join(dir, "HEAD"))) {
        fs.rmSync(dir, { recursive: true, force: true });
        await this.git.run(this.root, ["init", "--bare", "--initial-branch=main", dir]);
      }
    }
    // Set every time: anything an agent wrote to local.git's config is undone before the next session.
    await this.git.run(this.localDir, ["config", "credential.helper", ""]);
    const remotes = (await this.git.out(this.localDir, ["remote"])).split("\n").filter(Boolean);
    for (const r of remotes) await this.git.run(this.localDir, ["remote", "remove", r]);
  }

  /** Fetches GitHub's `main` into the push clone, then the local clone; returns its commit. */
  async fetchMain(token: string): Promise<string> {
    await this.git.run(this.pushDir, [...this.transport(), "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", this.remote.url, `+${MAIN}:${MAIN}`], { askpassToken: token });
    await this.fromPush(MAIN);
    const sha = await this.git.revParse(this.localDir, MAIN);
    if (!sha) throw new CodeRepoError("the code repo has no main branch");
    return sha;
  }

  private async fromPush(ref: string): Promise<void> {
    await this.git.run(this.localDir, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", this.pushDir, `+${ref}:${ref}`]);
  }

  /**
   * FR-10, SR-4: the one branch that leaves the owner's PC, at exactly `sha`.
   * It crosses from the local clone to the push clone by path, then to GitHub.
   */
  async pushFeature(branch: string, sha: string, token: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new CodeRepoError("malformed commit");
    const ref = `refs/heads/${branch}`;
    await this.git.run(this.pushDir, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", this.localDir, `+${ref}:${ref}`]);
    const at = await this.git.revParse(this.pushDir, ref);
    if (at !== sha) throw new CodeRepoError(`the branch moved from ${sha} before the push`);
    await this.git.run(this.pushDir, [...this.transport(), "push", "--no-verify", "--porcelain", this.remote.url, `${sha}:${ref}`], { askpassToken: token });
  }

  /** AC-1: the three branches from `main`, made once; an existing branch is kept as it is. */
  async ensureBranches(b: FeatureBranches, main: string): Promise<void> {
    for (const name of [b.feature, b.dev, b.test]) {
      if (await this.git.revParse(this.localDir, `refs/heads/${name}`)) continue;
      await this.git.run(this.localDir, ["update-ref", `refs/heads/${name}`, main, ""]);
    }
  }

  async head(branch: string): Promise<string | null> {
    return this.git.revParse(this.localDir, `refs/heads/${branch}`);
  }

  /**
   * FR-5: `dev` then `test` merged into the feature branch in an engine
   * worktree. A conflict leaves the feature branch where it was and names
   * the conflicted files, for the role that owns them (ADR 0013).
   */
  async mergeAgentBranches(b: FeatureBranches, worktree: string, identity: Identity, fid: string): Promise<{ status: "merged"; commit: string } | { status: "conflict"; files: string[] }> {
    const start = await this.head(b.feature);
    if (!start) throw new CodeRepoError(`no branch ${b.feature}`);
    fs.rmSync(worktree, { recursive: true, force: true });
    await this.git.run(this.localDir, ["worktree", "prune"]);
    ensureOwnerDir(path.dirname(worktree));
    await this.git.run(this.localDir, ["worktree", "add", "--detach", worktree, start]);
    try {
      let head = start;
      for (const [branch, what] of [[b.dev, "developer"], [b.test, "test engineer"]] as const) {
        const tip = await this.head(branch);
        if (!tip) throw new CodeRepoError(`no branch ${branch}`);
        const r = await this.git.run(worktree, ["-c", "merge.renames=true", "merge", "--no-ff", "--no-edit", "--no-verify", "-m", `${fid}: merge the ${what}'s branch`, tip], { identity, okCodes: [1] });
        if (r.code === 1) {
          const files = (await this.git.out(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
          await this.git.run(worktree, ["merge", "--abort"], { okCodes: [128] });
          return { status: "conflict", files };
        }
        head = await this.git.out(worktree, ["rev-parse", "HEAD"]);
      }
      await this.git.run(this.localDir, ["update-ref", `refs/heads/${b.feature}`, head, start]);
      return { status: "merged", commit: head };
    } finally {
      await this.git.run(this.localDir, ["worktree", "remove", "--force", worktree], { okCodes: [128] });
    }
  }
}
