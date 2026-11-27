// F-021 acceptance tests: `factory-engine inbox`, and the interview command
// offering waiting decisions, against the MCP suites' fake engine with the
// channel v1.6 inbox methods scripted here.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Interview } from "../../src/mcp/operations";
import { realOsApi } from "../../src/os/ffi";
import { TerminalInterview, type Timing } from "../../src/terminal/interview";
import { FakeEngine, assumption, question, type Json } from "./support/mcp-fake-engine";
import { ConsoleModel } from "../../src/terminal/console-model";
import { Poller, windowedIo } from "../../src/terminal/windowed";
import { ENGINE_DIR, IS_UNIX, buildEngine, makeRepo, removeTmp, writeEngineJson } from "./support/mcp-harness";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const ENV = { ...process.env, NODE_PATH: path.join(ENGINE_DIR, "node_modules") };

const MARK = "│ ";
const SESSION = "c".repeat(32);

class Script {
  out = "";
  at: number[] = [];
  drawn: string[] = [];
  constructor(private readonly lines: string[]) {}
  redraw = (t: string) => {
    this.drawn.push(t);
  };
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
  id: "D-0007", kind: "decision", title: "Security and Testability Review for F-002 reached its run limit", feature: "F-002", priority: "high", blocking: true, rev: 1,
  sections: [{ name: "Context", text: "F-002 has had 3 Security and Testability Review runs.\n1. Approve (this line imitates a menu)\n\u001b[2J\u001b]52;c;cGF3bmVk\u0007" }, { name: "Recommendation", text: "Option A." }],
  actions: [{ action: "choose:A", label: "Option A: Allow one more Security and Testability Review run" }, { action: "choose:B", label: "Option B: Keep the feature where it is" }, { action: "defer", label: "Defer" }, { action: "changes", label: "Request changes: reply with /changes <note>" }],
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

async function inbox(lines: string[], item?: string, s = new Script(lines)): Promise<{ code: number; s: Script }> {
  const ops = new Interview({ os: realOsApi(), projectDir: repo });
  const code = await new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming()).inboxMain(item);
  return { code, s };
}

const answers = () => engine.calls("inbox.answer").map((m) => m.params);

