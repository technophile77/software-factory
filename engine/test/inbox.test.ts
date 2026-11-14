import * as path from "node:path";
import YAML from "yaml";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Git } from "../src/git";
import { parseCommand } from "../src/inbox/commands";
import { Inbox } from "../src/inbox/store";
import type { ItemInput } from "../src/inbox/model";
import { engineText, fenced, renderBody, renderTitle } from "../src/inbox/render";
import { MemoryLogger } from "../src/log";
import { Children } from "../src/proc";
import { StateRepo } from "../src/state/state-repo";
import { FakeClock, GIT_PATH, git, removeTmpdirs, tmpdir } from "./helpers";
import { FakeIssues, OTHER, OWNER } from "./inbox-fake";

afterAll(removeTmpdirs);

const decision = (o: Partial<ItemInput> = {}): ItemInput => ({
  kind: "decision", title: "Choose a session store", category: "Architecture", priority: "high", blocking: true, created_by: "engine",
  options: [{ id: "A", label: "Redis" }, { id: "B", label: "Postgres table" }], recommendation: "A",
  sections: { Context: [{ engine: "Why it matters." }] }, ...o,
});

interface W { inbox: Inbox; gh: FakeIssues; clock: FakeClock; state: StateRepo; repo: string; notes: string[] }

async function world(): Promise<W> {
  const root = tmpdir();
  const repo = path.join(root, "cfg");
  git(root, "init", "-q", repo);
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "h"), children: new Children() });
  const state = new StateRepo(g, { scan: async () => ({ clean: true }) }, repo, new MemoryLogger(), path.join(root, "t"));
  await state.ensureWorktree();
  const gh = new FakeIssues();
  const clock = new FakeClock();
  const notes: string[] = [];
  let seed = 0;
  const inbox = new Inbox({
    state, clock, log: new MemoryLogger(), notify: (t) => notes.push(t),
    random: (n) => Buffer.from(Array.from({ length: n }, () => seed++)),
  });
  inbox.connect({ api: gh, repo: "o/cfg", ownerId: OWNER });
  return { inbox, gh, clock, state, repo, notes };
}

/** Files and polls twice: once to dispatch, once to find the issue and bind its comments. */
async function filed(w: W, item: ItemInput): Promise<{ id: string; issue: number }> {
  const id = await w.inbox.file(item);
  await w.inbox.poll();
  await w.inbox.poll();
  return { id, issue: (await w.inbox.read(id))!.issue! };
}

