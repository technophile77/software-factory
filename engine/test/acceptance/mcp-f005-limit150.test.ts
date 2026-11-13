// F-005 v10 SR-15: "every tool returns within 150 s", whatever wait it was
// asked for, in real time against an engine that never answers. New with
// v10 (the Python suite checked this only in SKILL.md's Bash timeout text).
// Unix only (the fake engine's socket).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { neverAnswer } from "./support/mcp-fake-engine";
import { IS_UNIX, buildEngine, expectCleanFailure, removeTmp } from "./support/mcp-harness";
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
// Measured at the MCP client, so it includes the stdio round trip and the
// SDK's own handling (tens of milliseconds), which the MCP mode doesn't control.
const LIMIT_S = 151;

describe.runIf(IS_UNIX)("SR-15: every tool returns within 150 s", () => {
  it("interview_next with wait_s 600 against a silent engine", async () => {
    w = await McpWorld.create(bundle);
    w.oneQuestion();
    await w.open();
    w.engine.hooks["interview.next"] = neverAnswer;
    const r = await w.call("next", { feature: "F-1", wait_s: 600 });
    expectCleanFailure(r);
    expect(r.elapsed).toBeLessThanOrEqual(LIMIT_S);
    const calls = w.engine.calls("interview.next");
    expect(calls[calls.length - 1]!.params.wait_s ?? 0, "the engine was asked to wait past the tool's limit").toBeLessThan(150);
  }, LONG);

  it("interview_approval with wait_s 900 against a silent engine", async () => {
    w = await McpWorld.create(bundle);
    w.oneQuestion();
    expectCleanFailure(await w.call("next", { feature: "F-1" })); // not open yet: refused
    const open = await w.call("open", { feature: "F-1" });
    expect(open.out.ok).toBe(true);
    w.engine.hooks["interview.awaitApproval"] = neverAnswer;
    const r = await w.call("approval", { feature: "F-1", wait_s: 900 });
    expectCleanFailure(r);
    expect(r.elapsed).toBeLessThanOrEqual(LIMIT_S);
    const calls = w.engine.calls("interview.awaitApproval");
    expect(calls[calls.length - 1]!.params.wait_s ?? 0).toBeLessThan(150);
  }, LONG);
});