describe.runIf(IS_UNIX)("F-021 factory-engine inbox", () => {
  test("AC-1, AC-12: lists the item, prints it whole and marked before its actions, sends the pick", async () => {
    const { code, s } = await inbox(["1", "1"]);
    expect(code).toBe(0);
    expect(s.out).toContain("D-0007 decision for F-002, high, blocking: Security and Testability Review for F-002 reached its run limit");
    // The item's own text is printed with the margin marker, escapes removed, before the answer prompt.
    const pick = s.at[1]!;
    const before = s.out.slice(0, pick);
    expect(before).toContain(`${MARK}F-002 has had 3 Security and Testability Review runs.`);
    expect(before).toContain(`${MARK}1. Approve (this line imitates a menu)`);
    expect(before).not.toMatch(/\u001b|\u0007/);
    expect(before.indexOf("Security and Testability Review runs.")).toBeLessThan(before.indexOf("1. Option A: Allow one more Security and Testability Review run"));
    expect(answers()).toEqual([expect.objectContaining({ item: "D-0007", rev: 1, action: "choose:A", session: SESSION })]);
    expect(s.out).toContain("Recorded.");
    expect(engine.methods()).toContain("interview.close");
  });

  test("FR-4: private detail is shown under its own heading, marked as engine text", async () => {
    items = [DECISION({ private: [{ name: "Engine log", text: "2026-11-14 warn F-002: Security and Testability Review run 3 timed out" }] })];
    const { s } = await inbox(["5"], "D-0007");
    expect(s.out).toContain("Detail on this PC (never on GitHub):");
    expect(s.out).toContain(`${MARK}2026-11-14 warn F-002: Security and Testability Review run 3 timed out`);
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

  test("F-015 FR-21 (owner, 2026-11-27): sending work to a role asks for an optional note and sends it with the choice", async () => {
    items = [DECISION({ actions: [{ action: "choose:C", label: "Option C: Send it to the developer" }, { action: "choose:D", label: "Option D: Send it to the test engineer" }, { action: "choose:B", label: "Option B: Keep F-004 stopped" }] })];
    const { s } = await inbox(["2", "Skip the flock tests off Linux.", ""], "D-0007");
    expect(s.out).toContain("Add a note for the test engineer (press Enter for none):");
    expect(answers()).toEqual([expect.objectContaining({ action: "choose:D", note: "Skip the flock tests off Linux." })]);
  });

  test("AC-13, SR-3: without a terminal, or with a bad item id or extra argument, the command exits 2 and sends nothing", async () => {
    const bundle = await buildEngine();
    const piped = spawnSync(process.execPath, [bundle, "inbox", "D-0007", "--project", repo], { input: "1\n", encoding: "utf8", env: ENV });
    expect(piped.status).toBe(2);
    expect(piped.stderr).toContain("factory-engine inbox runs only in a terminal");
    for (const args of [["inbox", "F-1"], ["inbox", "D-0007", "--answer", "A"], ["inbox", "../D-0007"]]) {
      expect(spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env: ENV }).status).toBe(2);
    }
    expect(engine.connections).toBe(0);
  });

  test("AC-15 (v7 FR-2, FR-12): with nothing open the console stays, shows each feature's status, and offers an item when one opens", async () => {
    items = [];
    let calls = 0;
    engine.hooks["engine.status"] = (conn, msg) => {
      calls++;
      // The third look finds the build moved on and an item filed.
      if (calls === 3) items = [DECISION()];
      const activity = calls < 3 ? "tests_running" : "waiting_for_decision";
      conn.respond(msg, ["result", { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1,
        features: [{ id: "F-002", stage: "orchestrator_review", active_agents: calls < 3 ? 1 : 0, activity, ...(calls < 3 ? {} : { waiting_on: ["D-0007"] }) }] }]);
      return true;
    };
    const { code, s } = await inbox(["1", "1"]);
    expect(code).toBe(0);
    expect(s.out).toContain("Watching the factory; press Ctrl+C to stop.");
    expect(s.out).toContain("F-002: Tests are running");
    // The same status isn't printed again on every look.
    expect(s.out.split("F-002: Tests are running").length).toBe(2);
    expect(s.out).toContain("An item is waiting for you.");
    expect(answers()).toEqual([expect.objectContaining({ item: "D-0007", action: "choose:A" })]);
    expect(engine.methods()).toContain("interview.close");
  });

  /** engine.status: F-1 waits for the owner's answer until a reply is recorded, then its analyst works. */
  function askingStatus(): void {
    engine.hooks["engine.status"] = (conn, msg) => {
      const answered = engine.calls("interview.reply").length > 0;
      conn.respond(msg, ["result", { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1,
        features: [{ id: "F-1", stage: "requirements_interview", active_agents: answered ? 1 : 0, activity: answered ? "analyst_writing_spec" : "waiting_for_owner" }] }]);
      return true;
    };
  }

  test("AC-18 (v9 FR-17): a feature's waiting question is offered, answered in place, and the console goes back to watching", async () => {
    items = [];
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["CSV"] })]);
    askingStatus();
    const { code, s } = await inbox(["1", "1"]);
    expect(code).toBe(0);
    expect(s.out).toContain("F-1: Waiting for your answer");
    expect(s.out).toContain("F-1 has a question waiting for you.");
    expect(engine.calls("interview.reply").map((m) => m.params)).toEqual([expect.objectContaining({ item: "Q1" })]);
    expect(s.out).toContain("back to watching the factory");
    expect(s.out).toContain("F-1: Analyst is writing the specification");
    expect(s.out).not.toContain("Getting your next question");
  });

  test("AC-18 (v9 FR-17): Not now sends nothing and isn't asked again while the feature keeps waiting", async () => {
    items = [];
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["CSV"] })]);
    askingStatus();
    const { code, s } = await inbox(["2"]);
    expect(code).toBe(0);
    expect(s.out.split("has a question waiting for you").length).toBe(2);
    expect(engine.calls("interview.reply")).toEqual([]);
  });

  test("FR-17: a waiting question is offered beside open items, answered in place, and the items menu comes back", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["CSV"] })]);
    askingStatus();
    const { code, s } = await inbox(["2", "1", "3"]);
    expect(code).toBe(0);
    expect(s.out).toContain("F-1: a question is waiting for you");
    expect(engine.calls("interview.reply").map((m) => m.params)).toEqual([expect.objectContaining({ item: "Q1" })]);
    expect(answers()).toEqual([]);
    // Once answered, the feature isn't offered again.
    expect(s.out.split("F-1: a question is waiting for you").length).toBe(2);
  });

  test("FR-18: a held project's console says why it is on hold, once, and lists the hold item", async () => {
    items = [DECISION({ id: "D-0018", title: "Pinned owner keys changed", feature: undefined })];
    engine.hooks["engine.status"] = (conn, msg) => {
      conn.respond(msg, ["result", { version: "1.10", capabilities: ["document", "inbox", "held"], uptime_s: 1, features: [], held: { reason: "a change to mcp_servers\u001b[2J" } }]);
      return true;
    };
    const { code, s } = await inbox(["", "3"]);
    expect(code).toBe(0);
    expect(s.out).toContain("This project is on hold: a change to mcp_servers. Answer D-0018 to confirm the change, or press Ctrl+C and run `factory-engine confirm --project <this project>`.");
    expect(s.out).not.toContain("\u001b[2J");
    expect(s.out.split("This project is on hold").length).toBe(2);
  });

  const STATUS = { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1, features: [{ id: "F-002", stage: "orchestrator_review", active_agents: 1, activity: "tests_running" }] };

  test("AC-16 (v8 FR-16): an engine restart is waited out with a countdown, the console session opened again, and the watch carries on", async () => {
    items = [];
    let calls = 0;
    let restarted = false;
    const NEW_SESSION = "d".repeat(32);
    engine.hooks["engine.status"] = (conn, msg) => {
      calls++;
      // The second and third looks find the engine gone; the fourth finds a new engine with an item filed.
      if (calls === 2 || calls === 3) {
        conn.close();
        return true;
      }
      if (calls >= 4 && !restarted) {
        restarted = true;
        items = [DECISION()];
      }
      conn.respond(msg, ["result", STATUS]);
      return true;
    };
    engine.hooks["inbox.open"] = (conn, msg) => {
      conn.respond(msg, ["result", { session: restarted ? NEW_SESSION : SESSION, started_at: "2026-11-14T08:00:00Z" }]);
      return true;
    };
    const list = engine.hooks["inbox.list"]!;
    engine.hooks["inbox.list"] = (conn, msg) => {
      // The restarted engine doesn't know the old session.
      if (restarted && msg.params.session === SESSION) {
        conn.respond(msg, ["error", -32004, "Unknown or expired session."]);
        return true;
      }
      return list(conn, msg);
    };
    engine.hooks["interview.close"] = (conn, msg) => {
      conn.respond(msg, ["result", { ok: true }]);
      return true;
    };
    const { code, s } = await inbox(["1", "1"]);
    expect(code).toBe(0);
    expect(s.out).toMatch(/Lost the connection to the engine \((it closed the connection|the connection couldn't be opened|it didn't answer in time)\)\. Reconnecting until it is back; press Ctrl\+C to stop\./);
    expect(s.drawn).toContain("Reconnecting in 1s (attempt 1)");
    expect(s.drawn).toContain("Reconnecting in 2s (attempt 2)");
    expect(s.drawn).toContain("Reconnecting in 1s (attempt 2)");
    expect(s.drawn.at(-1)).toBe("");
    expect(s.out).toContain("Reconnected to the engine.");
    // The status is shown again after the restart.
    expect(s.out.split("F-002: Tests are running").length).toBe(3);
    expect(engine.calls("inbox.open").length).toBe(2);
    expect(s.out).toContain("An item is waiting for you.");
    expect(answers()).toEqual([expect.objectContaining({ item: "D-0007", action: "choose:A" })]);
  });

  test("AC-16 (v8 FR-16): the wait doubles up to 60 s, and Ctrl+C during the countdown ends with exit 0", async () => {
    items = [];
    let calls = 0;
    engine.hooks["engine.status"] = (conn, msg) => {
      if (++calls === 1) conn.respond(msg, ["result", STATUS]);
      else conn.close();
      return true;
    };
    const s = new Script([]);
    s.aborted = () => s.drawn.includes("Reconnecting in 1s (attempt 9)");
    const { code } = await inbox([], undefined, s);
    expect(code).toBe(0);
    // Each attempt's countdown starts at its wait.
    const first = new Map<string, number>();
    for (const d of s.drawn) {
      const m = /^Reconnecting in (\d+)s \(attempt (\d+)\)$/.exec(d);
      if (m && !first.has(m[2]!)) first.set(m[2]!, Number(m[1]));
    }
    expect([...first.values()]).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
    expect(s.drawn.at(-1)).toBe("");
  });

  test("AC-16 (v8 FR-16): with no running engine at start the console waits for one, counting down", async () => {
    await engine.stop();
    const s = new Script([]);
    s.aborted = () => s.drawn.includes("Reconnecting in 1s (attempt 3)");
    const { code } = await inbox([], undefined, s);
    expect(code).toBe(0);
    expect(s.out).toContain("The engine isn't running. Waiting for it to start; press Ctrl+C to stop.");
    expect(s.drawn).toContain("Reconnecting in 4s (attempt 3)");
    expect(engine.connections).toBe(0);
  });

  test("a factory that runs but doesn't serve this project is reported as a stopped project, with the confirm command, once it stays away", async () => {
    await engine.stop();
    const s = new Script([]);
    s.aborted = () => s.drawn.includes("Reconnecting in 1s (attempt 3)");
    const ops = new Interview({ os: realOsApi(), projectDir: repo });
    const t = new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming());
    t.factoryRunning = async () => 21112;
    t.projectArg = "/work/mesbot-factory";
    expect(await t.inboxMain()).toBe(0);
    expect(s.out).toContain("The factory is running (pid 21112) but isn't serving this project, so the project is stopped.");
    expect(s.out).toContain("`factory-engine confirm --project /work/mesbot-factory`");
    // The first message is the plain wait; the project is called stopped only after it stays away.
    expect(s.out.indexOf("The engine isn't running")).toBeLessThan(s.out.indexOf("isn't serving this project"));
    expect(s.out.split("isn't serving this project").length).toBe(2);
  });

  test("a project that restarts within a second is never called stopped", async () => {
    items = [];
    let calls = 0;
    engine.hooks["engine.status"] = (conn, msg) => {
      calls++;
      // The second look finds the project restarting; the third finds it back.
      if (calls === 2) {
        conn.close();
        return true;
      }
      conn.respond(msg, ["result", { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1, features: [] }]);
      return true;
    };
    const s = new Script([]);
    s.aborted = () => s.out.includes("Reconnected to the engine.") && s.out.split("Watching the factory").length > 1;
    const ops = new Interview({ os: realOsApi(), projectDir: repo });
    const t = new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming());
    t.factoryRunning = async () => 21112;
    expect(await t.inboxMain()).toBe(0);
    expect(s.out).toContain("Lost the connection to the engine (");
    expect(s.out).toContain("Reconnected to the engine.");
    expect(s.out).not.toContain("isn't serving this project");
  });

  test("with no factory running at all, the wait still says the engine isn't running", async () => {
    await engine.stop();
    const s = new Script([]);
    s.aborted = () => s.drawn.includes("Reconnecting in 1s (attempt 2)");
    const ops = new Interview({ os: realOsApi(), projectDir: repo });
    const t = new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming());
    t.factoryRunning = async () => undefined;
    expect(await t.inboxMain()).toBe(0);
    expect(s.out).toContain("The engine isn't running. Waiting for it to start");
  });

  test("an engine without the inbox capability is refused before anything is sent, and the inbox keeps trying instead of exiting", async () => {
    writeEngineJson(`${repo}/.factory`, engine.path, { version: "1.4", capabilities: ["document"] });
    const s = new Script([]);
    s.aborted = () => s.drawn.includes("Trying again in 2s");
    const { code } = await inbox([], undefined, s);
    expect(code).toBe(0);
    expect(s.out).toContain("Answer on the item's GitHub issue instead");
    expect(s.out).toContain("The console couldn't be opened. Trying again until it works; press Ctrl+C to stop.");
    expect(s.drawn).toContain("Trying again in 2s");
    expect(engine.methods()).not.toContain("inbox.open");
  });

  test("owner's rule 2026-11-27: a refused sign-in wait doesn't end the inbox; it opens the console again once the engine lets it", async () => {
    let refuse = 1;
    engine.hooks["interview.awaitApproval"] = (conn, msg) => {
      if (refuse-- > 0) conn.respond(msg, ["error", -32010, "acme is on hold: a change to mcp_servers."]);
      else conn.respond(msg, ["result", { approved: true }]);
      return true;
    };
    engine.hooks["inbox.open"] = (conn, msg) => {
      conn.respond(msg, ["result", { session: SESSION, started_at: "2026-11-14T08:00:00Z", approval: { user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_at: "2026-11-14T08:15:00Z" } }]);
      return true;
    };
    const { code, s } = await inbox(["1", "1"]);
    expect(code).toBe(0);
    expect(s.out).toContain("The console couldn't be opened. Trying again until it works");
    expect(s.out).toContain("Approved.");
    expect(answers()).toEqual([expect.objectContaining({ item: "D-0007", action: "choose:A" })]);
  });
});

