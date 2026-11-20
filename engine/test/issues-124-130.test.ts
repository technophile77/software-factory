import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TurnQueue } from "../src/agent/runtime";
import { activityOf } from "../src/interview/activity";
import type { FeatureInterview } from "../src/interview/feature";
import { InterviewState, wire } from "../src/interview/model";
import { makeEntry } from "../src/state/transcript";
import { EngineRecord } from "../src/state/record";
import { RunBook } from "../src/state/runs";
import { FakeClock, tmpdir } from "./helpers";

/** Just what TurnQueue reads of a feature. */
function fakeFeature() {
  const f = { paused: false, state: { undelivered: [] as string[] }, changed: new EventEmitter(), takeTurn: async () => ({ message: f.state.undelivered.shift()! }) };
  return f;
}

describe("issue #124: a feature whose analyst waits for the owner says so", () => {
  it("the turn queue is idle once every turn it gave has ended, and busy again on the owner's reply", async () => {
    const f = fakeFeature();
    const q = new TurnQueue(f as unknown as FeatureInterview, "start");
    const it = q[Symbol.asyncIterator]();
    expect(q.idle).toBe(false);
    await it.next();
    expect(q.idle).toBe(false);
    q.turnEnded();
    expect(q.idle).toBe(true);
    const pending = it.next();
    f.state.undelivered.push("owner reply");
    f.changed.emit("change");
    expect((await pending).done).toBe(false);
    expect(q.idle).toBe(false);
    q.turnEnded();
    expect(q.idle).toBe(true);
    q.close();
  });

  it("a reply handed over mid-turn and folded into it: one result leaves the queue idle (mesbot F-003)", async () => {
    const f = fakeFeature();
    f.state.undelivered.push("owner reply recorded before the run");
    const q = new TurnQueue(f as unknown as FeatureInterview, "start");
    const it = q[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    q.working();
    q.turnEnded();
    expect(q.idle).toBe(true);
    q.close();
  });

  it("a reply worked on as its own turn after a result shows as working again once the session produces output", async () => {
    const f = fakeFeature();
    f.state.undelivered.push("reply");
    const q = new TurnQueue(f as unknown as FeatureInterview, "start");
    const it = q[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    q.turnEnded();
    q.working();
    expect(q.idle).toBe(false);
    q.turnEnded();
    expect(q.idle).toBe(true);
    q.close();
  });

  it("an open question with the analyst's turn over is waiting_for_owner, not analyst_reviewing", () => {
    expect(activityOf({ stage: "requirements_interview", paused: false, running: false, statuses: ["open"] })).toBe("waiting_for_owner");
    expect(activityOf({ stage: "requirements_interview", paused: false, running: true, statuses: ["open"] })).toBe("analyst_reviewing");
  });
});

describe("issue #130: a revised question stays readable", () => {
  const created = () => makeEntry(null, { type: "item_created", item: { id: "Q-001", kind: "question", text: "q", why: "w" } }, "t");

  it("a revision written the old way, with no question type, gets no question type", () => {
    const s = new InterviewState();
    s.apply(created());
    s.apply(makeEntry(null, { type: "item_revised", item: "Q-001", revision: 1, text: "q2", why: "w2", options: ["a", "b"] }, "t"));
    const it = s.items.get("Q-001")!;
    expect(it).toMatchObject({ revision: 1, text: "q2", status: "open" });
    expect(it.type).toBeUndefined();
    expect(wire(it).type).toBeUndefined();
  });

  it("a revision written the old way with a question type still counts as a revision", () => {
    const s = new InterviewState();
    s.apply(created());
    s.apply(makeEntry(null, { type: "gap", item: "Q-001", revision: 1, text: "q2", why: "w2" }, "t"));
    expect(s.items.get("Q-001")).toMatchObject({ revision: 1, text: "q2", type: "gap" });
  });

  it("a revision written now keeps its event type and its question type apart", () => {
    const s = new InterviewState();
    s.apply(created());
    s.apply(makeEntry(null, { type: "item_revised", item: "Q-001", revision: 1, text: "q2", why: "w2", question_type: "conflict" }, "t"));
    expect(s.items.get("Q-001")).toMatchObject({ revision: 1, type: "conflict" });
  });
});

describe("F-007 FR-14 (owner, 2026-11-20): a restart while the analyst waits on the owner costs no resume", () => {
  it("resumes without counting while awaiting the owner, and counts again once it works", () => {
    const book = new RunBook(new EngineRecord(tmpdir()), new FakeClock());
    const r = book.start({ project: "p", feature: "F-001", role: "requirements-analyst", stage: "requirements_interview" });
    book.update(r.id, { session_id: "s", awaiting_owner: true });
    for (let i = 0; i < 5; i++) {
      book.markInterrupted();
      expect(book.resume(r.id)).toMatchObject({ mode: "session", run: { resumes: 0, status: "running" } });
    }
    book.update(r.id, { awaiting_owner: false });
    for (let i = 1; i <= 3; i++) {
      book.markInterrupted();
      expect(book.resume(r.id)).toMatchObject({ run: { resumes: i } });
    }
    book.markInterrupted();
    expect(book.resume(r.id)).toMatchObject({ mode: "failed" });
  });

  it("the turn queue tells the run when it starts and stops waiting on the owner", async () => {
    const f = fakeFeature();
    const seen: boolean[] = [];
    const q = new TurnQueue(f as unknown as FeatureInterview, "start", (idle) => seen.push(idle));
    const it = q[Symbol.asyncIterator]();
    await it.next();
    q.turnEnded();
    const pending = it.next();
    f.state.undelivered.push("reply");
    f.changed.emit("change");
    await pending;
    expect(seen).toEqual([false, true, false]);
    q.close();
  });
});
