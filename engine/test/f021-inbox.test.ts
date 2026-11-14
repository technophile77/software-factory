import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Git } from "../src/git";
import { InboxLocal } from "../src/inbox/local";
import type { ItemInput } from "../src/inbox/model";
import { Inbox, entryHash, privateLine } from "../src/inbox/store";
import { MemoryLogger } from "../src/log";
import { Children } from "../src/proc";
import { StateRepo } from "../src/state/state-repo";
import { FakeClock, GIT_PATH, git, removeTmpdirs, tmpdir } from "./helpers";
import { FakeIssues, OWNER } from "./inbox-fake";

afterAll(removeTmpdirs);

const SECRET_DETAIL = "run 3 stopped: reviewer timed out at /home/alex/private-path line 42";

const decision = (o: Partial<ItemInput> = {}): ItemInput => ({
  kind: "decision", title: "Choose a session store", category: "Architecture", priority: "high", blocking: true, created_by: "engine",
  options: [{ id: "A", label: "Redis" }, { id: "B", label: "Postgres table" }, { id: "C", label: "Files" }], recommendation: "A",
  sections: { Context: [{ engine: "Why it matters." }] }, ...o,
});

interface W { state: StateRepo; inbox: Inbox; gh: FakeIssues; clock: FakeClock; repo: string; local: InboxLocal; localDir: string; scrubbed: string[]; make: () => Inbox }

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
  const localDir = path.join(root, "engine-home", "inbox-local", "p1");
  const local = new InboxLocal(localDir);
  const scrubbed: string[] = [];
  let seed = 0;
  const make = () => {
    const inbox = new Inbox({
      state, clock, log: new MemoryLogger(), notify: () => undefined, local,
      scrub: async (t) => (scrubbed.push(t), t.replace(/ghp_[A-Za-z0-9]+/g, "[secret removed by the engine]")),
      random: (n) => Buffer.from(Array.from({ length: n }, () => seed++)),
    });
    inbox.connect({ api: gh, repo: "o/cfg", ownerId: OWNER });
    return inbox;
  };
  return { state, inbox: make(), gh, clock, repo, local, localDir, scrubbed, make };
}

async function filed(w: W, item: ItemInput): Promise<{ id: string; issue: number }> {
  const id = await w.inbox.file(item);
  await w.inbox.poll();
  await w.inbox.poll();
  return { id, issue: (await w.inbox.read(id))!.issue! };
}

/** The engine's "Recorded from the console" comments on an issue. */
function consoleReplies(w: W, issue: number): string[] {
  return (w.gh.comments_.get(issue) ?? []).filter((c) => c.authorId === OWNER && c.body.startsWith("Recorded from the console:")).map((c) => c.body);
}

/** Every blob ever committed on factory/state, as text. */
function stateHistory(repo: string): string {
  return git(repo, "log", "-p", "--all", "--format=%H %s");
}

