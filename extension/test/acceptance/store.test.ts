import { describe, it, expect, afterEach } from "vitest";
import { readFile, readdir, writeFile, mkdir, realpath } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { loadInbox, performAction } from "../../src/core/store";
import { parseItem } from "../../src/core/item";
import { groupByStatus, sortQueue, countOpenBlocking } from "../../src/core/queue";
import type { OwnerAction, QueueEntry } from "../../src/core/types";
import {
  makeRepo,
  writeItem,
  itemFile,
  fakeGit,
  subcommand,
  commitMessage,
  pathspecs,
  FIXED_NOW,
  type TempRepo,
  type GitCall,
} from "./fixtures";

const repos: TempRepo[] = [];
async function repo(name = "repo-a", withFactory = true) {
  const r = await makeRepo(name, withFactory);
  repos.push(r);
  return r;
}
afterEach(async () => {
  while (repos.length) await repos.pop()!.cleanup();
});

async function loadOne(r: TempRepo, id: string): Promise<QueueEntry> {
  const { entries, errors } = await loadInbox([r]);
  expect(errors).toEqual([]);
  const e = entries.find((x) => x.item.id === id);
  expect(e, `entry ${id}`).toBeDefined();
  return e!;
}

const commits = (calls: GitCall[]) => calls.filter((c) => subcommand(c.args) === "commit");
const sameFile = async (a: string, b: string) =>
  expect(await realpath(a).catch(() => resolve(a))).toBe(await realpath(b).catch(() => resolve(b)));

describe("Edge case: missing .factory folder", () => {
  it("Edge: repo with no .factory folder gives no entries and no errors", async () => {
    const r = await repo("plain", false);
    await expect(loadInbox([r])).resolves.toEqual({ entries: [], errors: [] });
  });

  it("Edge: .factory without inbox/decision gives no entries and no errors", async () => {
    const r = await repo("partial", false);
    await mkdir(r.factoryDir, { recursive: true });
    await expect(loadInbox([r])).resolves.toEqual({ entries: [], errors: [] });
  });

  it("Edge: no roots at all gives an empty result", async () => {
    await expect(loadInbox([])).resolves.toEqual({ entries: [], errors: [] });
  });
});

describe("FR-1: loadInbox reads decision items", () => {
  it("FR-1: reads every .md item and ignores non-.md files", async () => {
    const r = await repo();
    await writeItem(r, "D-0001.md", itemFile({ id: "D-0001" }));
    await writeItem(r, "D-0002.md", itemFile({ id: "D-0002" }));
    await writeItem(r, "notes.txt", "not an item");
    const { entries, errors } = await loadInbox([r]);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.item.id).sort()).toEqual(["D-0001", "D-0002"]);
    for (const e of entries) {
      expect(e.repo).toBe("repo-a");
      await sameFile(e.path, join(r.decisionDir, `${e.item.id}.md`));
    }
  });
});

describe("AC-1 / FR-2: view order from disk", () => {
  it("AC-1: open items low, high, critical load and order as critical, high, low", async () => {
    const r = await repo();
    await writeItem(r, "D-0001.md", itemFile({ id: "D-0001", priority: "low" }));
    await writeItem(r, "D-0002.md", itemFile({ id: "D-0002", priority: "high" }));
    await writeItem(r, "D-0003.md", itemFile({ id: "D-0003", priority: "critical" }));
    const { entries } = await loadInbox([r]);
    expect(groupByStatus(entries).open.map((e) => e.item.effective_priority)).toEqual(["critical", "high", "low"]);
  });
});

describe("AC-2 / FR-3: blocking count from disk", () => {
  it("AC-2: an open blocking item on disk is counted for the badge", async () => {
    const r = await repo();
    await writeItem(r, "D-0001.md", itemFile({ id: "D-0001", blocking: true }));
    await writeItem(r, "D-0002.md", itemFile({ id: "D-0002", blocking: false }));
    const { entries } = await loadInbox([r]);
    expect(countOpenBlocking(entries)).toBe(1);
    expect(entries.find((e) => e.item.id === "D-0001")!.item.blocking).toBe(true);
  });
});

