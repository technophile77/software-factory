// F-005 v10's criteria for the interview operations, which the
// `factory-engine interview` command (F-018) now runs in-process: AC-13
// (FR-15, FR-17), AC-14 (FR-16, SR-18), AC-16's tool-set version (FR-18) and
// FR-19's project directory. The MCP-only checks (tool listing, annotations,
// the server process's sockets) went with the MCP mode (ADR 0029).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIELDS } from "../../src/mcp/operations";
import { question } from "./support/mcp-fake-engine";
import {
  IS_UNIX, Ops, type ToolResult, buildEngine, expectCleanFailure, expectNothingSent, expectOk, makeRepo, removeTmp, tmp, traffic,
} from "./support/mcp-harness";
import { McpWorld } from "./support/mcp-world";

let bundle: string;
let w: McpWorld | undefined;
const extra: Ops[] = [];

beforeAll(async () => {
  bundle = await buildEngine();
});
afterEach(async () => {
  for (const m of extra.splice(0)) await m.close();
  await w?.cleanup();
  w = undefined;
});
afterAll(() => removeTmp());

async function startMcp(projectDir: string | undefined): Promise<{ m: Ops; startedIn: number }> {
  const t0 = Date.now();
  const m = await Ops.start(bundle, projectDir);
  extra.push(m);
  return { m, startedIn: Date.now() - t0 };
}

// AC-13 quotes "engine not reachable"; an error code naming it (engine_unreachable) counts too.
const NOT_REACHABLE = /engine[^\n]{0,40}(not reachable|unreachable)|not reachable[^\n]{0,40}engine/i;
const describeText = (r: ToolResult) => `${r.out?.error?.code ?? ""}\n${r.out?.error?.message ?? ""}\n${r.out?.display ?? ""}`;

// ---------------------------------------------------------------------------
// AC-13 (FR-15, FR-17): tools listed at once with no engine; status then fails
// ---------------------------------------------------------------------------

