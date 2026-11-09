import { describe, expect, it } from "vitest";
import { applyAction, ActionError } from "../../src/core/actions";
import { parseItem, serializeItem } from "../../src/core/item";
import { resolveLink } from "../../src/core/links";

const file = (fm: string, body = "## Context\nWhy.\n") => `---\n${fm}\n---\n${body}`;
const base = `schema: inbox-item/1.0
id: D-0001
inbox: decision
title: Pick a store
category: Architecture
priority: high
effective_priority: high
blocking: true
status: open
created_by: orchestrator
created_at: 2026-11-08T21:00:00Z
options:
  - id: A
    label: Redis
history: []`;

describe("item", () => {
  it("defaults effective_priority to priority", () => {
    const r = parseItem(file(base.replace("effective_priority: high\n", "")), "x.md");
    expect(r.ok && r.item.effective_priority).toBe("high");
  });

  it("rejects a category outside the five", () => {
    const r = parseItem(file(base.replace("Architecture", "Ops")), "x.md");
    expect(r.ok).toBe(false);
  });

  it("keeps CRLF files parseable", () => {
    const r = parseItem(file(base).replace(/\n/g, "\r\n"), "x.md");
    expect(r.ok).toBe(true);
  });

  it("round-trips extra fields", () => {
    const r = parseItem(file(`${base}\nfuture_field: 7`), "x.md");
    if (!r.ok) throw new Error(r.error.message);
    const again = parseItem(serializeItem(r.item), "x.md");
    expect(again.ok && again.item.extra).toEqual({ future_field: 7 });
  });
});

describe("actions", () => {
  const item = () => {
    const r = parseItem(file(base), "x.md");
    if (!r.ok) throw new Error(r.error.message);
    return r.item;
  };

  it("rejects an option id not offered", () => {
    expect(() => applyAction(item(), { type: "approve", option: "Z" }, "t")).toThrow(ActionError);
  });

  it("does not mutate the input item", () => {
    const i = item();
    applyAction(i, { type: "defer" }, "t");
    expect(i.status).toBe("open");
    expect(i.history).toHaveLength(0);
  });
});

describe("links", () => {
  it("refuses javascript: urls", () => {
    expect(resolveLink("/repo", { kind: "url", ref: "javascript:alert(1)" }).kind).toBe("refused");
  });

  it("refuses absolute paths", () => {
    expect(resolveLink("/repo", { kind: "file", ref: "/etc/passwd" }).kind).toBe("refused");
  });
});