describe("AC-8 / FR-10: malformed files listed as errors", () => {
  it("AC-8: invalid frontmatter is listed as an error with the file name; valid items still load", async () => {
    const r = await repo();
    await writeItem(r, "D-0001.md", itemFile({ id: "D-0001" }));
    await writeItem(r, "D-0002.md", "---\nid: D-0002\ntitle: [broken\n---\nbody\n");
    const { entries, errors } = await loadInbox([r]);
    expect(entries.map((e) => e.item.id)).toEqual(["D-0001"]);
    expect(errors).toHaveLength(1);
    expect(basename(errors[0].path)).toBe("D-0002.md");
    expect(errors[0].message.trim().length).toBeGreaterThan(0);
  });

  it("AC-8: a file missing required fields is an error, not hidden", async () => {
    const r = await repo();
    await writeItem(r, "D-0003.md", itemFile({ id: "D-0003", status: undefined }));
    const { entries, errors } = await loadInbox([r]);
    expect(entries).toEqual([]);
    expect(errors.map((e) => basename(e.path))).toEqual(["D-0003.md"]);
  });

  it("AC-8: a file with no frontmatter is an error", async () => {
    const r = await repo();
    await writeItem(r, "D-0004.md", "just text\n");
    const { errors } = await loadInbox([r]);
    expect(errors.map((e) => basename(e.path))).toEqual(["D-0004.md"]);
  });
});

describe("AC-10 / FR-12: combined queue across repos", () => {
  it("AC-10: two repos each with an open item appear in one list, sorted together, labeled by repo", async () => {
    const a = await repo("alpha");
    const b = await repo("beta");
    await writeItem(a, "D-0001.md", itemFile({ id: "D-0001", priority: "low" }));
    await writeItem(b, "D-0001.md", itemFile({ id: "D-0001", priority: "critical" }));
    const { entries, errors } = await loadInbox([a, b]);
    expect(errors).toEqual([]);
    const sorted = sortQueue(entries);
    expect(sorted.map((e) => [e.repo, e.item.id, e.item.effective_priority])).toEqual([
      ["beta", "D-0001", "critical"],
      ["alpha", "D-0001", "low"],
    ]);
  });

  it("AC-10: one repo without .factory does not hide the other's items", async () => {
    const a = await repo("alpha");
    const b = await repo("no-factory", false);
    await writeItem(a, "D-0001.md", itemFile({ id: "D-0001" }));
    const { entries, errors } = await loadInbox([a, b]);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.repo)).toEqual(["alpha"]);
  });
});

