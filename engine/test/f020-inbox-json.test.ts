import * as path from "node:path";
import YAML from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { migrateInboxJson } from "../scripts/migrate-inbox-json-once";
import { Git } from "../src/git";
import { Inbox } from "../src/inbox/store";
import type { ItemInput } from "../src/inbox/model";
import { MemoryLogger } from "../src/log";
import { Children } from "../src/proc";
import { SchemaError } from "../src/schemas/json-file";
import { StateRepo } from "../src/state/state-repo";
import { FakeClock, GIT_PATH, git, removeTmpdirs, tmpdir } from "./helpers";

// F-020 FR-3, FR-4, SR-4, SR-5, SR-6: inbox records as JSON.

afterAll(removeTmpdirs);

const decision: ItemInput = {
  kind: "decision", title: "Choose a session store", category: "Architecture", priority: "high", blocking: true, created_by: "engine",
  options: [{ id: "A", label: "Redis" }, { id: "B", label: "Postgres table" }], recommendation: "A", sections: { Context: [{ engine: "Why." }] },
};

async function world(files: Record<string, string> = {}) {
  const root = tmpdir();
  const repo = path.join(root, "cfg");
  git(root, "init", "-q", repo);
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const g = new Git({ gitPath: GIT_PATH, homeDir: path.join(root, "h"), children: new Children() });
  const clean = { scan: async () => ({ clean: true as const }) };
  const state = new StateRepo(g, clean, repo, new MemoryLogger(), path.join(root, "t"));
  await state.ensureWorktree();
  if (Object.keys(files).length) await state.commit(Object.entries(files).map(([p, content]) => ({ path: p, content })), "seed");
  const inbox = new Inbox({ state, clock: new FakeClock(), log: new MemoryLogger(), notify: () => undefined });
  const migrate = () => migrateInboxJson({ git: g, scanner: clean as never, repo, log: new MemoryLogger(), clock: new FakeClock(), tmpDir: path.join(root, "t2") });
  return { repo, state, inbox, migrate };
}

/** A v3.1 record as the engine wrote it before F-020. */
function v3(id: string): string {
  return YAML.stringify({
    schema: "inbox-record/3.0", id, kind: "decision", title: `Item ${id}`, category: "Security", priority: "high", effective_priority: "high",
    blocking: true, status: "open", repo: "project", feature: "F-012", created_by: "engine", created_at: "2026-11-13T10:00:00Z", issue: 7,
    options: [{ id: "A", label: "Yes" }, { id: "B", label: "No" }], recommendation: "A", links: [],
    effect: { type: "st_review_risk", feature: "F-012", finding: 2 },
    revisions: [{ rev: 1, body_sha256: "a".repeat(64), action_comments: [{ id: 11, action: "choose:A", sha256: "b".repeat(64) }], dispatched: true }],
    engine_comments: [12],
    history: [{ at: "2026-11-13T10:00:00Z", by: "engine", action: "filed" }, { at: "2026-11-13T11:00:00Z", by: "owner", action: "deferred", source: "command", actor_id: 1, comment_id: 13 }],
  });
}

const files = (repo: string) => git(repo, "ls-tree", "-r", "--name-only", "factory/state", "--", "inbox").split("\n").filter(Boolean);

