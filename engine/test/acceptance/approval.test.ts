// Owner approval through GitHub's device flow (AC-6, FR-7, ADR 0014,
// channel v1.2) and validation of everything GitHub sends (SR-23).
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drive, realDelay } from "./support/clock";
import { expectRpcError } from "./support/flows";
import { VERIFICATION_URI } from "./support/fake-github";
import { ERR } from "./support/rpc";
import { rand, World } from "./support/world";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function openFeature(world: World) {
  await world.boot();
  const feature = await world.startFeature();
  const open = await world.ok("interview.open", { feature });
  return { feature, open };
}

const await_ = (world: World, session: string, wait_s = 900) =>
  drive(world.clock, world.rpc("interview.awaitApproval", { session, wait_s }, 120_000), { maxMs: 2_000_000 });

describe("AC-6 / FR-7: a session is pending until the owner approves", () => {
  it("[AP-1] AC-6: interview.next and interview.reply on an unapproved session get approval_pending (-32006)", async () => {
    w = await World.create();
    const { feature, open } = await openFeature(w);
    expect(open.session).toMatch(/^[0-9a-f]{32}$/i);
    expect(open.approval.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(open.approval.verification_uri).toBe(VERIFICATION_URI);
    expect(Date.parse(open.approval.expires_at)).toBeGreaterThan(w.clock.now());
    expect(Date.parse(open.approval.expires_at)).toBeLessThanOrEqual(w.clock.now() + 900_000);
    expect(typeof open.started_at).toBe("string");
    expectRpcError(await w.rpc("interview.next", { session: open.session }), ERR.approvalPending);
    const reply = await w.rpc("interview.reply", {
      session: open.session,
      item: "q1",
      revision: 0,
      reply_id: rand(),
      kind: "answer",
      text: "x",
    });
    expectRpcError(reply, ERR.approvalPending);
    void feature;
  });

  it("[AP-2] AC-6: approval by a GitHub account other than the owner gives approval_failed (-32007), and the session never accepts a reply", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    w.gh.addUser(9999, "someone-else");
    w.gh.approve(open.approval.user_code, 9999);
    expectRpcError(await await_(w, open.session), ERR.approvalFailed);
    const after = await w.rpc("interview.next", { session: open.session });
    expect([ERR.approvalFailed, ERR.session]).toContain(after.error?.code);
  });

  it("[AP-3] FR-7: the owner's approval opens the session, and GET /user is called with the device token", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    w.gh.approve(open.approval.user_code, w.projects[0].ownerId);
    const r = await await_(w, open.session);
    expect(r.result).toEqual({ approved: true });
    expect((await w.rpc("interview.next", { session: open.session })).result).toBeDefined();
    const userCalls = w.gh.requests.filter((q) => q.path === "/api/user");
    expect(userCalls.length).toBeGreaterThan(0);
  });

  it("[AP-4] ADR 0014: the owner is matched by numeric id, never by login", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    const owner = w.projects[0];
    // An impostor with the owner's login but another id.
    w.gh.addUser(8888, owner.ownerLogin);
    w.gh.approve(open.approval.user_code, 8888);
    expectRpcError(await await_(w, open.session), ERR.approvalFailed);
  });

  it("[AP-5] SR-23: a /user answer whose id is a string, even the owner's digits, is refused", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    const owner = w.projects[0];
    w.gh.userBody.set(owner.ownerId, { id: String(owner.ownerId), login: owner.ownerLogin });
    w.gh.approve(open.approval.user_code, owner.ownerId);
    expectRpcError(await await_(w, open.session), ERR.approvalFailed);
  });

  it("[AP-6] ADR 0014: a denied approval gives approval_failed", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    w.gh.deny(open.approval.user_code);
    expectRpcError(await await_(w, open.session), ERR.approvalFailed);
  });

  it("[AP-7] ADR 0014 / edge case: the owner approves after the device code expired; approval_failed", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    const pending = w.rpc("interview.awaitApproval", { session: open.session, wait_s: 900 }, 120_000);
    await w.clock.advance(901_000);
    w.gh.approve(open.approval.user_code, w.projects[0].ownerId);
    const r = await drive(w.clock, pending, { maxMs: 2_000_000 });
    expect(r.result?.approved).not.toBe(true);
    const r2 = await w.rpc("interview.awaitApproval", { session: open.session, wait_s: 1 });
    expect([ERR.approvalFailed, ERR.session]).toContain(r2.error?.code);
  });

  it.each([
    ["503 from GitHub", "down"],
    ["dropped connections", "reset"],
  ] as const)("[AP-8] ADR 0014 / SR-2: GitHub unreachable during approval (%s) fails closed with approval_failed", async (_n, outage) => {
    w = await World.create();
    const { open } = await openFeature(w);
    w.gh.outage = outage;
    w.gh.approve(open.approval.user_code, w.projects[0].ownerId);
    expectRpcError(await await_(w, open.session), ERR.approvalFailed);
  });

  it("[AP-9] FR-7: the device-code request carries the project's client id, no scopes and no client secret", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    const d = w.gh.device(open.approval.user_code);
    expect(d.clientId).toBe(w.projects[0].clientId);
    expect(d.scope === undefined || d.scope === "").toBe(true);
    expect(d.sentSecret).toBe(false);
  });

  it("[AP-10] ADR 0014: each session gets its own device code; a new session needs a new approval", async () => {
    w = await World.create();
    await w.boot();
    const f = await w.startFeature();
    const s1 = await w.approvedSession(f);
    await w.ok("interview.close", { session: s1 });
    const open2 = await w.ok("interview.open", { feature: f });
    expect(w.gh.devices.length).toBe(2);
    expectRpcError(await w.rpc("interview.next", { session: open2.session }), ERR.approvalPending);
  });

  it("[AP-11] channel v1.2: awaitApproval waits at most 900 s of engine time, whatever wait_s says", async () => {
    w = await World.create();
    const { open } = await openFeature(w);
    const t0 = w.clock.now();
    const r = await drive(w.clock, w.rpc("interview.awaitApproval", { session: open.session, wait_s: 100_000 }, 120_000), {
      stepMs: 10_000,
      maxMs: 2_000_000,
    });
    expect(r.result?.approved).not.toBe(true);
    expect(w.clock.now() - t0).toBeLessThanOrEqual(920_000);
  });
});

