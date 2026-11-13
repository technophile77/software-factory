import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Git, GitError } from "../src/git";
import { CatFileReader, ReaderBroken, ReaderLimit, TreeError, parseTree } from "../src/git-reader";
import { Children } from "../src/proc";
import { GIT_PATH, git, initRepo, tmpdir } from "./helpers";

// F-014: reads through one `cat-file --batch-command` per repo give exactly
// what the plain git calls gave, and fall back to them when the reader fails.

function fixture(): { repo: string; head: string } {
  const repo = path.join(tmpdir(), "repo");
  initRepo(repo, {
    "a.txt": "a\n",
    "dir/b.txt": "b\n",
    "dir/sub/c.txt": "c\n",
    "dir/with space.txt": "s\n",
    "dir/ünï.txt": "u\n",
    "skills/x/SKILL.md": "x\n",
    "agents/r/AGENT.md": "r\n",
    "engine/config/limits.yaml": "l: 1\n",
  });
  fs.writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\n");
  git(repo, "add", "run.sh");
  git(repo, "update-index", "--chmod=+x", "run.sh");
  const blob = git(repo, "rev-parse", "HEAD:a.txt");
  git(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},link`);
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${git(repo, "rev-parse", "HEAD")},mod`);
  git(repo, "commit", "-qm", "more");
  return { repo, head: git(repo, "rev-parse", "HEAD") };
}

const make = (o: { readers?: boolean; gitPath?: string; idleMs?: number } = {}) =>
  new Git({ gitPath: o.gitPath ?? GIT_PATH, homeDir: path.join(tmpdir(), "h"), children: new Children(), readers: o.readers, readerIdleMs: o.idleMs });

describe("F-014 reader parity (FR-1)", () => {
  it("gives the same refs, listings and blobs as plain git calls", async () => {
    const { repo, head } = fixture();
    const fast = make();
    const plain = make({ readers: false });
    for (const ref of ["refs/heads/main", "HEAD", head, "refs/heads/none", `${head.slice(0, 39)}0`]) {
      expect(await fast.revParse(repo, ref), ref).toBe(await plain.revParse(repo, ref));
    }
    for (const f of ["a.txt", "dir", "dir/sub/c.txt", "dir/with space.txt", "dir/ünï.txt", "run.sh", "link", "mod", "none", "a.txt/x", "link/x", "dir/none"]) {
      expect(await fast.lsTreeEntry(repo, head, f), f).toEqual(await plain.lsTreeEntry(repo, head, f));
    }
    for (const d of [undefined, "dir", "dir/sub", "a.txt", "none"]) {
      expect(await fast.lsTree(repo, head, d), String(d)).toEqual(await plain.lsTree(repo, head, d));
    }
    const paths = ["skills", "agents", "engine/config/limits.yaml", "none/x"];
    expect(await fast.lsTreeSized(repo, head, paths)).toEqual(await plain.lsTreeSized(repo, head, paths));
    expect((await fast.readBlob(repo, head, "dir/sub/c.txt"))!.toString()).toBe("c\n");
    await expect(fast.readBlob(repo, head, "link")).rejects.toThrow(/not a regular file/);
    await expect(fast.readBlob(repo, head, "mod")).rejects.toThrow(/not a regular file/);
    const shas = (await plain.lsTree(repo, head, "dir")).map((e) => e.sha);
    expect(await fast.catBlobs(repo, shas)).toEqual(await plain.catBlobs(repo, shas));
    // One reader served every read above.
    expect(fast.spawns.get("cat-file --batch-command")).toBe(1);
    expect(fast.spawnCount()).toBe(1);
    await fast.closeReaders();
  });

  it("sees a ref moved and objects written after it started", async () => {
    const { repo } = fixture();
    const g = make();
    const before = await g.revParse(repo, "refs/heads/main");
    fs.writeFileSync(path.join(repo, "new.txt"), "n\n");
    git(repo, "add", "new.txt");
    git(repo, "commit", "-qm", "new");
    const after = await g.revParse(repo, "refs/heads/main");
    expect(after).not.toBe(before);
    expect((await g.readBlob(repo, after!, "new.txt"))!.toString()).toBe("n\n");
    expect(g.spawnCount()).toBe(1);
    await g.closeReaders();
  });
});

