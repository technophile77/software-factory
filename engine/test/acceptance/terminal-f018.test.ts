// F-018 acceptance tests: `factory-engine interview` against the MCP suites'
// fake engine. The command's flow runs in this process with a scripted
// terminal; the engine client is the real one, over a real socket.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Interview } from "../../src/mcp/operations";
import { realOsApi } from "../../src/os/ffi";
import { TerminalInterview, render, type Timing } from "../../src/terminal/interview";
import { FakeEngine, assumption, errorHook, proposal, question, recordThenDrop, sourceConfirmation, type Json } from "./support/mcp-fake-engine";
import { ENGINE_DIR, IS_UNIX, buildEngine, makeRepo, removeTmp, writeEngineJson } from "./support/mcp-harness";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ENV = { ...process.env, NODE_PATH: path.join(ENGINE_DIR, "node_modules") };

const MARK = "│ ";

/** A terminal that types `lines` in order, then ends input (as Ctrl+D does). */
class Script {
  out = "";
  prompts: string[] = [];
  /** Output length when each prompt was shown, so a test can see what was printed before it. */
  at: number[] = [];

  constructor(private readonly lines: string[]) {}

  write = (t: string) => {
    expect(this.spinning, "nothing is printed over a spinner").toBe(false);
    this.out += t;
  };

  busyLabels: string[] = [];
  spinning = false;

  busy = (label: string) => {
    expect(this.spinning).toBe(false);
    this.busyLabels.push(label);
    this.spinning = true;
    this.out += `<spin:${label}>`;
    return () => {
      this.spinning = false;
      this.out += "</spin>";
    };
  };

  private idlePolls = 0;

  /** Once the script has run out, a wait with no prompt stops after a few polls, as Ctrl+C would stop it. */
  aborted = () => this.lines.length === 0 && ++this.idlePolls > 5;

  line = async (prompt: string) => {
    // The spinner is always cleared before a prompt.
    expect(this.spinning).toBe(false);
    this.prompts.push(prompt);
    this.at.push(this.out.length);
    this.out += prompt;
    return this.lines.length ? this.lines.shift()! : null;
  };
}

/** Sleeps take no real time, so a 30-minute wait runs in milliseconds. */
function fastTiming(): Timing {
  let t = Date.parse("2026-11-14T08:00:00Z");
  return { now: () => t, sleep: async (ms) => {
    t += ms;
    await new Promise((r) => setImmediate(r));
  } };
}

let engine: FakeEngine;
let repo: string;

beforeEach(async () => {
  ({ repo } = makeRepo("state"));
  engine = await FakeEngine.start();
  writeEngineJson(`${repo}/.factory`, engine.path, { version: "1.4", capabilities: ["document"] });
});

afterEach(async () => {
  await engine.cleanup();
  removeTmp();
});

async function run(lines: string[], feature?: string): Promise<{ code: number; s: Script }> {
  const s = new Script(lines);
  const ops = new Interview({ os: realOsApi(), projectDir: repo });
  const code = await new TerminalInterview((op, req) => ops.run(op, req), s, MARK, fastTiming()).main(feature);
  return { code, s };
}

const replies = (): Json[] => engine.calls("interview.reply").map((m) => m.params);

