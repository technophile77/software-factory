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

describe("security fixes from Gate 2", () => {
  it("keeps a __proto__ frontmatter key through a round trip", () => {
    const r = parseItem(file(`${base}\n__proto__:\n  polluted: true`), "x.md");
    if (!r.ok) throw new Error(r.error.message);
    const again = parseItem(serializeItem(r.item), "x.md");
    expect(again.ok && Object.keys(again.item.extra)).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("store hardening from Gate 2", () => {
  it("lists a misnamed file and an unreadable entry as errors without hiding valid items", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadInbox } = await import("../../src/core/store");
    const repoDir = await mkdtemp(join(tmpdir(), "sf-"));
    const dir = join(repoDir, ".factory", "inbox", "decision");
    await mkdir(join(dir, "folder.md"), { recursive: true });
    await writeFile(join(dir, "D-0001.md"), file(base));
    await writeFile(join(dir, "wrong-name.md"), file(base.replace("D-0001", "D-0002")));
    const { entries, errors } = await loadInbox([{ name: "r", repoDir, factoryDir: join(repoDir, ".factory") }]);
    expect(entries.map((e) => e.item.id)).toEqual(["D-0001"]);
    expect(errors.map((e) => e.path.split(/[\\/]/).pop()).sort()).toEqual(["folder.md", "wrong-name.md"]);
  });
});

describe("git lookup (Gate 2 finding 1)", async () => {
  const { findGitOnPath, isWithin } = await import("../../src/core/git");
  it("skips PATH entries inside a workspace folder, case-insensitively on Windows", () => {
    const found = findGitOnPath(
      "C:\\Work\\Repo\\.factory;C:\\Program Files\\Git\\cmd",
      ["c:\\work\\repo"],
      "win32",
      (f) => f.toLowerCase().endsWith("git.exe"),
    );
    expect(found).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });
  it("skips relative PATH entries", () => {
    expect(findGitOnPath(".:/usr/bin", [], "linux", () => true)).toBe("/usr/bin/git");
  });
  it("returns undefined when git is missing", () => {
    expect(findGitOnPath("/usr/bin", [], "linux", () => false)).toBeUndefined();
  });
  it("treats names starting with .. as inside", () => {
    expect(isWithin("/repo", "/repo/..notes.md")).toBe(true);
    expect(isWithin("/repo", "/other")).toBe(false);
  });
});

describe("queue ordering", async () => {
  const { sortQueue } = await import("../../src/core/queue");
  it("compares creation times as instants across offsets", () => {
    const mk = (id: string, at: string) => {
      const r = parseItem(file(base.replace("D-0001", id).replace("2026-11-08T21:00:00Z", at)), "x.md");
      if (!r.ok) throw new Error(r.error.message);
      return { repo: "r", path: id, item: r.item };
    };
    const later = mk("D-0002", "2026-11-08T22:00:00+02:00"); // 20:00Z
    const earlier = mk("D-0003", "2026-11-08T20:30:00Z");
    expect(sortQueue([earlier, later]).map((e) => e.item.id)).toEqual(["D-0002", "D-0003"]);
  });
});