describe("F-020 inbox records as JSON", () => {
  it("FR-4: a filed item's record is inbox/<id>.json under inbox-record/4.0, and reads back", async () => {
    const w = await world();
    const id = await w.inbox.file(decision);
    expect(files(w.repo)).toEqual([`inbox/${id}.json`, `inbox/${id}.rev1.md`]);
    const rec = JSON.parse(git(w.repo, "show", `factory/state:inbox/${id}.json`));
    expect(rec).toMatchObject({ schema: "inbox-record/4.0", id, status: "open" });
    expect((await w.inbox.read(id))!.title).toBe("Choose a session store");
  });

  it("FR-3, SR-6: a record with an unknown key or a value outside its enum is refused, naming the file and field but not the value", async () => {
    const w = await world();
    const id = await w.inbox.file(decision);
    const rec = JSON.parse(git(w.repo, "show", `factory/state:inbox/${id}.json`));
    await w.state.commit([{ path: `inbox/${id}.json`, content: JSON.stringify({ ...rec, status: "done-secret-value" }) }], "forge");
    const e = await w.inbox.read(id).catch((x: Error) => x);
    expect(e).toBeInstanceOf(SchemaError);
    expect((e as Error).message).toBe(`inbox/${id}.json: status is invalid (invalid_value)`);
    expect((e as Error).message).not.toContain("secret");
    await w.state.commit([{ path: `inbox/${id}.json`, content: JSON.stringify({ ...rec, extra: 1 }) }], "forge");
    await expect(w.inbox.read(id)).rejects.toThrow(`inbox/${id}.json: (top level) is invalid (unknown key "extra")`);
  });

  it("SR-6: a record over the byte cap is refused before it is parsed", async () => {
    const w = await world({ "inbox/D-0001.json": `{"pad":"${"x".repeat(1024 * 1024)}"}` });
    await expect(w.inbox.read("D-0001")).rejects.toThrow("inbox/D-0001.json: larger than 1048576 bytes");
  });

  it("FR-3: a record that fails its schema is never written (AC-4)", async () => {
    const w = await world();
    const id = await w.inbox.file(decision);
    const head = git(w.repo, "rev-parse", "factory/state");
    const change = w.inbox.effectChange(id, "x".repeat(200));
    await expect(change).rejects.toThrow(`inbox/${id}.json: history[1].effect is invalid (too_big)`);
    expect(git(w.repo, "rev-parse", "factory/state")).toBe(head);
  });

  it("SR-4: while a YAML record is left, nothing is filed, and the next id counts the YAML ids (AC-6)", async () => {
    const w = await world({ "inbox/D-0004.yaml": v3("D-0004") });
    expect(await w.inbox.legacyRecords()).toEqual(["inbox/D-0004.yaml"]);
    expect(await w.inbox.records()).toEqual([]);
    await expect(w.inbox.file(decision)).rejects.toThrow("the inbox still has 1 YAML record(s)");
    expect(await w.inbox.nextId("decision")).toBe("D-0005");
  });
});

describe("F-020 one-time migration to JSON (FR-4, SR-5, AC-5)", () => {
  it("converts each readable YAML record in its own commit, keeps its history, and leaves an unreadable one in place", async () => {
    const w = await world({ "inbox/D-0001.yaml": v3("D-0001"), "inbox/D-0002.yaml": v3("D-0002"), "inbox/D-0003.yaml": "id: D-0003\nhistory: []\n" });
    const r = await w.migrate();
    expect(r.migrated).toEqual([{ from: "inbox/D-0001.yaml", to: "inbox/D-0001.json" }, { from: "inbox/D-0002.yaml", to: "inbox/D-0002.json" }]);
    expect(r.skipped).toEqual([{ from: "inbox/D-0003.yaml", why: "schema is invalid (invalid_value)" }]);
    expect(files(w.repo)).toEqual(["inbox/D-0001.json", "inbox/D-0002.json", "inbox/D-0003.yaml"]);
    expect(git(w.repo, "log", "--format=%s", "-2", "factory/state").split("\n")).toEqual([
      "D-0002: migrated from inbox/D-0002.yaml (F-020)", "D-0001: migrated from inbox/D-0001.yaml (F-020)",
    ]);
    w.state.forgetHead();
    const rec = (await w.inbox.read("D-0001"))!;
    expect(rec.schema).toBe("inbox-record/4.0");
    expect(rec.effect).toEqual({ type: "st_review_risk", feature: "F-012", finding: 2 });
    expect(rec.history.map((h) => h.action)).toEqual(["filed", "deferred", "migrated"]);
    expect(rec.history[2]).toMatchObject({ by: "engine", from: "inbox/D-0001.yaml" });
    expect(rec.history[2]!.note).toMatch(/^from inbox\/D-0001\.yaml at factory\/state [0-9a-f]{40} \(F-020\)$/);
  });

  it("SR-5: a record whose id doesn't match its file name, an alias bomb, or an existing JSON record is reported and left in place", async () => {
    const bomb = `a: &a [x, x]\nb: &b [*a, *a]\nc: &c [*b, *b]\n${Array.from({ length: 120 }, (_, i) => `k${i}: *c`).join("\n")}\n`;
    const w = await world({
      "inbox/D-0001.yaml": v3("D-0009"), "inbox/D-0002.yaml": bomb,
      "inbox/D-0003.yaml": v3("D-0003"), "inbox/D-0003.json": JSON.stringify({ kept: true }),
    });
    const r = await w.migrate();
    expect(r.migrated).toEqual([]);
    expect(r.skipped).toEqual([
      { from: "inbox/D-0001.yaml", why: "its id doesn't match its file name" },
      { from: "inbox/D-0002.yaml", why: "not readable YAML" },
      { from: "inbox/D-0003.yaml", why: "inbox/D-0003.json already exists" },
    ]);
    expect(git(w.repo, "show", "factory/state:inbox/D-0003.json")).toBe(JSON.stringify({ kept: true }));
  });
});