describe.runIf(IS_UNIX)("F-021 FR-11: the interview command offers the feature's waiting decisions", () => {
  test("AC-10: at Security and Testability Review with a decision waiting, the item is shown and answered in the interview's own session", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    items = [DECISION({ feature: "F-1" })];
    engine.hooks["engine.status"] = (conn, msg) => {
      const waiting = items.filter((i) => !i.answered).map((i) => i.id);
      conn.respond(msg, ["result", { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1,
        features: [{ id: "F-1", stage: "security_testability_review", active_agents: 0, activity: waiting.length ? "waiting_for_decision" : "security_reviewing", ...(waiting.length ? { waiting_on: waiting } : {}) }] }]);
      return true;
    };
    const s = new Script(["1", "1", "2"]);
    const ops = new Interview({ os: realOsApi(), projectDir: repo });
    await new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming()).main("F-1");
    expect(s.out).toContain("The factory needs your decision on D-0007.");
    expect(s.out).toContain(`${MARK}F-002 has had 3 Security and Testability Review runs.`);
    const a = answers();
    expect(a).toEqual([expect.objectContaining({ item: "D-0007", action: "choose:B" })]);
    // The interview's own session, not a second one.
    expect(a[0]!.session).not.toBe(SESSION);
    expect(engine.methods()).not.toContain("inbox.open");
  });

  test("Not now sends nothing and keeps waiting", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    engine.hooks["engine.status"] = (conn, msg) => (conn.respond(msg, ["result", { version: "1.4", capabilities: ["document", "inbox"], uptime_s: 1,
      features: [{ id: "F-1", stage: "security_testability_review", active_agents: 0, activity: "waiting_for_decision", waiting_on: ["D-0007"] }] }]), true);
    const s = new Script(["1", "2"]);
    const ops = new Interview({ os: realOsApi(), projectDir: repo });
    await new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming()).main("F-1");
    expect(s.out).toContain("The factory needs your decision on D-0007.");
    expect(s.out).toMatch(/\] Waiting for your decision on D-0007/);
    expect(answers()).toEqual([]);
  });
});

