// F-018 AC-12: the terminal command against the real engine over its own
// channel, the named pipe on Windows and the socket elsewhere, in the
// platform suite so Windows CI runs it on every PR.
import { afterEach, expect, it } from "vitest";
import type { EngineHandle } from "../src/engine";
import { Interview } from "../src/mcp/operations";
import { realOsApi } from "../src/os/ffi";
import { TerminalInterview } from "../src/terminal/interview";
import { makeWorld, manifestYaml, removeTmpdirs, start } from "./helpers";

let engines: EngineHandle[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop();
  engines = [];
  removeTmpdirs();
});

it("AC-12: the command completes the AC-2 scenario against the real engine over its channel", async () => {
  // No sign-in, so the run needs no GitHub approval (FR-15).
  const manifest = manifestYaml({ extra: "  interview_sign_in: { every: never }" }).replace("maturity: prototype", "maturity: rapid-prototype");
  const w = makeWorld({ manifest });
  const e = await start(w);
  engines.push(e);
  const ops = new Interview({ os: realOsApi(), projectDir: w.config });
  const started = await ops.run("start", { request: "Export reports" });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const feature = started.feature as string;
  const asked = await e.interviewTools(feature, w.worktree).interview_ask({
    text: "Which format?", why: "It decides the exporter.", suggested: "CSV", options: ["CSV", "JSON lines", "Parquet files with a schema"],
  });
  expect(asked.ok).toBe(true);

  const lines = ["3"];
  let out = "";
  let idle = 0;
  const io = {
    write: (t: string) => void (out += t),
    line: async (p: string) => {
      out += p;
      return lines.shift() ?? null;
    },
    // Once the script has run out, the wait for the next item stops as Ctrl+C would.
    aborted: () => lines.length === 0 && ++idle > 3,
  };
  const timing = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))) };
  const code = await new TerminalInterview((op, req) => ops.run(op, req), io, "| ", timing).main(feature);

  expect(code, out).toBe(0);
  expect(out).toMatch(/1\. CSV \(recommended\)\n {2}2\. JSON lines\n {2}3\. Parquet files with a schema/);
  const item = e.feature(feature)!.state.list().find((it) => it.text === "Which format?");
  expect(item?.status).toBe("answered");
  expect(JSON.stringify(item)).toContain("Parquet files with a schema");
}, 60_000);
