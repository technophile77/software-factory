import { describe, it, expect } from "vitest";
import { sortQueue, groupByStatus, countOpenBlocking } from "../../src/core/queue";
import type { QueueEntry, InboxItem } from "../../src/core/types";
import { makeItem } from "./fixtures";

let n = 0;
function entry(over: Partial<InboxItem> = {}, repo = "repo-a"): QueueEntry {
  n++;
  const id = over.id ?? `D-${String(n).padStart(4, "0")}`;
  const item = makeItem({ id, ...over });
  return { repo, path: `/${repo}/.factory/inbox/decision/${id}.md`, item };
}
const ids = (es: QueueEntry[]) => es.map((e) => e.item.id);

describe("AC-1 / FR-2: queue order", () => {
  it("AC-1: three open items low, high, critical appear critical, high, low", () => {
    const low = entry({ priority: "low", effective_priority: "low" });
    const high = entry({ priority: "high", effective_priority: "high" });
    const crit = entry({ priority: "critical", effective_priority: "critical" });
    const sorted = sortQueue([low, high, crit]);
    expect(sorted.map((e) => e.item.effective_priority)).toEqual(["critical", "high", "low"]);
    expect(groupByStatus([low, high, crit]).open.map((e) => e.item.effective_priority)).toEqual([
      "critical",
      "high",
      "low",
    ]);
  });

  it("AC-1: sorts by effective_priority, not filed priority", () => {
    const deferredCrit = entry({ priority: "critical", effective_priority: "high", status: "deferred" });
    const medium = entry({ priority: "medium", effective_priority: "medium" });
    const high = entry({ priority: "high", effective_priority: "high", created_at: "2026-11-01T00:00:00Z" });
    const sorted = sortQueue([medium, deferredCrit, high]);
    expect(sorted.map((e) => e.item.effective_priority)).toEqual(["high", "high", "medium"]);
  });

  it("FR-2: same priority sorts by age, oldest first", () => {
    const newer = entry({ created_at: "2026-11-08T12:00:00Z" });
    const older = entry({ created_at: "2026-11-01T12:00:00Z" });
    const middle = entry({ created_at: "2026-11-05T12:00:00Z" });
    expect(ids(sortQueue([newer, older, middle]))).toEqual(ids([older, middle, newer]));
  });

  it("FR-2: all four priorities order critical > high > medium > low", () => {
    const es = (["medium", "low", "critical", "high"] as const).map((p) =>
      entry({ priority: p, effective_priority: p }),
    );
    expect(sortQueue(es).map((e) => e.item.effective_priority)).toEqual(["critical", "high", "medium", "low"]);
  });

  it("FR-2: sortQueue does not mutate its input", () => {
    const es = [entry({ effective_priority: "low", priority: "low" }), entry({ effective_priority: "critical", priority: "critical" })];
    const before = ids(es);
    sortQueue(es);
    expect(ids(es)).toEqual(before);
  });
});

describe("FR-2: grouping by status", () => {
  it("FR-2: open / deferred / decided groups; changes and research requested count as open", () => {
    const open = entry({ status: "open" });
    const changes = entry({ status: "changes_requested" });
    const research = entry({ status: "research_requested" });
    const deferred = entry({ status: "deferred", effective_priority: "medium" });
    const approved = entry({ status: "approved" });
    const rejected = entry({ status: "rejected" });
    const g = groupByStatus([open, changes, research, deferred, approved, rejected]);
    expect(new Set(ids(g.open))).toEqual(new Set(ids([open, changes, research])));
    expect(ids(g.deferred)).toEqual(ids([deferred]));
    expect(new Set(ids(g.decided))).toEqual(new Set(ids([approved, rejected])));
  });

  it("FR-2: each group is sorted", () => {
    const lo = entry({ priority: "low", effective_priority: "low" });
    const hi = entry({ priority: "critical", effective_priority: "critical" });
    expect(ids(groupByStatus([lo, hi]).open)).toEqual(ids([hi, lo]));
  });
});

describe("AC-2 / FR-3: blocking badge count", () => {
  it("AC-2: an open blocking item is counted", () => {
    expect(countOpenBlocking([entry({ blocking: true, status: "open" })])).toBe(1);
  });

  it("AC-2: deferred blocking items still count; non-blocking and decided items do not", () => {
    const es = [
      entry({ blocking: true, status: "open" }),
      entry({ blocking: true, status: "deferred", effective_priority: "medium" }),
      entry({ blocking: false, status: "open" }),
      entry({ blocking: true, status: "approved" }),
      entry({ blocking: true, status: "rejected" }),
    ];
    expect(countOpenBlocking(es)).toBe(2);
  });

  it("AC-2: blocking items with changes/research requested count as open", () => {
    const es = [
      entry({ blocking: true, status: "changes_requested" }),
      entry({ blocking: true, status: "research_requested" }),
    ];
    expect(countOpenBlocking(es)).toBe(2);
  });

  it("AC-2: empty queue counts zero", () => {
    expect(countOpenBlocking([])).toBe(0);
  });
});

describe("AC-10 / FR-12: combined queue across repos (pure sort)", () => {
  it("AC-10: items from two repos sort together by priority, repo label kept", () => {
    const aLow = entry({ priority: "low", effective_priority: "low" }, "alpha");
    const bCrit = entry({ priority: "critical", effective_priority: "critical" }, "beta");
    const aHigh = entry({ priority: "high", effective_priority: "high" }, "alpha");
    const sorted = sortQueue([aLow, bCrit, aHigh]);
    expect(sorted.map((e) => [e.repo, e.item.effective_priority])).toEqual([
      ["beta", "critical"],
      ["alpha", "high"],
      ["alpha", "low"],
    ]);
  });

  it("AC-10: same priority and age tie-break by repo name, then id", () => {
    const at = "2026-11-08T21:00:00Z";
    const b1 = entry({ id: "D-0001", created_at: at }, "beta");
    const a2 = entry({ id: "D-0002", created_at: at }, "alpha");
    const a1 = entry({ id: "D-0001", created_at: at }, "alpha");
    expect(sortQueue([b1, a2, a1]).map((e) => `${e.repo}/${e.item.id}`)).toEqual([
      "alpha/D-0001",
      "alpha/D-0002",
      "beta/D-0001",
    ]);
  });
});
