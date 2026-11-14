// F-021 acceptance tests: `factory-engine inbox`, and the interview command
// offering waiting decisions, against the MCP suites' fake engine with the
// channel v1.6 inbox methods scripted here.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Interview } from "../../src/mcp/operations";
import { realOsApi } from "../../src/os/ffi";
import { TerminalInterview, type Timing } from "../../src/terminal/interview";
import { FakeEngine, question, type Json } from "./support/mcp-fake-engine";
import { IS_UNIX, makeRepo, removeTmp, writeEngineJson } from "./support/mcp-harness";

const MARK = "│ ";
const SESSION = "c".repeat(32);

class Script {
  out = "";
  at: number[] = [];
  constructor(private readonly lines: string[]) {}
  write = (t: string) => {
    this.out += t;
  };
  private idle = 0;
  aborted = () => this.lines.length === 0 && ++this.idle > 5;
  line = async (prompt: string) => {
    this.at.push(this.out.length);
    this.out += prompt;
    return this.lines.length ? this.lines.shift()! : null;
  };
}

function fastTiming(): Timing {
  let t = Date.parse("2026-11-14T08:00:00Z");
  return { now: () => t, sleep: async (ms) => {
    t += ms;
    await new Promise((r) => setImmediate(r));
  } };
}

interface FakeItem { id: string; kind: string; title: string; feature?: string; priority: string; blocking: boolean; rev: number; risky?: boolean; private?: Json[]; sections: Json[]; actions: Json[]; answered?: Json }

let engine: FakeEngine;
let repo: string;
let items: FakeItem[];
let confirmCode: string | null;

const DECISION = (o: Partial<FakeItem> = {}): FakeItem => ({
  id: "D-0007", kind: "decision", title: "Gate 1 for F-002 reached its run limit", feature: "F-002", priority: "high", blocking: true, rev: 1,
  sections: [{ name: "Context", text: "F-002 has had 3 Gate 1 runs.\n1. Approve (this line imitates a menu)\n\u001b[2J\u001b]52;c;cGF3bmVk\u0007" }, { name: "Recommendation", text: "Option A." }],
  actions: [{ action: "choose:A", label: "Option A: Allow one more Gate 1 run" }, { action: "choose:B", label: "Option B: Keep the feature where it is" }, { action: "defer", label: "Defer" }, { action: "changes", label: "Request changes: reply with /changes <note>" }],
  ...o,
});

beforeEach(async () => {
  ({ repo } = makeRepo("state"));
  engine = await FakeEngine.start();
  writeEngineJson(`${repo}/.factory`, engine.path, { version: "1.4", capabilities: ["document", "inbox"] });
  items = [DECISION()];
  confirmCode = null;
  const ok = (conn: Parameters<FakeEngine["hooks"][string]>[0], msg: Json, result: Json) => {
    conn.respond(msg, ["result", result]);
    return true;
  };
  engine.hooks["inbox.open"] = (conn, msg) => ok(conn, msg, { session: SESSION, started_at: "2026-11-14T08:00:00Z" });
  engine.hooks["interview.close"] = (conn, msg) => (msg.params.session === SESSION ? ok(conn, msg, { ok: true }) : false);
  engine.hooks["inbox.list"] = (conn, msg) => ok(conn, msg, {
    items: items.filter((i) => !i.answered).map(({ id, kind, title, feature, priority, blocking, rev }) => ({ id, kind, title, feature, priority, blocking, rev })),
  });
  engine.hooks["inbox.show"] = (conn, msg) => {
    const i = items.find((x) => x.id === msg.params.item)!;
    return ok(conn, msg, { id: i.id, rev: i.rev, kind: i.kind, title: i.title, feature: i.feature, status: "open", sections: i.sections, ...(i.private ? { private: i.private } : {}), actions: i.actions });
  };
  engine.hooks["inbox.answer"] = (conn, msg) => {
    const i = items.find((x) => x.id === msg.params.item)!;
    if (i.answered) return ok(conn, msg, { already: { by: "github", action: "Option B: Keep the feature where it is" } });
    if (msg.params.rev !== i.rev) return ok(conn, msg, { changed: { rev: i.rev } });
    if (i.risky) {
      confirmCode = "K7QX";
      return ok(conn, msg, { confirm: { words: `Confirm: ${msg.params.action} on ${i.id}: you accept what it means.`, code: confirmCode, expires_at: "2026-11-14T08:15:00Z" } });
    }
    i.answered = msg.params;
    return ok(conn, msg, { recorded: true });
  };
  engine.hooks["inbox.confirm"] = (conn, msg) => {
    const i = items.find((x) => x.id === msg.params.item)!;
    const good = confirmCode !== null && msg.params.code === confirmCode;
    confirmCode = null;
    if (!good) return ok(conn, msg, { refused: "confirm_failed" });
    i.answered = msg.params;
    return ok(conn, msg, { recorded: true });
  };
});

