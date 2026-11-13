import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { EndpointService, type EndpointServiceOptions, estimateTokens } from "../src/agent/endpoint-service";
import type { EndpointProbe, ModelIdentity } from "../src/agent/endpoint-check";
import { requestDeadlineMs } from "../src/proxy/server";
import { SessionGroup } from "../src/agent/sandbox";
import { type Endpoint, validateEndpoints } from "../src/config/endpoints";
import { type DockerCli, DockerError } from "../src/docker/cli";
import { MemoryLogger } from "../src/log";
import type { RolePolicy } from "../src/policy/role-policy";
import { MemoryCredentialStore } from "../src/secrets";
import { FakeDocker } from "./fakes";
import { FakeClock, settle, tmpdir } from "./helpers";

// Built from parts so this file holds no literal private address (F-013 AC-1).
const PRIVATE = ["10", "0", "0", "5"].join(".");
const PUBLIC = ["93", "184", "216", "34"].join(".");
const MiB = 1024 * 1024;
const LIMITS = { cpus: 1, memoryBytes: 512 * MiB, pids: 64, tmpBytes: 16 * MiB };
const IMAGE = { id: `sha256:${"c".repeat(64)}`, user: "65532:65532" };
const RUNG = { endpoint: "lan", model: "qwen3" };

function endpoints(over: Record<string, Record<string, unknown>> = {}): Endpoint[] {
  const base = { base_url: "http://llm.example:8080", model: "qwen3", api: "anthropic", billing: "local" };
  const lan = { ...base, ...over.lan };
  return validateEndpoints({ endpoints: { lan, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "lan").map(([k, v]) => [k, { ...base, ...v }])) } }).endpoints;
}

interface Rig {
  svc: EndpointService;
  clock: FakeClock;
  log: MemoryLogger;
  probed: Array<{ name: string; key: string | null }>;
  opts: EndpointServiceOptions;
}

async function rig(config: EndpointServiceOptions["config"], o: { probe?: EndpointProbe; lookup?: EndpointServiceOptions["lookup"]; planFile?: string; clock?: FakeClock; keys?: Record<string, string>; identityFile?: string; onModelChanged?: (endpoint: string) => void } = {}): Promise<Rig> {
  const dir = tmpdir();
  const probed: Rig["probed"] = [];
  const clock = o.clock ?? new FakeClock();
  const log = new MemoryLogger();
  const opts: EndpointServiceOptions = {
    config, clock, log, credentials: new MemoryCredentialStore(o.keys ?? {}),
    lookup: o.lookup ?? (async () => [{ address: PRIVATE, family: 4 }]),
    probe: o.probe ?? (async (e, _pin, key) => (probed.push({ name: e.name, key }), { ok: true, toolChecked: true })),
    planFile: o.planFile ?? path.join(dir, "plans.json"), workDir: path.join(dir, "router"),
    image: async () => IMAGE,
    slotWaitMs: 10 * 60_000,
    ...(o.identityFile ? { identityFile: o.identityFile } : {}),
    ...(o.onModelChanged ? { onModelChanged: o.onModelChanged } : {}),
  };
  return { svc: await EndpointService.start(opts), clock, log, probed, opts };
}