// ---------- F-024: the windowed console, driven through its model (no terminal) ----------

const RUN_A = "R-aaaaaaaaaaaa";
const RUN_B = "R-bbbbbbbbbbbb";

/**
 * Runs a command in the windowed console: answers are typed into the answer
 * bar as they are asked, and the console quits once `until` holds.
 */
async function windowedRun(o: { answers: string[]; transcript?: boolean; until: (m: ConsoleModel) => boolean; keys?: (m: ConsoleModel) => void; interview?: string }) {
  const ops = new Interview({ os: realOsApi(), projectDir: repo });
  const runner = (op: Parameters<typeof ops.run>[0], req: Record<string, unknown>) => ops.run(op, req);
  const timing = fastTiming();
  const model = new ConsoleModel({ project: "acme", transcript: o.transcript ?? false, now: timing.now });
  const t = new TerminalInterview(runner, windowedIo(model, timing), MARK, timing);
  const poller = new Poller(model, runner, () => t.sessionKey(), timing);
  let answered = 0;
  model.onChange(() => o.keys?.(model));
  model.onChange(() => {
    if (model.prompt === null || answered === model.asks || !o.answers.length) return;
    answered = model.asks;
    setImmediate(() => {
      for (const ch of o.answers.shift()!) model.key(ch, {});
      model.key("", { return: true });
    });
  });
  const watcher = setInterval(() => {
    o.keys?.(model);
    if (o.until(model)) model.stop();
  }, 5);
  const polling = poller.run();
  try {
    const code = await (o.interview ? t.main(o.interview) : t.inboxMain());
    return { code, model, frame: () => model.frame(MARK) };
  } finally {
    clearInterval(watcher);
    poller.stop();
    model.stop();
    await polling;
  }
}

