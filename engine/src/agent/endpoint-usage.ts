/**
 * Pure scheduling and billing logic for model endpoints (F-013): session
 * slots (FR-7), measured request deadlines (FR-12), cost and plan share
 * (FR-13) and subscription plan limits (SR-14). Nothing here touches the
 * network or disk; callers wire it into sessions and persist the PlanCounter.
 */
import { type Clock, systemClock } from "../clock";

/** Prices for a `per_token` endpoint, in USD per million tokens. */
export interface TokenPrices {
  input_per_mtok: number;
  output_per_mtok: number;
}

/** What a plan limit counts. */
export type PlanLimitKind = "requests" | "input_tokens" | "output_tokens";

/** Window names; see {@link WINDOW_MS} for exact durations. */
export type PlanWindow = "5h" | "day" | "week" | "month";

/** One plan limit, e.g. 100 requests per 5h. */
export interface PlanLimit {
  kind: PlanLimitKind;
  count: number;
  window: PlanWindow;
}

/** A subscription plan: its limits and the share (percent) kept unused. */
export interface Plan {
  limits: PlanLimit[];
  reserve_pct: number;
}

/** How an endpoint is billed. Mirrors the config type owned by another task. */
export type Billing =
  | { mode: "local" }
  | { mode: "per_token"; prices: TokenPrices }
  | { mode: "subscription"; plan: Plan };

/** Usage of one task (or one request): token counts and request count. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Requests made; only subscription request limits read it. Default 0. */
  requests?: number;
}

/** Result of {@link costFor}. */
export interface Cost {
  usd: number;
  /** Largest used/limit fraction (0.09 = 9% of plan); 0 unless subscription. */
  planShare: number;
  /** True when `usd` must be charged to the project budget. */
  chargesBudget: boolean;
}

/**
 * Cost of a task's usage on an endpoint, and whether it charges the budget.
 *
 * @example
 * // AC-12: 1M in at $1 plus 0.5M out at $2 is $2
 * costFor({ mode: "per_token", prices: { input_per_mtok: 1, output_per_mtok: 2 } },
 *   { inputTokens: 1_000_000, outputTokens: 500_000 }).usd; // 2
 * @see PlanCounter for the cross-project counters that enforce plan limits.
 */
export function costFor(billing: Billing, usage: Usage): Cost {
  switch (billing.mode) {
    case "local":
      return { usd: 0, planShare: 0, chargesBudget: false };
    case "per_token":
      return {
        usd:
          (usage.inputTokens / 1e6) * billing.prices.input_per_mtok +
          (usage.outputTokens / 1e6) * billing.prices.output_per_mtok,
        planShare: 0,
        chargesBudget: true,
      };
    case "subscription": {
      let planShare = 0;
      for (const l of billing.plan.limits) {
        planShare = Math.max(planShare, amountFor(l.kind, usage) / l.count);
      }
      return { usd: 0, planShare, chargesBudget: false };
    }
  }
}

function amountFor(kind: PlanLimitKind, u: Usage): number {
  if (kind === "requests") return u.requests ?? 0;
  return kind === "input_tokens" ? u.inputTokens : u.outputTokens;
}

// ---------------------------------------------------------------- slots

/** Default slot wait before a session falls back to Claude (FR-7). */
export const DEFAULT_SLOT_WAIT_MS = 10 * 60_000;

/** A held concurrency slot. */
export interface Lease {
  /** Frees the slot. Safe to call more than once; only the first counts. */
  release(): void;
}

interface Waiter {
  grant(): void;
}

/**
 * Per-endpoint concurrency caps (`max_sessions`) with FIFO waiting.
 *
 * @example
 * // AC-7: with max_sessions 1 the second session waits for the first
 * const slots = new EndpointSlots({ qwen: 1 });
 * const a = await slots.acquire("qwen") as Lease;
 * const second = slots.acquire("qwen"); // pending
 * a.release();                          // second now resolves to a Lease
 */
export class EndpointSlots {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();