describe("AC-6 / FR-8: every action is exactly one commit touching only the item file", () => {
  const actions: [string, OwnerAction][] = [
    ["approve", { type: "approve", option: "A" }],
    ["reject", { type: "reject", note: "no" }],
    ["request_changes", { type: "request_changes", note: "more detail" }],
    ["request_research", { type: "request_research", note: "benchmark" }],
    ["defer", { type: "defer" }],
  ];

  for (const [name, action] of actions) {
    it(`AC-6: ${name} creates exactly one commit, message starts with the id, only that file`, async () => {
      const r = await repo();
      await writeItem(r, "D-0042.md", itemFile({ id: "D-0042" }));
      await writeItem(r, "D-0043.md", itemFile({ id: "D-0043" }));
      const entry = await loadOne(r, "D-0042");
      const { git, calls } = fakeGit();

      await performAction(r, entry, action, git, () => FIXED_NOW);

      const cs = commits(calls);
      expect(cs).toHaveLength(1);
      const commit = cs[0];
      await sameFile(commit.cwd, r.factoryDir);
      const msg = commitMessage(commit.args);
      expect(msg, "commit message").toBeDefined();
      expect(msg!.startsWith("D-0042")).toBe(true);
      expect(msg!.charAt(6)).not.toMatch(/\d/);
      const specs = pathspecs(commit.args);
      expect(specs, "commit must be limited by a pathspec").toHaveLength(1);
      await sameFile(resolve(commit.cwd, specs[0]), entry.path);
      expect(commit.args).not.toContain("-a");
      expect(commit.args).not.toContain("--all");

      // Any staging must be limited to the same single file.
      for (const c of calls.filter((x) => subcommand(x.args) === "add")) {
        const files = c.args.slice(c.args.indexOf("add") + 1).filter((x) => x !== "--" && !x.startsWith("-"));
        expect(c.args).not.toContain("-A");
        expect(c.args).not.toContain("--all");
        expect(files).toHaveLength(1);
        await sameFile(resolve(c.cwd, files[0]), entry.path);
      }

      // The other item is untouched.
      expect(await readFile(join(r.decisionDir, "D-0043.md"), "utf8")).toBe(itemFile({ id: "D-0043" }));
    });
  }

  it("AC-6: restore on a deferred item creates exactly one commit", async () => {
    const r = await repo();
    await writeItem(r, "D-0042.md", itemFile({ id: "D-0042", status: "deferred", priority: "high", effective_priority: "medium" }));
    const entry = await loadOne(r, "D-0042");
    const { git, calls } = fakeGit();
    await performAction(r, entry, { type: "restore" }, git, () => FIXED_NOW);
    expect(commits(calls)).toHaveLength(1);
    expect(commitMessage(commits(calls)[0].args)!.startsWith("D-0042")).toBe(true);
  });

  it("AC-6 / SR-4: commit message is passed as one argument, not shell-quoted", async () => {
    const r = await repo();
    await writeItem(r, "D-0042.md", itemFile({ id: "D-0042" }));
    const entry = await loadOne(r, "D-0042");
    const { git, calls } = fakeGit();
    await performAction(r, entry, { type: "defer" }, git, () => FIXED_NOW);
    const msg = commitMessage(commits(calls)[0].args)!;
    expect(msg.startsWith('"') || msg.startsWith("'")).toBe(false);
    for (const c of calls) for (const a of c.args) expect(typeof a).toBe("string");
  });

  it("AC-6: a refused action makes no git calls and leaves the file unchanged", async () => {
    const r = await repo();
    const text = itemFile({ id: "D-0042" });
    await writeItem(r, "D-0042.md", text);
    const entry = await loadOne(r, "D-0042");
    const { git, calls } = fakeGit();
    await expect(performAction(r, entry, { type: "approve" }, git, () => FIXED_NOW)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await readFile(entry.path, "utf8")).toBe(text);
  });
});

describe("AC-4 / FR-7 / FR-8: defer persisted to disk", () => {
  it("AC-4: deferred high blocking item is still listed, effective medium, blocking true, history deferred", async () => {
    const r = await repo();
    await writeItem(r, "D-0007.md", itemFile({ id: "D-0007", priority: "high", blocking: true }));
    const entry = await loadOne(r, "D-0007");
    const { git } = fakeGit();
    const returned = await performAction(r, entry, { type: "defer" }, git, () => FIXED_NOW);
    expect(returned.effective_priority).toBe("medium");

    const { entries } = await loadInbox([r]);
    const after = entries.find((e) => e.item.id === "D-0007");
    expect(after, "still listed").toBeDefined();
    const g = groupByStatus(entries);
    expect([...g.open, ...g.deferred].map((e) => e.item.id)).toContain("D-0007");
    expect(after!.item.effective_priority).toBe("medium");
    expect(after!.item.priority).toBe("high");
    expect(after!.item.blocking).toBe(true);
    const h = after!.item.history;
    expect(h[h.length - 1]).toMatchObject({ at: FIXED_NOW, by: "owner", action: "deferred" });
    expect(h[0]).toMatchObject({ by: "orchestrator", action: "filed" });
    expect(countOpenBlocking(entries)).toBe(1);
  });

  it("AC-5: restore on disk sets effective priority back to priority", async () => {
    const r = await repo();
    await writeItem(r, "D-0007.md", itemFile({ id: "D-0007", priority: "high", blocking: true }));
    const { git } = fakeGit();
    await performAction(r, await loadOne(r, "D-0007"), { type: "defer" }, git, () => FIXED_NOW);
    await performAction(r, await loadOne(r, "D-0007"), { type: "restore" }, git, () => "2026-11-09T11:00:00Z");
    const after = await loadOne(r, "D-0007");
    expect(after.item.effective_priority).toBe(after.item.priority);
    expect(after.item.status).toBe("open");
    expect(after.item.history.map((x) => x.action)).toEqual(["filed", "deferred", "restored"]);
  });
});