const TRANSCRIPT_STATUS = { ...{ version: "1.4", capabilities: ["document", "inbox", "transcript"], uptime_s: 1 },
  features: [{ id: "F-003", stage: "requirements_interview", active_agents: 1, activity: "analyst_researching" }, { id: "F-007", stage: "build_and_test_prep", active_agents: 1, activity: "developer_working" }] };

describe.runIf(IS_UNIX)("F-024 windowed console", () => {
  beforeEach(() => {
    writeEngineJson(`${repo}/.factory`, engine.path, { version: "1.4", capabilities: ["document", "inbox", "transcript"] });
    engine.hooks["engine.status"] = (conn, msg) => {
      conn.respond(msg, ["result", TRANSCRIPT_STATUS]);
      return true;
    };
    engine.hooks["engine.transcript"] = (conn, msg) => {
      const after = (msg.params.after as number | undefined) ?? 0;
      const all = [
        { seq: 1, at: "2026-11-14T08:00:01Z", run: RUN_A, feature: "F-003", role: "requirements-analyst", kind: "text", text: "Reading the spec.\u001b]52;c;cGF3bmVk\u0007" },
        { seq: 2, at: "2026-11-14T08:00:02Z", run: RUN_B, feature: "F-007", role: "software-developer", kind: "tool", text: "Bash npm test" },
        { seq: 3, at: "2026-11-14T08:00:03Z", run: RUN_A, feature: "F-003", role: "requirements-analyst", kind: "tool", text: "Read docs/spec.md" },
      ];
      conn.respond(msg, ["result", {
        agents: [
          { run: RUN_A, feature: "F-003", role: "requirements-analyst", started_at: "2026-11-14T07:58:00Z" },
          { run: RUN_B, feature: "F-007", role: "software-developer", started_at: "2026-11-14T07:59:00Z", cost_usd: 0.42 },
        ],
        entries: all.filter((e) => e.seq > after), next: 3, skipped: 0,
      }]);
      return true;
    };
  });

  test("AC-4: an item opened from the Inbox is shown whole, marked, and its pick recorded; Status shows each feature", async () => {
    const r = await windowedRun({ answers: ["1", "1"], until: () => answers().length > 0 });
    expect(answers()).toEqual([expect.objectContaining({ item: "D-0007", action: "choose:A" })]);
    expect(r.model.statusRows).toEqual(["F-003 (Interview): Analyst is researching", "F-007 (Building): Developer is working"]);
    // FR-15: the side pane's features, with their stage.
    expect(r.model.frame(MARK).pane.lines.join("\n")).toContain("F-003 Interview, F-007 Building");
    r.model.tab = "inbox";
    const shown = r.frame().lines.join("\n");
    expect(r.model.frame(MARK).windowTitle).toBe("Inbox");
    expect(shown + "").toBeDefined();
    // The conversation keeps the item's text with the engine-text marker.
    r.model.resize(80, 40);
    r.model.key("", { home: true });
    expect(r.frame().lines.join("\n")).toContain(`${MARK}F-002 has had 3 Security and Testability Review runs.`);
  });

  test("AC-5, AC-12: with -v the Transcript shows only the selected agent, cleaned; Down picks the other one", async () => {
    items = [];
    let switched = false;
    const r = await windowedRun({
      answers: [], transcript: true,
      keys: (m) => {
        if (!switched && m.tab !== "agents") {
          m.key("3", {});
        } else if (m.agents.length === 2 && !switched && m.tab === "agents") {
          switched = true;
          m.key("", { upArrow: true });
        }
      },
      until: (m) => switched && m.agents.length === 2,
    });
    expect(r.model.agents.map((a) => a.run)).toEqual([RUN_A, RUN_B]);
    // The newest agent was selected first; Up picked the analyst.
    expect(r.model.selectedRun).toBe(RUN_A);
    r.model.tab = "transcript";
    const f = r.frame();
    expect(f.windowTitle).toBe("Transcript: F-003 requirements-analyst");
    const text = f.lines.join("\n");
    expect(text).toContain("Reading the spec.");
    expect(text).toContain("* Read docs/spec.md");
    expect(text).not.toContain("npm test");
    expect(text).not.toMatch(/[\u001b\u0007]/);
    r.model.tab = "agents";
    expect(r.frame().lines.join("\n")).toContain("F-007 software-developer");
    expect(r.frame().lines.join("\n")).toContain("$0.42");
  });

  test("AC-6: without -v and without the Agents window, the transcript is read only with the status, for the side pane's agents", async () => {
    items = [];
    let looks = 0;
    let reads = 0;
    const status = engine.hooks["engine.status"]!;
    engine.hooks["engine.status"] = (conn, msg) => {
      looks++;
      return status(conn, msg);
    };
    const transcript = engine.hooks["engine.transcript"]!;
    engine.hooks["engine.transcript"] = (conn, msg) => {
      reads++;
      return transcript(conn, msg);
    };
    const r = await windowedRun({ answers: [], until: (m) => looks >= 6 && m.agents.length === 2 });
    expect(r.model.tab).not.toBe("transcript");
    // One read per poller status at most (the watch loop reads the status too), never once a second.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(looks);
    expect(r.model.frame(MARK).pane.lines.join("\n")).toContain("Agents: F-003 requirements-analyst");
  });

  test("AC-8: an engine restart marks the windows stale, counts down in the title, and the Log has both events", async () => {
    items = [];
    let looks = 0;
    let sawCountdown = false;
    const status = engine.hooks["engine.status"]!;
    engine.hooks["engine.status"] = (conn, msg) => {
      looks++;
      // Away from the third look until the title has counted down.
      if (looks >= 3 && !sawCountdown && looks < 500) {
        conn.close();
        return true;
      }
      return status(conn, msg);
    };
    const r = await windowedRun({
      answers: [],
      keys: (m) => {
        if (m.frame(MARK).title.includes("Reconnecting in")) sawCountdown = true;
      },
      until: (m) => sawCountdown && !m.stale && m.engine !== "connecting",
    });
    expect(sawCountdown).toBe(true);
    r.model.tab = "log";
    const log = r.frame().lines.join("\n");
    expect(log).toContain("Lost the connection to the engine");
    expect(log).toContain("Connected to the engine again");
    // AC-14: once a status read answers after the reconnect, the title is not marked stale.
    expect(r.frame().title).not.toContain("(stale)");
    expect(r.frame().title).toContain("engine connected");
  });

  test("AC-9: the interview command shows the waiting assumption in the Inbox window and sends the pick", async () => {
    engine.addFeature("F-1", "Export", [assumption("A1")]);
    const r = await windowedRun({ answers: ["1"], interview: "F-1", until: () => engine.calls("interview.reply").length > 0 });
    expect(engine.calls("interview.reply").map((m) => m.params.kind)).toEqual(["approve_assumption"]);
    expect(r.model.tab).toBe("inbox");
  });
});
