// Interview sessions on the channel (FR-6, channel v1.1 to v1.3 rules):
// session lock and takeover, lifetimes, revisions and `stale`, reply ids,
// deferred items once per session, `wait_s`, reply kinds.
import { afterEach, describe, expect, it } from "vitest";
import { drive, realDelay } from "./support/clock";
import { askAndFetch, expectRpcError, interviewReady, ISO_UTC, SESSION_TOKEN } from "./support/flows";
import { ERR } from "./support/rpc";
import { rand, waitFor, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const MIN = 60_000;

describe("Session lock and takeover (channel v1.1, ADR 0014)", () => {
  it("[SE-1] a second interview.open gets busy (-32001) with data.started_at in ISO 8601 UTC; the token is 128 bits of hex", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const first = await w.ok("interview.open", { feature: f });
    expect(first.session).toMatch(SESSION_TOKEN);
    expect(first.started_at).toMatch(ISO_UTC);
    const second = await w.rpc("interview.open", { feature: f });
    expectRpcError(second, ERR.busy);
    expect(second.error!.data.started_at).toMatch(ISO_UTC);
    expect(second.error!.data.started_at).toBe(first.started_at);
  });

  it("[SE-2] takeover ends the old session and the new one needs its own approval", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const old = await w.approvedSession(f);
    const taken = await w.ok("interview.open", { feature: f, takeover: true });
    expect(taken.session).not.toBe(old);
    expectRpcError(await w.rpc("interview.next", { session: old }), ERR.session);
    expectRpcError(await w.rpc("interview.next", { session: taken.session }), ERR.approvalPending);
  });

  it("[SE-3] edge case: takeover during a pending approval; approving the old code doesn't approve the new session", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const first = await w.ok("interview.open", { feature: f });
    const second = await w.ok("interview.open", { feature: f, takeover: true });
    expect(second.approval.user_code).not.toBe(first.approval.user_code);
    w.gh.approve(first.approval.user_code, w.projects[0].ownerId);
    for (let i = 0; i < 30; i++) {
      await realDelay(5);
      await w.clock.advance(1000);
    }
    expectRpcError(await w.rpc("interview.next", { session: second.session }), ERR.approvalPending);
    expectRpcError(await w.rpc("interview.next", { session: first.session }), ERR.session);
  });

  it("[SE-4] interview.close releases the lock and ends the session", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const s = await w.approvedSession(f);
    expect(await w.ok("interview.close", { session: s })).toEqual({ ok: true });
    expectRpcError(await w.rpc("interview.next", { session: s }), ERR.session);
    expect((await w.rpc("interview.open", { feature: f })).result?.session).toMatch(SESSION_TOKEN);
  });

  it("[SE-5] the lock is released after 30 minutes without a call", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const s = await w.approvedSession(f);
    await w.clock.advance(31 * MIN);
    expectRpcError(await w.rpc("interview.next", { session: s }), ERR.session);
    expect((await w.rpc("interview.open", { feature: f })).result?.session).toMatch(SESSION_TOKEN);
  });

  it("[SE-6] calls within 30 minutes keep a session alive, but it ends 2 hours after approval", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const s = await w.approvedSession(f);
    for (let t = 20; t <= 100; t += 20) {
      await w.clock.advance(20 * MIN);
      expect((await w.rpc("interview.next", { session: s })).result, `alive at ${t} min`).toBeDefined();
    }
    await w.clock.advance(21 * MIN);
    expectRpcError(await w.rpc("interview.next", { session: s }), ERR.session);
  });

  it("[SE-7] an unknown session token is -32004, and so is a malformed one", async () => {
    w = await World.create();
    await w.boot();
    expectRpcError(await w.rpc("interview.next", { session: "0".repeat(32) }), ERR.session);
    const bad = await w.rpc("interview.next", { session: "not a token" });
    expect([ERR.session, ERR.invalidParams]).toContain(bad.error?.code);
  });
});