describe("F-014 reader failures (FR-2, AC-3, SR-6, SR-7)", () => {
  it("a reader killed between reads is replaced; reads still answer", async () => {
    const { repo, head } = fixture();
    const g = make();
    expect((await g.readBlob(repo, head, "a.txt"))!.toString()).toBe("a\n");
    const pid = (g as unknown as { readers: Map<string, { child: { pid: number } | null }> }).readers.get(repo)!.child!.pid;
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    expect((await g.readBlob(repo, head, "dir/b.txt"))!.toString()).toBe("b\n");
    expect(await g.revParse(repo, "refs/heads/main")).toBe(head);
    await g.closeReaders();
  });

  it.skipIf(process.platform === "win32")("a reader that answers out of step is killed and the read falls back to plain git", async () => {
    const { repo, head } = fixture();
    const bin = path.join(tmpdir(), "bin");
    fs.mkdirSync(bin);
    const fake = path.join(bin, "git");
    // A git whose batch reader answers with the wrong object every time.
    fs.writeFileSync(fake, `#!/bin/sh\ncase " $* " in *" --batch-command "*) while read l; do echo "${"0".repeat(40)} blob 1"; printf 'x\\n'; done ;; *) exec "${GIT_PATH}" "$@" ;; esac\n`, { mode: 0o755 });
    const g = make({ gitPath: fake });
    expect((await g.readBlob(repo, head, "dir/sub/c.txt"))!.toString()).toBe("c\n");
    expect(await g.revParse(repo, "refs/heads/main")).toBe(head);
    expect(g.spawns.get("ls-tree")).toBeGreaterThan(0);
    // After three readers break without an answer, the repo reads with plain git only.
    await g.revParse(repo, "HEAD");
    const readers = g.spawns.get("cat-file --batch-command");
    await g.revParse(repo, "HEAD");
    expect(g.spawns.get("cat-file --batch-command")).toBe(readers);
    expect(readers).toBe(3);
    await g.closeReaders();
  });

  it.skipIf(process.platform === "win32")("a reader that hangs times out, is killed, and the read fails over", async () => {
    const { repo } = fixture();
    const bin = path.join(tmpdir(), "bin");
    fs.mkdirSync(bin);
    const fake = path.join(bin, "git");
    fs.writeFileSync(fake, `#!/bin/sh\ncase " $* " in *" --batch-command "*) exec sleep 30 ;; *) exec "${GIT_PATH}" "$@" ;; esac\n`, { mode: 0o755 });
    const children = new Children();
    const r = new CatFileReader({ gitPath: fake, args: ["-C", repo], cwd: repo, env: process.env, children, idleMs: 1000, timeoutMs: 200 });
    await expect(r.info("HEAD")).rejects.toBeInstanceOf(ReaderBroken);
    await r.close();
  });

  it("a body over the limit is refused before it is read, and the reader stays in step", async () => {
    const { repo, head } = fixture();
    const r = new CatFileReader({ gitPath: GIT_PATH, args: ["-C", repo], cwd: repo, env: process.env, children: new Children(), idleMs: 1000, timeoutMs: 10_000 });
    const big = git(repo, "rev-parse", `${head}:engine/config/limits.yaml`);
    await expect(r.contents(big, 2)).rejects.toBeInstanceOf(ReaderLimit);
    expect((await r.contents(big, 100))!.body.toString()).toBe("l: 1\n");
    await r.close();
  });

  it("names the reader isn't given go to plain git (SR-2)", async () => {
    const { repo } = fixture();
    const g = make();
    expect(await g.revParse(repo, "refs/heads/../main")).toBeNull();
    expect(await g.revParse(repo, "main\ninfo HEAD")).toBeNull();
    expect(g.spawns.get("rev-parse")).toBe(2);
    await g.closeReaders();
  });
});

describe("F-014 reader setup (SR-2, SR-4)", () => {
  it.skipIf(process.platform === "win32")("starts the reader with the same overrides and environment as every engine git call", async () => {
    const { repo } = fixture();
    const bin = path.join(tmpdir(), "bin");
    fs.mkdirSync(bin);
    const log = path.join(bin, "argv.log");
    const fake = path.join(bin, "git");
    fs.writeFileSync(fake, `#!/bin/sh\ncase " $* " in *" --batch-command "*) printf '%s\\n' "$@" > "${log}"; env > "${log}.env" ;; esac\nexec "${GIT_PATH}" "$@"\n`, { mode: 0o755 });
    const g = make({ gitPath: fake });
    await g.revParse(repo, "HEAD");
    await g.closeReaders();
    const argv = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(argv.slice(0, -2)).toEqual(g.args(repo, []));
    expect(argv.slice(-2)).toEqual(["cat-file", "--batch-command"]);
    expect(argv).toContain("core.fsmonitor=false");
    const env = fs.readFileSync(`${log}.env`, "utf8");
    expect(env).toMatch(/^GIT_CONFIG_NOSYSTEM=1$/m);
    expect(env).not.toMatch(/^FACTORY_GIT_TOKEN=/m);
  });

  it("keeps one reader per repo, so one repo's answers never serve another", async () => {
    const a = fixture();
    const b = fixture();
    fs.writeFileSync(path.join(b.repo, "only-b.txt"), "b\n");
    git(b.repo, "add", "only-b.txt");
    git(b.repo, "commit", "-qm", "b");
    b.head = git(b.repo, "rev-parse", "HEAD");
    expect(b.head).not.toBe(a.head);
    const g = make();
    expect(await g.revParse(a.repo, "HEAD")).toBe(a.head);
    expect(await g.revParse(b.repo, "HEAD")).toBe(b.head);
    expect(await g.lsTreeEntry(b.repo, b.head, "only-b.txt")).not.toBeNull();
    expect(await g.lsTreeEntry(a.repo, a.head, "only-b.txt")).toBeNull();
    expect(g.spawns.get("cat-file --batch-command")).toBe(2);
    await g.closeReaders();
  });
});

