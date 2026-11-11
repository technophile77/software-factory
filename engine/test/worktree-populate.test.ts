// Security Gate 2, H2: the branch tree written into an analyst worktree on
// the host can't steer a write outside it, through a link, a name the file
// system reads as another, or a folder that turns out to be a link.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { populateWorktree } from "../src/agent/runtime";
import { TreeEntry, WorktreeRefused, badSegment, caseInsensitiveAt, checkTree, writeNew } from "../src/agent/worktree-populate";
import { Git } from "../src/git";
import { Children } from "../src/proc";
import { canSymlink, needsSymlinks } from "./acceptance/support/platform";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";

const blob = (p: string, mode = "100644"): TreeEntry => ({ mode, type: "blob", sha: "a".repeat(40), path: p });

/** A git that serves a crafted tree, as a pushed tree object can be. */
function craftedGit(entries: TreeEntry[], content: Record<string, string>): Git {
  const bySha = (sha: string) => Buffer.from(content[sha] ?? "x");
  return {
    lsTree: async () => entries,
    catBlobs: async (_r: string, shas: string[]) => new Map(shas.map((s) => [s, bySha(s)])),
    catBlob: async (_r: string, sha: string) => bySha(sha),
    run: async () => ({ code: 0, signal: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false }),
  } as unknown as Git;
}