describe("F-011 inbox on GitHub issues", () => {
  let w: W;
  beforeEach(async () => {
    w = await world();
  });

  it("items filed at the same moment get different ids (live trial: two analyststop items both took D-0001)", async () => {
    const ids = await Promise.all([w.inbox.file(decision()), w.inbox.file(decision({ title: "Second" })), w.inbox.file(decision({ title: "Third" }))]);
    expect(ids).toEqual(["D-0001", "D-0002", "D-0003"]);
    expect((await w.inbox.records()).map((r) => r.title).sort()).toEqual(["Choose a session store", "Second", "Third"]);
  });

  it("AC-1: files each kind as one issue with its title, labels and one action comment per action", async () => {
    const { id, issue } = await filed(w, decision());
    expect(id).toBe("D-0001");
    const i = w.gh.issues.get(issue)!;
    expect(i.author).toBe("github-actions[bot]");
    expect(i.title).toBe("D-0001 Decision (Architecture): Choose a session store");
    expect(i.labels).toEqual(["factory-inbox", "kind:decision", "category:architecture", "priority:high", "blocking"]);
    expect(i.body.split("\n")[0]).toBe("<!-- factory-item: D-0001 rev 1 -->");
    const actions = (await w.gh.comments("", issue)).map((c) => c.body.split("\n")[0]);
    expect(actions).toEqual(["choose:A", "choose:B", "reject", "changes", "research", "defer", "restore"].map((a) => `<!-- factory-action: D-0001 rev 1 ${a} -->`));
    expect(w.notes).toEqual(["Factory: D-0001 needs you"]);
    const rec = YAML.parse(git(w.repo, "show", "factory/state:inbox/D-0001.yaml"));
    expect(rec.revisions[0].action_comments).toHaveLength(7);
    for (const kind of ["hygiene", "spec", "maturity", "notice"] as const) {
      const r = await filed(w, { kind, title: "t", priority: "low", blocking: false, created_by: "engine", sections: {} });
      expect(w.gh.issues.get(r.issue)!.labels).toEqual(["factory-inbox", `kind:${kind}`, "priority:low"]);
    }
    const t = await filed(w, { kind: "testing", title: "t", priority: "low", blocking: false, created_by: "engine", steps: ["Re-run", "Skip"], sections: {} });
    expect((await w.gh.comments("", t.issue)).map((c) => c.body.split("\n")[1])).toEqual(["Step 1: Re\\-run", "Step 2: Skip", "Ask for more research: reply with /research <note>", "Defer"]);
  });

  it("AC-2: a 👍 from the owner records one commit, replies and closes", async () => {
    const { id, issue } = await filed(w, decision());
    const before = git(w.repo, "rev-list", "--count", "factory/state");
    const rid = w.gh.react(w.gh.actionComment(issue, "choose:B").id, "+1");
    const got = await w.inbox.poll();
    expect(got).toHaveLength(1);
    expect(got[0]!.entry).toMatchObject({ action: "chosen", option: "B", source: "reaction", actor_id: OWNER, reaction_id: rid });
    expect(git(w.repo, "log", "-1", "--format=%s", "factory/state")).toMatch(/^D-0001: /);
    expect(Number(git(w.repo, "rev-list", "--count", "factory/state"))).toBeGreaterThan(Number(before));
    expect(w.gh.replies(issue)).toEqual(["Recorded: Option B: Postgres table."]);
    expect(w.gh.issues.get(issue)!.state).toBe("closed");
    expect((await w.inbox.read(id))!.status).toBe("chosen");
    expect(await w.inbox.poll()).toEqual([]);
  });

  it("AC-3: a command records the same, with source command", async () => {
    const { issue } = await filed(w, decision());
    w.gh.say(issue, "/choose A");
    const got = await w.inbox.poll();
    expect(got[0]!.entry).toMatchObject({ action: "chosen", option: "A", source: "command" });
  });

  it("AC-4: other accounts, other emoji, stale revisions, two actions and edits record nothing", async () => {
    const { id, issue } = await filed(w, decision());
    w.gh.react(w.gh.actionComment(issue, "choose:A").id, "+1", OTHER);
    w.gh.react(w.gh.actionComment(issue, "choose:A").id, "heart");
    w.gh.say(issue, "/choose A", OTHER);
    w.gh.say(issue, "just a note, no command");
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.replies(issue)).toEqual([]);

    w.gh.say(issue, "/choose A", OWNER, true);
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.replies(issue)).toEqual(["Not recorded: comment edited."]);

    w.gh.react(w.gh.actionComment(issue, "choose:A").id, "+1");
    w.gh.react(w.gh.actionComment(issue, "choose:B").id, "+1");
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.replies(issue).slice(-1)).toEqual(["Not recorded: two actions chosen."]);
    await w.inbox.poll();
    expect(w.gh.replies(issue)).toHaveLength(2);

    w.gh.say(issue, "/approve");
    w.gh.say(issue, "/choose a");
    await w.inbox.poll();
    expect(w.gh.replies(issue).slice(-2)).toEqual(["Not recorded: not a command.", "Not recorded: not a command."]);
    expect((await w.inbox.read(id))!.status).toBe("open");
  });

  it("AC-4, SR-8: an edited action comment or issue body records nothing", async () => {
    const { issue } = await filed(w, decision());
    const ac = w.gh.actionComment(issue, "choose:A");
    await w.gh.editComment("", ac.id, ac.body.replace("Redis", "Redis (recommended by the bot)"));
    w.gh.react(ac.id, "+1");
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.replies(issue)).toEqual(["Not recorded: comment edited."]);
    w.gh.issues.get(issue)!.body += "\nextra";
    w.gh.react(w.gh.actionComment(issue, "choose:B").id, "+1");
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.replies(issue).slice(-1)).toEqual(["Not recorded: changed since."]);
  });

  it("SR-17: the engine never reads its own comments as commands", async () => {
    const { issue } = await filed(w, decision());
    const id = await w.gh.comment("", issue, "/choose A");
    const rec = (await w.inbox.read("D-0001"))!;
    rec.engine_comments.push(id);
    await w.state.commit([{ path: "inbox/D-0001.yaml", content: YAML.stringify(rec) }], "D-0001: test");
    expect(await w.inbox.poll()).toEqual([]);
    for (const t of [engineText.confirm("/approve", "/x", "ABCD"), engineText.recorded("/approve"), engineText.notRecorded("not a command"), engineText.stale(2), engineText.reopened()]) {
      expect(t.startsWith("/")).toBe(false);
      expect(parseCommand(t)).toBeNull();
    }
  });

  it("AC-5: a risky action needs 🚀 or /confirm within 15 minutes at the same revision", async () => {
    const { issue } = await filed(w, decision({ category: "Security" }));
    expect(w.gh.issues.get(issue)!.title).toBe("D-0001 Decision (Security): needs your decision");
    w.gh.react(w.gh.actionComment(issue, "choose:A").id, "+1");
    expect(await w.inbox.poll()).toEqual([]);
    const confirm = w.gh.replies(issue)[0]!;
    expect(confirm).toMatch(/^Confirm: Option A: Redis on D-0001: you accept .* React 🚀 or reply \/confirm ([A-Z0-9]{4}) within 15 minutes\.$/);
    const code = /\/confirm ([A-Z0-9]{4})/.exec(confirm)![1]!;
    w.gh.say(issue, "/confirm ZZZZ");
    expect(await w.inbox.poll()).toEqual([]);
    w.gh.say(issue, `/confirm ${code}`);
    const got = await w.inbox.poll();
    expect(got[0]!.entry).toMatchObject({ action: "chosen", option: "A", confirmed_by: { source: "command" } });
  });

  it("AC-5: 🚀 confirms; after 15 minutes nothing is recorded", async () => {
    const a = await filed(w, decision({ category: "Security" }));
    w.gh.react(w.gh.actionComment(a.issue, "choose:B").id, "+1");
    await w.inbox.poll();
    const c = (await w.gh.comments("", a.issue)).filter((x) => x.body.startsWith("Confirm:")).pop()!;
    w.gh.react(c.id, "rocket", OTHER);
    expect(await w.inbox.poll()).toEqual([]);
    w.gh.react(c.id, "rocket");
    expect((await w.inbox.poll())[0]!.entry).toMatchObject({ option: "B", confirmed_by: { source: "reaction" } });

    const b = await filed(w, { kind: "spec", title: "F-002 spec", priority: "high", blocking: true, created_by: "engine", feature: "F-002", sections: {} });
    w.gh.say(b.issue, "/approve");
    await w.inbox.poll();
    const code = /\/confirm ([A-Z0-9]{4})/.exec(w.gh.replies(b.issue)[0]!)![1]!;
    await w.clock.advance(16 * 60 * 1000);
    w.gh.say(b.issue, `/confirm ${code}`);
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.replies(b.issue).slice(-1)).toEqual(["Not recorded: confirm expired."]);
  });

  it("AC-6: Defer lowers the priority label and keeps the issue open; Restore sets it back", async () => {
    const { id, issue } = await filed(w, decision());
    w.gh.say(issue, "/defer");
    await w.inbox.poll();
    expect(w.gh.issues.get(issue)!.state).toBe("open");
    expect(w.gh.issues.get(issue)!.labels).toEqual(["factory-inbox", "kind:decision", "category:architecture", "priority:medium", "blocking"]);
    expect((await w.inbox.read(id))!.history.some((h) => h.action === "deferred")).toBe(true);
    w.gh.say(issue, "/restore");
    await w.inbox.poll();
    expect(w.gh.issues.get(issue)!.labels).toContain("priority:high");
  });

  it("AC-7: a revised item marks old action comments stale, posts new ones, and old 👍 record nothing", async () => {
    const { id, issue } = await filed(w, decision());
    const old = w.gh.actionComment(issue, "choose:A");
    await w.inbox.revise(id, decision({ options: [{ id: "A", label: "Redis" }, { id: "B", label: "Postgres" }, { id: "C", label: "Memory" }] }));
    await w.inbox.poll();
    await w.inbox.poll();
    expect(w.gh.issues.get(issue)!.body.split("\n")[0]).toBe("<!-- factory-item: D-0001 rev 2 -->");
    expect((await w.gh.comments("", issue)).find((c) => c.id === old.id)!.body).toBe("Stale: revision 2 replaces this.");
    w.gh.react(old.id, "+1");
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.replies(issue).slice(-1)).toEqual(["Not recorded: changed since."]);
    w.gh.react(w.gh.actionComment(issue, "choose:C").id, "+1");
    expect((await w.inbox.poll())[0]!.entry).toMatchObject({ option: "C", rev: 2 });
  });

  it("AC-12: a public config repo or a second collaborator files nothing and says why", async () => {
    w.gh.private = false;
    await w.inbox.file(decision());
    expect(await w.inbox.poll()).toEqual([]);
    expect(w.gh.dispatches).toEqual([]);
    expect(w.notes).toEqual(["Factory inbox stopped"]);
    w.gh.private = true;
    w.gh.collaborators = [OWNER, OTHER];
    await w.inbox.poll();
    expect(w.gh.dispatches).toEqual([]);
    w.gh.collaborators = [OWNER];
    await w.inbox.poll();
    expect(w.gh.dispatches).toHaveLength(1);
  });

  it("section 6: a missing issue is reported after two polls; a closed one is reopened once", async () => {
    w.gh.workflowDown = true;
    await w.inbox.file(decision());
    await w.inbox.poll();
    await w.inbox.poll();
    await w.inbox.poll();
    expect(w.notes).toEqual(["Factory inbox: an item didn't appear"]);
    expect(w.gh.dispatches).toHaveLength(1);
    w.gh.workflowDown = false;
    const { issue } = await filed(w, decision({ title: "second" }));
    w.gh.issues.get(issue)!.state = "closed";
    await w.inbox.poll();
    expect(w.gh.issues.get(issue)!.state).toBe("open");
    w.gh.issues.get(issue)!.state = "closed";
    await w.inbox.poll();
    expect(w.gh.issues.get(issue)!.state).toBe("closed");
  });

  it("SR-10: outside text is fenced, unmentioned and unlinked", () => {
    const f = fenced("@octocat ``` ![x](https://evil.example/a.png) # Heading", "the security reviewer");
    expect(f).toMatch(/^Written by the security reviewer, shown as plain text:\n\n````text\n/);
    expect(f).not.toContain("@octocat");
    expect(f).not.toContain("https://");
    expect(f.trimEnd().endsWith("````")).toBe(true);
    const body = renderBody("D-0009", 1, decision({ sections: { Context: [{ outside: "/approve", author: "reviewer" }] } }));
    expect(body.split("\n")[0]).toBe("<!-- factory-item: D-0009 rev 1 -->");
    expect(body.trimEnd().endsWith("Revision 1.")).toBe(true);
    expect(renderTitle("D-0001", decision({ title: "x".repeat(200) })).length).toBeLessThanOrEqual(120);
  });

  it("SR-18: commands are exact first lines", () => {
    expect(parseCommand("/choose B")).toEqual({ kind: "action", action: "choose:B" });
    expect(parseCommand("/changes Please split FR-3\nand FR-4")).toEqual({ kind: "action", action: "changes", note: "Please split FR-3\nand FR-4" });
    expect(parseCommand("/confirm AB2C")).toEqual({ kind: "confirm", code: "AB2C" });
    for (const bad of ["/Approve", "/approve now", " /approve", "/choose E", "/changes", "/step 0", "please /approve"]) expect(parseCommand(bad)).toBeNull();
  });
});
