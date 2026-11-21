// F-015 FR-27: the owner cancels a feature from any state that isn't final; `closed` means only a merged PR.
import { afterEach, describe, expect, it } from "vitest";
import { buildMachine } from "../src/build/lifecycle";
import { RPC } from "../src/constants";
import { EngineHandle } from "../src/engine";
import { activityOf } from "../src/interview/activity";
import { parseTranscript } from "../src/state/transcript";
import { RpcClient, engineJson, git, makeWorld, start } from "./helpers";

let engines: EngineHandle[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await e.stop();
  engines = [];
  clients = [];
});

const ready = ["dependencies_merged", "done", "done", "branches_merged", "passed", "clean", "pass", "opened", "green"] as const;

describe("cancelled and closed (F-015 FR-27)", () => {
  it("a merged PR ends the build closed; one closed without merging ends it cancelled", () => {
    expect(buildMachine([...ready, "owner_merged"]).machine.state()).toBe("closed");
    expect(buildMachine([...ready, "engine_merged"]).machine.state()).toBe("closed");
    expect(buildMachine([...ready, "owner_closed"]).machine.state()).toBe("cancelled");
    expect(buildMachine([...ready, "owner_closed"]).machine.isFinal()).toBe(true);
  });

  it("a cancelled feature reports cancelled, even paused or with items open", () => {
    expect(activityOf({ stage: "cancelled", paused: true, running: false, statuses: ["open"], decisions: ["D-0001"] })).toBe("cancelled");
    expect(activityOf({ stage: "pull_request", paused: false, running: false, statuses: [], build: "closed" })).toBe("closed");
  });

  it("AC-51, AC-52: the owner cancels an interview; it records the reason and stage, keeps the branch, refuses a second cancel and stays cancelled after a restart", async () => {
    const w = makeWorld();
    let e = await start(w);
    engines.push(e);
    let c = await RpcClient.connect(engineJson(w).path);
    clients.push(c);
    const feature = (await c.ok("feature.start", { request: "Print hello world" })).feature as string;
    const branch = e.feature("acme", feature)!.state.branch;

    expect((await c.call("feature.cancel", { feature: "F-999" })).error).toMatchObject({ code: RPC.unknown });
    expect((await c.call("feature.cancel", { feature, reason: 5 })).error).toMatchObject({ code: RPC.invalidParams });
    expect(await c.ok("feature.cancel", { feature, reason: " Abandoned test feature " })).toEqual({ ok: true });

    const last = parseTranscript(git(w.config, "show", `factory/state:interviews/${feature}/transcript.jsonl`) + "\n").at(-1)!;
    expect(last).toMatchObject({ type: "feature_cancelled", reason: "Abandoned test feature", by: "owner" });
    expect(e.feature("acme", feature)!.state.cancelled).toMatchObject({ from: "requirements_interview" });
    expect(git(w.config, "branch", "--list", branch)).toContain(branch);
    const status = async () => ((await c.ok("engine.status")).features as Array<{ id: string; stage: string; activity: string }>).find((x) => x.id === feature);
    expect(await status()).toMatchObject({ stage: "cancelled", activity: "cancelled" });
    expect((await c.call("feature.cancel", { feature })).error).toMatchObject({ code: RPC.invalidParams, message: `${feature} is already cancelled.` });
    // Nothing more is recorded for it, whoever tries.
    await expect(e.feature("acme", feature)!.append([{ type: "stage", stage: "requirements_interview" }] as never, "late")).rejects.toThrow(/was cancelled/);

    c.close();
    await e.stop();
    e = await start(w);
    engines.push(e);
    c = await RpcClient.connect(engineJson(w).path);
    clients.push(c);
    expect(await status()).toMatchObject({ stage: "cancelled", activity: "cancelled" });
  });
});
