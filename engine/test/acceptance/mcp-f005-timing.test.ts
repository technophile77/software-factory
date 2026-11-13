// F-005 v10 AC-17, SR-15 and AC-11: the MCP mode's time limits, in real time.
// The Python suite shortened the client's 60 s limit in-process; the MCP mode
// is its own process with no such knob, so these wait out the real limits:
// 60 s per channel call, extended by the `wait_s` it asks the engine to wait,
// and every tool back within 150 s. Split from mcp-f005.test.ts so the
// minutes they take run beside the rest. Unix only (the fake engine's socket).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ID_RE, neverAnswer, recordNeverAnswer } from "./support/mcp-fake-engine";
import { IS_UNIX, buildEngine, expectCleanFailure, expectOk, removeTmp } from "./support/mcp-harness";
import { McpWorld } from "./support/mcp-world";

let bundle: string;
let w: McpWorld;

beforeAll(async () => {
  if (IS_UNIX) bundle = await buildEngine();
});
afterEach(async () => {
  await w?.cleanup();
});
afterAll(() => removeTmp());

const LONG = 240_000;

describe.runIf(IS_UNIX)("SR-15 / AC-11: real-time limits", () => {
  it("test_sr15_silent_engine_real_60_second_timeout (and test_sr15_timeout_is_60_seconds_per_call)", async () => {
    w = await McpWorld.create(bundle);
    w.engine.hooks["engine.status"] = neverAnswer;
    const r = await w.call("status");
    const err = expectCleanFailure(r);
    expect(err.code).toBe("timeout");
    expect(err.message).toMatch(/answer|time/i);
    expect(r.elapsed).toBeGreaterThanOrEqual(58);
    expect(r.elapsed).toBeLessThan(90);
  }, LONG);

  it("test_ac11_timeout_after_send_then_retry", async () => {
    w = await McpWorld.create(bundle);
    w.oneQuestion();
    await w.open();
    w.engine.hooks["interview.reply"] = recordNeverAnswer;
    const r = await w.reply("Q1", "answer", "Use CSV.");
    const err = expectCleanFailure(r);
    expect(err.code).toBe("timeout");
    expect(r.text).not.toContain("Use CSV.");
    const rid = r.out.reply_id;
    expect(rid ?? "").toMatch(ID_RE);
    delete w.engine.hooks["interview.reply"];
    const n = w.engine.requests.length;
    const out = expectOk(await w.reply("Q1", "answer", "Use CSV.", { reply_id: rid }));
    expect(w.engine.methods().slice(n)).toEqual(["interview.state"]);
    expect(out.already_recorded).toBe(true);
    expect(w.engine.transcript).toHaveLength(1);
  }, LONG);

  it("test_sr15_wait_for_research_is_not_cut_by_the_call_limit", async () => {
    // The engine answers after 63 s, past the 60 s call limit, but within the
    // 75 s the MCP mode asked it to wait for research.
    w = await McpWorld.create(bundle);
    w.oneQuestion();
    await w.open();
    w.engine.hooks["interview.next"] = (conn, msg) => {
      setTimeout(() => void conn.engine.handle(msg).then((o) => conn.respond(msg, o)), 63_000);
      return true;
    };
    const r = await w.call("next", { feature: "F-1", wait_s: 75 });
    expectOk(r);
    const calls = w.engine.calls("interview.next");
    expect(calls[calls.length - 1]!.params.wait_s).toBe(75);
    expect(r.elapsed).toBeGreaterThanOrEqual(62);
  }, LONG);
});