describe("Items, revisions, replies (channel v1.1)", () => {
  it("[SE-8] Item shape: id, revision, kind, text, why, suggested, options, findings, status; ids match the id pattern", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const item = await askAndFetch(w, feature, session, {
      text: "CSV or JSON?",
      why: "Format drives the parser.",
      suggested: "CSV",
      options: ["CSV", "JSON"],
      findings: [{ text: "Most users use spreadsheets.", source: "https://example.org/survey" }],
    });
    expect(item).toMatchObject({
      kind: "question",
      text: "CSV or JSON?",
      why: "Format drives the parser.",
      suggested: "CSV",
      options: ["CSV", "JSON"],
      findings: [{ text: "Most users use spreadsheets.", source: "https://example.org/survey" }],
      status: "open",
    });
    expect(item.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(Number.isInteger(item.revision) && item.revision >= 0).toBe(true);
  });

  it("[SE-9] a reply naming a revision other than the current one is stale (-32002) and changes nothing", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const item = await askAndFetch(w, feature, session);
    expectRpcError(await w.reply(session, { id: item.id, revision: item.revision + 1 }, "answer", "x"), ERR.stale);
    const st = await w.ok("interview.state", { feature, item: item.id });
    expect(st.status).toBe("open");
    expect(st.revision).toBe(item.revision);
  });

  it("[SE-10] more_info puts a question in research; the analyst's revision brings it back open at revision + 1; the old revision is then stale; wait_s waits for it; itemReady is sent", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const listener = await w.connect();
    const item = await askAndFetch(w, feature, session);
    let revised = false;
    w.analyst.onTurn = async (_f, _m, tools) => {
      if (revised) return;
      revised = true;
      await tools.call("interview_revise", {
        item: item.id,
        text: item.text + " (with findings)",
        why: item.why,
        findings: [{ text: "Found it.", source: "https://example.org/a" }],
      });
    };
    const r = await w.reply(session, item, "more_info", "What do others do?");
    expect(r.result?.status).toBeDefined();
    const next = await drive(w.clock, w.rpc("interview.next", { session, wait_s: 600 }, 60_000));
    expect(next.result.item.id).toBe(item.id);
    expect(next.result.item.revision).toBe(item.revision + 1);
    expect(next.result.item.status).toBe("open");
    expect(next.result.item.findings).toEqual([{ text: "Found it.", source: "https://example.org/a" }]);
    expectRpcError(await w.reply(session, item, "answer", "late"), ERR.stale);
    await waitFor(
      () => listener.notifications.find((n) => n.method === "interview.itemReady" && n.params?.item === item.id),
      5000,
      "interview.itemReady",
    ).then((n) => expect(n.params).toEqual({ feature, item: item.id }));
    listener.close();
  });

  it("[SE-11] while research runs the item is researching; wait_s waits at most 600 s of engine time", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const item = await askAndFetch(w, feature, session);
    await w.reply(session, item, "more_info", "Please look into it.");
    expect((await w.ok("interview.state", { feature, item: item.id })).status).toBe("researching");
    const t0 = w.clock.now();
    const r = await drive(w.clock, w.rpc("interview.next", { session, wait_s: 100_000 }, 60_000), { stepMs: 10_000 });
    expect(r.error).toBeUndefined();
    expect(w.clock.now() - t0).toBeLessThanOrEqual(620_000);
  });

  it("[SE-12] a repeated reply_id returns the first result and changes nothing, even with other text", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const item = await askAndFetch(w, feature, session);
    const id = rand(8);
    const first = await w.reply(session, item, "answer", "first words", id);
    expect(first.result).toBeDefined();
    const st1 = await w.ok("interview.state", { feature, item: item.id });
    await w.settle();
    const turns = w.analyst.turnsFor(feature).length;
    const transcript = w.transcriptText(w.projects[0], feature);
    const again = await w.reply(session, item, "answer", "first words", id);
    expect(again.result).toEqual(first.result);
    const other = await w.reply(session, item, "defer", "second words", id);
    expect(other.result).toEqual(first.result);
    await w.settle();
    expect(await w.ok("interview.state", { feature, item: item.id })).toEqual(st1);
    expect(w.analyst.turnsFor(feature).length).toBe(turns);
    expect(w.transcriptText(w.projects[0], feature)).toBe(transcript);
    expect(transcript).not.toContain("second words");
  });

  it("[SE-13] reply kinds: assumption kinds on a question and question kinds on an assumption are -32005", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const q = await askAndFetch(w, feature, session);
    for (const kind of ["approve_assumption", "reject_assumption"]) {
      expectRpcError(await w.reply(session, q, kind, ""), ERR.kindNotAllowed);
    }
    const a = await w.propose(feature);
    for (const kind of ["answer", "more_info", "defer"]) {
      expectRpcError(await w.reply(session, a, kind, "x"), ERR.kindNotAllowed);
    }
    const bogus = await w.reply(session, q, "approve", "x");
    expect([ERR.kindNotAllowed, ERR.invalidParams]).toContain(bogus.error?.code);
  });

  it("[SE-14] approve_assumption and reject_assumption set approved / rejected; interview.state reports recorded_at", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const a1 = await w.propose(feature, { text: "Assume UTF-8 only." });
    const a2 = await w.propose(feature, { text: "Assume no Excel quirks." });
    expect((await w.reply(session, a1, "approve_assumption", "")).result).toBeDefined();
    expect((await w.reply(session, a2, "reject_assumption", "No, Excel matters.")).result).toBeDefined();
    const s1 = await w.ok("interview.state", { feature, item: a1.id });
    const s2 = await w.ok("interview.state", { feature, item: a2.id });
    expect(s1.status).toBe("approved");
    expect(s2.status).toBe("rejected");
    expect(s1.recorded_at).toMatch(ISO_UTC);
  });

  it("[SE-15] interview.state of an unknown item is -32003", async () => {
    w = await World.create();
    const { feature } = await interviewReady(w);
    expectRpcError(await w.rpc("interview.state", { feature, item: "nope" }), ERR.unknown);
  });

  it("[SE-16] interview.list counts open questions, deferred questions and pending assumptions", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const q1 = await askAndFetch(w, feature, session);
    await w.reply(session, q1, "defer", "");
    await w.ask(feature);
    await w.propose(feature);
    await w.propose(feature);
    const entry = (await w.ok("interview.list")).features.find((x: any) => x.id === feature);
    expect(entry).toMatchObject({ open: 1, deferred: 1, pending_assumptions: 2 });
  });
});

