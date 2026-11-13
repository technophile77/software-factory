import { describe, expect, it } from "vitest";
import {
  EndpointSlots,
  PlanCounter,
  RateTracker,
  costFor,
  median,
  type Lease,
  type Plan,
  type PlanLimit,
} from "../src/agent/endpoint-usage";
import { FakeClock } from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Small deterministic PRNG so stochastic failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("EndpointSlots (AC-7)", () => {
  it("makes the second session wait until the first releases", async () => {
    const slots = new EndpointSlots({ qwen: 1 }, new FakeClock());
    const a = (await slots.acquire("qwen")) as Lease;
    let got: Lease | "timeout" | undefined;
    const p = slots.acquire("qwen").then((l) => (got = l));
    await flush();
    expect(got).toBeUndefined();
    a.release();
    await p;
    expect(got).not.toBe("timeout");
  });

  it("returns timeout after the wait limit and leaves the queue", async () => {
    const clock = new FakeClock();
    const slots = new EndpointSlots({ qwen: 1 }, clock);
    const a = (await slots.acquire("qwen")) as Lease;
    const p = slots.acquire("qwen", 10 * MIN);
    await clock.advance(10 * MIN);
    expect(await p).toBe("timeout");
    a.release();
    const b = await slots.acquire("qwen");
    expect(b).not.toBe("timeout");
  });

  it("release is idempotent", async () => {
    const slots = new EndpointSlots({ qwen: 1 }, new FakeClock());
    const a = (await slots.acquire("qwen")) as Lease;
    a.release();
    a.release();
    const b = (await slots.acquire("qwen")) as Lease;
    let third: unknown;
    void slots.acquire("qwen").then((l) => (third = l));
    await flush();
    expect(third).toBeUndefined();
    b.release();
  });

  it("rejects an endpoint without a cap", async () => {
    await expect(new EndpointSlots({}, new FakeClock()).acquire("x")).rejects.toThrow(/unknown endpoint/);
  });

  it("stochastic: never exceeds the cap and serves waiters FIFO", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const cap = 1 + Math.floor(rand() * 3);
      const slots = new EndpointSlots({ e: cap }, new FakeClock());
      const held: Lease[] = [];
      const grantOrder: number[] = [];
      let requested = 0;
      let inUse = 0;
      for (let step = 0; step < 60; step++) {
        if (rand() < 0.55) {
          const id = requested++;
          void slots.acquire("e").then((l) => {
            // The fake clock never advances here, so a timeout is impossible.
            const lease = l as Lease;
            grantOrder.push(id);
            inUse++;
            expect(inUse).toBeLessThanOrEqual(cap);
            held.push({
              release: () => {
                inUse--;
                lease.release();
              },
            });
          });
        } else if (held.length > 0) {
          const i = Math.floor(rand() * held.length);
          held.splice(i, 1)[0]!.release();
        }
        await flush();
        expect(inUse).toBeLessThanOrEqual(cap);
      }
      // Drain everything.
      while (held.length > 0) {
        held.pop()!.release();
        await flush();
      }
      expect(grantOrder).toEqual([...grantOrder].sort((a, b) => a - b));
      expect(grantOrder).toEqual(Array.from({ length: grantOrder.length }, (_, i) => i));
    }
  });
});

