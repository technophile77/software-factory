// F-005 v10 end to end: the interview operations `factory-engine interview`
// runs (F-018, ADR 0029) against the real engine (engine/test/helpers.ts's
// world: real git, fake GitHub and clock). Spec constraint: "tested ...
// end to end with the real engine". Unix only here: the engine serves a
// named pipe on Windows, and this file has not been run there.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../../src/engine";
import { OTHER_ID, OWNER_ID, type World, engineJson, makeWorld, removeTmpdirs, start } from "../helpers";
import { IS_UNIX, Ops, type ToolResult, buildEngine, expectCleanFailure, expectOk, removeTmp } from "./support/mcp-harness";

let bundle: string | undefined;
const engines: EngineHandle[] = [];
const procs: Ops[] = [];

afterEach(async () => {
  for (const m of procs.splice(0)) await m.close();
  for (const e of engines.splice(0)) await e.stop();
});
afterAll(() => {
  removeTmp();
  removeTmpdirs();
});

async function setup(): Promise<{ w: World; m: Ops }> {
  bundle ??= await buildEngine();
  const w = makeWorld();
  engines.push(await start(w));
  return { w, m: await mcp(w) };
}

async function mcp(w: World): Promise<Ops> {
  const m = await Ops.start(bundle!, w.config);
  procs.push(m);
  return m;
}

const call = (m: Ops, tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> => m.call(`interview_${tool}`, args);

/** The owner approves on (fake) GitHub; polls interview_approval until the engine accepts. */
async function approve(w: World, m: Ops, feature: string, approver = OWNER_ID): Promise<ToolResult> {
  w.github.approver = approver;
  await w.clock.advance(5000);
  w.github.approver = null;
  let r: ToolResult | undefined;
  for (let i = 0; i < 200; i++) {
    r = await call(m, "approval", { feature, wait_s: 0 });
    if (!r.isError || r.out?.error?.code !== -32006) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  return r!;
}

describe.runIf(IS_UNIX)("MCP mode against the real engine", () => {
  it("AC-1 / AC-16: interview_status reaches the engine and reports the tool-set version", async () => {
    const { w, m } = await setup();
    const out = expectOk(await call(m, "status"));
    expect(Number.isInteger(out.tools_version) && out.tools_version > 0).toBe(true);
    expect(out.features).toEqual([]);
    expect(engineJson(w).pid).toBe(process.pid);
  });

  it("AC-3 / AC-4: start sends the request unchanged, and list shows the new feature", async () => {
    const { m } = await setup();
    const request = "Let owners export their data\nas CSV — \"quoted\" ✓";
    const out = expectOk(await call(m, "start", { request }));
    expect(out.feature).toBe("F-001");
    const list = expectOk(await call(m, "list"));
    expect(list.features).toEqual([{ id: "F-001", title: "Let owners export their data", open: 0, deferred: 0, pending_assumptions: 0 }]);
    const st = expectOk(await call(m, "status"));
    expect(st.features).toEqual(["F-001"]);
  });

  it("open with GitHub approval through interview_approval, next, close; the token never shows", async () => {
    const { w, m } = await setup();
    expectOk(await call(m, "start", { request: "Export reports" }));
    const open = await call(m, "open", { feature: "F-001" });
    const o = expectOk(open);
    expect(o.approval).toMatchObject({ user_code: "ABCD-1234", verification_uri: "https://github.com/login/device" });
    expect(o).not.toHaveProperty("session");
    // Before the owner approves, the engine holds replies back.
    const pending = await call(m, "next", { feature: "F-001" });
    expect(expectCleanFailure(pending).name).toBe("approval_pending");
    const ok = expectOk(await approve(w, m, "F-001"));
    expect(ok.approved).toBe(true);
    const nextResult = await call(m, "next", { feature: "F-001" });
    const nxt = expectOk(nextResult);
    expect(nxt.item).toBeNull();
    expect(typeof nxt.display).toBe("string");
    for (const r of [open, pending, nextResult]) expect(r.text).not.toMatch(/\b[0-9a-f]{32}\b/);
    expect(expectOk(await call(m, "close", { feature: "F-001" })).closed).toBe(true);
    // Closed: another chat can open it now.
    const other = await mcp(w);
    expectOk(await call(other, "open", { feature: "F-001" }));
  });

  it("AC-9: a second MCP process gets busy; with takeover the first session ends", async () => {
    const { w, m } = await setup();
    expectOk(await call(m, "start", { request: "Export reports" }));
    expectOk(await call(m, "open", { feature: "F-001" }));
    expectOk(await approve(w, m, "F-001"));
    const other = await mcp(w);
    const busy = await call(other, "open", { feature: "F-001" });
    const err = expectCleanFailure(busy);
    expect(err.name).toBe("busy");
    expect(busy.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expectOk(await call(m, "next", { feature: "F-001" }));
    expectOk(await call(other, "open", { feature: "F-001", takeover: true }));
    expectOk(await approve(w, other, "F-001"));
    expect(expectCleanFailure(await call(m, "next", { feature: "F-001" })).name).toBe("session_expired");
    expectOk(await call(other, "next", { feature: "F-001" }));
  });

  it("AC-14: a second process can't next or reply in the owner's session", async () => {
    const { w, m } = await setup();
    expectOk(await call(m, "start", { request: "Export reports" }));
    expectOk(await call(m, "open", { feature: "F-001" }));
    expectOk(await approve(w, m, "F-001"));
    const other = await mcp(w);
    expect(expectCleanFailure(await call(other, "next", { feature: "F-001" })).code).not.toBe(-32004);
    expectCleanFailure(await call(other, "reply", { feature: "F-001", item: "Q1", revision: 0, status: "open", kind: "answer", text: "x" }));
    expectOk(await call(m, "next", { feature: "F-001" }));
  });

  it("v1.2: an approval by the wrong GitHub account fails and ends the session", async () => {
    const { w, m } = await setup();
    expectOk(await call(m, "start", { request: "Export reports" }));
    expectOk(await call(m, "open", { feature: "F-001" }));
    const r = await approve(w, m, "F-001", OTHER_ID);
    expect(expectCleanFailure(r).name).toBe("approval_failed");
  });

  it("interview_state on an unknown item names it unknown", async () => {
    const { m } = await setup();
    expectOk(await call(m, "start", { request: "Export reports" }));
    expect(expectCleanFailure(await call(m, "state", { feature: "F-001", item: "Q9" })).name).toBe("unknown");
  });

  it("AC-13: after the engine stops, status fails and names the engine", async () => {
    const { m } = await setup();
    expectOk(await call(m, "status"));
    await engines.pop()!.stop();
    const r = await call(m, "status");
    expectCleanFailure(r);
    expect(`${r.out.error.code} ${r.out.error.message}`).toMatch(/engine/i);
  });
});
