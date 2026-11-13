import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { EndpointService, type EndpointServiceOptions } from "../src/agent/endpoint-service";
import type { EndpointProbe } from "../src/agent/endpoint-check";
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

async function rig(config: EndpointServiceOptions["config"], o: { probe?: EndpointProbe; lookup?: EndpointServiceOptions["lookup"]; planFile?: string; clock?: FakeClock; keys?: Record<string, string> } = {}): Promise<Rig> {
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
    let fail = true;
    const svc = await EndpointService.start({ ...r.opts, image: async () => { if (fail) throw new DockerError("the LiteLLM image's cosign signature hasn't been verified"); return IMAGE; } });
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