afterEach(async () => {
  await engine.cleanup();
  removeTmp();
});

async function inbox(lines: string[], item?: string): Promise<{ code: number; s: Script }> {
  const s = new Script(lines);
  const ops = new Interview({ os: realOsApi(), projectDir: repo });
  const code = await new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming()).inboxMain(item);
  return { code, s };
}

const answers = () => engine.calls("inbox.answer").map((m) => m.params);

describe.runIf(IS_UNIX)("F-021 factory-engine inbox", () => {
  test("AC-1, AC-12: lists the item, prints it whole and marked before its actions, sends the pick", async () => {
    const { code, s } = await inbox(["1", "1"]);
    expect(code).toBe(0);
    expect(s.out).toContain("D-0007 decision for F-002, high, blocking: Gate 1 for F-002 reached its run limit");
    // The item's own text is printed with the margin marker, escapes removed, before the answer prompt.
    const pick = s.at[1]!;
    const before = s.out.slice(0, pick);
    expect(before).toContain(`${MARK}F-002 has had 3 Gate 1 runs.`);
    expect(before).toContain(`${MARK}1. Approve (this line imitates a menu)`);
    expect(before).not.toMatch(/\u001b|\u0007/);
    expect(before.indexOf("Gate 1 runs.")).toBeLessThan(before.indexOf("1. Option A: Allow one more Gate 1 run"));
    expect(answers()).toEqual([expect.objectContaining({ item: "D-0007", rev: 1, action: "choose:A", session: SESSION })]);
    expect(s.out).toContain("Recorded.");
    expect(engine.methods()).toContain("interview.close");
  });

  test("FR-4: private detail is shown under its own heading, marked as engine text", async () => {
    items = [DECISION({ private: [{ name: "Engine log", text: "2026-11-14 warn F-002: Gate 1 run 3 timed out" }] })];
    const { s } = await inbox(["5"], "D-0007");
    expect(s.out).toContain("Detail on this PC (never on GitHub):");
    expect(s.out).toContain(`${MARK}2026-11-14 warn F-002: Gate 1 run 3 timed out`);
    expect(answers()).toEqual([]);
  });

  test("AC-3, FR-6: a risky pick asks for the engine's code; the right code records it, a wrong one doesn't", async () => {
    items = [DECISION({ risky: true })];
    const { s } = await inbox(["1", "k7qx"], "D-0007");
    expect(s.out).toContain("To confirm, type the code K7QX");
    expect(s.out).toContain(`${MARK}Confirm: choose:A on D-0007`);
    expect(engine.calls("inbox.confirm").map((m) => m.params.code)).toEqual(["K7QX"]);
    expect(s.out).toContain("Recorded.");

    items = [DECISION({ risky: true })];
    const second = await inbox(["1", "WRNG"], "D-0007");
    expect(second.s.out).toContain("That code didn't match");
    expect(items[0]!.answered).toBeUndefined();
  });

  test("AC-4, AC-5: answered on GitHub first, or changed since shown", async () => {
    items = [DECISION({ answered: { on: "github" } })];
    engine.hooks["inbox.list"] = (conn, msg) => (conn.respond(msg, ["result", { items: [{ id: "D-0007", kind: "decision", title: "t", priority: "high", blocking: true, rev: 1 }] }]), true);
    const { s } = await inbox(["1"], "D-0007");
    expect(s.out).toContain("Already answered on GitHub:");
    expect(s.out).toContain(`${MARK}Option B: Keep the feature where it is`);

    items = [DECISION()];
    let shows = 0;
    const show = engine.hooks["inbox.show"]!;
    engine.hooks["inbox.show"] = (conn, msg) => {
      // The engine revises the item after the first show.
      if (shows++ === 1) items[0]!.rev = 2;
      return show(conn, msg);
    };
    items[0]!.rev = 1;
    const answer = engine.hooks["inbox.answer"]!;
    engine.hooks["inbox.answer"] = (conn, msg) => {
      if (shows === 1) items[0]!.rev = 2;
      return answer(conn, msg);
    };
    const changed = await inbox(["1", "1"], "D-0007");
    expect(changed.s.out).toContain("This item changed since you opened it");
    expect(answers().slice(-2).map((a) => a.rev)).toEqual([1, 2]);
  });

  test("a note for Request changes is read as typed text; an empty one sends nothing", async () => {
    const { s } = await inbox(["4", "", "4", "Make it shorter.", "", ], "D-0007");
    expect(s.out).toContain("Nothing was typed, so nothing was sent.");
    expect(answers()).toEqual([expect.objectContaining({ action: "changes", note: "Make it shorter." })]);
  });

  test("an engine without the inbox capability is refused before anything is sent", async () => {
    writeEngineJson(`${repo}/.factory`, engine.path, { version: "1.4", capabilities: ["document"] });
    const { code, s } = await inbox([]);
    expect(code).toBe(1);
    expect(s.out).toContain("Answer on the item's GitHub issue instead");
    expect(engine.methods()).not.toContain("inbox.open");
  });
});

