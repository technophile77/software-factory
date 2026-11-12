import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeLimits, commitWorktree } from "../src/agent/worktree-commit";
import { rejectSession, writeBreaches } from "../src/agent/write-check";
import { Git } from "../src/git";
import type { SecretsScanner } from "../src/gitleaks";
import { allowedBy, globError, globMatch, worktreeRelative } from "../src/policy/glob";
import { effectiveRole } from "../src/policy/role-policy";
import { Children } from "../src/proc";
import { SecretFound } from "../src/state/state-repo";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";
import { ANALYST, READER, policyDoc } from "./policy-fixture";

const posix = process.platform !== "win32";

describe("Role policy glob dialect (H-0046)", () => {
  it("refuses what other glob libraries read differently", () => {
    for (const g of ["/abs", "C:/x", "a\\b", "a?", "[ab]", "{a,b}", "@(a)", "!(a)", "+(a)", "a/../b", "a/./b", "a//b", "..", "a/**b", "x\u0065\u0301"]) {
      expect(globError(g), g).not.toBeNull();
    }
    for (const g of ["**", "src/**", "*.md", "**/.env", ".factory/runs/**/x-*.json"]) expect(globError(g), g).toBeNull();
  });

  it("* stays within a segment and matches dot files; ** matches zero or more segments", () => {
    expect(globMatch("*.md", "README.md", false)).toBe(true);
    expect(globMatch("*.md", "docs/README.md", false)).toBe(false);
    expect(globMatch("*", ".env", false)).toBe(true);
    expect(globMatch("**/.env", ".env", false)).toBe(true);
    expect(globMatch("**/.env", "a/b/.env", false)).toBe(true);
    expect(globMatch("src/**", "src", false)).toBe(true);
    expect(globMatch("src/**", "src/a/b.ts", false)).toBe(true);
    expect(globMatch("src/**", "srcx/a", false)).toBe(false);
    expect(globMatch("**", "", false)).toBe(true);
    expect(globMatch("a/**/b/**/c", "a/x/y/b/c", false)).toBe(true);
    expect(globMatch("**/**/**/**/**/**/**/**/z", "a/".repeat(200) + "y", false)).toBe(false);
  });

  it("deny matches case-insensitively, allow case-sensitively; deny wins", () => {
    const r = { allow: ["docs/**"], deny: ["**/.ENV"] };
    expect(allowedBy(r, "docs/a.md")).toBe(true);
    expect(allowedBy(r, "Docs/a.md")).toBe(false);
    expect(allowedBy(r, "docs/.env")).toBe(false);
    expect(allowedBy({ allow: [], deny: [] }, "a")).toBe(false);
  });

  it.skipIf(!posix)("the path rule follows links and refuses one that leaves the worktree", () => {
    const wt = tmpdir();
    const out = tmpdir();
    fs.mkdirSync(path.join(wt, "docs"));
    fs.symlinkSync(out, path.join(wt, "docs", "away"));
    fs.symlinkSync(path.join(wt, "docs"), path.join(wt, "inside"));
    expect(worktreeRelative(wt, path.join(wt, "docs", "new", "file.md"))).toBe("docs/new/file.md");
    expect(worktreeRelative(wt, path.join(wt, "inside", "x.md"))).toBe("docs/x.md");
    expect(worktreeRelative(wt, wt)).toBe("");
    expect(() => worktreeRelative(wt, path.join(wt, "docs", "away", "x"))).toThrow(/outside/);
    expect(() => worktreeRelative(wt, path.join(wt, "..", "elsewhere"))).toThrow(/outside/);
  });
});