describe("SR-5: atomic writes that preserve unknown fields", () => {
  it("SR-5: unknown frontmatter fields survive an action on disk", async () => {
    const r = await repo();
    await writeItem(
      r,
      "D-0009.md",
      itemFile({ id: "D-0009", x_engine_lock: "run-17", custom: { tags: ["a", "b"], n: 3 } }),
    );
    const entry = await loadOne(r, "D-0009");
    const { git } = fakeGit();
    await performAction(r, entry, { type: "request_changes", note: "please" }, git, () => FIXED_NOW);
    const parsed = parseItem(await readFile(entry.path, "utf8"), entry.path);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item.extra).toEqual({ x_engine_lock: "run-17", custom: { tags: ["a", "b"], n: 3 } });
    expect(parsed.item.status).toBe("changes_requested");
  });

  it("SR-5: body is preserved by an action on disk", async () => {
    const r = await repo();
    await writeItem(r, "D-0009.md", itemFile({ id: "D-0009" }));
    const entry = await loadOne(r, "D-0009");
    const { git } = fakeGit();
    await performAction(r, entry, { type: "defer" }, git, () => FIXED_NOW);
    const after = await loadOne(r, "D-0009");
    expect(after.item.body).toBe(entry.item.body);
  });

  it("SR-5: no temp files are left in the inbox folder after a write", async () => {
    const r = await repo();
    await writeItem(r, "D-0009.md", itemFile({ id: "D-0009" }));
    const entry = await loadOne(r, "D-0009");
    const { git } = fakeGit();
    await performAction(r, entry, { type: "defer" }, git, () => FIXED_NOW);
    expect((await readdir(r.decisionDir)).sort()).toEqual(["D-0009.md"]);
  });
});

describe("Edge case: two edits to the same item at once", () => {
  it("Edge: performAction re-reads the file so an agent's concurrent edit is not lost", async () => {
    const r = await repo();
    await writeItem(r, "D-0010.md", itemFile({ id: "D-0010" }));
    const stale = await loadOne(r, "D-0010");
    // An agent edits the file after the view loaded it.
    await writeFile(stale.path, itemFile({ id: "D-0010", title: "Updated by agent", x_agent_note: "added" }), "utf8");
    const { git } = fakeGit();
    await performAction(r, stale, { type: "defer" }, git, () => FIXED_NOW);
    const after = await loadOne(r, "D-0010");
    expect(after.item.title).toBe("Updated by agent");
    expect(after.item.extra).toMatchObject({ x_agent_note: "added" });
    expect(after.item.status).toBe("deferred");
  });

  it("Edge: an action on an item another party already approved is refused", async () => {
    const r = await repo();
    await writeItem(r, "D-0011.md", itemFile({ id: "D-0011" }));
    const stale = await loadOne(r, "D-0011");
    await writeFile(stale.path, itemFile({ id: "D-0011", status: "approved" }), "utf8");
    const { git, calls } = fakeGit();
    await expect(performAction(r, stale, { type: "defer" }, git, () => FIXED_NOW)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("SR-4: invalid ids never reach git", () => {
  it("SR-4: a file whose id becomes invalid on disk is refused before any git call", async () => {
    const r = await repo();
    await writeItem(r, "D-0012.md", itemFile({ id: "D-0012" }));
    const entry = await loadOne(r, "D-0012");
    await writeFile(entry.path, itemFile({ id: "D-0012; touch /tmp/pwned" }), "utf8");
    const { git, calls } = fakeGit();
    await expect(performAction(r, entry, { type: "defer" }, git, () => FIXED_NOW)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("SR-4: a file with an invalid id is reported as an error by loadInbox", async () => {
    const r = await repo();
    await writeItem(r, "evil.md", itemFile({ id: "../../etc/passwd" }));
    const { entries, errors } = await loadInbox([r]);
    expect(entries).toEqual([]);
    expect(errors.map((e) => basename(e.path))).toEqual(["evil.md"]);
  });
});

describe("FR-5: actions on decided items refused on disk", () => {
  it("FR-5: performAction on an approved item is refused with no git call", async () => {
    const r = await repo();
    await writeItem(r, "D-0013.md", itemFile({ id: "D-0013", status: "approved" }));
    const entry = await loadOne(r, "D-0013");
    const { git, calls } = fakeGit();
    await expect(
      performAction(r, entry, { type: "reject", note: "changed mind" }, git, () => FIXED_NOW),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