describe("RateTracker (AC-11)", () => {
  it("computes 60 + 500 + 400 = 960 s from 200 and 10 tokens/s", () => {
    const t = new RateTracker();
    t.record("e", "m", { promptTokens: 2000, generatedTokens: 100, promptMs: 10_000, generatedMs: 10_000 });
    expect(t.deadlineMs("e", "m", { promptTokens: 100_000, maxTokens: 4_000, marginS: 60 })).toBe(960_000);
  });

  it("returns null without samples or seed, and uses a seed otherwise", () => {
    const t = new RateTracker();
    const input = { promptTokens: 100_000, maxTokens: 4_000, marginS: 60 };
    expect(t.deadlineMs("e", "m", input)).toBeNull();
    t.seed("e", "m", { promptRate: 200, genRate: 10 });
    expect(t.deadlineMs("e", "m", input)).toBe(960_000);
  });

  it("splits wall time by tokens when the server reports no timings", () => {
    const t = new RateTracker();
    t.record("e", "m", { promptTokens: 900, generatedTokens: 100, wallMs: 10_000 });
    expect(t.rates("e", "m")).toEqual({ promptRate: 100, genRate: 100 });
  });

  it("keeps only the last 25 samples and takes the median", () => {
    const t = new RateTracker();
    for (let i = 0; i < 10; i++) t.record("e", "m", { promptTokens: 1000, generatedTokens: 0, promptMs: 1000 / 1 });
    // 10 old samples at 1000 t/s, then 25 at 50 t/s evict all of them.
    for (let i = 0; i < 25; i++) t.record("e", "m", { promptTokens: 50, generatedTokens: 0, promptMs: 1000 });
    expect(t.rates("e", "m").promptRate).toBe(50);
  });

  it("median averages the middle pair when even", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5, 1, 9])).toBe(5);
  });

  it("keeps endpoints and models separate", () => {
    const t = new RateTracker();
    t.record("e1", "m", { promptTokens: 100, generatedTokens: 0, promptMs: 1000 });
    expect(t.rates("e2", "m").promptRate).toBeNull();
    expect(t.rates("e1", "other").promptRate).toBeNull();
  });

  it("reports medians per prompt-size band", () => {
    const t = new RateTracker();
    t.record("e", "m", { promptTokens: 1_000, generatedTokens: 10, promptMs: 10_000, generatedMs: 1_000 }); // 100, 10
    t.record("e", "m", { promptTokens: 3_000, generatedTokens: 10, promptMs: 10_000, generatedMs: 500 }); // 300, 20
    t.record("e", "m", { promptTokens: 8_000, generatedTokens: 10, promptMs: 40_000, generatedMs: 1_000 }); // 200, 10
    t.record("e", "m", { promptTokens: 200_000, generatedTokens: 10, promptMs: 1_000_000, generatedMs: 2_000 }); // 200, 5
    expect(t.bandReport("e", "m")).toEqual([
      { band: "<8k", count: 2, medianPromptRate: 200, medianGenRate: 15 },
      { band: "8k-32k", count: 1, medianPromptRate: 200, medianGenRate: 10 },
      { band: "32k-128k", count: 0, medianPromptRate: null, medianGenRate: null },
      { band: ">128k", count: 1, medianPromptRate: 200, medianGenRate: 5 },
    ]);
  });
});

describe("costFor (AC-12)", () => {
  const prices = { input_per_mtok: 1, output_per_mtok: 2 };

  it("local costs nothing and charges no budget", () => {
    expect(costFor({ mode: "local" }, { inputTokens: 5e6, outputTokens: 5e6 })).toEqual({
      usd: 0,
      planShare: 0,
      chargesBudget: false,
    });
  });

  it("per_token: 1M in at $1 + 0.5M out at $2 is $2 and charges the budget", () => {
    expect(costFor({ mode: "per_token", prices }, { inputTokens: 1_000_000, outputTokens: 500_000 })).toEqual({
      usd: 2,
      planShare: 0,
      chargesBudget: true,
    });
  });

  it("subscription: no dollars, planShare is the largest used/limit (AC-14: 9 of 100 = 9%)", () => {
    const plan: Plan = {
      reserve_pct: 10,
      limits: [
        { kind: "requests", count: 100, window: "5h" },
        { kind: "input_tokens", count: 1_000_000, window: "week" },
      ],
    };
    const c = costFor({ mode: "subscription", plan }, { requests: 9, inputTokens: 50_000, outputTokens: 1 });
    expect(c.usd).toBe(0);
    expect(c.chargesBudget).toBe(false);
    expect(c.planShare).toBeCloseTo(0.09, 12);
    const tokenHeavy = costFor({ mode: "subscription", plan }, { requests: 1, inputTokens: 250_000, outputTokens: 0 });
    expect(tokenHeavy.planShare).toBe(0.25);
  });
});