describe("EndpointService at engine start (FR-6, AC-2, AC-3, AC-6)", () => {
  it("marks an endpoint that passes the check available, and hands its key to the probe alone", async () => {
    const r = await rig({ endpoints: endpoints({ lan: { api_key_ref: "lan-key" } }) }, { keys: { "endpoint-key/lan-key": "the-key" } });
    expect(r.svc.statuses()).toEqual([{ name: "lan", model: "qwen3", available: true }]);
    expect(r.probed).toEqual([{ name: "lan", key: "the-key" }]);
    expect(r.svc.unavailable(RUNG)).toBeNull();
  });

  it("AC-6: marks an endpoint unavailable with the probe's reason, and logs the name and reason only", async () => {
    const r = await rig({ endpoints: endpoints() }, { probe: async () => ({ ok: false, reason: "it doesn't list the configured model" }) });
    expect(r.svc.statuses()).toEqual([{ name: "lan", model: "qwen3", available: false, reason: "it doesn't list the configured model" }]);
    expect(r.svc.unavailable(RUNG)).toContain("it doesn't list the configured model");
    expect(r.log.text()).toContain("Model endpoint lan is unavailable: it doesn't list the configured model");
  });

  it("AC-3: a public endpoint over http is unavailable, and the reason doesn't name its host", async () => {
    const r = await rig({ endpoints: endpoints() }, { lookup: async () => [{ address: PUBLIC, family: 4 }] });
    const st = r.svc.statuses()[0]!;
    expect(st.available).toBe(false);
    expect(st.reason).toMatch(/https/);
    expect(JSON.stringify(st)).not.toContain("llm.example");
    expect(r.log.text()).not.toContain("llm.example");
  });

  it("is unavailable, with a reason, when its key isn't in the credential store, and never probes", async () => {
    const r = await rig({ endpoints: endpoints({ lan: { api_key_ref: "lan-key" } }) });
    expect(r.svc.statuses()[0]).toMatchObject({ available: false, reason: expect.stringContaining("API key") });
    expect(r.probed).toEqual([]);
  });

  it("AC-2: a refused endpoints file leaves no endpoint available and says why", async () => {
    const r = await rig({ problem: "factory-endpoints.local.yaml must be owned by you and writable by nobody else." });
    expect(r.svc.statuses()).toEqual([]);
    expect(r.svc.fileProblem()).toContain("writable by nobody else");
    expect(r.svc.unavailable(RUNG)).toContain("endpoints file was refused");
  });

  it("answers for a rung the PC lacks or whose model differs from the configured one", async () => {
    const r = await rig({ endpoints: endpoints() });
    expect(r.svc.unavailable({ endpoint: "other", model: "x" })).toMatch(/no endpoint of that name/);
    expect(r.svc.unavailable({ endpoint: "lan", model: "other-model" })).toMatch(/different model/);
  });
});