describe("AC-13: with no engine running, status says so", () => {
  it.runIf(IS_UNIX)("with a factory repo whose engine isn't running (no engine.json)", async () => {
    const { repo } = makeRepo("state");
    const { m } = await startMcp(repo);
    const r = await m.call("interview_status");
    expectCleanFailure(r);
    expect(describeText(r)).toMatch(NOT_REACHABLE);
  });

  it.runIf(IS_UNIX)("with a stale engine.json whose socket is gone", async () => {
    w = await McpWorld.create(bundle);
    await w.engine.stop();
    const { m } = await startMcp(w.repo);
    const r = await m.call("interview_status");
    expectCleanFailure(r);
    expect(describeText(r)).toMatch(NOT_REACHABLE);
  });

  it.runIf(IS_UNIX)("FR-17: starting never contacts the engine", async () => {
    w = await McpWorld.create(bundle);
    const before = traffic(w.engine);
    await startMcp(w.repo);
    await new Promise((r) => setTimeout(r, 300));
    expectNothingSent(w.engine, before, "the operations contacted the engine before any call");
  });

  it.runIf(IS_UNIX)("FR-17: it connects for each tool call (a new connection per call)", async () => {
    w = await McpWorld.create(bundle);
    expectOk(await w.call("status"));
    expectOk(await w.call("list"));
    expectOk(await w.call("status"));
    expect(w.engine.connections).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// FR-19: the repo comes from CLAUDE_PROJECT_DIR
// ---------------------------------------------------------------------------

describe("FR-19: the project directory", () => {
  it("without CLAUDE_PROJECT_DIR every tool refuses and names the reason", async () => {
    const { m } = await startMcp(undefined);
    for (const [tool, args] of [["interview_status", {}], ["interview_list", {}], ["interview_start", { request: "x" }],
      ["interview_state", { feature: "F-1", item: "Q1" }]] as const) {
      const r = await m.call(tool, args);
      expectCleanFailure(r);
      expect(describeText(r), tool).toMatch(/CLAUDE_PROJECT_DIR|project (dir|folder)/i);
    }
  });

  it.runIf(IS_UNIX)("a repo with no factory/state worktree is refused, naming factory/state", async () => {
    const { repo } = makeRepo("none");
    const { m } = await startMcp(repo);
    const r = await m.call("interview_status");
    expectCleanFailure(r);
    expect(describeText(r)).toMatch(/factory\/state/);
  });

  it.runIf(IS_UNIX)("a project folder that isn't a factory repo is refused even while a factory repo's engine runs", async () => {
    w = await McpWorld.create(bundle);
    const elsewhere = tmp();
    const m = await Ops.start(bundle, elsewhere);
    extra.push(m);
    const before = traffic(w.engine);
    expectCleanFailure(await m.call("interview_status"));
    expectNothingSent(w.engine, before);
  });
});

// ---------------------------------------------------------------------------
// AC-14 (FR-16, SR-18): the session token never leaves the MCP mode process
// ---------------------------------------------------------------------------

describe.runIf(IS_UNIX)("AC-14: the session token stays in the process", () => {
  it("no tool result, display or error carries the token, through a whole interview", async () => {
    w = await McpWorld.create(bundle);
    w.engine.addFeature("F-1", "t", [question("Q1"), question("Q2", "deferred"), question("Q3")]);
    const results: ToolResult[] = [];
    const call = async (tool: string, args: Record<string, unknown> = {}, on?: Ops) => {
      const r = await w!.call(tool, args, on);
      results.push(r);
      return r;
    };
    await call("status");
    await call("list");
    const open = await call("open", { feature: "F-1" });
    expect(open.out.ok).toBe(true);
    expect(open.out).not.toHaveProperty("session");
    await call("approval", { feature: "F-1", wait_s: 0 });
    await call("next", { feature: "F-1" });
    await call("reply", { feature: "F-1", item: "Q2", revision: 0, status: "deferred", kind: "answer", text: "a" });
    await call("reply", { feature: "F-1", item: "Q1", revision: 7, status: "open", kind: "answer", text: "stale" }); // error: stale
    w.engine.hooks["interview.reply"] = (conn, msg) => {
      // An engine error that quotes the session token back.
      conn.respond(msg, ["error", -32000, `Refused for session ${msg.params.session}`, { session: msg.params.session }]);
      return true;
    };
    await call("reply", { feature: "F-1", item: "Q1", revision: 0, status: "open", kind: "answer", text: "b" });
    delete w.engine.hooks["interview.reply"];
    await call("state", { feature: "F-1", item: "Q1" });
    const other = await w.another();
    await call("open", { feature: "F-1" }, other); // busy
    await call("open", { feature: "F-1", takeover: true }, other);
    await call("approval", { feature: "F-1", wait_s: 0 }, other);
    await call("next", { feature: "F-1" }); // the first process's session has ended
    await call("close", { feature: "F-1" }, other);
    const tokens = new Set(w.tokens());
    expect(tokens.size, "the test needs the tokens the engine issued").toBeGreaterThanOrEqual(2);
    for (const r of results) {
      for (const tok of tokens) {
        expect(r.text, "a tool result carries the session token").not.toContain(tok);
        expect(r.text.toLowerCase()).not.toContain(tok.toLowerCase());
      }
    }
    for (const tok of tokens) {
      expect(w.mcp.stderrText).not.toContain(tok);
      expect(other.stderrText).not.toContain(tok);
    }
  });

  it("a second MCP mode process can't next, reply, approve or close a feature it didn't open, without contacting the engine", async () => {
    w = await McpWorld.create(bundle);
    w.oneQuestion();
    await w.open();
    const other = await w.another();
    for (const [tool, args] of [["next", { feature: "F-1" }], ["next", { feature: "F-1", wait_s: 5 }],
      ["reply", { feature: "F-1", item: "Q1", revision: 0, status: "open", kind: "answer", text: "not the owner's" }],
      ["reply", { feature: "F-1", item: "Q1", revision: 0, status: "open", kind: "answer", text: "x", reply_id: "r".repeat(32) }],
      ["approval", { feature: "F-1", wait_s: 0 }], ["close", { feature: "F-1" }]] as const) {
      const r = await w.call(tool, args, other);
      w.expectRefusedBeforeConnecting(r);
    }
    expect(w.engine.transcript).toEqual([]);
    // The owner's own session is untouched.
    expect((await w.next()).item.id).toBe("Q1");
  });

  it("a tool call made before interview_open in this session is refused without contacting the engine", async () => {
    w = await McpWorld.create(bundle);
    w.oneQuestion();
    w.engine.openSession("F-1"); // the owner's approved session, held by another chat
    for (const [tool, args] of [["next", { feature: "F-1" }],
      ["reply", { feature: "F-1", item: "Q1", revision: 0, status: "open", kind: "approve_assumption", text: "yes" }],
      ["close", { feature: "F-1" }]] as const) {
      w.expectRefusedBeforeConnecting(await w.call(tool, args));
    }
  });

  it("opening one feature doesn't let the process reply in another", async () => {
    w = await McpWorld.create(bundle);
    w.oneQuestion();
    w.engine.addFeature("F-2", "other", [question("Q1")]);
    w.engine.openSession("F-2");
    await w.open("F-1");
    w.expectRefusedBeforeConnecting(await w.call("reply", { feature: "F-2", item: "Q1", revision: 0, status: "open", kind: "answer", text: "x" }));
    w.expectRefusedBeforeConnecting(await w.call("next", { feature: "F-2" }));
  });

  it("no tool accepts a session token as an input", async () => {
    w = await McpWorld.create(bundle);
    for (const [op, fields] of Object.entries(FIELDS)) expect(fields, op).not.toContain("session");
    // An unknown `session` field is refused by the operations' own check, not silently used.
    w.oneQuestion();
    const tok = w.engine.openSession("F-1");
    w.expectRefusedBeforeConnecting(await w.call("next", { feature: "F-1", session: tok }));
  });
});

// ---------------------------------------------------------------------------
// AC-16 (FR-18): the tool-set version; SR-20: annotations
// ---------------------------------------------------------------------------

describe("AC-16 / FR-18: interview_status reports the tool-set version", () => {
  it.runIf(IS_UNIX)("tools_version is a positive whole number, the same on every call and in every process", async () => {
    w = await McpWorld.create(bundle);
    const a = expectOk(await w.call("status"));
    expect(Number.isInteger(a.tools_version) && a.tools_version > 0, JSON.stringify(a)).toBe(true);
    const b = expectOk(await w.call("status", {}, await w.another()));
    expect(b.tools_version).toBe(a.tools_version);
  });
});

describe("FR-15: inputs", () => {
  it("each operation's inputs are the old subcommands' inputs, with feature in place of session", () => {
    const sorted = Object.fromEntries(Object.entries(FIELDS).map(([op, f]) => [op, [...f].sort()]));
    expect(sorted).toEqual({
      status: [], list: [],
      start: ["document", "request"],
      open: ["feature", "takeover"],
      approval: ["feature", "wait_s"],
      next: ["feature", "wait_s"],
      reply: ["feature", "item", "kind", "reply_id", "revision", "status", "text", "wait_s"],
      state: ["feature", "item"],
      close: ["feature"],
      // F-021: the console's inbox operations.
      inbox_open: [], inbox_list: ["feature"], inbox_show: ["feature", "item"],
      inbox_answer: ["action", "feature", "item", "note", "reply_id", "rev"],
      inbox_confirm: ["code", "feature", "item", "rev"],
    });
  });
});