describe("Role policy v2.5 from the manifest", () => {
  it("resolves the analyst and the fixed web reader", () => {
    const a = effectiveRole(policyDoc(), "requirements-analyst");
    expect(a.tools).toEqual(["Read", "Grep", "Glob", "Write", "Edit", "Skill"]);
    expect(effectiveRole(policyDoc(), "web-reader").network).toEqual(["*"]);
  });

  it("refuses a missing role, a missing core role, missing secret denies, and an open-web role with file tools", () => {
    expect(() => effectiveRole(policyDoc({ "web-reader": undefined }), "web-reader")).toThrow(/may not run/);
    expect(() => effectiveRole(policyDoc({ "test-engineer": undefined }), "requirements-analyst")).toThrow(/core role test-engineer/);
    expect(() => effectiveRole(policyDoc({ "requirements-analyst": { ...ANALYST, read: { allow: ["**"], deny: [] } } }), "requirements-analyst")).toThrow(/read.deny must hold/);
    expect(() => effectiveRole(policyDoc({ "requirements-analyst": { ...ANALYST, network: { allow: ["*"] } } }), "requirements-analyst")).toThrow(/"\*" is only/);
    expect(() => effectiveRole(policyDoc({ "requirements-analyst": { ...ANALYST, write: { allow: ["src/**"], deny: [] } } }), "requirements-analyst")).toThrow(/write.deny must hold/);
    expect(() => effectiveRole(policyDoc({ "web-reader": { ...READER, tools: { allow: ["WebFetch", "WebSearch"] } } }), "web-reader")).toThrow(/fixed/);
    expect(() => effectiveRole(policyDoc({ "requirements-analyst": { ...ANALYST, tools: { allow: ["Telepathy"] } } }), "requirements-analyst")).toThrow(/unknown tool/);
    expect(() => effectiveRole(policyDoc({ "requirements-analyst": { ...ANALYST, extra: 1 } }), "requirements-analyst")).toThrow(/not a policy key/);
  });

  it("a repo override replaces allow lists, adds denies, and may not add tools", () => {
    const repos = [{ name: "app", url: "u", policy: { roles: { "requirements-analyst": { write: { allow: ["docs/**"], deny: ["docs/secret/**"] } } } } }];
    const r = effectiveRole(policyDoc({}, repos), "requirements-analyst", "app");
    expect(r.write.allow).toEqual(["docs/**"]);
    expect(r.write.deny).toContain("docs/secret/**");
    expect(r.write.deny).toContain(".github/**");
    const adds = [{ name: "app", url: "u", policy: { roles: { "requirements-analyst": { tools: { allow: ["Read", "Bash"] } } } } }];
    expect(() => effectiveRole(policyDoc({}, adds), "requirements-analyst", "app")).toThrow(/may not add tools/);
  });
});

function testGit(): Git {
  return new Git({ gitPath: GIT_PATH, homeDir: path.join(tmpdir(), "git"), children: new Children() });
}

const cleanScanner: SecretsScanner = { scan: async () => ({ clean: true }) };

describe("end-of-session write check (FR-9, SR-12, AC-9)", () => {
  function repo() {
    const dir = tmpdir();
    initRepo(dir, { "docs/features/F-001-x.md": "spec\n", "README.md": "r\n" });
    return { dir, base: git(dir, "rev-parse", "HEAD") };
  }
  const policy = effectiveRole(policyDoc(), "requirements-analyst");

  it("passes changes inside the write rules and flags the rest", async () => {
    const { dir, base } = repo();
    fs.writeFileSync(path.join(dir, "docs/features/F-001-x.md"), "spec v2\n");
    git(dir, "commit", "-qam", "ok");
    const ok = git(dir, "rev-parse", "HEAD");
    expect(await writeBreaches(testGit(), dir, base, ok, policy)).toEqual([]);
    fs.writeFileSync(path.join(dir, "README.md"), "changed\n");
    fs.mkdirSync(path.join(dir, ".github"));
    fs.writeFileSync(path.join(dir, ".github", "ci.yml"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "bad");
    const head = git(dir, "rev-parse", "HEAD");
    const b = await writeBreaches(testGit(), dir, base, head, policy);
    expect(b.map((x) => x.path).sort()).toEqual([".github/ci.yml", "README.md"]);
  });

  it.skipIf(!posix)("flags a new symlink even where writes are allowed", async () => {
    const { dir, base } = repo();
    fs.symlinkSync("/etc/passwd", path.join(dir, "docs/features/link.md"));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "link");
    expect(await writeBreaches(testGit(), dir, base, git(dir, "rev-parse", "HEAD"), policy)).toEqual([{ path: "docs/features/link.md", reason: "symlink" }]);
  });

  it("flags a branch that no longer descends from its start, and rejects by moving the branch back", async () => {
    const { dir, base } = repo();
    git(dir, "checkout", "-q", "--orphan", "other");
    git(dir, "commit", "-qm", "orphan");
    const other = git(dir, "rev-parse", "HEAD");
    expect(await writeBreaches(testGit(), dir, base, other, policy)).toEqual([{ path: "", reason: "history" }]);
    git(dir, "checkout", "-q", "main");
    fs.writeFileSync(path.join(dir, "README.md"), "x\n");
    git(dir, "commit", "-qam", "bad");
    const head = git(dir, "rev-parse", "HEAD");
    await rejectSession(testGit(), dir, "main", base, head);
    expect(git(dir, "rev-parse", "main")).toBe(base);
  });
});

