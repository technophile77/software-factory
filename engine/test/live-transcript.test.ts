// F-021 FR-18: the engine's in-memory transcript buffer behind engine.transcript.

import { describe, expect, it } from "vitest";
import { FIRST_READ, LiveTranscript, MAX_TEXT, PER_RUN, toolLine } from "../src/agent/live-transcript";

const who = (feature: string, project = "acme") => ({ project, feature, role: "requirements-analyst" });

describe("F-021 FR-18: live transcript buffer", () => {
  it("a tool call is its name and target only, a command cut at 200 characters", () => {
    expect(toolLine("Read", { file_path: "/w/a.md" })).toBe("Read /w/a.md");
    expect(toolLine("Grep", { pattern: "TODO", path: "src" })).toBe("Grep TODO in src");
    expect(toolLine("Bash", { command: "y".repeat(500) })).toBe(`Bash ${"y".repeat(200)}`);
    expect(toolLine("mcp__factory__interview_ask", { text: "secret question text" })).toBe("interview_ask");
    expect(toolLine("Unknown", { anything: "x" })).toBe("Unknown");
  });

  it("the first read gets the newest entries; later reads get what came after, per project", () => {
    const t = new LiveTranscript(() => 0);
    for (let i = 1; i <= FIRST_READ + 10; i++) t.add("R-1", who("F-1"), "text", `line ${i}`);
    t.add("R-2", who("F-1", "other"), "text", "not this project");
    const first = t.read("acme", undefined);
    expect(first.entries).toHaveLength(FIRST_READ);
    expect(first.entries[0]!.text).toBe("line 11");
    t.add("R-1", who("F-1"), "tool", "Read x");
    const next = t.read("acme", first.next);
    expect(next.entries.map((e) => e.text)).toEqual(["Read x"]);
    expect(next.skipped).toBe(0);
  });

  it("keeps the last 500 entries of a run, counts what a slow reader missed, and cuts long text", () => {
    const t = new LiveTranscript(() => 0);
    t.add("R-1", who("F-1"), "text", "start");
    const at = t.read("acme", undefined).next;
    for (let i = 0; i < PER_RUN + 37; i++) t.add("R-1", who("F-1"), "text", "x".repeat(MAX_TEXT + 5));
    const r = t.read("acme", at);
    expect(r.entries).toHaveLength(PER_RUN);
    expect(r.entries[0]!.text).toHaveLength(MAX_TEXT);
    expect(r.skipped).toBe(37);
  });

  it("an ended run's lines go a minute after its end", () => {
    let now = 0;
    const t = new LiveTranscript(() => now);
    t.add("R-1", who("F-1"), "text", "done soon");
    t.end("R-1");
    now = 30_000;
    expect(t.read("acme", undefined).entries).toHaveLength(1);
    now = 61_000;
    expect(t.read("acme", undefined).entries).toHaveLength(0);
  });
});