describe("Deferred items once per session (channel v1.1)", () => {
  it("[SE-17] a new session gets deferred items first, each once, then new items", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const q1 = await askAndFetch(w, feature, session);
    await w.reply(session, q1, "defer", "");
    const q2 = await w.ask(feature);
    await w.ok("interview.close", { session });

    const s2 = await w.approvedSession(feature);
    const first = (await w.ok("interview.next", { session: s2 })).item;
    expect(first.id).toBe(q1.id);
    expect(first.status).toBe("deferred");
    const second = (await w.ok("interview.next", { session: s2 })).item;
    expect(second.id).toBe(q2.id);
    const third = (await w.ok("interview.next", { session: s2 })).item;
    expect(third?.id).not.toBe(q1.id);
  });

  it("[SE-18] a deferred question can still be answered later at its current revision", async () => {
    w = await World.create();
    const { feature, session } = await interviewReady(w);
    const q1 = await askAndFetch(w, feature, session);
    await w.reply(session, q1, "defer", "");
    await w.ok("interview.close", { session });
    const s2 = await w.approvedSession(feature);
    const d = (await w.ok("interview.next", { session: s2 })).item;
    expect((await w.reply(s2, d, "answer", "Now I know.")).result).toBeDefined();
    expect((await w.ok("interview.state", { feature, item: q1.id })).status).toBe("answered");
  });
});
