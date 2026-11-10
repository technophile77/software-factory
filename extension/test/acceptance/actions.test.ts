import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/core/actions";
import type { InboxItem, OwnerAction } from "../../src/core/types";
import { makeItem } from "./fixtures";

const AT = "2026-11-09T10:00:00Z";
const last = (i: InboxItem) => i.history[i.history.length - 1];

function expectRefused(item: InboxItem, action: OwnerAction) {
  let err: unknown;
  try {
    applyAction(item, action, AT);
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${action.type} to be refused`).toBeInstanceOf(Error);
  // "refused with a message": the owner must be told why.
  expect((err as Error).message.trim().length).toBeGreaterThan(0);
}

describe("AC-3 / FR-6: approve requires an option when the item has options", () => {
  it("AC-3: approve without an option on an item with options is refused with a message", () => {
    expectRefused(makeItem(), { type: "approve" });
  });

  it("AC-3: approve with an option id not in the list is refused", () => {
    expectRefused(makeItem(), { type: "approve", option: "Z" });
  });

  it("AC-3: approve with a valid option succeeds and records the option", () => {
    const out = applyAction(makeItem(), { type: "approve", option: "B" }, AT);
    expect(out.status).toBe("approved");
    expect(last(out)).toMatchObject({ at: AT, by: "owner", action: "approved", option: "B" });
  });

  it("FR-6: approve on an item without options needs no option", () => {
    const out = applyAction(makeItem({ options: undefined, recommendation: undefined }), { type: "approve" }, AT);
    expect(out.status).toBe("approved");
    expect(last(out)).toMatchObject({ by: "owner", action: "approved" });
  });

  it("AC-3: a refused action leaves the item unchanged", () => {
    const item = makeItem();
    const snapshot = structuredClone(item);
    try {
      applyAction(item, { type: "approve" }, AT);
    } catch {
      /* expected */
    }
    expect(item).toEqual(snapshot);
  });
});

describe("FR-6: request changes / research require a note", () => {
  it("FR-6: request_changes with an empty note is refused", () => {
    expectRefused(makeItem(), { type: "request_changes", note: "" });
  });

  it("FR-6: request_changes with no note at all is refused", () => {
    expectRefused(makeItem(), { type: "request_changes" } as unknown as OwnerAction);
  });

  it("FR-6: request_research with an empty note is refused", () => {
    expectRefused(makeItem(), { type: "request_research", note: "" });
  });

  it("FR-6: request_changes with a note sets changes_requested and records the note", () => {
    const out = applyAction(makeItem(), { type: "request_changes", note: "Compare cost too" }, AT);
    expect(out.status).toBe("changes_requested");
    expect(last(out)).toMatchObject({ at: AT, by: "owner", action: "changes_requested", note: "Compare cost too" });
  });

  it("FR-6: request_research with a note sets research_requested and records the note", () => {
    const out = applyAction(makeItem(), { type: "request_research", note: "Benchmark both" }, AT);
    expect(out.status).toBe("research_requested");
    expect(last(out)).toMatchObject({ by: "owner", action: "research_requested", note: "Benchmark both" });
  });

  it("FR-5: reject sets rejected and appends a rejected history entry with optional note", () => {
    const out = applyAction(makeItem(), { type: "reject", note: "Out of scope" }, AT);
    expect(out.status).toBe("rejected");
    expect(last(out)).toMatchObject({ at: AT, by: "owner", action: "rejected", note: "Out of scope" });
  });
});

describe("AC-4 / FR-7: defer", () => {
  it("AC-4: deferring a high blocking item gives effective medium, blocking still true, a deferred history entry", () => {
    const item = makeItem({ priority: "high", effective_priority: "high", blocking: true });
    const out = applyAction(item, { type: "defer" }, AT);
    expect(out.status).toBe("deferred");
    expect(out.effective_priority).toBe("medium");
    expect(out.priority).toBe("high");
    expect(out.blocking).toBe(true);
    expect(last(out)).toMatchObject({ at: AT, by: "owner", action: "deferred" });
  });

  it("FR-7: defer lowers exactly one step for each priority; low stays low", () => {
    const cases = [
      ["critical", "high"],
      ["high", "medium"],
      ["medium", "low"],
      ["low", "low"],
    ] as const;
    for (const [from, to] of cases) {
      const out = applyAction(makeItem({ priority: from, effective_priority: from }), { type: "defer" }, AT);
      expect(out.effective_priority, `${from} → ${to}`).toBe(to);
    }
  });

  it("FR-7: defer keeps blocking false when it was false", () => {
    const out = applyAction(makeItem({ blocking: false }), { type: "defer" }, AT);
    expect(out.blocking).toBe(false);
  });

  it("FR-8: defer records an optional note", () => {
    const out = applyAction(makeItem(), { type: "defer", note: "After launch" }, AT);
    expect(last(out)).toMatchObject({ action: "deferred", note: "After launch" });
  });
});

describe("AC-5 / FR-7: restore", () => {
  it("AC-5: restoring a deferred item sets effective priority back to priority and status open", () => {
    const deferred = applyAction(makeItem({ priority: "critical", effective_priority: "critical", blocking: true }), { type: "defer" }, AT);
    const out = applyAction(deferred, { type: "restore" }, "2026-11-09T11:00:00Z");
    expect(out.effective_priority).toBe(out.priority);
    expect(out.effective_priority).toBe("critical");
    expect(out.status).toBe("open");
    expect(out.blocking).toBe(true);
    expect(last(out)).toMatchObject({ at: "2026-11-09T11:00:00Z", by: "owner", action: "restored" });
  });

  it("AC-5: restore on an item that is not deferred is refused", () => {
    expectRefused(makeItem({ status: "open" }), { type: "restore" });
  });
});

describe("FR-8: history is append-only; applyAction is pure", () => {
  it("FR-8: every action appends exactly one entry and leaves earlier entries untouched", () => {
    const actions: OwnerAction[] = [
      { type: "approve", option: "A" },
      { type: "reject" },
      { type: "request_changes", note: "n" },
      { type: "request_research", note: "n" },
      { type: "defer" },
    ];
    for (const a of actions) {
      const item = makeItem();
      const out = applyAction(item, a, AT);
      expect(out.history.length, a.type).toBe(item.history.length + 1);
      expect(out.history.slice(0, -1), a.type).toEqual(item.history);
    }
  });

  it("FR-8: applyAction returns a new item and does not mutate its input", () => {
    const item = makeItem();
    const snapshot = structuredClone(item);
    const out = applyAction(item, { type: "defer" }, AT);
    expect(out).not.toBe(item);
    expect(item).toEqual(snapshot);
  });

  it("SR-5: unknown fields (extra) and body are carried through an action", () => {
    const item = makeItem({ extra: { x_custom: { a: 1 } } });
    const out = applyAction(item, { type: "defer" }, AT);
    expect(out.extra).toEqual({ x_custom: { a: 1 } });
    expect(out.body).toBe(item.body);
  });
});

describe("FR-5: actions on decided items are refused", () => {
  const all: OwnerAction[] = [
    { type: "approve", option: "A" },
    { type: "reject" },
    { type: "request_changes", note: "n" },
    { type: "request_research", note: "n" },
    { type: "defer" },
    { type: "restore" },
  ];
  for (const status of ["approved", "rejected"] as const) {
    for (const a of all) {
      it(`FR-5: ${a.type} on a ${status} item is refused`, () => {
        expectRefused(makeItem({ status }), a);
      });
    }
  }
});