  /**
   * @param caps max_sessions per endpoint name (integers >= 1). Acquiring an
   *   endpoint absent from `caps` throws, so a typo can't mean "unlimited".
   * @param clock injectable so tests control the wait limit.
   */
  constructor(
    private readonly caps: Readonly<Record<string, number>>,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Takes a slot, waiting FIFO behind earlier callers.
   *
   * @param waitLimitMs longest wait; on expiry the caller is dropped from the
   *   queue and gets "timeout" (the caller then falls back to Claude).
   * @throws Error when the endpoint has no configured cap.
   */
  async acquire(
    endpoint: string,
    waitLimitMs: number = DEFAULT_SLOT_WAIT_MS,
  ): Promise<Lease | "timeout"> {
    const cap = this.caps[endpoint];
    if (cap === undefined) throw new Error(`unknown endpoint "${endpoint}"`);
    const queue = this.queueOf(endpoint);
    if (queue.length === 0 && this.activeOf(endpoint) < cap) {
      return this.take(endpoint);
    }
    const timer = new AbortController();
    return new Promise<Lease | "timeout">((resolve) => {
      const waiter: Waiter = {
        grant: () => {
          timer.abort();
          resolve(this.take(endpoint));
        },
      };
      queue.push(waiter);
      void this.clock.sleep(waitLimitMs, timer.signal).then(() => {
        if (timer.signal.aborted) return;
        const i = queue.indexOf(waiter);
        if (i >= 0) {
          queue.splice(i, 1);
          resolve("timeout");
        }
      });
    });
  }

  private queueOf(endpoint: string): Waiter[] {
    let q = this.queues.get(endpoint);
    if (!q) this.queues.set(endpoint, (q = []));
    return q;
  }

  private activeOf(endpoint: string): number {
    return this.active.get(endpoint) ?? 0;
  }

  private take(endpoint: string): Lease {
    this.active.set(endpoint, this.activeOf(endpoint) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active.set(endpoint, this.activeOf(endpoint) - 1);
        this.pump(endpoint);
      },
    };
  }

  private pump(endpoint: string): void {
    const queue = this.queueOf(endpoint);
    while (queue.length > 0 && this.activeOf(endpoint) < this.caps[endpoint]!) {
      queue.shift()!.grant();
    }
  }
}

// ---------------------------------------------------------------- rates

/** Samples kept per endpoint+model for the rolling median. */
export const RATE_WINDOW = 25;

/** One request's timing. Prefer the server-reported fields. */
export interface RateSample {
  promptTokens: number;
  generatedTokens: number;
  /** Server-reported prompt processing time. */
  promptMs?: number;
  /** Server-reported generation time. */
  generatedMs?: number;
  /** Wall time of the whole request; used only when the server gave none. */
  wallMs?: number;
}

/** Tokens per second; either may be unknown. */
export interface Rates {
  promptRate: number | null;
  genRate: number | null;
}

interface StoredSample extends Rates {
  promptTokens: number;
}

/** Inputs to {@link RateTracker.deadlineMs}. */
export interface DeadlineInput {
  promptTokens: number;
  maxTokens: number;
  /** Fixed allowance in seconds for connection and queueing. */
  marginS: number;
}

/** Prompt-size bands for {@link RateTracker.bandReport}. */
export const PROMPT_BANDS = [
  { label: "<8k", min: 0, max: 8_000 },
  { label: "8k-32k", min: 8_000, max: 32_000 },
  { label: "32k-128k", min: 32_000, max: 128_000 },
  { label: ">128k", min: 128_000, max: Infinity },
] as const;

/** One row of {@link RateTracker.bandReport}. */
export interface BandRow {
  band: string;
  /** Samples in the band (of the retained window). */
  count: number;
  medianPromptRate: number | null;
  medianGenRate: number | null;
}

/** Median of a non-empty list; the mean of the middle pair when even. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function medianOrNull(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? median(v) : null;
}

/**
 * Rolling per-endpoint+model throughput, turned into request deadlines
 * (FR-12). Rates are measured because a long prompt on a local box can take
 * many minutes and a fixed timeout would either kill good requests or hang
 * on dead ones.
 */
export class RateTracker {
  private readonly samples = new Map<string, StoredSample[]>();
  private readonly seeds = new Map<string, Rates>();

  private static key(endpoint: string, model: string): string {
    return JSON.stringify([endpoint, model]);
  }

