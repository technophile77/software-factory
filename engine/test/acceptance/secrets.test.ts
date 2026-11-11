// SR-1 and the sensitive-data rules (G1 #15): secrets never reach a log, a
// file in Git, an inbox item, an argument list or the analyst's prompt; logs
// are owner-only and hold no reply text; the credential store uses a
// factory-specific name (SR-20).
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_NAMES } from "./harness";
import { askAndFetch, interviewReady } from "./support/flows";
import { allObjects, reachable } from "./support/inspect";
import { listFiles, rand, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** A full milestone-1 run: start, approve, ask, answer, assumption, close. */
async function fullRun(world: World) {
  const { feature, session } = await interviewReady(world);
  const replyText = `owner-words-${rand(8)}`;
  const q = await askAndFetch(world, feature, session);
  await world.reply(session, q, "answer", replyText);
  const a = await world.propose(feature);
  await world.reply(session, a, "approve_assumption", "");
  await world.ok("interview.close", { session });
  await world.settle();
  return { feature, replyText };
}

function secretsOf(world: World) {
  return [
    ["model credential", world.modelCredential],
    ["factory token", world.factoryToken],
    ...world.gh.issuedTokens.map((t) => ["device-flow token", t]),
    ...world.gh.devices.map((d) => ["device_code", d.deviceCode]),
    ...world.sessionTokens.map((t) => ["session token", t]),
  ] as Array<[string, string]>;
}

describe("SR-1: secrets stay out of logs, Git, inbox items, argument lists and prompts", () => {
  it("[SC-1] SR-1: after a full run no secret appears in the logs, any repo's objects or history, engine.json, a git or gitleaks argument, or a turn message", async () => {
    w = await World.create(undefined, { logGit: true });
    await fullRun(w);
    const secrets = secretsOf(w);
    expect(secrets.filter(([k]) => k === "device-flow token").length).toBeGreaterThan(0);

    const places: Array<[string, string]> = [];
    for (const f of listFiles(w.logDir)) places.push([`log ${f}`, readFileSync(f, "latin1")]);
    for (const p of w.projects) {
      for (const repo of [p.clone, p.bare, p.configRepo]) {
        places.push([`objects of ${repo}`, allObjects(repo)]);
        places.push([`history of ${repo}`, reachable(repo)]);
      }
      for (const f of listFiles(join(p.clone, ".factory"))) places.push([f, readFileSync(f, "latin1")]);
    }
    places.push(["master repo", reachable(w.master)]);
    places.push(["git arguments", w.gitw.calls().map((c) => c.argv.join(" ")).join("\n")]);
    places.push(["gitleaks arguments", w.gitleaks.runs().map((r) => r.argv.join(" ")).join("\n")]);
    places.push(["analyst turns", w.analyst.turns.map((t) => t.message).join("\n")]);
    places.push([
      "analyst start",
      JSON.stringify(w.analyst.starts.map((s) => ({ ...s, tools: undefined }))),
    ]);
    for (const [where, text] of places) {
      for (const [what, secret] of secrets) {
        expect(text.includes(secret), `${what} found in ${where}`).toBe(false);
      }
    }
  });

  it("[SC-2] SR-1 / SR-20: the model credential and factory token never land in the engine's state folder either", async () => {
    w = await World.create();
    await fullRun(w);
    for (const f of listFiles(w.stateDir)) {
      const text = readFileSync(f, "latin1");
      expect(text.includes(w.modelCredential), f).toBe(false);
      expect(text.includes(w.factoryToken), f).toBe(false);
      for (const t of w.gh.issuedTokens) expect(text.includes(t), f).toBe(false);
    }
  });

  it("[SC-3] G1 #15: logs live in an owner-only folder (0700, files 0600) and hold no reply text", async () => {
    w = await World.create();
    const { replyText } = await fullRun(w);
    // Windows has no mode bits to check; the reply-text check still runs there.
    const modes = process.platform !== "win32";
    if (modes) expect(statSync(w.logDir).mode & 0o777).toBe(0o700);
    for (const f of listFiles(w.logDir)) {
      if (modes) expect(statSync(f).mode & 0o777, f).toBe(0o600);
      expect(readFileSync(f, "utf8").includes(replyText), `reply text in ${f}`).toBe(false);
    }
  });

  it("[SC-4] SR-20: the engine reads only its own secret names (the store's service is software-factory-engine)", async () => {
    w = await World.create();
    await fullRun(w);
    expect(w.store.accessed.length).toBeGreaterThan(0);
    const own = new Set([CREDENTIAL_NAMES.model, ...w.projects.map((p) => CREDENTIAL_NAMES.factoryToken(p.name))]);
    for (const name of w.store.accessed) expect(own.has(name), name).toBe(true);
    expect(w.store.accessed).toContain(CREDENTIAL_NAMES.factoryToken(w.project().name));
  });

  it("[SC-5] SR-2: with no factory token in the store, no project runs (fail closed)", async () => {
    w = await World.create();
    w.store.values.delete(CREDENTIAL_NAMES.factoryToken(w.project().name));
    let started = true;
    try {
      await w.boot();
    } catch (e) {
      if (/engine not available/.test((e as Error).message)) throw e;
      started = false;
    }
    if (started) expect(await w.isRunning(w.project())).toBe(false);
  });
});