describe("EndpointService.route (FR-4, FR-7, FR-13)", () => {
  const req = { rung: RUNG, role: "log-reader", allowed: ["lan"], promptTokens: 1234 };

  it("grants a route for the endpoint: report model with the prefix, the endpoint's name as SDK model and grant, one pinned endpoint and its key", async () => {
    const r = await rig({ endpoints: endpoints({ lan: { api_key_ref: "lan-key" } }) }, { keys: { "endpoint-key/lan-key": "the-key" } });
    const got = await r.svc.route(req);
    if (!("router" in got)) throw new Error("expected a route");
    expect(got).toMatchObject({ reportModel: "lan/qwen3", sdkModel: "lan", upstream: "lan", waitedS: 0 });
    expect(got.router.endpoints.map((e) => e.name)).toEqual(["lan"]);
    expect(got.router.pins).toEqual([{ name: "lan", class: "private", scheme: "http", host: "llm.example", address: PRIVATE, port: 8080, basePath: "" }]);
    expect([...got.router.keys]).toEqual([["lan-key", "the-key"]]);
    got.abandon();
  });

  it("AC-13: an endpoint the project's manifest doesn't list falls back with that reason, before anything is reserved", async () => {
    const r = await rig({ endpoints: endpoints() });
    const got = await r.svc.route({ ...req, allowed: [] });
    expect(got).toEqual({ fallback: { endpoint: "lan", reason: expect.stringContaining("manifest doesn't list"), waited_s: 0, prompt_tokens: 1234 } });
  });

  it("falls back, naming the reason, when the endpoint was unavailable at start or its address now fails the check", async () => {
    const down = await rig({ endpoints: endpoints() }, { probe: async () => ({ ok: false, reason: "it didn't answer in time" }) });
    expect(await down.svc.route(req)).toMatchObject({ fallback: { reason: expect.stringContaining("it didn't answer in time") } });
    let answer = PRIVATE;
    const moved = await rig({ endpoints: endpoints() }, { lookup: async () => [{ address: answer, family: 4 }] });
    answer = PUBLIC;
    const got = await moved.svc.route(req);
    expect(got).toMatchObject({ fallback: { reason: expect.stringContaining("https") } });
    expect(JSON.stringify(got)).not.toContain("llm.example");
  });

  it("AC-7, AC-9: a second session waits for the first's slot; one that waits 10 minutes falls back with the time waited", async () => {
    const r = await rig({ endpoints: endpoints() });
    const first = await r.svc.route(req);
    if (!("router" in first)) throw new Error("expected a route");
    const second = r.svc.route(req);
    await settle();
    await r.clock.advance(10 * 60_000);
    expect(await second).toEqual({ fallback: { endpoint: "lan", reason: expect.stringMatching(/no session slot .* 10 minutes/), waited_s: 600, prompt_tokens: 1234 } });
    // The slot is still the first session's: a third waits, and gets it when the first ends.
    const third = r.svc.route(req);
    await settle();
    first.finish({ inputTokens: 1, outputTokens: 1, requests: 1 });
    const got = await third;
    expect("router" in got).toBe(true);
  });

  it("AC-8, AC-12: a local endpoint costs $0 and charges no budget; a per_token endpoint costs its tokens times its prices and charges the budget", async () => {
    const r = await rig({ endpoints: endpoints({ lan: {}, paid: { billing: "per_token", prices: { input_per_mtok: 1, output_per_mtok: 2 } } }) });
    const local = await r.svc.route(req);
    if (!("router" in local)) throw new Error("expected a route");
    expect(local.finish({ inputTokens: 5_000_000, outputTokens: 1_000_000, requests: 10 })).toEqual({ costUsd: 0, planShare: 0, chargesBudget: false });
    const paid = await r.svc.route({ ...req, rung: { endpoint: "paid", model: "qwen3" }, allowed: ["paid"] });
    if (!("router" in paid)) throw new Error("expected a route");
    expect(paid.finish({ inputTokens: 1_000_000, outputTokens: 500_000, requests: 3 })).toEqual({ costUsd: 2, planShare: 0, chargesBudget: true });
  });

  describe("a subscription endpoint (AC-14)", () => {
    const plan = { billing: "subscription", plan: { limits: [{ kind: "requests", count: 100, window: "5h" }], reserve_pct: 10 } };

    it("records a run's share of the plan, falls back once 90 requests are counted, and remembers across a restart", async () => {
      const dir = tmpdir();
      const planFile = path.join(dir, "plans.json");
      const clock = new FakeClock();
      const r = await rig({ endpoints: endpoints({ lan: plan }) }, { planFile, clock });
      const run = await r.svc.route(req);
      if (!("router" in run)) throw new Error("expected a route");
      expect(run.finish({ inputTokens: 100, outputTokens: 50, requests: 9 })).toEqual({ costUsd: 0, planShare: 0.09, chargesBudget: false });
      expect(r.svc.planUsed("lan", "requests", "5h")).toBe(9);
      const big = await r.svc.route(req);
      if (!("router" in big)) throw new Error("expected a route");
      big.finish({ inputTokens: 0, outputTokens: 0, requests: 81 });
      expect(await r.svc.route(req)).toMatchObject({ fallback: { endpoint: "lan", reason: "the plan limit was reached" } });
      // A new engine reads the counters back: the limit holds across restarts.
      const again = await rig({ endpoints: endpoints({ lan: plan }) }, { planFile, clock });
      expect(await again.svc.route(req)).toMatchObject({ fallback: { reason: "the plan limit was reached" } });
      // The window rolls on: six hours later the same requests no longer count.
      await clock.advance(6 * 3_600_000);
      expect("router" in (await again.svc.route(req))).toBe(true);
    });

    it("frees the slot when it falls back for the plan limit", async () => {
      const r = await rig({ endpoints: endpoints({ lan: { ...plan, plan: { limits: [{ kind: "requests", count: 10, window: "5h" }], reserve_pct: 10 } } }) });
      const run = await r.svc.route(req);
      if (!("router" in run)) throw new Error("expected a route");
      run.finish({ inputTokens: 0, outputTokens: 0, requests: 9 });
      expect(await r.svc.route(req)).toMatchObject({ fallback: { reason: "the plan limit was reached" } });
      expect(await r.svc.route(req)).toMatchObject({ fallback: { waited_s: 0 } });
    });
  });

  it("falls back, without holding the slot, when the router image can't be used", async () => {
    const r = await rig({ endpoints: endpoints() });
    let fail = false;
    const svc = await EndpointService.start({ ...r.opts, image: async () => { if (fail) throw new DockerError("the LiteLLM image's cosign signature hasn't been verified"); return IMAGE; } });
    fail = true;
    expect(await svc.route(req)).toMatchObject({ fallback: { reason: expect.stringContaining("cosign") } });
    fail = false;
    expect("router" in (await svc.route(req))).toBe(true);
  });

  it("finish counts once however often it is called", async () => {
    const r = await rig({ endpoints: endpoints({ lan: { billing: "subscription", plan: { limits: [{ kind: "requests", count: 100, window: "5h" }], reserve_pct: 10 } } }) });
    const run = await r.svc.route(req);
    if (!("router" in run)) throw new Error("expected a route");
    run.finish({ inputTokens: 1, outputTokens: 1, requests: 4 });
    run.finish({ inputTokens: 1, outputTokens: 1, requests: 4 });
    expect(r.svc.planUsed("lan", "requests", "5h")).toBe(4);
  });
});