describe("H2: populating a worktree from a branch tree", () => {
  it("refuses a symbolic link or a submodule anywhere in the tree, before touching the worktree", async () => {
    for (const bad of [[{ ...blob("docs"), mode: "120000" }, blob("docs/evil.txt")], [blob("a.md"), { mode: "160000", type: "commit", sha: "b".repeat(40), path: "vendor/lib" }]]) {
      const wt = tmpdir();
      const outside = tmpdir();
      fs.writeFileSync(path.join(wt, "keep.md"), "kept");
      await expect(populateWorktree(craftedGit(bad, { ["a".repeat(40)]: outside }), "/repo", "c".repeat(40), wt, "/gitdir")).rejects.toBeInstanceOf(WorktreeRefused);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.readFileSync(path.join(wt, "keep.md"), "utf8")).toBe("kept");
    }
  });

  it("refuses names that are .git, or that Windows would read as another name", () => {
    for (const s of [".git", ".GIT", "", ".", ".."]) {
      expect(badSegment(s, "linux"), s).not.toBeNull();
      expect(badSegment(s, "win32"), s).not.toBeNull();
    }
    for (const s of ["docs.", "docs ", "a:b", "file.txt:stream", "CON", "con.txt", "Aux.c", "nul", "COM1.log", "lpt9", "GIT~1", "DOCUME~1", "a<b", "a|b", "a\x01b"]) {
      expect(badSegment(s, "win32"), s).not.toBeNull();
    }
    // On Linux these are ordinary names, so a Linux project that has them still runs.
    for (const s of ["aux.c", "con.txt", "a:b", "docs.", "x~1"]) expect(badSegment(s, "linux"), s).toBeNull();
    for (const s of ["README.md", "src", "a.b.c", "~tilde"]) expect(badSegment(s, "win32"), s).toBeNull();
    expect(() => checkTree([blob("x/.git/config")], false, "linux")).toThrow(WorktreeRefused);
    expect(() => checkTree([blob("src/aux.c")], false, "win32")).toThrow(/device name/);
    expect(() => checkTree([blob("Docs./a.md")], false, "win32")).toThrow(/dot or space/);
  });

  it("refuses paths the file system would treat as one: case, Unicode form, file against folder", () => {
    expect(() => checkTree([blob("Docs/x.md"), blob("docs/y.md")], true, "linux")).toThrow(/same folder/);
    expect(() => checkTree([blob("README.md"), blob("readme.md")], true, "win32")).toThrow(/same file/);
    expect(() => checkTree([blob("docs"), blob("DOCS/x.md")], true, "darwin")).toThrow(/both a file and a folder/);
    expect(() => checkTree([blob("café.md"), blob("café.md")], true, "darwin")).toThrow(/same file/);
    expect(() => checkTree([blob("a‌.md"), blob("a.md")], true, "darwin")).toThrow(/same file/);
    // A case-sensitive file system keeps them apart.
    expect(() => checkTree([blob("Docs/x.md"), blob("docs/y.md"), blob("README.md"), blob("readme.md")], false, "linux")).not.toThrow();
    expect(() => checkTree([blob("docs/a.md"), blob("docs/b.md"), blob("src/docs/a.md")], true, "win32")).not.toThrow();
  });

  it("finds out whether the worktree's file system ignores case", () => {
    const d = tmpdir();
    fs.writeFileSync(path.join(d, "probe-a"), "");
    const expected = fs.existsSync(path.join(d, "PROBE-A"));
    expect(caseInsensitiveAt(d)).toBe(expected);
    expect(fs.readdirSync(d)).toEqual(["probe-a"]);
  });

  it("writes each file new, and never over an existing name", () => {
    const wt = tmpdir();
    writeNew(wt, "docs/deep/a.md", Buffer.from("a"), false);
    writeNew(wt, "run.sh", Buffer.from("#!/bin/sh\n"), true);
    expect(fs.readFileSync(path.join(wt, "docs", "deep", "a.md"), "utf8")).toBe("a");
    if (process.platform !== "win32") expect(fs.statSync(path.join(wt, "run.sh")).mode & 0o111).not.toBe(0);
    expect(() => writeNew(wt, "docs/deep/a.md", Buffer.from("b"), false)).toThrow(/already wrote/);
    expect(fs.readFileSync(path.join(wt, "docs", "deep", "a.md"), "utf8")).toBe("a");
  });

  it.skipIf(!canSymlink())(needsSymlinks("refuses to write through a folder that is a link, or over a file that is one"), () => {
    const wt = tmpdir();
    const outside = tmpdir();
    fs.symlinkSync(outside, path.join(wt, "docs"));
    expect(() => writeNew(wt, "docs/evil.txt", Buffer.from("x"), false)).toThrow(WorktreeRefused);
    fs.mkdirSync(path.join(wt, "a"));
    fs.symlinkSync(path.join(outside, "target"), path.join(wt, "a", "f.txt"));
    expect(() => writeNew(wt, "a/f.txt", Buffer.from("x"), false)).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("populates a real branch: files, the executable bit and the index, and refuses one with a link", async () => {
    const root = tmpdir();
    const repo = path.join(root, "repo");
    initRepo(repo, { "README.md": "hi\n", "docs/features/F-001.md": "spec\n", "tool.sh": "#!/bin/sh\n" });
    git(repo, "update-index", "--chmod=+x", "tool.sh");
    git(repo, "commit", "-qm", "exec");
    const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "home"), children: new Children() });
    const wt = path.join(root, "wt");
    git(repo, "worktree", "add", "-q", "--no-checkout", wt, "-b", "feature/x");
    const gitDir = path.join(repo, ".git", "worktrees", "wt");
    await populateWorktree(g, repo, git(repo, "rev-parse", "HEAD"), wt, gitDir);
    expect(fs.readFileSync(path.join(wt, "docs", "features", "F-001.md"), "utf8")).toBe("spec\n");
    if (process.platform !== "win32") expect(fs.statSync(path.join(wt, "tool.sh")).mode & 0o111).not.toBe(0);
    expect(git(wt, "status", "--porcelain")).toBe("");
    if (!canSymlink()) return;
    fs.symlinkSync("/etc", path.join(repo, "etc-link"));
    git(repo, "add", "etc-link");
    git(repo, "commit", "-qm", "link");
    await expect(populateWorktree(g, repo, git(repo, "rev-parse", "HEAD"), wt, gitDir)).rejects.toThrow(/symbolic link \(etc-link\)/);
    // Refused before anything was removed or written.
    expect(fs.readFileSync(path.join(wt, "README.md"), "utf8")).toBe("hi\n");
  });
});
