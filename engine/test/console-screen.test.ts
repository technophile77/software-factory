// F-024: the windowed console drawn by Ink into a fake terminal of a given size.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "../src/console-ui/screen";
import { ConsoleModel } from "../src/terminal/console-model";

class FakeOut extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  constructor(public columns: number, public rows: number) {
    super();
  }
  write(s: string): boolean {
    this.frames.push(s);
    return true;
  }
  last(): string {
    return this.frames.filter((f) => f.trim()).at(-1) ?? "";
  }
  resize(c: number, r: number): void {
    this.columns = c;
    this.rows = r;
    this.emit("resize");
  }
}

class FakeIn extends EventEmitter {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  private queue: string[] = [];
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  type(s: string): void {
    this.queue.push(s);
    this.emit("readable");
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

function draw(cols: number, rows: number, o: { ascii?: boolean; transcript?: boolean } = {}) {
  const out = new FakeOut(cols, rows);
  const inp = new FakeIn();
  const model = new ConsoleModel({ project: "acme", transcript: o.transcript ?? false });
  model.setStatus(["F-003: Analyst is researching"], 1);
  mounted.push(mount(model, { ascii: o.ascii ?? false, marker: "│ ", stdout: out as never, stdin: inp as never, alternateScreen: false, debug: true }));
  return { out, inp, model };
}

const fits = (frame: string, cols: number, rows: number) => {
  const lines = frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n").filter((l, i, a) => i < a.length - 1 || l !== "");
  expect(lines.length).toBeLessThanOrEqual(rows);
  for (const l of lines) expect(Array.from(l).length, l).toBeLessThanOrEqual(cols);
};

describe("F-024 windowed console drawing", () => {
  it("AC-1: title, tabs without Transcript, the Status window and the answer bar fit 100 by 30", async () => {
    const { out } = draw(100, 30);
    await tick();
    const f = out.last();
    expect(f).toContain("acme");
    expect(f).toContain("1 Status");
    expect(f).toContain("2 Inbox (1)");
    expect(f).toContain("3 Agents");
    expect(f).toContain("4 Log");
    expect(f).not.toContain("Transcript");
    expect(f).toContain("F-003: Analyst is researching");
    expect(f).toContain("q: quit");
    fits(f, 100, 30);
  });

  it("AC-2: redraws to fit after a resize, and asks for a larger window below 60 by 16", async () => {
    const { out } = draw(100, 30);
    await tick();
    out.resize(70, 20);
    await tick();
    fits(out.last(), 70, 20);
    out.resize(50, 12);
    await tick();
    expect(out.last()).toContain("Make the window at least 60 by 16");
    out.resize(80, 24);
    await tick();
    expect(out.last()).toContain("F-003: Analyst is researching");
  });

  it("AC-3: plain ASCII borders for the old Windows console, box drawing otherwise", async () => {
    const a = draw(80, 24, { ascii: true });
    await tick();
    expect(a.out.last()).not.toMatch(/[─-╿]/);
    expect(a.out.last()).toContain("+");
    const b = draw(80, 24);
    await tick();
    expect(b.out.last()).toMatch(/[─-╿]/);
  });

  it("AC-6: keys switch tabs, v adds and removes the Transcript tab", async () => {
    const { out, inp, model } = draw(100, 30);
    await tick();
    inp.type("4");
    await tick();
    expect(model.tab).toBe("log");
    inp.type("v");
    await tick();
    expect(model.tab).toBe("transcript");
    expect(out.last()).toContain("4 Transcript");
    inp.type("v");
    await tick();
    expect(out.last()).not.toContain("Transcript");
    inp.type("q");
    await tick();
    expect(model.quit).toBe(true);
  });

  it("AC-13: the side pane lists the features with their stage and the agent, on the right when wide, under the window when narrow", async () => {
    const { out, model } = draw(120, 30);
    model.setStatus(["F-001 (Interview): Waiting for your answer", "F-003 (Building): Developer is working"], 0, [
      { id: "F-001", stage: "Interview", activity: "Waiting for your answer" },
      { id: "F-003", stage: "Building", activity: "Developer is working" },
    ]);
    model.setAgents([{ run: "R-000000000001", feature: "F-003", role: "software-developer", started_at: new Date().toISOString() }]);
    model.toggleTranscript();
    await tick();
    let f = out.last();
    expect(model.tab).toBe("transcript");
    expect(f).toContain("Features (2)");
    expect(f).toContain("F-001 Interview");
    expect(f).toContain("F-003 Building");
    expect(f).toContain("F-003 software-developer 0 min");
    // On the right: the pane's lines share a row with the window's border.
    expect(f.split("\n").some((l) => /│.*│.*F-003 Building/.test(l))).toBe(true);
    fits(f, 120, 30);
    out.resize(80, 24);
    await tick();
    f = out.last();
    expect(f).toContain("Features: F-001 Interview, F-003 Building");
    expect(f).toContain("Agents: F-003 software-developer 0 min");
    fits(f, 80, 24);
  });
});