describe("PlanCounter (AC-14)", () => {
  const plan: Plan = { reserve_pct: 10, limits: [{ kind: "requests", count: 100, window: "5h" }] };
  const req = { inputTokens: 10, outputTokens: 10 };

  it("refuses the next request after 90 of 100, but admits at 89", () => {
    const c = new PlanCounter(new FakeClock());
    for (let i = 0; i < 89; i++) c.record("sub", req);
    expect(c.wouldExceed("sub", plan)).toBe(false);
    c.record("sub", req);
    expect(c.wouldExceed("sub", plan)).toBe(true);
  });

  it("is keyed by endpoint only", () => {
    const c = new PlanCounter(new FakeClock());
    for (let i = 0; i < 90; i++) c.record("a", req);
    expect(c.wouldExceed("b", plan)).toBe(false);
  });

  it("the 5h window rolls: usage older than 5h stops counting", async () => {
    const clock = new FakeClock();
    const c = new PlanCounter(clock);
    for (let i = 0; i < 90; i++) c.record("sub", req);
    await clock.advance(5 * HOUR - 1);
    expect(c.wouldExceed("sub", plan)).toBe(true);
    await clock.advance(1);
    expect(c.wouldExceed("sub", plan)).toBe(false);
  });

  it("checks token limits using the next-request estimate", () => {
    const tokenPlan: Plan = { reserve_pct: 20, limits: [{ kind: "input_tokens", count: 1000, window: "day" }] };
    const c = new PlanCounter(new FakeClock());
    c.record("sub", { inputTokens: 700, outputTokens: 0 });
    expect(c.wouldExceed("sub", tokenPlan, { inputTokens: 100 })).toBe(false); // 800 == threshold
    expect(c.wouldExceed("sub", tokenPlan, { inputTokens: 101 })).toBe(true);
  });

  it("stochastic: admitted requests never push any window past the threshold; reload is identical", async () => {
    const windowMs = { "5h": 5 * HOUR, day: 24 * HOUR, week: 168 * HOUR, month: 720 * HOUR } as const;
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const clock = new FakeClock();
      const reserve = Math.floor(rand() * 30);
      const limits: PlanLimit[] = [
        { kind: "requests", count: 5 + Math.floor(rand() * 40), window: "5h" },
        { kind: "input_tokens", count: 5_000 + Math.floor(rand() * 50_000), window: "day" },
        { kind: "output_tokens", count: 5_000 + Math.floor(rand() * 90_000), window: "week" },
      ];
      const p: Plan = { reserve_pct: reserve, limits };
      let c = new PlanCounter(clock);
      const log: { at: number; inT: number; outT: number }[] = [];
      for (let step = 0; step < 150; step++) {
        await clock.advance(Math.floor(rand() * 40 * MIN));
        if (step % 25 === 24) c = PlanCounter.fromJSON(JSON.parse(JSON.stringify(c.toJSON())), clock);
        const inT = Math.floor(rand() * 2000);
        const outT = Math.floor(rand() * 3000);
        const reloaded = PlanCounter.fromJSON(JSON.parse(JSON.stringify(c.toJSON())), clock);
        const refused = c.wouldExceed("e", p, { inputTokens: inT, outputTokens: outT });
        expect(reloaded.wouldExceed("e", p, { inputTokens: inT, outputTokens: outT })).toBe(refused);
        if (refused) continue;
        c.record("e", { inputTokens: inT, outputTokens: outT });
        log.push({ at: clock.now(), inT, outT });
        // Independent recount from the raw log.
        for (const l of limits) {
          const from = clock.now() - windowMs[l.window];
          const total = log
            .filter((e) => e.at > from)
            .reduce((n, e) => n + (l.kind === "requests" ? 1 : l.kind === "input_tokens" ? e.inT : e.outT), 0);
          expect(total * 100).toBeLessThanOrEqual(l.count * (100 - reserve));
        }
      }
      expect(log.length).toBeGreaterThan(0);
    }
  });
});
