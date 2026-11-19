import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_DIR, placeCodeCopies, removeCodeCopies } from "../src/agent/code-copies";
import { commitWorktree } from "../src/agent/worktree-commit";
import { Git } from "../src/git";
import type { SecretsScanner } from "../src/gitleaks";
import { allowedBy } from "../src/policy/glob";
import { effectiveRole } from "../src/policy/role-policy";
import { Children } from "../src/proc";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";
import { policyDoc } from "./policy-fixture";

const posix = process.platform !== "win32";
const cleanScanner: SecretsScanner = { scan: async () => ({ clean: true }) };

function testGit(): Git {
  return new Git({ gitPath: GIT_PATH, homeDir: path.join(tmpdir(), "git"), children: new Children() });
}

/** A code repo with a link and a token-bearing remote, as the engine's clone must never pass on. */
function codeRepo(): { dir: string; commit: string } {
  const dir = tmpdir();
  initRepo(dir, { "bot/main.py": "print('hi')\n", "run.sh": "#!/bin/sh\n" });
  if (posix) {
    fs.chmodSync(path.join(dir, "run.sh"), 0o755);
    fs.symlinkSync("/etc/hosts", path.join(dir, "hosts"));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "link");
  }
  git(dir, "remote", "add", "origin", "https://x-access-token:secret@github.com/example-org/bot.git");
  return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

function configWorktree() {
  const main = tmpdir();
  initRepo(main, { "docs/features/F-001-x.md": "spec\n" });
  const wt = path.join(tmpdir(), "wt");
  git(main, "worktree", "add", "-q", "-b", "feature/F-001-x", wt);
  const gitDir = git(wt, "rev-parse", "--absolute-git-dir");
  const base = git(wt, "rev-parse", "HEAD");
  const policy = effectiveRole(policyDoc(), "requirements-analyst");
  return { wt, gitDir, base, policy };
}

describe("F-007 FR-15: the analyst's copies of the code repos", () => {
  it("AC-22: each repo's main as plain files, with no .git, link or credential", async () => {
    const code = codeRepo();
    const { wt } = configWorktree();
    const c = await placeCodeCopies(testGit(), wt, [{ name: "bot", load: async () => code }]);
    expect(c.placed).toEqual([{ name: "bot", commit: code.commit }]);
    expect(c.missing).toEqual([]);
    const root = path.join(wt, CODE_DIR, "bot");
    expect(fs.readFileSync(path.join(root, "bot/main.py"), "utf8")).toBe("print('hi')\n");
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(root, "hosts"))).toBe(false);
    expect([...c.files.keys()].sort()).toEqual([`${CODE_DIR}/bot/bot/main.py`, `${CODE_DIR}/bot/run.sh`]);
    const all = fs.readdirSync(path.join(wt, CODE_DIR), { recursive: true }).map(String);
    for (const f of all) {
      const full = path.join(wt, CODE_DIR, f);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, "utf8")).not.toContain("secret");
    }
  });

  it("a repo that can't be fetched is left out and reported; the others are placed", async () => {
    const code = codeRepo();
    const { wt } = configWorktree();
    const c = await placeCodeCopies(testGit(), wt, [
      { name: "gone", load: async () => { throw new Error("no token is stored for example-org"); } },
      { name: "bot", load: async () => code },
    ]);
    expect(c.placed.map((x) => x.name)).toEqual(["bot"]);
    expect(c.missing.map((x) => [x.name, (x.error as Error).message])).toEqual([["gone", "no token is stored for example-org"]]);
    expect(fs.existsSync(path.join(wt, CODE_DIR, "gone"))).toBe(false);
  });

  it("an unchanged copy is never committed; the spec edit is", async () => {
    const code = codeRepo();
    const { wt, gitDir, base, policy } = configWorktree();
    const c = await placeCodeCopies(testGit(), wt, [{ name: "bot", load: async () => code }]);
    fs.writeFileSync(path.join(wt, "docs/features/F-001-x.md"), "spec v2\n");
    const r = await commitWorktree({
      git: testGit(), gitDir, worktree: wt, branch: "feature/F-001-x", base, policy, scanner: cleanScanner,
      tmpDir: path.join(tmpdir(), "t"), message: "analyst session", limits: { maxFiles: 1000, maxTotalBytes: 1 << 20, maxFileBytes: 1 << 20 }, frozen: c.files,
    });
    expect(r.status).toBe("committed");
    const head = git(wt, "rev-parse", "feature/F-001-x");
    expect(git(wt, "diff-tree", "-r", "--name-only", "--no-commit-id", base, head)).toBe("docs/features/F-001-x.md");
  });

  it.each([
    ["a changed file", (root: string) => fs.writeFileSync(path.join(root, "bot/main.py"), "evil\n"), `${CODE_DIR}/bot/bot/main.py`],
    ["a new file", (root: string) => fs.writeFileSync(path.join(root, "new.py"), "x\n"), `${CODE_DIR}/bot/new.py`],
    ["a removed file", (root: string) => fs.rmSync(path.join(root, "run.sh")), `${CODE_DIR}/bot/run.sh`],
  ])("AC-22: %s in the copy rejects the session", async (_what, change, breach) => {
    const code = codeRepo();
    const { wt, gitDir, base, policy } = configWorktree();
    const c = await placeCodeCopies(testGit(), wt, [{ name: "bot", load: async () => code }]);
    change(path.join(wt, CODE_DIR, "bot"));
    fs.writeFileSync(path.join(wt, "docs/features/F-001-x.md"), "spec v2\n");
    const r = await commitWorktree({
      git: testGit(), gitDir, worktree: wt, branch: "feature/F-001-x", base, policy, scanner: cleanScanner,
      tmpDir: path.join(tmpdir(), "t"), message: "analyst session", limits: { maxFiles: 1000, maxTotalBytes: 1 << 20, maxFileBytes: 1 << 20 }, frozen: c.files,
    });
    expect(r).toEqual({ status: "rejected", breaches: [{ path: breach, reason: "not_allowed" }] });
    expect(git(wt, "rev-parse", "feature/F-001-x")).toBe(base);
  });

  it("AC-22: the analyst's write rules refuse the copy", () => {
    const policy = effectiveRole(policyDoc(), "requirements-analyst");
    expect(allowedBy(policy.write, `${CODE_DIR}/bot/x.py`)).toBe(false);
    expect(allowedBy(policy.read, `${CODE_DIR}/bot/x.py`)).toBe(true);
    expect(allowedBy(policy.read, `${CODE_DIR}/bot/.env`)).toBe(false);
  });

  it("is removed when the session is over", async () => {
    const code = codeRepo();
    const { wt } = configWorktree();
    await placeCodeCopies(testGit(), wt, [{ name: "bot", load: async () => code }]);
    removeCodeCopies(wt);
    expect(fs.existsSync(path.join(wt, CODE_DIR))).toBe(false);
  });
});
