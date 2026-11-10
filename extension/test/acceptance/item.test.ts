import { describe, it, expect } from "vitest";
import { parseItem, serializeItem, isValidItemId } from "../../src/core/item";
import { itemFile, makeItem, DECISION_BODY } from "./fixtures";

const PATH = "/repo/.factory/inbox/decision/D-0001.md";

function expectParseError(text: string, path = PATH) {
  const r = parseItem(text, path);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.path).toBe(path);
    expect(r.error.message.trim().length).toBeGreaterThan(0);
  }
}

describe("FR-1 / contract: parseItem reads Inbox item v1.0", () => {
  it("FR-1: parses a valid decision item with every contract field", () => {
    const r = parseItem(itemFile({ blocking: true }), PATH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.item;
    expect(item.schema).toBe("inbox-item/1.0");
    expect(item.id).toBe("D-0001");
    expect(item.inbox).toBe("decision");
    expect(item.title).toBe("Choose session store for login");
    expect(item.category).toBe("Architecture");
    expect(item.priority).toBe("high");
    expect(item.effective_priority).toBe("high");
    expect(item.blocking).toBe(true);
    expect(item.status).toBe("open");
    expect(item.feature).toBe("F-012");
    expect(item.created_by).toBe("orchestrator");
    expect(item.created_at).toBe("2026-11-08T21:00:00Z");
    expect(item.options).toEqual([
      { id: "A", label: "Redis" },
      { id: "B", label: "Postgres table" },
    ]);
    expect(item.recommendation).toBe("A");
    expect(item.links).toEqual([{ kind: "file", ref: "docs/features/F-012-login.md" }]);
    expect(item.history).toEqual([{ at: "2026-11-08T21:00:00Z", by: "orchestrator", action: "filed" }]);
    expect(item.body).toContain("## Context");
    expect(item.body).toContain("## Cost of delay");
    expect(item.extra).toEqual({});
  });

  it("FR-1: optional fields (feature, options, recommendation, links) may be absent", () => {
    const r = parseItem(
      itemFile({ feature: undefined, options: undefined, recommendation: undefined, links: undefined }),
      PATH,
    );
    expect(r.ok).toBe(true);
  });

  it("FR-1: accepts every status value in the contract", () => {
    for (const status of ["open", "approved", "rejected", "changes_requested", "research_requested", "deferred"]) {
      expect(parseItem(itemFile({ status }), PATH).ok, status).toBe(true);
    }
  });

  it("FR-1: accepts every decision category in the contract", () => {
    for (const category of ["Product", "Architecture", "Interfaces", "Assumptions", "Security"]) {
      expect(parseItem(itemFile({ category }), PATH).ok, category).toBe(true);
    }
  });
});

describe("AC-8 / FR-10: malformed files are reported, not hidden", () => {
  it("AC-8: file without frontmatter is an error naming the path", () => {
    expectParseError("# Just a heading\n\nNo frontmatter here.\n");
  });

  it("AC-8: invalid YAML is an error naming the path", () => {
    expectParseError("---\nid: D-0001\ntitle: [unclosed\n  : : :\n---\nbody\n");
  });

  it("AC-8: missing required field (title) is an error", () => {
    expectParseError(itemFile({ title: undefined }));
  });

  it("AC-8: missing required field (history) is an error", () => {
    expectParseError(itemFile({ history: undefined }));
  });

  it("AC-8: unknown priority value is an error", () => {
    expectParseError(itemFile({ priority: "urgent", effective_priority: "urgent" }));
  });

  it("AC-8: unknown status value is an error", () => {
    expectParseError(itemFile({ status: "pending" }));
  });

  it("AC-8: category outside the five decision categories is an error", () => {
    expectParseError(itemFile({ category: "Finance" }));
  });
});

describe("SR-4: item ids must match ^[DTH]-\\d{4,}$", () => {
  it("SR-4: isValidItemId accepts valid ids", () => {
    for (const id of ["D-0001", "T-0001", "H-0001", "D-12345", "D-0000"]) {
      expect(isValidItemId(id), id).toBe(true);
    }
  });

  it("SR-4: isValidItemId rejects invalid ids", () => {
    for (const id of [
      "",
      "D-001",
      "d-0001",
      "X-0001",
      "D0001",
      "D-0001a",
      " D-0001",
      "D-0001 ",
      "D-0001\n",
      "../D-0001",
      "D-0001/../../x",
      "D-0001; rm -rf /",
      "D-0001$(whoami)",
      "D-０００１", // full-width digits
    ]) {
      expect(isValidItemId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it("SR-4: parseItem rejects an item whose id is invalid", () => {
    expectParseError(itemFile({ id: "../../etc/passwd" }));
    expectParseError(itemFile({ id: "D-1" }));
    expectParseError(itemFile({ id: "D-0001; touch pwned" }));
  });
});

describe("SR-5 / edge case: unknown frontmatter fields are preserved", () => {
  it("SR-5: unknown fields go to extra and survive serialize", () => {
    const text = itemFile({ x_reviewer: "agent-7", custom_meta: { nested: [1, 2, { k: "v" }] } });
    const r = parseItem(text, PATH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.extra).toEqual({ x_reviewer: "agent-7", custom_meta: { nested: [1, 2, { k: "v" }] } });
    const again = parseItem(serializeItem(r.item), PATH);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.item.extra).toEqual(r.item.extra);
  });
});

describe("Contract: round trip parse/serialize", () => {
  it("Round trip: parseItem(serializeItem(x)) equals x for a constructed item", () => {
    const x = makeItem({ blocking: true, extra: { keep_me: "yes" } });
    const r = parseItem(serializeItem(x), PATH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item).toEqual(x);
  });

  it("Round trip: parse → serialize → parse is stable for a file as agents write it", () => {
    const first = parseItem(itemFile({ status: "deferred", effective_priority: "medium" }), PATH);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parseItem(serializeItem(first.item), PATH);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.item).toEqual(first.item);
  });

  it("Round trip: body Markdown is preserved", () => {
    const r = parseItem(itemFile(), PATH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.body.trim()).toBe(DECISION_BODY.trim());
    const again = parseItem(serializeItem(r.item), PATH);
    if (!again.ok) throw new Error(again.error.message);
    expect(again.item.body).toBe(r.item.body);
  });

  it("Round trip: serialized output is YAML frontmatter followed by the body", () => {
    const out = serializeItem(makeItem());
    expect(out.startsWith("---\n") || out.startsWith("---\r\n")).toBe(true);
    // Frontmatter must be plain YAML a non-extension reader (the engine) can parse.
    const fmText = out.split(/^---\r?\n/m)[1];
    expect(fmText).toBeDefined();
    expect(fmText).toContain("schema:");
  });
});
