// F-024: the windowed console's state, without a terminal.

import { describe, expect, it } from "vitest";
import { CHROME_ROWS, ConsoleModel, wrap } from "../src/terminal/console-model";

const M = "│ ";
const model = (o: { transcript?: boolean } = {}) => new ConsoleModel({ project: "acme", transcript: o.transcript ?? false, now: () => Date.parse("2026-11-20T19:00:00Z") });

describe("F-024 console model", () => {
  it("wraps at a space near the width, and a wrapped piece of engine text keeps the marker (SR-1)", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrap("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
    const m = model();
    m.resize(60, 20);
    m.write(`${M}${"word ".repeat(30)}\n`);
    m.key("2", {});
    expect(m.frame(M).lines.filter((l) => l.trim()).every((l) => l.startsWith(M))).toBe(true);
  });

  it("FR-3: shows only as many lines as the window holds and follows the newest; Up scrolls back", () => {
    const m = model();
    m.resize(80, 20);
    for (let i = 1; i <= 50; i++) m.write(`line ${i}\n`);
    m.key("2", {});
    const f = m.frame(M);
    // Under 24 rows the side pane is a 2-line strip with its borders (FR-15).
    expect(f.lines).toHaveLength(20 - CHROME_ROWS - 4);
    expect(f.lines.at(-1)).toBe("");
    expect(f.lines.at(-2)).toBe("line 50");
    m.key("", { upArrow: true });
    expect(m.frame(M).lines.at(-1)).toBe("line 50");
    m.key("", { end: true });
    expect(m.frame(M).lines.at(-2)).toBe("line 50");
    m.resize(50, 12);
    expect(m.frame(M).tooSmall).toBe(true);
  });

  it("FR-9: while typing, digits, v and q are text, Tab still switches windows, Enter answers", async () => {
    const m = model();
    const asked = m.ask("Pick a number: ");
    expect(m.tab).toBe("inbox");
    for (const ch of "1vq") m.key(ch, {});
    expect(m.transcriptOn).toBe(false);
    expect(m.quit).toBe(false);
    m.key("", { backspace: true });
    m.key("", { tab: true });
    expect(m.tab).toBe("agents");
    m.key("", { return: true });
    expect(await asked).toBe("1v");
  });

  it("FR-12: Ctrl+C, or q when not typing, ends any open question with no answer", async () => {
    const m = model();
    const asked = m.ask("> ");
    m.key("c", { ctrl: true });
    expect(await asked).toBeNull();
    expect(await m.ask("again")).toBeNull();
    const n = model();
    n.key("q", {});
    expect(n.quit).toBe(true);
  });

  it("FR-6: the newest agent is picked until the owner picks another; the Log notes starts and ends", () => {
    const m = model({ transcript: true });
    const a = { run: "R-aaaaaaaaaaaa", feature: "F-1", role: "requirements-analyst", started_at: "2026-11-20T18:50:00Z" };
    const b = { run: "R-bbbbbbbbbbbb", feature: "F-2", role: "software-developer", started_at: "2026-11-20T18:55:00Z" };
    m.setAgents([a, b]);
    expect(m.selectedRun).toBe(b.run);
    m.key("3", {});
    m.key("", { upArrow: true });
    expect(m.selectedRun).toBe(a.run);
    m.setAgents([{ ...a, ended: true }, b]);
    expect(m.selectedRun).toBe(a.run);
    m.key("", { return: true });
    expect(m.tab).toBe("transcript");
    expect(m.frame(M).windowTitle).toBe("Transcript: F-1 requirements-analyst (ended)");
    m.key("5", {});
    const log = m.frame(M).lines.join("\n");
    expect(log).toContain("F-1 requirements-analyst started");
    expect(log).toContain("F-1 requirements-analyst ended");
  });

  it("FR-7: transcript lines are per agent, tool lines starred, and a gap is counted", () => {
    const m = model({ transcript: true });
    m.setAgents([{ run: "R-aaaaaaaaaaaa", feature: "F-1", role: "requirements-analyst", started_at: "2026-11-20T18:50:00Z" }]);
    m.addTranscript([{ run: "R-aaaaaaaaaaaa", at: "2026-11-20T18:51:00Z", kind: "text", text: "two\nlines" }], 0);
    m.addTranscript([{ run: "R-aaaaaaaaaaaa", at: "2026-11-20T18:52:00Z", kind: "tool", text: "Read a.md" }], 12);
    m.key("4", {});
    const lines = m.frame(M).lines.filter((l) => l.trim());
    expect(lines.some((l) => l.endsWith("two"))).toBe(true);
    expect(lines).toContain("(12 earlier lines not shown)");
    expect(lines.some((l) => l.endsWith("* Read a.md"))).toBe(true);
    expect(m.wantsTranscript()).toBe(true);
    m.key("v", {});
    expect(m.visibleTabs()).not.toContain("transcript");
    expect(m.wantsTranscript()).toBe(true);
    m.key("1", {});
    expect(m.wantsTranscript()).toBe(false);
  });

  it("FR-15: the side pane lists features with their stage and the agents, beside the window when wide, under it when narrow", () => {
    const m = model({ transcript: true });
    m.setStatus(["F-001 (Interview): Waiting for your answer", "F-003 (Building): Developer is working"], 0, [
      { id: "F-001", stage: "Interview", activity: "Waiting for your answer" },
      { id: "F-003", stage: "Building", activity: "Developer is working" },
    ]);
    m.setAgents([{ run: "R-000000000001", feature: "F-003", role: "software-developer", started_at: "2026-11-20T18:48:00Z" }]);
    m.key("4", {});
    m.resize(120, 30);
    let f = m.frame(M);
    expect(m.tab).toBe("transcript");
    expect(f.pane.side).toBe(true);
    expect(f.pane.lines).toEqual(expect.arrayContaining(["Features (2)", "F-001 Interview", "  Waiting for your answer", "F-003 Building", "Agents (1)", "F-003 software-developer 12 min"]));
    for (let i = 1; i <= 40; i++) m.write(`${"word ".repeat(30)}${i}\n`);
    m.key("2", {});
    f = m.frame(M);
    expect(f.lines).toHaveLength(30 - CHROME_ROWS);
    expect(Math.max(...f.lines.map((l) => l.length))).toBeLessThanOrEqual(120 - 32 - 2);
    m.resize(80, 24);
    f = m.frame(M);
    expect(f.pane.side).toBe(false);
    expect(f.pane.lines[0]).toBe("Features: F-001 Interview, F-003 Building");
    expect(f.pane.lines[1]).toBe("Agents: F-003 software-developer 12 min");
    expect(f.pane.lines).toHaveLength(4);
    expect(f.lines).toHaveLength(24 - CHROME_ROWS - 6);
    expect(f.lines.at(-2)).toMatch(/ 40$/);
  });

  it("FR-15: what doesn't fit is counted as \"+<n> more\"", () => {
    const m = model();
    const feats = Array.from({ length: 30 }, (_, i) => ({ id: `F-${100 + i}`, stage: "Building", activity: "Developer is working" }));
    m.setStatus(feats.map((x) => `${x.id} (Building): Developer is working`), 0, feats);
    m.setAgents(Array.from({ length: 12 }, (_, i) => ({ run: `R-00000000000${(i + 10).toString(16)}`, feature: `F-${100 + i}`, role: "software-developer", started_at: "2026-11-20T18:58:00Z" })));
    m.resize(120, 30);
    const side = m.frame(M).pane.lines;
    expect(side.length).toBeLessThanOrEqual(30 - CHROME_ROWS + 1);
    expect(side.filter((l) => /^\+\d+ more$/.test(l))).toHaveLength(2);
    m.resize(80, 30);
    const strip = m.frame(M).pane.lines;
    expect(strip[0]).toMatch(/\+\d+ more$/);
    expect(Array.from(strip[0]!).length).toBeLessThanOrEqual(78);
    expect(strip.at(-1)).toMatch(/\+\d+ more$/);
  });

  it("FR-11: a status read after a reconnect clears \"(stale)\"", () => {
    const m = model();
    m.setStatus([], 0);
    m.away("Engine away: reconnecting in 4s (attempt 2)");
    expect(m.frame(M).title).toContain("(stale)");
    m.away(null);
    m.setStatus(["F-003 (Building): Developer is working"], null, [{ id: "F-003", stage: "Building", activity: "Developer is working" }]);
    expect(m.frame(M).title).not.toContain("(stale)");
    expect(m.frame(M).title).toContain("1 feature running");
  });
});