describe("a routed session group (FR-5)", () => {
  const POLICY: RolePolicy = { role: "log-reader", tools: ["Read"], read: { allow: ["**"], deny: [] }, write: { allow: [], deny: [] }, commands: [], network: [], mayRequest: [] };

  it("starts the router, sends the endpoint pin list and grants the agent session its endpoint as upstream", async () => {
    const r = await rig({ endpoints: endpoints() });
    const route = await r.svc.route({ rung: RUNG, role: "log-reader", allowed: ["lan"], promptTokens: 10 });
    if (!("router" in route)) throw new Error("expected a route");
    const d = new FakeDocker();
    const group = new SessionGroup({
      docker: d as unknown as DockerCli, runId: "R-0a1b2c-adv", project: "demo", agentImageId: `sha256:${"a".repeat(64)}`, proxyImageId: `sha256:${"b".repeat(64)}`,
      proxyScript: "/opt/engine/dist/proxy.js", agentLimits: { "log-reader": LIMITS }, proxyLimits: LIMITS, maxPageBytes: 1 << 20,
      credential: { kind: "api_key", value: "claude-credential-placeholder" }, log: new MemoryLogger(), platform: "linux", sleep: async () => undefined,
      router: { ...route.router, workDir: tmpdir() },
    });
    await group.open();
    const agent = await group.startAgent(POLICY, null, { upstream: route.upstream });
    const sent = d.spawned[0]!.child.sent();
    expect(sent.find((m) => m.t === "start")?.router).toMatchObject({ port: 4000 });
    expect(sent.find((m) => m.t === "endpoints")?.list).toEqual(route.router.pins);
    expect(sent.find((m) => m.t === "grant" && m.session === agent.name)).toMatchObject({ role: "log-reader", upstream: "lan" });
    // The Claude credential went to the proxy only; the router container got none of it.
    expect(JSON.stringify(d.calls.filter((c) => c.args.includes(`factory-r-0a1b2c-adv-router`)))).not.toContain("claude-credential-placeholder");
    await group.close();
    route.finish({ inputTokens: 1, outputTokens: 1, requests: 1 });
  });

  it("FR-12: puts the measured rates in the agent's grant, and the group notes a gateway 504 deadline", async () => {
    const r = await rig({ endpoints: endpoints() }, { probe: seededProbe });
    const route = await r.svc.route({ rung: RUNG, role: "log-reader", allowed: ["lan"], promptTokens: 10 });
    if (!("router" in route)) throw new Error("expected a route");
    const d = new FakeDocker();
    const group = new SessionGroup({
      docker: d as unknown as DockerCli, runId: "R-0a1b2c-adv", project: "demo", agentImageId: `sha256:${"a".repeat(64)}`, proxyImageId: `sha256:${"b".repeat(64)}`,
      proxyScript: "/opt/engine/dist/proxy.js", agentLimits: { "log-reader": LIMITS }, proxyLimits: LIMITS, maxPageBytes: 1 << 20,
      credential: { kind: "api_key", value: "claude-credential-placeholder" }, log: new MemoryLogger(), platform: "linux", sleep: async () => undefined,
      router: { ...route.router, workDir: tmpdir() },
    });
    await group.open();
    const agent = await group.startAgent(POLICY, null, { upstream: route.upstream });
    expect(d.spawned[0]!.child.sent().find((m) => m.t === "grant" && m.session === agent.name)).toMatchObject({ deadline: { promptTps: 200, genTps: 10, marginS: 60 } });
    const log = (o: Record<string, unknown>) => d.spawned[0]!.child.stdout.write(`${JSON.stringify({ t: "log", kind: "gateway", session: agent.name, ...o })}\n`);
    log({ status: 200 });
    await settle();
    expect(group.deadlineHit()).toBe(false);
    log({ status: 504, reason: "deadline" });
    await settle();
    expect(group.deadlineHit()).toBe(true);
    await group.close();
    route.abandon();
  });

  it("refuses an upstream the run's router doesn't serve, and a session on Claude has no upstream", async () => {
    const d = new FakeDocker();
    const group = new SessionGroup({
      docker: d as unknown as DockerCli, runId: "R-0a1b2c", project: "demo", agentImageId: `sha256:${"a".repeat(64)}`, proxyImageId: `sha256:${"b".repeat(64)}`,
      proxyScript: "/opt/engine/dist/proxy.js", agentLimits: { "log-reader": LIMITS }, proxyLimits: LIMITS, maxPageBytes: 1 << 20,
      credential: { kind: "api_key", value: "x" }, log: new MemoryLogger(), platform: "linux", sleep: async () => undefined,
    });
    await group.open();
    await expect(group.startAgent(POLICY, null, { upstream: "lan" })).rejects.toThrow(/doesn't route to/);
    await group.startAgent(POLICY, null);
    expect(d.spawned[0]!.child.sent().find((m) => m.t === "grant" && m.role === "log-reader")).not.toHaveProperty("upstream");
    await group.close();
  });
});

// Rates seeded the way the AC-11 example has them: 2,000 prompt tokens in 10 s is 200 per second, 100 generated in 10 s is 10 per second.
const SEED_TIMING = { promptTokens: 2000, generatedTokens: 100, promptMs: 10_000, generatedMs: 10_000 };
const seededProbe: EndpointProbe = async () => ({ ok: true, toolChecked: true, timing: SEED_TIMING });

describe("request deadlines from measured rates (FR-12, AC-11)", () => {
  const big = { rung: RUNG, role: "log-reader", allowed: ["lan"], promptTokens: 100_000 };
  // A request body the gateway reads as 100,000 prompt tokens (400,000 bytes / 4) and max_tokens 4,000.
  const body = Buffer.from(JSON.stringify({ max_tokens: 4000, p: "x".repeat(400_000 - 40) }));

  it("AC-11: the probe seeds the rates the grant carries, so the gateway's deadline for that request is 60 + 500 + 400 = 960 s", async () => {
    const r = await rig({ endpoints: endpoints() }, { probe: seededProbe });
    const got = await r.svc.route(big);
    if (!("router" in got)) throw new Error("expected a route");
    expect(got.router.deadline).toEqual({ promptTps: 200, genTps: 10, marginS: 60 });
    expect(requestDeadlineMs(got.router.deadline!, body)).toBeCloseTo(960_000, -2);
    got.abandon();
  });

  it("uses the endpoint's own deadline.margin_s", async () => {
    const r = await rig({ endpoints: endpoints({ lan: { deadline: { margin_s: 100 } } }) }, { probe: seededProbe });
    const got = await r.svc.route(big);
    if (!("router" in got)) throw new Error("expected a route");
    expect(got.router.deadline).toEqual({ promptTps: 200, genTps: 10, marginS: 100 });
    got.abandon();
  });

  it("has no grant deadline while no rate is known", async () => {
    const r = await rig({ endpoints: endpoints() });
    const got = await r.svc.route(big);
    if (!("router" in got)) throw new Error("expected a route");
    expect(got.router.deadline).toBeUndefined();
    got.abandon();
  });

  it("records a finished session's usage and duration, reports them by band, and prefers them to the seed afterwards", async () => {
    const r = await rig({ endpoints: endpoints() }, { probe: seededProbe });
    expect(r.svc.bandReports()).toEqual([]);
    const got = await r.svc.route(big);
    if (!("router" in got)) throw new Error("expected a route");
    r.clock.t += 10_000;
    got.finish({ inputTokens: 1000, outputTokens: 100, requests: 2 });
    // 1,100 tokens in 10 s is 110 per second, for both rates (wall time split by tokens).
    const report = r.svc.bandReports();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ endpoint: "lan", model: "qwen3" });
    expect(report[0]!.bands[0]).toEqual({ band: "<8k", count: 1, medianPromptRate: 110, medianGenRate: 110 });
    expect(report[0]!.bands.slice(1).map((b) => b.count)).toEqual([0, 0, 0]);
    const next = await r.svc.route(big);
    if (!("router" in next)) throw new Error("expected a route");
    expect(next.router.deadline).toEqual({ promptTps: 110, genTps: 110, marginS: 60 });
    next.abandon();
  });

  it("a stopped session is recorded as a fallback with the given reason, frees its slot and adds no sample", async () => {
    const r = await rig({ endpoints: endpoints() }, { probe: seededProbe });
    const got = await r.svc.route(big);
    if (!("router" in got)) throw new Error("expected a route");
    r.clock.t += 960_000;
    expect(got.stopped("deadline")).toEqual({ endpoint: "lan", reason: "deadline", waited_s: 0, prompt_tokens: 100_000 });
    got.finish({ inputTokens: 5, outputTokens: 5, requests: 1 });
    expect(r.svc.bandReports()).toEqual([]);
    expect(r.log.text()).toContain("deadline");
    expect("router" in (await r.svc.route(big))).toBe(true);
  });

  it("records the gate's own wall cap as wall_cap", async () => {
    const r = await rig({ endpoints: endpoints() }, { probe: seededProbe });
    const got = await r.svc.route(big);
    if (!("router" in got)) throw new Error("expected a route");
    expect(got.stopped("wall_cap").reason).toBe("wall_cap");
    got.abandon();
  });

  it("estimates tokens as one per four characters, rounded up", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("a changed endpoint model (SR-11)", () => {
  const probeOf = (identity: ModelIdentity): EndpointProbe => async () => ({ ok: true, toolChecked: true, identity, timing: SEED_TIMING });
  const QWEN = { name: "qwen3", params: 8_190_735_360, sizeBytes: 5_027_783_680, quant: "Q4_K_M" };

  it("keeps the identity, and tells nobody the first time or when it is unchanged", async () => {
    const file = path.join(tmpdir(), "models.json");
    const changed: string[] = [];
    const first = await rig({ endpoints: endpoints() }, { probe: probeOf(QWEN), identityFile: file, onModelChanged: (n) => changed.push(n) });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ lan: { model: "qwen3", identity: QWEN } });
    const again = await rig({ endpoints: endpoints() }, { probe: probeOf({ ...QWEN }), identityFile: file, onModelChanged: (n) => changed.push(n) });
    expect(changed).toEqual([]);
    expect(first.svc.statuses()[0]).not.toHaveProperty("notice");
    expect(again.svc.statuses()[0]).not.toHaveProperty("notice");
    expect(again.log.text()).not.toContain("changed");
  });

  it.each([
    ["parameter count", { ...QWEN, params: 14_000_000_000 }],
    ["byte size", { ...QWEN, sizeBytes: 9_000_000_000 }],
    ["quant type", { ...QWEN, quant: "Q8_0" }],
    ["name", { ...QWEN, name: "qwen3-instruct" }],
  ])("a different %s counts as a new model: it is stored, logged, shown in the status and passed on so the match rate resets", async (_what, next) => {
    const file = path.join(tmpdir(), "models.json");
    await rig({ endpoints: endpoints() }, { probe: probeOf(QWEN), identityFile: file });
    const changed: string[] = [];
    const r = await rig({ endpoints: endpoints() }, { probe: probeOf(next), identityFile: file, onModelChanged: (n) => changed.push(n) });
    expect(changed).toEqual(["lan"]);
    const st = r.svc.statuses()[0]!;
    expect(st).toMatchObject({ name: "lan", available: true, notice: expect.stringContaining("model changed") });
    expect(r.log.text()).toContain("model changed");
    expect(JSON.stringify([st, r.log.lines])).not.toContain("llm.example");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).lan.identity).toEqual(next);
  });

  it("a probe that reports no identity changes nothing", async () => {
    const file = path.join(tmpdir(), "models.json");
    await rig({ endpoints: endpoints() }, { probe: probeOf(QWEN), identityFile: file });
    const r = await rig({ endpoints: endpoints() }, { probe: seededProbe, identityFile: file });
    expect(r.svc.statuses()[0]).not.toHaveProperty("notice");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).lan.identity).toEqual(QWEN);
  });
});

describe("the LiteLLM image at engine start (AC-16)", () => {
  it("a failing image check at start makes every endpoint rung unavailable with the reason, without probing", async () => {
    const r = await rig({ endpoints: endpoints({ other: {} }) });
    const probed: string[] = [];
    const svc = await EndpointService.start({
      ...r.opts, probe: async (e) => (probed.push(e.name), { ok: true, toolChecked: true }),
      image: async () => { throw new DockerError("the LiteLLM image doesn't carry the pinned digest"); },
    });
    expect(probed).toEqual([]);
    for (const st of svc.statuses()) expect(st).toMatchObject({ available: false, reason: expect.stringContaining("pinned digest") });
    expect(svc.unavailable(RUNG)).toContain("pinned digest");
  });

  it("checks the image once at start, not at first use, and not at all with no endpoint configured", async () => {
    let calls = 0;
    const image = async () => (calls++, IMAGE);
    const r = await rig({ endpoints: endpoints() });
    await EndpointService.start({ ...r.opts, image });
    expect(calls).toBe(1);
    await EndpointService.start({ ...r.opts, image, config: { endpoints: [] } });
    expect(calls).toBe(1);
  });
});
