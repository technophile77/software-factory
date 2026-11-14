import * as path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { migrateInbox, parseOldItem } from "../scripts/migrate-inbox-once";
import { Git } from "../src/git";
import { MemoryLogger } from "../src/log";
import { Children } from "../src/proc";
import { StateRepo } from "../src/state/state-repo";
import { FakeClock, GIT_PATH, git, tmpdir } from "./helpers";
import { inboxItems } from "./inbox-items";

// F-011 FR-16, AC-13, SR-20: the one-time move of item files to issue records.

function oldItem(front: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(front)}---\n\n${body}\n`;
}

const CHOICE = oldItem({
  schema: "inbox-item/1.0", id: "D-0003", inbox: "decision", title: "Security and Testability Review #2 for F-002: the owner's choice", category: "Security",
  priority: "high", effective_priority: "high", blocking: true, status: "open", feature: "F-002", created_by: "engine", created_at: "2026-11-12T10:00:00Z",
  options: [{ id: "A", label: "Read only" }, { id: "B", label: "Read and write" }], recommendation: "A", links: [],
  history: [{ at: "2026-11-12T10:00:00Z", by: "engine", action: "filed" }, { at: "2026-11-12T11:00:00Z", by: "owner", action: "deferred" }],
}, "## Context\n\nThe reviewer's words [click](https://evil.example).\n\n## Options\n\n- **A. Read only.**\n\n## Project impact\n\nF-002 waits.\n\n## Recommendation\n\nOption A.\n\n## Cost of delay\n\nF-002 can't reach the readiness gate.");

async function setup(files: Record<string, string>, scan: (paths: string[]) => boolean = () => true) {
  const root = tmpdir();
  const repo = path.join(root, "cfg");
  git(root, "init", "-q", repo);
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "h"), children: new Children() });
  const clean = { scan: async () => ({ clean: true }) };
  const state = new StateRepo(g, clean as never, repo, new MemoryLogger(), path.join(root, "t"));
  await state.ensureWorktree();
  await state.commit(Object.entries(files).map(([p, content]) => ({ path: p, content })), "old items");
  const scanner = {
    scan: async (blobs: Array<{ sha: string; path?: string; content: Buffer }>) => {
      const bad = blobs.filter((b) => !scan([b.content.toString("utf8")]));
      return bad.length ? { clean: false, blobs: bad.map((b) => b.sha), rules: ["generic-api-key"] } : { clean: true };
    },
  };
  return { repo, run: () => migrateInbox({ git: g, scanner: scanner as never, repo, log: new MemoryLogger(), clock: new FakeClock(), tmpDir: path.join(root, "t2") }) };
}

describe("one-time inbox migration (F-011 FR-16)", () => {
  it("AC-13: each open item is a record and a rendered body, its file gone, in one commit per item; closed items stay", async () => {
    const closed = CHOICE.replace("id: D-0003", "id: D-0001").replace("status: open", "status: chosen");
    const { repo, run } = await setup({ "inbox/decision/D-0003.md": CHOICE, "inbox/decision/D-0001.md": closed });
    const r = await run();
    expect(r).toEqual({ migrated: [{ from: "inbox/decision/D-0003.md", id: "D-0003" }], skipped: [], closed: ["inbox/decision/D-0001.md"] });
    const files = git(repo, "ls-tree", "-r", "--name-only", "factory/state", "--", "inbox").split("\n");
    expect(files).toEqual(["inbox/D-0003.json", "inbox/D-0003.rev1.md", "inbox/decision/D-0001.md"]);
    expect(git(repo, "show", "--name-status", "--format=%s", "factory/state").split("\n").filter(Boolean)).toEqual([
      "D-0003: migrated from inbox/decision/D-0003.md", "A\tinbox/D-0003.json", "A\tinbox/D-0003.rev1.md", "D\tinbox/decision/D-0003.md",
    ]);
    const [item] = inboxItems(repo);
    // F-016 FR-12: the engine's own Security and Testability Review item keeps its effect; SR-20: the owner's old action is dropped and noted.
    expect(item!.record).toMatchObject({
      id: "D-0003", category: "Security", feature: "F-002", status: "open", options: [{ id: "A", label: "Read only" }, { id: "B", label: "Read and write" }],
      effect: { type: "st_review_choice", feature: "F-002", finding: 2 },
    });
    expect(item!.record.history.map((h: any) => h.action)).toEqual(["filed", "migrated"]);
    expect(item!.record.history[1].note).toMatch(/1 owner action\(s\).*not carried over/);
    // SR-20: the old text is re-rendered as outside text.
    expect(item!.text).toContain("Written by the old item file, from engine, shown as plain text:");
    expect(item!.text).not.toContain("https://evil.example");
  });

  it("SR-20: a file with a secret, or one it can't read, stays where it is and is reported", async () => {
    const leaky = CHOICE.replace("id: D-0003", "id: D-0004").replace("F-002 waits.", "F-002 waits. SECRET-XYZ");
    const { repo, run } = await setup({ "inbox/decision/D-0004.md": leaky, "inbox/decision/D-0005.md": "no front matter" }, ([t]) => !t!.includes("SECRET-XYZ"));
    const r = await run();
    expect(r.migrated).toEqual([]);
    expect(r.skipped).toEqual([
      { from: "inbox/decision/D-0004.md", why: "the secrets scan found a secret in it" },
      { from: "inbox/decision/D-0005.md", why: "no front matter" },
    ]);
    expect(git(repo, "ls-tree", "-r", "--name-only", "factory/state", "--", "inbox").split("\n")).toEqual(["inbox/decision/D-0004.md", "inbox/decision/D-0005.md"]);
  });

  it("an item not filed by the engine gets no effect, whatever its title says", () => {
    const r = parseOldItem(CHOICE.replace("created_by: engine", "created_by: onboarding"), "inbox/decision/D-0003.md");
    expect("item" in r && r.item.effect).toBeFalsy();
  });
});