describe("F-014 idle close (OQ-1, AC-7)", () => {
  it("closes the reader after its idle time and starts a new one on the next read", async () => {
    const { repo, head } = fixture();
    const children = new Children();
    const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(tmpdir(), "h"), children, readerIdleMs: 100 });
    await g.revParse(repo, "HEAD");
    const pid = (g as unknown as { readers: Map<string, { child: { pid: number } | null }> }).readers.get(repo)!.child!.pid;
    expect(children.startedByEngine(pid)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(children.startedByEngine(pid)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await g.revParse(repo, "HEAD")).toBe(head);
    expect(g.spawns.get("cat-file --batch-command")).toBe(2);
    await g.closeReaders();
  });
});

describe("F-014 tree parsing (SR-5)", () => {
  const id = Buffer.alloc(20, 0xab);
  const entry = (mode: string, name: string | Buffer, oid = id) => Buffer.concat([Buffer.from(`${mode} `), Buffer.from(name), Buffer.from([0]), oid]);

  it("parses modes as ls-tree prints them", () => {
    const t = parseTree(Buffer.concat([entry("100644", "a"), entry("100755", "b"), entry("100664", "c"), entry("120000", "d"), entry("40000", "e"), entry("160000", "f")]), 20);
    expect(t.map((e) => [e.mode, e.type, e.name])).toEqual([
      ["100644", "blob", "a"], ["100755", "blob", "b"], ["100644", "blob", "c"], ["120000", "blob", "d"], ["040000", "tree", "e"], ["160000", "commit", "f"],
    ]);
    expect(t[0]!.sha).toBe("ab".repeat(20));
  });

  it("refuses names, modes and ids git wouldn't write", () => {
    for (const bad of [
      entry("100644", ""), entry("100644", "."), entry("100644", ".."), entry("100644", "a/b"),
      Buffer.concat([entry("100644", "a"), entry("100644", "a")]),
      entry("170000", "a"), entry("1006x4", "a"), entry("100644", "a", Buffer.alloc(19)),
      entry("100644", Buffer.from([0xff, 0xfe])),
      Buffer.from("100644 a"),
    ]) {
      expect(() => parseTree(bad, 20)).toThrow(TreeError);
    }
  });

  it("refuses entries out of git's order, where a folder sorts as if its name ended in / (Gate 2 L2)", () => {
    expect(() => parseTree(Buffer.concat([entry("100644", "b"), entry("100644", "a")]), 20)).toThrow(/order/);
    expect(() => parseTree(Buffer.concat([entry("40000", "a"), entry("100644", "a.txt")]), 20)).toThrow(/order/);
    expect(parseTree(Buffer.concat([entry("100644", "a.txt"), entry("40000", "a"), entry("100644", "a0")]), 20).map((e) => e.name)).toEqual(["a.txt", "a", "a0"]);
  });

  it("a crafted tree in a repo reads as unreadable, not as another file", async () => {
    const { repo } = fixture();
    const blob = git(repo, "rev-parse", "HEAD:a.txt");
    const raw = Buffer.concat([entry("100644", "x", Buffer.from(blob, "hex")), entry("100644", "x", Buffer.from(blob, "hex"))]);
    const tree = execFileSync("git", ["hash-object", "-t", "tree", "-w", "--literally", "--stdin"], { cwd: repo, input: raw, encoding: "utf8" }).trim();
    const commit = git(repo, "commit-tree", tree, "-m", "crafted");
    const g = make();
    await expect(g.readBlob(repo, commit, "x")).rejects.toBeInstanceOf(GitError);
    await expect(g.lsTree(repo, commit)).rejects.toBeInstanceOf(GitError);
    await g.closeReaders();
  });
});
