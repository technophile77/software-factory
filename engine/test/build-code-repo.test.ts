import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodeRepo, CodeRepoError, codeRepoUrl, commitIdentity, featureBranches } from "../src/build/code-repo";
import { Git } from "../src/git";
import { Children } from "../src/proc";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";

const ACCOUNT = { id: 4401, login: "octo", name: "Octo Cat" };
const ID = { name: "Octo Cat", email: "4401+octo@users.noreply.github.com" };

describe("commit identity (FR-17, SR-15, AC-16, AC-31)", () => {
  it("uses the profile name and the noreply address", () => {
    expect(commitIdentity(ACCOUNT, 4401)).toEqual({ identity: ID, notice: null });
  });
  it("uses the login when the profile has no name", () => {
    expect(commitIdentity({ ...ACCOUNT, name: null }, 4401).identity.name).toBe("octo");
  });
  it("prefers owner.commit_name", () => {
    expect(commitIdentity(ACCOUNT, 4401, "Someone Else").identity).toEqual({ ...ID, name: "Someone Else" });
  });
  it("stops on a commit_name with control characters or over 100 characters", () => {
    expect(() => commitIdentity(ACCOUNT, 4401, "a\nb")).toThrow(CodeRepoError);
    expect(() => commitIdentity(ACCOUNT, 4401, "x".repeat(101))).toThrow(/over 100/);
    expect(() => commitIdentity(ACCOUNT, 4401, "Eve <e@x>")).toThrow(CodeRepoError);
  });
  it("falls back to the login with a notice for a bad profile name", () => {
    const r = commitIdentity({ ...ACCOUNT, name: "Bad\u0007Name" }, 4401);
    expect(r.identity.name).toBe("octo");
    expect(r.notice).toMatch(/login/);
  });
  it("stops when the account isn't the pinned owner", () => {
    expect(() => commitIdentity(ACCOUNT, 99)).toThrow(/pinned owner/);
  });
});

describe("code repo url", () => {
  it("puts owner/name under the engine's GitHub base", () => {
    expect(codeRepoUrl({ owner: "acme", repo: "app" }, "https://github.com")).toBe("https://github.com/acme/app.git");
    expect(codeRepoUrl({ owner: "acme", repo: "app" }, "http://127.0.0.1:9")).toBe("http://127.0.0.1:9/acme/app.git");
  });
  it.each([["ac/me", "app"], ["acme", ".."], ["acme", "a b"], ["-acme", "app"]])("refuses %s/%s", (owner, repo) => {
    expect(() => codeRepoUrl({ owner, repo }, "https://github.com")).toThrow(CodeRepoError);
  });
});

describe("feature branches (ADR 0005)", () => {
  it("names the feature and agent branches", () => {
    expect(featureBranches("F-002", "feature/F-002-tuning")).toEqual({ feature: "feature/F-002-tuning", dev: "feature/F-002/dev", test: "feature/F-002/test" });
    expect(() => featureBranches("F-002", "feature/F-003-x")).toThrow(CodeRepoError);
  });
});

describe("engine clones (SR-7, AC-1, AC-24, FR-5)", () => {
  function setup() {
    const root = tmpdir();
    const origin = path.join(root, "origin");
    initRepo(origin, { "src/app.js": "export const a = 1;\n", "README.md": "app\n" });
    const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "home"), children: new Children() });
    const repo = new CodeRepo(g, path.join(root, "code"), { url: origin, base: "https://github.com" });
    return { root, origin, g, repo };
  }

  it("the local clone has no remote and an empty credential helper, and gets main from the push clone", async () => {
    const { origin, repo } = setup();
    await repo.init();
    git(repo.localDir, "remote", "add", "origin", origin);
    await repo.init();
    expect(git(repo.localDir, "remote")).toBe("");
    expect(git(repo.localDir, "config", "--get", "credential.helper")).toBe("");
    const main = await repo.fetchMain("token");
    expect(main).toBe(git(origin, "rev-parse", "main"));
    expect(git(repo.pushDir, "rev-parse", "main")).toBe(main);
  });

  it("makes the three branches from main once and merges dev and test as the owner", async () => {
    const { root, repo, g } = setup();
    await repo.init();
    const main = await repo.fetchMain("t");
    const b = featureBranches("F-001", "feature/F-001-app");
    await repo.ensureBranches(b, main);
    for (const n of [b.feature, b.dev, b.test]) expect(await repo.head(n)).toBe(main);
    const commitOn = (branch: string, file: string, text: string) => {
      const wt = path.join(root, `wt-${branch.replace(/\//g, "-")}`);
      git(repo.localDir, "worktree", "add", "-q", wt, branch);
      fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
      fs.writeFileSync(path.join(wt, file), text);
      git(wt, "add", "-A");
      git(wt, "commit", "-qm", "work");
      git(repo.localDir, "worktree", "remove", "--force", wt);
    };
    commitOn(b.dev, "src/app.js", "export const a = 2;\n");
    commitOn(b.test, "test/app.test.js", "test\n");
    await repo.ensureBranches(b, main);
    expect(await repo.head(b.dev)).not.toBe(main);
    const r = await repo.mergeAgentBranches(b, path.join(root, "merge-wt"), ID, "F-001");
    expect(r.status).toBe("merged");
    const head = (r as { commit: string }).commit;
    expect(await repo.head(b.feature)).toBe(head);
    expect(git(repo.localDir, "show", "-s", "--format=%an <%ae>|%cn <%ce>|%s", head)).toBe(`${ID.name} <${ID.email}>|${ID.name} <${ID.email}>|F-001: merge the test engineer's branch`);
    expect(git(repo.localDir, "show", `${head}:test/app.test.js`)).toBe("test");
    expect(git(repo.localDir, "show", `${head}:src/app.js`)).toBe("export const a = 2;");
    expect(fs.existsSync(path.join(root, "merge-wt"))).toBe(false);
    void g;
  });

  it("a conflict leaves the feature branch where it was and names the files", async () => {
    const { root, repo } = setup();
    await repo.init();
    const main = await repo.fetchMain("t");
    const b = featureBranches("F-001", "feature/F-001-app");
    await repo.ensureBranches(b, main);
    for (const [branch, text] of [[b.dev, "dev\n"], [b.test, "test\n"]] as const) {
      const wt = path.join(root, `wt-${branch.replace(/\//g, "-")}`);
      git(repo.localDir, "worktree", "add", "-q", wt, branch);
      fs.writeFileSync(path.join(wt, "README.md"), text);
      git(wt, "commit", "-qam", "edit");
      git(repo.localDir, "worktree", "remove", "--force", wt);
    }
    const r = await repo.mergeAgentBranches(b, path.join(root, "merge-wt"), ID, "F-001");
    expect(r).toEqual({ status: "conflict", files: ["README.md"] });
    expect(await repo.head(b.feature)).toBe(main);
  });
});