  /**
   * Sets fallback rates used for any metric with no samples yet.
   * @example tracker.seed("qwen", "q3", { promptRate: 200, genRate: 10 });
   */
  seed(endpoint: string, model: string, rates: Rates): void {
    this.seeds.set(RateTracker.key(endpoint, model), rates);
  }

  /**
   * Records a request's timing, keeping the last {@link RATE_WINDOW}.
   * Server-reported times win. Without them the wall time is split in
   * proportion to tokens, so both rates equal total tokens / wall time; a
   * crude estimate, but the only one available. Unusable timings (zero or
   * negative time, zero tokens) yield no rate for that metric.
   */
  record(endpoint: string, model: string, s: RateSample): void {
    const { promptRate, genRate } = ratesOf(s);
    if (promptRate === null && genRate === null) return;
    const k = RateTracker.key(endpoint, model);
    const list = this.samples.get(k) ?? [];
    list.push({ promptTokens: s.promptTokens, promptRate, genRate });
    if (list.length > RATE_WINDOW) list.splice(0, list.length - RATE_WINDOW);
    this.samples.set(k, list);
  }

  /**
   * Forgets the samples and the seed of an endpoint+model: its model was
   * swapped (SR-11), so what was measured says nothing about the new one.
   */
  reset(endpoint: string, model: string): void {
    const k = RateTracker.key(endpoint, model);
    this.samples.delete(k);
    this.seeds.delete(k);
  }

  /** Current median rates, falling back per metric to the seed, then null. */
  rates(endpoint: string, model: string): Rates {
    const k = RateTracker.key(endpoint, model);
    const list = this.samples.get(k) ?? [];
    const seed = this.seeds.get(k);
    return {
      promptRate: medianOrNull(list.map((x) => x.promptRate)) ?? seed?.promptRate ?? null,
      genRate: medianOrNull(list.map((x) => x.genRate)) ?? seed?.genRate ?? null,
    };
  }

  /**
   * Deadline in ms: (marginS + promptTokens/promptRate + maxTokens/genRate) * 1000.
   * Returns null when either rate is unknown, so the caller applies its
   * configured default.
   *
   * @example
   * // AC-11: 60 + 100000/200 + 4000/10 = 960 s
   * tracker.seed("e", "m", { promptRate: 200, genRate: 10 });
   * tracker.deadlineMs("e", "m", { promptTokens: 100_000, maxTokens: 4_000, marginS: 60 }); // 960000
   */
  deadlineMs(endpoint: string, model: string, input: DeadlineInput): number | null {
    const { promptRate, genRate } = this.rates(endpoint, model);
    if (promptRate === null || genRate === null) return null;
    return (input.marginS + input.promptTokens / promptRate + input.maxTokens / genRate) * 1000;
  }

  /** Retained samples grouped by prompt size, for the run review (FR-12). */
  bandReport(endpoint: string, model: string): BandRow[] {
    const list = this.samples.get(RateTracker.key(endpoint, model)) ?? [];
    return PROMPT_BANDS.map((b) => {
      const inBand = list.filter((x) => x.promptTokens >= b.min && x.promptTokens < b.max);
      return {
        band: b.label,
        count: inBand.length,
        medianPromptRate: medianOrNull(inBand.map((x) => x.promptRate)),
        medianGenRate: medianOrNull(inBand.map((x) => x.genRate)),
      };
    });
  }
}

/**
 * The rates one timing amounts to: server-reported times win; without them the
 * wall time is split in proportion to tokens, so both rates equal total tokens /
 * wall time. A crude estimate, but the only one available.
 *
 * @example
 * ratesOf({ promptTokens: 1000, generatedTokens: 50, promptMs: 5000, generatedMs: 5000 }); // { promptRate: 200, genRate: 10 }
 */
export function ratesOf(s: RateSample): Rates {
  if (s.promptMs !== undefined || s.generatedMs !== undefined) {
    return { promptRate: rate(s.promptTokens, s.promptMs), genRate: rate(s.generatedTokens, s.generatedMs) };
  }
  const total = rate(s.promptTokens + s.generatedTokens, s.wallMs);
  return { promptRate: s.promptTokens > 0 ? total : null, genRate: s.generatedTokens > 0 ? total : null };
}

