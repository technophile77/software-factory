import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/log";
import { osNotifier } from "../src/os/notify";
import { Children } from "../src/proc";
import { tmpdir } from "./helpers";

// F-011 FR-13: OS notifications are best effort; a failure is logged and never stops the engine.

// Node stands in for the OS's notifier, so the test behaves the same on every host: osascript is
// there on macOS and notify-send may be on Linux, and either could show a real notification.
const node = (script: string) => () => ({ bin: process.execPath, args: ["-e", script] });

describe("OS notifications (F-011 FR-13)", () => {
  it("a notifier that can't run logs it and doesn't throw", async () => {
    const log = new MemoryLogger();
    const notify = osNotifier({ platform: "linux", children: new Children(), log, cwd: tmpdir(), program: () => ({ bin: path.join(tmpdir(), "no-such-notifier"), args: [] }) });
    expect(() => notify("Factory: D-0001 needs you", "line one\nline two\u0007")).not.toThrow();
    await notify.settled();
    expect(log.lines.map((l) => l.message)).toEqual([expect.stringMatching(/^OS notification not shown/)]);
  });

  it("a notifier that fails logs its exit code", async () => {
    const log = new MemoryLogger();
    const notify = osNotifier({ platform: "linux", children: new Children(), log, cwd: tmpdir(), program: node("process.exit(3)") });
    notify("Factory: D-0001 needs you", "text");
    await notify.settled();
    expect(log.lines.map((l) => l.message)).toEqual(["OS notification not shown (exit 3)."]);
  });

  it("stop ends a notification that hangs at once, rather than waiting out its 10-second limit, and shows no more", async () => {
    const log = new MemoryLogger();
    let started = 0;
    const notify = osNotifier({ platform: "win32", children: new Children(), log, cwd: tmpdir(), program: () => (started++, node("setTimeout(() => {}, 60000)")()) });
    notify("Factory: D-0001 needs you", "text");
    const t0 = Date.now();
    await notify.stop();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(log.lines.map((l) => l.message)).toEqual(["OS notification not shown: the engine stopped first."]);
    notify("Factory: D-0002 needs you", "text");
    await notify.settled();
    expect(started).toBe(1);
  });
});
