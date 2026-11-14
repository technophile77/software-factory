import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/log";
import { osNotifier } from "../src/os/notify";
import { Children } from "../src/proc";
import { tmpdir } from "./helpers";

// F-011 FR-13: OS notifications are best effort; a failure is logged and never stops the engine.

describe("OS notifications (F-011 FR-13)", () => {
  it("a notifier that can't run logs it and doesn't throw", async () => {
    const log = new MemoryLogger();
    // On this Linux test host, macOS's osascript isn't there.
    const notify = osNotifier({ platform: "darwin", children: new Children(), log, cwd: tmpdir() });
    expect(() => notify("Factory: D-0001 needs you", "line one\nline two\u0007")).not.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    expect(log.lines.map((l) => l.message)).toEqual([expect.stringMatching(/^OS notification not shown/)]);
  });
});