describe("F-021 console answers in the inbox store", () => {
  let w: W;
  beforeEach(async () => {
    w = await world();
  });

  it("AC-1, FR-2, FR-3: lists open items blocking first and shows the body and actions in actionsFor order", async () => {
    await filed(w, decision({ blocking: false, priority: "low", title: "Low one" }));
    await filed(w, decision({ title: "Blocking one" }));
    expect((await w.inbox.consoleList()).map((r) => r.title)).toEqual(["Blocking one", "Low one"]);
    const shown = (await w.inbox.consoleShow("D-0002"))!;
    expect(shown.body).toContain("## Context");
    expect(shown.actions.map((a) => a.action)).toEqual(["choose:A", "choose:B", "choose:C", "reject", "changes", "research", "defer", "restore"]);
    expect(shown.actions[1]!.label).toBe("Option B: Postgres table");
    expect(shown.private).toBeNull();
  });

  it("AC-2, FR-8: a console choice is recorded with source console, the issue gets the fixed comment and is closed", async () => {
    const { id, issue } = await filed(w, decision());
    const r = await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:B", session: 7, signedIn: false });
    expect("recorded" in r).toBe(true);
    const rec = (await w.inbox.read(id))!;
    expect(rec.status).toBe("chosen");
    const entry = rec.history.find((h) => h.by === "owner")!;
    expect(entry).toMatchObject({ action: "chosen", option: "B", source: "console", signed_in: false, rev: 1 });
    expect(entry.comment_id).toBeUndefined();
    expect(entry.console_answer).toBe(entryHash(entry));
    expect(consoleReplies(w, issue)).toEqual(["Recorded from the console: Option B: Postgres table."]);
    expect(w.gh.issues.get(issue)!.state).toBe("closed");
    expect(rec.history.at(-1)).toMatchObject({ by: "engine", action: "closed" });
    // The proof sits in the engine folder only.
    expect(w.local.readAnswer(id, rec.history.indexOf(entry))!.entry_sha256).toBe(entry.console_answer);
  });

  it("AC-3, FR-6, SR-2: a Security choice needs the engine's code, once, within 15 minutes", async () => {
    const { id } = await filed(w, decision({ category: "Security" }));
    const c1 = await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:A", session: 1, signedIn: false });
    if (!("confirm" in c1)) throw new Error("expected a confirm");
    expect(c1.confirm.words).toBe(`Confirm: Option A: Redis on ${id}: you accept what option A means for the project.`);
    expect((await w.inbox.read(id))!.status).toBe("open");
    // A wrong code ends the attempt; the right code after it doesn't count.
    expect(await w.inbox.consoleConfirm({ id, rev: 1, code: "ZZZZ", session: 1, signedIn: false })).toEqual({ refused: "confirm failed" });
    expect(await w.inbox.consoleConfirm({ id, rev: 1, code: c1.confirm.code, session: 1, signedIn: false })).toEqual({ refused: "confirm failed" });
    // Another session's code doesn't count either.
    const c2 = await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:A", session: 1, signedIn: false });
    if (!("confirm" in c2)) throw new Error("expected a confirm");
    expect(await w.inbox.consoleConfirm({ id, rev: 1, code: c2.confirm.code, session: 2, signedIn: false })).toEqual({ refused: "confirm failed" });
    // Too late.
    const c3 = await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:A", session: 1, signedIn: false });
    if (!("confirm" in c3)) throw new Error("expected a confirm");
    w.clock.t += 15 * 60_000 + 1;
    expect(await w.inbox.consoleConfirm({ id, rev: 1, code: c3.confirm.code, session: 1, signedIn: false })).toEqual({ refused: "confirm failed" });
    // In time.
    const c4 = await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:A", session: 1, signedIn: true });
    if (!("confirm" in c4)) throw new Error("expected a confirm");
    w.clock.t += 14 * 60_000;
    expect("recorded" in (await w.inbox.consoleConfirm({ id, rev: 1, code: c4.confirm.code, session: 1, signedIn: true }))).toBe(true);
    expect((await w.inbox.read(id))!.history.find((h) => h.by === "owner")).toMatchObject({ option: "A", confirmed_by: { source: "console" }, signed_in: true });
  });

  it("AC-4, FR-7: GitHub first wins; console first wins; a later 👍 records nothing", async () => {
    const one = await filed(w, decision());
    w.gh.react(w.gh.actionComment(one.issue, "choose:A").id, "+1");
    await w.inbox.poll();
    expect(await w.inbox.consoleAnswer({ id: one.id, rev: 1, action: "choose:B", session: 1, signedIn: false }))
      .toEqual({ already: { by: "github", action: "Option A: Redis" } });

    const two = await filed(w, decision({ title: "Second" }));
    await w.inbox.consoleAnswer({ id: two.id, rev: 1, action: "choose:C", session: 1, signedIn: false });
    w.gh.react(w.gh.actionComment(two.issue, "choose:A").id, "+1");
    expect(await w.inbox.poll()).toEqual([]);
    const rec = (await w.inbox.read(two.id))!;
    expect(rec.history.filter((h) => h.by === "owner").map((h) => h.option)).toEqual(["C"]);
    expect(await w.inbox.consoleAnswer({ id: two.id, rev: 1, action: "choose:A", session: 2, signedIn: false }))
      .toEqual({ already: { by: "console", action: "Option C: Files" } });
  });

  it("AC-4, FR-7: the poll and a console answer started together record exactly one answer, every time", async () => {
    for (let i = 0; i < 100; i++) {
      const { id, issue } = await filed(w, decision({ title: `Race ${i}` }));
      w.gh.react(w.gh.actionComment(issue, "choose:A").id, "+1");
      const [, c] = await Promise.all([w.inbox.poll(), w.inbox.consoleAnswer({ id, rev: 1, action: "choose:B", session: 1, signedIn: false })]);
      const owners = (await w.inbox.read(id))!.history.filter((h) => h.by === "owner");
      expect(owners, `run ${i}`).toHaveLength(1);
      expect(owners[0]!.option === "A" ? "already" in c : "recorded" in c, `run ${i}`).toBe(true);
    }
  }, 120_000);

  it("AC-5, FR-7: a revision since the owner saw the item records nothing and names the new revision", async () => {
    const { id } = await filed(w, decision());
    await w.inbox.revise(id, decision({ title: "Revised" }));
    expect(await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:A", session: 1, signedIn: false })).toEqual({ changed: { rev: 2 } });
    expect((await w.inbox.read(id))!.status).toBe("open");
  });

  it("an item withdrawn by the engine says so, and unknown or wrong actions are refused", async () => {
    const { id } = await filed(w, decision());
    expect(await w.inbox.consoleAnswer({ id, rev: 1, action: "approve", session: 1, signedIn: false })).toEqual({ refused: "not allowed" });
    expect(await w.inbox.consoleAnswer({ id, rev: 1, action: "changes", session: 1, signedIn: false })).toEqual({ refused: "not allowed" });
    expect(await w.inbox.consoleAnswer({ id: "D-9999", rev: 1, action: "choose:A", session: 1, signedIn: false })).toEqual({ refused: "unknown item" });
    await w.inbox.withdraw(id, "Not needed.");
    expect(await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:A", session: 1, signedIn: false })).toEqual({ already: { by: "engine" } });
  });

  it("a deferred item stays open, its issue too, with the fixed comment and lowered labels", async () => {
    const { id, issue } = await filed(w, decision());
    expect("recorded" in (await w.inbox.consoleAnswer({ id, rev: 1, action: "defer", session: 1, signedIn: false }))).toBe(true);
    const rec = (await w.inbox.read(id))!;
    expect(rec.status).toBe("open");
    expect(rec.effective_priority).toBe("medium");
    expect(w.gh.issues.get(issue)!.state).toBe("open");
    expect(w.gh.issues.get(issue)!.labels).toContain("priority:medium");
    expect(consoleReplies(w, issue)).toEqual(["Recorded from the console: Defer."]);
  });

  it("a /changes note typed in the console is recorded but never posted (SR-7)", async () => {
    const { id, issue } = await filed(w, { kind: "hygiene", title: "Edit", priority: "low", blocking: false, created_by: "engine", sections: {} });
    await w.inbox.consoleAnswer({ id, rev: 1, action: "changes", note: "Shorter, please.", session: 1, signedIn: false });
    expect((await w.inbox.read(id))!.history.find((h) => h.by === "owner")).toMatchObject({ action: "changes_requested", note: "Shorter, please." });
    expect(consoleReplies(w, issue)).toEqual(["Recorded from the console: Request changes."]);
    expect(JSON.stringify([...w.gh.comments_.values()])).not.toContain("Shorter");
  });

  it("AC-6, FR-4, SR-5: private detail stays in the engine folder; the issue only says it exists", async () => {
    const { id, issue } = await filed(w, decision({ private: [{ name: "Engine log", text: `${SECRET_DETAIL}\ntoken ghp_abc123XYZ` }] }));
    const body = w.gh.issues.get(issue)!.body;
    expect(body).toContain(privateLine(id));
    expect(body).not.toContain("private-path");
    expect(JSON.stringify(w.gh.dispatches)).not.toContain("private-path");
    expect(stateHistory(w.repo)).not.toContain("private-path");
    expect(w.scrubbed).toHaveLength(1);
    const shown = (await w.inbox.consoleShow(id))!;
    expect(shown.private).toEqual([{ name: "Engine log", text: `${SECRET_DETAIL}\ntoken [secret removed by the engine]` }]);
    // A revision keeps its own detail, and still nothing reaches GitHub or factory/state.
    await w.inbox.revise(id, decision({ title: "Revised", private: [{ name: "Engine log", text: "second private-path" }] }));
    await w.inbox.poll();
    expect((await w.inbox.consoleShow(id))!.private![0]!.text).toBe("second private-path");
    expect(JSON.stringify([...w.gh.issues.values()]) + JSON.stringify(w.gh.dispatches)).not.toContain("private-path");
    expect(stateHistory(w.repo)).not.toContain("private-path");
    // SR-6: a damaged file counts as missing.
    fs.writeFileSync(path.join(w.localDir, "private", `${id}.rev2.json`), "{not json");
    expect((await w.inbox.consoleShow(id))!.private).toBeNull();
  });

  it("AC-8, FR-10: a console answer from an earlier run counts only with its matching proof file", async () => {
    const { id } = await filed(w, decision());
    await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:B", session: 1, signedIn: false });
    const fresh = w.make();
    const [pending] = await fresh.pendingEffects();
    expect(pending!.entry.source).toBe("console");
    expect(await fresh.verify(pending!)).toBe(true);
    // The proof edited: no longer counts.
    const n = pending!.record.history.indexOf(pending!.entry);
    const file = path.join(w.localDir, "answers", `${id}.${n}.json`);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...doc, action: "choose:A" }));
    expect(await fresh.verify(pending!)).toBe(false);
    // A forged entry on factory/state with no proof file.
    fs.rmSync(file);
    expect(await fresh.verify(pending!)).toBe(false);
  });

  it("AC-8: a forged console entry whose hash matches no file is not carried out", async () => {
    const { id } = await filed(w, decision());
    const rec = (await w.inbox.read(id))!;
    const forged = { at: "2026-11-11T10:05:00Z", by: "owner" as const, action: "chosen" as const, option: "A", rev: 1, source: "console" as const, signed_in: true };
    rec.history.push({ ...forged, console_answer: entryHash(forged) });
    rec.status = "chosen";
    // As a push to the config repo would put it there: the store can't tell it from its own write.
    await w.state.commit([{ path: `inbox/${id}.yaml`, content: YAML.stringify(rec) }], "forged");
    const fresh = w.make();
    const [pending] = await fresh.pendingEffects();
    expect(await fresh.verify(pending!)).toBe(false);
  });

  it("AC-9, FR-8: with GitHub down the answer stands; the next poll comments and closes the issue once", async () => {
    const { id, issue } = await filed(w, decision());
    const real = w.gh.comment.bind(w.gh);
    w.gh.comment = async () => {
      throw new Error("GitHub unreachable");
    };
    expect("recorded" in (await w.inbox.consoleAnswer({ id, rev: 1, action: "choose:A", session: 1, signedIn: false }))).toBe(true);
    expect((await w.inbox.read(id))!.status).toBe("chosen");
    expect(w.gh.issues.get(issue)!.state).toBe("open");
    w.gh.comment = real;
    await w.inbox.poll();
    await w.inbox.poll();
    expect(consoleReplies(w, issue)).toEqual(["Recorded from the console: Option A: Redis."]);
    expect(w.gh.issues.get(issue)!.state).toBe("closed");
  });
});