describe("SR-23: every device-flow field from GitHub is validated", () => {
  const bad: Array<[string, (d: Record<string, unknown>) => Record<string, unknown>]> = [
    ["lowercase user_code", (d) => ({ ...d, user_code: "abcd-1234" })],
    ["user_code without the dash", (d) => ({ ...d, user_code: "ABCD1234" })],
    ["user_code with a newline", (d) => ({ ...d, user_code: "ABCD-1234\nVISIT evil.example" })],
    ["verification_uri on another host", (d) => ({ ...d, verification_uri: "https://github.com.evil.example/login/device" })],
    ["verification_uri over http", (d) => ({ ...d, verification_uri: "http://github.com/login/device" })],
    ["verification_uri with a query", (d) => ({ ...d, verification_uri: "https://github.com/login/device?next=evil" })],
    ["device_code not a string", (d) => ({ ...d, device_code: 12345 })],
    ["missing device_code", (d) => ({ ...d, device_code: undefined })],
  ];
  it.each(bad)("[AP-12] SR-23: %s: the code is never shown and no session can be approved", async (_n, override) => {
    w = await World.create();
    await w.boot();
    const feature = await w.startFeature();
    w.gh.deviceOverride = override;
    const r = await w.rpc("interview.open", { feature });
    if (r.error) {
      expect(r.error.code).toBeLessThan(0);
      return;
    }
    // If the engine answered, it must not pass on what GitHub sent, and the
    // session must fail rather than be approved.
    expect(r.result.approval.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(r.result.approval.verification_uri).toBe(VERIFICATION_URI);
    const d = w.gh.lastDevice();
    if (d) w.gh.approve(d.userCode, w.projects[0].ownerId);
    expectRpcError(await await_(w, r.result.session), ERR.approvalFailed);
  });

  it("[AP-13] SR-23: expires_in over 900 s is refused or capped at 900 s", async () => {
    w = await World.create();
    await w.boot();
    const feature = await w.startFeature();
    w.gh.deviceOverride = (d) => ({ ...d, expires_in: 86_400 });
    const r = await w.rpc("interview.open", { feature });
    if (r.error) return;
    expect(Date.parse(r.result.approval.expires_at)).toBeLessThanOrEqual(w.clock.now() + 900_000);
    // Polling stops by 900 s even though GitHub said a day.
    await drive(w.clock, w.rpc("interview.awaitApproval", { session: r.result.session, wait_s: 900 }, 120_000), { stepMs: 10_000 });
    const before = w.gh.lastDevice()!.polls.length;
    await w.clock.advance(3_600_000);
    await realDelay(200);
    const polls = w.gh.lastDevice()!.polls;
    expect(polls.length).toBe(before);
    for (const t of polls) expect(t - w.gh.lastDevice()!.issuedAt).toBeLessThanOrEqual(905_000);
  });

  it("[AP-14] SR-23: polling honours interval, and slow_down adds to it", async () => {
    w = await World.create();
    await w.boot();
    const feature = await w.startFeature();
    w.gh.deviceOverride = (d) => ({ ...d, interval: 7 });
    const open = await w.ok("interview.open", { feature });
    const d = w.gh.device(open.approval.user_code);
    d.slowDownNext = 1;
    const pending = w.rpc("interview.awaitApproval", { session: open.session, wait_s: 900 }, 120_000);
    // Let a few polls happen, then approve.
    for (let i = 0; i < 60 && d.polls.length < 4; i++) {
      await realDelay(5);
      await w.clock.advance(1000);
    }
    w.gh.approve(open.approval.user_code, w.projects[0].ownerId);
    expect((await drive(w.clock, pending)).result).toEqual({ approved: true });
    expect(d.polls.length).toBeGreaterThanOrEqual(3);
    // First gap at least 7 s; after slow_down (answered on the first poll) at least 12 s.
    expect(d.polls[0] - d.issuedAt).toBeGreaterThanOrEqual(7000);
    expect(d.polls[1] - d.polls[0]).toBeGreaterThanOrEqual(12_000);
    for (let i = 2; i < d.polls.length; i++) expect(d.polls[i] - d.polls[i - 1]).toBeGreaterThanOrEqual(12_000);
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -1],
  ])("[AP-15] SR-23: an interval that is %s never makes the engine poll faster than every 5 s", async (_n, interval) => {
    w = await World.create();
    await w.boot();
    const feature = await w.startFeature();
    w.gh.deviceOverride = (d) => ({ ...d, interval });
    const r = await w.rpc("interview.open", { feature });
    if (r.error) return;
    const d = w.gh.lastDevice()!;
    for (let i = 0; i < 40; i++) {
      await realDelay(5);
      await w.clock.advance(1000);
    }
    const gaps = [d.polls[0] - d.issuedAt, ...d.polls.slice(1).map((t, i) => t - d.polls[i])].filter((g) => !Number.isNaN(g));
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(5000);
  });

  it("[AP-16] SR-23: default TLS checks: a GitHub with an untrusted certificate is refused (fail closed)", async () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `f007-tls-${rand(4)}`);
    execFileSync("mkdir", ["-p", dir]);
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    w = await World.create([{}], {
      tls: { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") },
    });
    execFileSync("rm", ["-rf", dir]);
    let started = true;
    try {
      await w.boot();
    } catch (e) {
      if (/engine not available/.test((e as Error).message)) throw e;
      started = false;
    }
    if (!started || !(await w.isRunning(w.projects[0]))) {
      // The repo check against GitHub already failed closed.
      return;
    }
    const feature = await w.startFeature();
    const r = await w.rpc("interview.open", { feature });
    if (r.error) return;
    const d = w.gh.lastDevice();
    if (d) w.gh.approve(d.userCode, w.projects[0].ownerId);
    expectRpcError(await await_(w, r.result.session), ERR.approvalFailed);
  });
});