describe("worktree commit (FR-11 with the FR-9 check)", () => {
  function setup() {
    const main = tmpdir();
    initRepo(main, { "docs/features/F-001-x.md": "spec\n", "README.md": "r\n" });
    const wt = path.join(tmpdir(), "wt");
    git(main, "worktree", "add", "-q", "-b", "feature/F-001-x", wt);
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
    const base = git(wt, "rev-parse", "HEAD");
    const policy = effectiveRole(policyDoc(), "requirements-analyst");
    const input = (scanner = cleanScanner, lim: Partial<WorktreeLimits> = {}) => ({
      git: testGit(), gitDir, worktree: wt, branch: "feature/F-001-x", base, policy, scanner,
      tmpDir: path.join(tmpdir(), "t"), message: "analyst session", limits: { maxFiles: 1000, maxTotalBytes: 1 << 20, maxFileBytes: 1 << 20, ...lim },
    });
    return { main, wt, base, input };
  }

  it("commits allowed edits to the branch with git's plumbing", async () => {
    const { wt, base, input } = setup();
    expect(await commitWorktree(input())).toEqual({ status: "unchanged" });
    fs.writeFileSync(path.join(wt, "docs/features/F-001-x.md"), "spec v2\n");
    fs.writeFileSync(path.join(wt, "docs/features/notes.md"), "n\n");
    const r = await commitWorktree(input());
    expect(r.status).toBe("committed");
    const head = git(wt, "rev-parse", "feature/F-001-x");
    expect(head).not.toBe(base);
    expect(git(wt, "show", `${head}:docs/features/F-001-x.md`)).toBe("spec v2");
    expect(git(wt, "diff-tree", "-r", "--name-only", "--no-commit-id", base, head).split("\n").sort()).toEqual(["docs/features/F-001-x.md", "docs/features/notes.md"]);
  });

  it("AC-9: a write outside the rules commits nothing", async () => {
    const { wt, base, input } = setup();
    fs.writeFileSync(path.join(wt, "docs/features/F-001-x.md"), "spec v2\n");
    fs.mkdirSync(path.join(wt, ".husky"));
    fs.writeFileSync(path.join(wt, ".husky", "pre-commit"), "curl evil\n");
    const r = await commitWorktree(input());
    expect(r).toEqual({ status: "rejected", breaches: [{ path: ".husky/pre-commit", reason: "not_allowed" }] });
    expect(git(wt, "rev-parse", "feature/F-001-x")).toBe(base);
  });

  it.skipIf(!posix)("a new symlink or a rewritten .git link rejects the session", async () => {
    const a = setup();
    fs.symlinkSync("/etc/hosts", path.join(a.wt, "docs/features/hosts.md"));
    expect((await commitWorktree(a.input())).status).toBe("rejected");
    const b = setup();
    fs.writeFileSync(path.join(b.wt, ".git"), "gitdir: /tmp/evil\n");
    expect(await commitWorktree(b.input())).toMatchObject({ status: "rejected", breaches: [{ path: ".git" }] });
  });

  it("a secret in the change commits nothing", async () => {
    const { wt, base, input } = setup();
    fs.writeFileSync(path.join(wt, "docs/features/F-001-x.md"), "token\n");
    const hit: SecretsScanner = { scan: async (blobs) => ({ clean: false, blobs: blobs.map((b) => b.sha), rules: ["generic"] }) };
    await expect(commitWorktree(input(hit))).rejects.toBeInstanceOf(SecretFound);
    expect(git(wt, "rev-parse", "feature/F-001-x")).toBe(base);
  });

  it("H-0087: a change over a cap commits nothing and names the cap", async () => {
    const { wt, base, input } = setup();
    const feat = (n: string) => path.join(wt, "docs/features", n);
    fs.writeFileSync(feat("a.md"), "a\n");
    fs.writeFileSync(feat("b.md"), "b\n");
    expect(await commitWorktree(input(cleanScanner, { maxFiles: 1 }))).toEqual({ status: "over_limit", cap: "files changed" });
    fs.rmSync(feat("b.md"));
    fs.rmSync(feat("F-001-x.md"));
    // A removed file counts as a changed one.
    expect(await commitWorktree(input(cleanScanner, { maxFiles: 1 }))).toEqual({ status: "over_limit", cap: "files changed" });
    fs.writeFileSync(feat("F-001-x.md"), "spec\n");
    fs.writeFileSync(feat("a.md"), "x".repeat(101));
    expect(await commitWorktree(input(cleanScanner, { maxFileBytes: 100 }))).toEqual({ status: "over_limit", cap: "largest file" });
    fs.writeFileSync(feat("b.md"), "y".repeat(100));
    expect(await commitWorktree(input(cleanScanner, { maxFileBytes: 101, maxTotalBytes: 200 }))).toEqual({ status: "over_limit", cap: "total size" });
    expect(git(wt, "rev-parse", "feature/F-001-x")).toBe(base);
    // Exactly at each cap is within it.
    expect((await commitWorktree(input(cleanScanner, { maxFiles: 2, maxFileBytes: 101, maxTotalBytes: 201 }))).status).toBe("committed");
  });

  it("H-0087: unchanged files don't count, however large", async () => {
    const { wt, input } = setup();
    // README.md is in the base and stays as it is; a same-size rewrite still counts.
    expect(await commitWorktree(input(cleanScanner, { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 }))).toEqual({ status: "unchanged" });
    fs.writeFileSync(path.join(wt, "docs/features/F-001-x.md"), "Spec\n");
    expect(await commitWorktree(input(cleanScanner, { maxFiles: 1, maxFileBytes: 4 }))).toEqual({ status: "over_limit", cap: "largest file" });
    expect((await commitWorktree(input(cleanScanner, { maxFiles: 1, maxFileBytes: 5, maxTotalBytes: 5 }))).status).toBe("committed");
  });

  it("AC-9 still holds past a cap: a write or a removal outside the rules rejects the session", async () => {
    const { wt, input } = setup();
    fs.writeFileSync(path.join(wt, "docs/features/a.md"), "a\n");
    fs.writeFileSync(path.join(wt, "evil.sh"), "x\n");
    expect(await commitWorktree(input(cleanScanner, { maxFiles: 1 }))).toEqual({ status: "rejected", breaches: [{ path: "evil.sh", reason: "not_allowed" }] });
    fs.rmSync(path.join(wt, "evil.sh"));
    fs.rmSync(path.join(wt, "README.md"));
    expect(await commitWorktree(input(cleanScanner, { maxFiles: 1 }))).toEqual({ status: "rejected", breaches: [{ path: "README.md", reason: "not_allowed" }] });
  });
});
