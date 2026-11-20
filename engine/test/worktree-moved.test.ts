import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareWorktree } from "../src/agent/runtime";
import { Git } from "../src/git";
import { Children } from "../src/proc";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";

function testGit(): Git {
  return new Git({ gitPath: GIT_PATH, homeDir: path.join(tmpdir(), "git"), children: new Children() });
}

describe("an analyst worktree at a path an older engine used", () => {
  it("gives the branch up to the new path when it is the engine's own", async () => {
    const repo = tmpdir();
    initRepo(repo, { "docs/a.md": "a\n" });
    git(repo, "branch", "feature/F-003-x");
    const root = path.join(tmpdir(), "worktrees");
    const old = path.join(root, "0123456789abcdef", "F-003");
    await prepareWorktree(testGit(), repo, old, "feature/F-003-x");
    const now = path.join(root, "mesbot", "F-003");
    const wt = await prepareWorktree(testGit(), repo, now, "feature/F-003-x");
    expect(wt.path).toBe(now);
    expect(fs.readFileSync(path.join(now, "docs/a.md"), "utf8")).toBe("a\n");
    expect(fs.existsSync(old)).toBe(false);
  });

  it("leaves a checkout outside the engine's folder alone and fails", async () => {
    const repo = tmpdir();
    initRepo(repo, { "docs/a.md": "a\n" });
    git(repo, "branch", "feature/F-003-x");
    const mine = path.join(tmpdir(), "owner-wt");
    git(repo, "worktree", "add", "-q", mine, "feature/F-003-x");
    await expect(prepareWorktree(testGit(), repo, path.join(tmpdir(), "worktrees", "mesbot", "F-003"), "feature/F-003-x")).rejects.toThrow();
    expect(fs.existsSync(mine)).toBe(true);
  });
});