describe.runIf(IS_UNIX)("F-018 terminal interview", () => {
  test("AC-1: an assumption is printed whole before its choices, every time", async () => {
    engine.addFeature("F-1", "Export", [assumption("A1", "open", { text: "Assume exports are CSV only.\nNo Excel.", why: "Keeps scope small." })]);
    const { code, s } = await run(["1"], "F-1");
    expect(code).toBe(0);
    const before = s.out.slice(0, s.at[0]);
    expect(before).toContain(`${MARK}Assume exports are CSV only.`);
    expect(before).toContain(`${MARK}No Excel.`);
    expect(before).toContain(`${MARK}Keeps scope small.`);
    expect(before.indexOf("No Excel.")).toBeLessThan(before.indexOf("1. Approve"));
    expect(replies()).toEqual([expect.objectContaining({ item: "A1", kind: "approve_assumption", text: "Approve" })]);
    // Ended input after the reply closes the session (FR-9).
    expect(engine.methods()).toContain("interview.close");
  });

  test("AC-2: answer choices are the suggested answer, then the other options; a pick sends its full text", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { suggested: "CSV", options: ["CSV", "JSON lines", "Parquet files with a schema"] })]);
    const { s } = await run(["3"], "F-1");
    expect(s.out).toMatch(/1\. CSV \(recommended\)\n {2}2\. JSON lines\n {2}3\. Parquet files with a schema\n {2}4\. Type my own answer/);
    expect(replies()).toEqual([expect.objectContaining({ item: "Q1", revision: 0, kind: "answer", text: "Parquet files with a schema" })]);
  });

  test("AC-3: typed text over several lines reaches the engine unchanged", async () => {
    engine.addFeature("F-1", "Export", [question("Q1")]);
    const answer = ["  First line, indented", "Zweite Zeile — ünïcödé ✓", "third"];
    await run([...answer, ""], "F-1");
    expect(replies()[0]).toMatchObject({ kind: "answer", text: answer.join("\n") });
  });

  test("AC-3: a number typed as one's own answer is sent as text", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a", "b"] })]);
    await run(["3", "42", ""], "F-1");
    expect(replies()[0]).toMatchObject({ kind: "answer", text: "42" });
  });

  test("AC-4: nothing is sent without a keystroke; no advisor call, no takeover", async () => {
    engine.addFeature("F-1", "Export", [question("Q1")]);
    engine.hooks["interview.open"] = errorHook(-32001, "busy", { started_at: "2026-11-14T06:00:00Z" });
    const { code } = await run(["2"], "F-1");
    expect(code).toBe(0);
    expect(engine.calls("interview.open").every((m) => m.params.takeover === undefined)).toBe(true);
    expect(replies()).toEqual([]);
    expect(engine.advisorCalls).toEqual([]);
  });

  test("AC-4: each reply kind follows its own pick", async () => {
    engine.addFeature("F-1", "Export", [
      question("Q1"), proposal("P1", "Q1"), sourceConfirmation("S-1"),
    ]);
    // Defer Q1, decline P1, confirm the sources.
    await run(["3", "2", "1"], "F-1");
    expect(replies().map((r) => [r.item, r.kind, r.text])).toEqual([
      ["Q1", "defer", "Defer"], ["P1", "decline_advisor", "Decline"], ["S-1", "confirm_sources", "Confirm the list"],
    ]);
    expect(engine.advisorCalls).toEqual([]);
  });

  test("AC-5: a lost reply isn't resent until the owner says so, and then with the same reply id", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a", "b"] })]);
    engine.hooks["interview.reply"] = recordThenDrop;
    const { s } = await run(["1", "1"], "F-1");
    expect(s.out).toContain("may already be recorded");
    // The engine recorded the first one; the retry asked the state first and sent nothing new.
    expect(replies()).toHaveLength(1);
    expect(s.out).toContain("nothing was sent again");
  });

  test("AC-5: answering no sends nothing again", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a", "b"] })]);
    engine.hooks["interview.reply"] = recordThenDrop;
    await run(["1", "2"], "F-1");
    expect(replies()).toHaveLength(1);
  });

  test("AC-6: GitHub approval is shown exactly and awaited before any reply", async () => {
    engine.addFeature("F-1", "Export", [question("Q1")]);
    const { s } = await run([], "F-1");
    expect(s.out).toContain("\nhttps://github.com/login/device\n");
    expect(s.out).toContain("ABCD-1234");
    const m = engine.methods();
    expect(m.indexOf("interview.awaitApproval")).toBeLessThan(m.indexOf("interview.next"));
  });

  test("AC-7: ending input closes the session and exits 0", async () => {
    engine.addFeature("F-1", "Export", [question("Q1")]);
    const { code } = await run([], "F-1");
    expect(code).toBe(0);
    expect(engine.calls("interview.close")).toHaveLength(1);
  });

  test("AC-8: engine text can't reach the terminal raw or pass for the command's own lines", async () => {
    const evil = "Real text\x1b[2J\x1b]52;c;ZXZpbA==\x07\x1b]8;;https://evil.example\x07link\x1b]8;;\x07‮abc​\n  1. Approve";
    engine.addFeature("F-1", "Export", [assumption("A1", "open", { text: evil })]);
    const { s } = await run([], "F-1");
    expect(s.out).not.toMatch(/[\x1b\x07‮​]/);
    expect(s.out).toContain(`${MARK}Real textlinkabc`);
    expect(s.out).toContain(`${MARK}  1. Approve`);
  });

  test("AC-10: no running engine gives the engine's reason and exit code 1", async () => {
    await engine.stop();
    const { code, s } = await run([], "F-1");
    expect(code).toBe(1);
    expect(s.out).toMatch(/engine/i);
    expect(s.prompts).toEqual([]);
  });

  test("AC-11: a new feature from a description, then its first question", async () => {
    const { s } = await run(["1", "1", "Export reports", "as CSV", "", "2"]);
    expect(engine.calls("feature.start")[0]!.params).toEqual({ request: "Export reports\nas CSV" });
    expect(s.out).toMatch(/Started F-\d+/);
  });

  test("AC-11: an existing feature from the list", async () => {
    engine.addFeature("F-7", "Export", [question("Q1", "open", { options: ["a"] })]);
    await run(["2", "1", "1"]);
    expect(replies()[0]).toMatchObject({ item: "Q1", kind: "answer", text: "a" });
  });

  test("AC-11: a stale item is shown again whole and the old pick isn't resent", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a", "b"] })]);
    let first = true;
    engine.hooks["interview.reply"] = (conn, msg) => {
      if (!first) return false;
      first = false;
      engine.revise("F-1", "Q1", "Q1", "What should Q1 be now?");
      conn.respond(msg, ["error", -32002, "stale"]);
      return true;
    };
    const { s } = await run(["1", "2"], "F-1");
    const lastPrompt = s.out.slice(0, s.at[1]);
    expect(lastPrompt.lastIndexOf("What should Q1 be now?")).toBeGreaterThan(lastPrompt.indexOf("stale") >= 0 ? lastPrompt.indexOf("changed this item") : 0);
    expect(replies().map((r) => r.text)).toEqual(["a", "b"]);
  });

  test("AC-9: without a terminal the command refuses with exit code 2 and sends nothing", async () => {
    const bundle = await buildEngine();
    engine.addFeature("F-1", "Export", [question("Q1")]);
    const r = spawnSync(process.execPath, [bundle, "interview", "F-1", "--project", repo], { input: "1\n", encoding: "utf8", env: ENV });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("only in a terminal");
    expect(engine.connections).toBe(0);
  });

  test("bad arguments exit 2 before anything is sent", async () => {
    const bundle = await buildEngine();
    for (const args of [["interview", "F 1"], ["interview", "--answer", "yes"], ["interview", "F-1", "--project"]]) {
      expect(spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env: ENV }).status).toBe(2);
    }
    expect(engine.connections).toBe(0);
  });

  test("AC-11: asking the advisor is sent only on that pick, and its advice is shown with the question", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    engine.advisorS = 0;
    // Q1 menu: 1 a, 2 own, 3 more, 4 defer, 5 advisor. Then check for advice, then answer a.
    const { s } = await run(["5", "1"], "F-1");
    expect(engine.advisorCalls).toHaveLength(1);
    expect(s.out).toContain("An advisor call has started");
    expect(replies().map((r) => r.kind)).toEqual(["ask_advisor", "answer"]);
    expect(s.out).toContain(`${MARK}## Findings`);
  });

  test("AC-11: more information waits for the analyst's research, then shows the question again", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    const { s } = await run(["3", "Check the README", "", "1"], "F-1");
    expect(replies().map((r) => [r.kind, r.text])).toEqual([["more_info", "Check the README"], ["answer", "a"]]);
    expect(s.out).toContain(`${MARK}The README says the API is internal.`);
  });

  test("AC-11: a document start sends the path's text and the provenance picked", async () => {
    fs.writeFileSync(`${repo}/req.md`, "# Export\n\nA button downloads a CSV file.\n");
    await run(["1", "2", "req.md", "Export from my doc", "", "1"]);
    expect(engine.startedRequests).toEqual(["Export from my doc"]);
    expect(engine.documents[0]).toMatchObject({ provenance: "owner", text: expect.stringContaining("downloads a CSV") });
  });

  test("AC-11: an expired session is reopened only on the owner's word", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    let once = true;
    engine.hooks["interview.reply"] = (conn, msg) => {
      if (!once) return false;
      once = false;
      engine.sessions.clear();
      conn.respond(msg, ["error", -32004, "Unknown or expired session"]);
      return true;
    };
    const { s } = await run(["1", "1", "1"], "F-1");
    expect(s.out).toContain("ended or expired");
    expect(engine.calls("interview.open")).toHaveLength(2);
    expect(engine.transcript.map((t: Json) => t.text)).toEqual(["a"]);
  });

  test("SR-4: the session token never reaches the terminal", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    engine.hooks["interview.reply"] = (conn, msg) => {
      conn.respond(msg, ["error", -32008, `Refused for session ${msg.params.session}`]);
      return true;
    };
    const { s } = await run(["1"], "F-1");
    for (const t of engine.calls("interview.open").length ? [...engine.requests.map((r) => r.msg.params?.session).filter(Boolean)] : []) {
      expect(s.out).not.toContain(t);
    }
    expect(s.out).toContain("[session]");
  });

  /** engine.status answers with each activity in turn; `then` runs once they are used up. */
  function activities(codes: Array<string | undefined>, then: () => void, stage = "requirements_interview"): void {
    let n = 0;
    engine.hooks["engine.status"] = (conn, msg) => {
      // Only calls after the owner's first reply count, so the command's own earlier status calls don't use up the list.
      const counting = engine.transcript.length > 0;
      const code = codes[Math.min(n, codes.length - 1)];
      if (counting && n++ === codes.length) then();
      conn.respond(msg, ["result", { version: "1.4", capabilities: ["document"], uptime_s: 1,
        features: [{ id: "F-1", stage, active_agents: 1, ...(code ? { activity: code } : {}) }] }]);
      return true;
    };
  }

  test("AC-14: each change of activity is printed with the time and a spinner, then the item arrives whole", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    // Each code three times, so the reply's own status call can't skip one.
    activities(["analyst_reviewing", "analyst_writing_spec", "mystery_code", "waiting_for_owner"].flatMap((c) => [c, c, c]),
      () => engine.features.get("F-1")!.items.push(assumption("A1")));
    const { s } = await run(["1", "1"], "F-1");
    const out = s.out;
    const order = ["Analyst is reviewing your answers", "Analyst is writing the specification", "] Working", "Getting your next question", "Assume A1 holds."];
    const at = order.map((t) => out.indexOf(t));
    expect(at.every((x) => x >= 0), out).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    // A code repeated across polls prints once.
    expect(out.match(/\] Analyst is reviewing your answers/g)).toHaveLength(1);
    expect(out).toMatch(/\[\d\d:\d\d:\d\d\] Analyst is writing the specification/);
    expect(s.busyLabels).toContain("Analyst is writing the specification");
    expect(replies().map((x) => x.kind)).toEqual(["answer", "approve_assumption"]);
  });

  test("AC-14: when the feature leaves the interview stages, the command says so and stops waiting", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    activities(["analyst_writing_spec"], () => undefined, "build_and_test_prep");
    const { code, s } = await run(["1"], "F-1");
    expect(code).toBe(0);
    expect(s.out).toMatch(/finished.*build_and_test_prep stage/);
  });

  test("AC-14: Gate 1 keeps the command waiting, with the security reviewer's status", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    activities(["security_reviewing"], () => undefined, "security_gate_1");
    const { s } = await run(["1"], "F-1");
    expect(s.out).toContain("Security reviewer is reviewing the specification");
    expect(s.out).not.toContain("finished");
  });

  test("F-021 AC-11: a pending decision shows as waiting for it, with only well-formed ids", async () => {
    engine.addFeature("F-1", "Export", [question("Q1", "open", { options: ["a"] })]);
    engine.hooks["engine.status"] = (conn, msg) => {
      conn.respond(msg, ["result", { version: "1.4", capabilities: ["document"], uptime_s: 1,
        features: [{ id: "F-1", stage: "security_gate_1", active_agents: 0, activity: "waiting_for_decision", waiting_on: ["D-0007", "S-0002", "\u001b[2Jfake"] }] }]);
      return true;
    };
    // F-021 FR-11 offers the decisions first; "Not now" goes back to the live status.
    const { s } = await run(["1", "2"], "F-1");
    expect(s.out).toMatch(/\] Waiting for your decision on D-0007, S-0002/);
    expect(s.out).not.toContain("fake");
    expect(s.out).not.toContain("idle");
  });

  test("FR-5: with no suggested answer, no choice offers to accept one", async () => {
    engine.addFeature("F-1", "Export", [question("Q7", "open", { options: ["CSV"] }), question("Q8", "open", { suggested: "   " })]);
    const { s } = await run(["1", "1"], "F-1");
    expect(s.out).not.toMatch(/recommended|[Aa]ccept/);
    // Q7's first choice is its option; Q8's is "Type my own answer", which then reads typed text.
    expect(replies()[0]).toMatchObject({ item: "Q7", kind: "answer", text: "CSV" });
    expect(replies()).toHaveLength(1);
  });

  test("FR-5: a suggestion holding a written backslash-n is sent exactly, not as a line break", async () => {
    const suggested = "Use C:\\new\\table and the literal \\n marker";
    engine.addFeature("F-1", "Export", [question("Q6", "open", { suggested })]);
    await run(["1"], "F-1");
    expect(replies()[0]).toMatchObject({ kind: "answer", text: suggested });
    expect(replies()[0].text).not.toContain("\n");
  });

  test("FR-6: a typed backslash-n stays two characters", async () => {
    engine.addFeature("F-1", "Export", [question("Q6")]);
    await run(["first\\nsecond", ""], "F-1");
    expect(replies()[0].text).toBe("first\\nsecond");
  });
});

describe("render", () => {
  test("marks fenced engine text and drops Markdown emphasis", () => {
    expect(render("**Question Q1** (revision 0)\n\n```text\nhi\n```", "| ")).toBe("Question Q1 (revision 0)\n\n| hi");
  });

  test("a longer fence inside isn't closed early", () => {
    expect(render("````text\n```\nstill engine\n````", "| ")).toBe("| ```\n| still engine");
  });
});