function rate(tokens: number, ms: number | undefined): number | null {
  if (ms === undefined || ms <= 0 || tokens <= 0) return null;
  return tokens / (ms / 1000);
}

// ---------------------------------------------------------------- plans

/**
 * Window durations in ms. All are rolling (the last N hours/days), not
 * calendar-aligned: providers' reset boundaries differ and aren't visible to
 * us, and a rolling window never admits more than the limit in any span of
 * that length, so it is the safe over-approximation.
 */
export const WINDOW_MS: Readonly<Record<PlanWindow, number>> = {
  "5h": 5 * 3_600_000,
  day: 24 * 3_600_000,
  week: 7 * 24 * 3_600_000,
  month: 30 * 24 * 3_600_000,
};

const LONGEST_WINDOW_MS = WINDOW_MS.month;

/** One counted request. */
export interface PlanEvent {
  at: number;
  inputTokens: number;
  outputTokens: number;
}

/** JSON form of a {@link PlanCounter}. */
export type PlanCounterState = Record<string, PlanEvent[]>;

/**
 * Subscription usage across all projects, keyed by endpoint only, so one
 * plan's limits hold no matter which project spends it (SR-14).
 *
 * @example
 * // AC-14: limit 100 requests/5h, reserve 10
 * const plan = { limits: [{ kind: "requests", count: 100, window: "5h" }], reserve_pct: 10 };
 * const c = new PlanCounter();
 * for (let i = 0; i < 90; i++) c.record("claude-sub", { inputTokens: 1, outputTokens: 1 });
 * c.wouldExceed("claude-sub", plan); // true
 */
export class PlanCounter {
  private readonly events = new Map<string, PlanEvent[]>();

  /** @param clock injectable so tests control the rolling windows. */
  constructor(private readonly clock: Clock = systemClock) {}

  /** Counts one finished request against the endpoint. */
  record(endpoint: string, usage: { inputTokens: number; outputTokens: number }): void {
    const now = this.clock.now();
    const list = this.prune(endpoint, now);
    list.push({ at: now, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  }

  /** Used amount of `kind` in the window ending now. */
  used(endpoint: string, kind: PlanLimitKind, window: PlanWindow): number {
    const now = this.clock.now();
    let total = 0;
    for (const e of this.prune(endpoint, now)) {
      if (e.at <= now - WINDOW_MS[window]) continue;
      total += kind === "requests" ? 1 : kind === "input_tokens" ? e.inputTokens : e.outputTokens;
    }
    return total;
  }

  /**
   * True when admitting `next` would take any limit past (100 - reserve_pct)%
   * of its count. Exactly the threshold is still admitted. The default
   * `next` is one request with unknown token sizes.
   */
  wouldExceed(
    endpoint: string,
    plan: Plan,
    next: { inputTokens?: number; outputTokens?: number } = {},
  ): boolean {
    return plan.limits.some((l) => {
      const add =
        l.kind === "requests" ? 1 : l.kind === "input_tokens" ? (next.inputTokens ?? 0) : (next.outputTokens ?? 0);
      // Integer-friendly form of used+add > count*(100-reserve)/100.
      return (this.used(endpoint, l.kind, l.window) + add) * 100 > l.count * (100 - plan.reserve_pct);
    });
  }

  /** Serialisable snapshot for persistence. */
  toJSON(): PlanCounterState {
    const out: PlanCounterState = {};
    for (const [k, v] of this.events) out[k] = v.map((e) => ({ ...e }));
    return out;
  }

  /** Rebuilds a counter from {@link toJSON} output (or its parsed JSON text). */
  static fromJSON(state: PlanCounterState, clock: Clock = systemClock): PlanCounter {
    const c = new PlanCounter(clock);
    for (const [k, v] of Object.entries(state)) c.events.set(k, v.map((e) => ({ ...e })));
    return c;
  }

  private prune(endpoint: string, now: number): PlanEvent[] {
    const kept = (this.events.get(endpoint) ?? []).filter((e) => e.at > now - LONGEST_WINDOW_MS);
    this.events.set(endpoint, kept);
    return kept;
  }
}