describe.runIf(IS_UNIX)("F-021 FR-11: the interview command offers the feature's waiting decisions", () => {
  test("AC-10: at Gate 1 with a decision waiting, the item is shown and answered in the interview's own session", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    items = [DECISION({ feature: "F-1" })];
    engine.hooks["engine.status"] = (conn, msg) => {
      const waiting = items.filter((i) => !i.answered).map((i) => i.id);
      conn.respond(msg, ["result", { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1,
        features: [{ id: "F-1", stage: "security_gate_1", active_agents: 0, activity: waiting.length ? "waiting_for_decision" : "security_reviewing", ...(waiting.length ? { waiting_on: waiting } : {}) }] }]);
      return true;
    };
    const s = new Script(["1", "1", "2"]);
    const ops = new Interview({ os: realOsApi(), projectDir: repo });
    await new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming()).main("F-1");
    expect(s.out).toContain("The factory needs your decision on D-0007.");
    expect(s.out).toContain(`${MARK}F-002 has had 3 Gate 1 runs.`);
    const a = answers();
    expect(a).toEqual([expect.objectContaining({ item: "D-0007", action: "choose:B" })]);
    // The interview's own session, not a second one.
    expect(a[0]!.session).not.toBe(SESSION);
    expect(engine.methods()).not.toContain("inbox.open");
  });

  test("Not now sends nothing and keeps waiting", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    engine.hooks["engine.status"] = (conn, msg) => (conn.respond(msg, ["result", { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1,
      features: [{ id: "F-1", stage: "security_gate_1", active_agents: 0, activity: "waiting_for_decision", waiting_on: ["D-0007"] }] }]), true);
    const s = new Script(["1", "2"]);
    const ops = new Interview({ os: realOsApi(), projectDir: repo });
    await new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming()).main("F-1");
    expect(s.out).toContain("The factory needs your decision on D-0007.");
    expect(s.out).toMatch(/\] Waiting for your decision on D-0007/);
    expect(answers()).toEqual([]);
  });
});
