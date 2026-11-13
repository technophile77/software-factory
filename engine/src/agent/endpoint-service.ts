import * as fs from "node:fs";
import * as path from "node:path";
import { type EndpointLookup, EndpointAddressError, type PinnedEndpoint, resolveEndpoint } from "../config/endpoint-address";
import type { RungRef } from "../config/endpoint-roles";
import type { Endpoint } from "../config/endpoints";
import type { LitellmImage } from "../docker/litellm-image";
import type { ContainerLimits } from "../docker/plan";
import { type Clock } from "../clock";
import { ensureOwnerDir, writeFileAtomic } from "../fsutil";
import type { Logger } from "../log";
import { type CredentialStore, SecretError, endpointKeyName } from "../secrets";
import type { EndpointProbe } from "./endpoint-check";
import { type Billing, DEFAULT_SLOT_WAIT_MS, EndpointSlots, type Lease, PlanCounter, type PlanCounterState, costFor } from "./endpoint-usage";
import type { RouterConfig } from "./sandbox";

const MiB = 1024 * 1024;
/** The router is a Python service holding a model-format translator; this is the A-1 spike's size. A `limits.yaml` entry for it is an open decision. */
export const ROUTER_LIMITS: ContainerLimits = { cpus: 1, memoryBytes: 2048 * MiB, pids: 256, tmpBytes: 256 * MiB };

/** One endpoint as the engine status shows it: the name and a plain reason, never an address or a key (SR-2). */
export interface EndpointStatus {
  name: string;
  model: string;
  available: boolean;
  reason?: string;
}

/** Agent report v1.4 `fallback`: a role meant for an endpoint that ran on Claude, and why (FR-7). */
export interface FallbackRecord {
  endpoint: string;
  reason: string;
  waited_s: number;
  prompt_tokens: number;
}

/** What a finished endpoint session cost, by the endpoint's billing mode (FR-13). */
export interface EndpointCost {
  /** Dollars to put in the report; 0 unless `per_token`. */
  costUsd: number;
  /** 0 to 1; non-zero only for `subscription`. */
  planShare: number;
  /** True when `costUsd` counts against the project budget. */
  chargesBudget: boolean;
}

/** A granted use of an endpoint: the slot is held until `finish` or `abandon`. */
export interface EndpointRoute {
  endpoint: Endpoint;
  /** The model name the agent's SDK is given: the endpoint's name. The gateway sends the granted endpoint's model whatever this says. */
  sdkModel: string;
  /** The Agent report `model`, `<endpoint>/<model>` (FR-8). */
  reportModel: string;
  /** For `GroupConfig.router`: only this endpoint, pinned for this use. */
  router: RouterConfig;
  /** For the agent's grant (`startAgent`'s `upstream`). */
  upstream: string;
  waitedS: number;
  /** Frees the slot and counts the use against the plan (`subscription`); safe to call twice, and only the first counts. */
  finish(u: { inputTokens: number; outputTokens: number; requests: number }): EndpointCost;
  /** Frees the slot without counting any use (the session never ran). */
  abandon(): void;
}

/** What `route` needs to know about the use. */
export interface RouteRequest {
  rung: RungRef;
  role: string;
  /** The project's `settings.endpoints` (SR-8). */
  allowed: readonly string[];
  /** Size of the prompt, for the fallback record. */
  promptTokens: number;
}

export interface EndpointServiceOptions {
  /** The parsed endpoints file, or why it couldn't be used (then no endpoint is available, AC-2). */
  config: { endpoints: Endpoint[] } | { problem: string };
  credentials: CredentialStore;
  lookup: EndpointLookup;
  probe: EndpointProbe;
  clock: Clock;
  log: Logger;
  /** Where the subscription counters are kept across restarts: an engine-owned file. */
  planFile: string;
  /** An engine-owned folder for the routers' config files. */
  workDir: string;
  /** The pinned LiteLLM image; absent when the engine has no Docker (then no route can start). */
  image?: () => Promise<LitellmImage>;
  routerLimits?: ContainerLimits;
  /** Defaults to 10 minutes (FR-7). */
  slotWaitMs?: number;
}

export function billingOf(e: Endpoint): Billing {
  if (e.billing === "per_token") return { mode: "per_token", prices: e.prices };
  if (e.billing === "subscription") return { mode: "subscription", plan: e.plan };
  return { mode: "local" };
}

/** Replaces the host name an address error quotes, so a reason can go in a log or a report (SR-2). */
function withoutHost(message: string, endpoint: Endpoint): string {
  let host = "";
  try {
    host = new URL(endpoint.base_url).hostname;
  } catch {
    // The file was validated, so this does not happen; the message is then used as is.
  }
  return host ? message.split(host).join("<host>") : message;
}

/**
 * The engine's model endpoints (F-013): the start-time check of each (FR-6),
 * and the per-use decision that pins its address (FR-4), holds a slot (FR-7),
 * stops at the plan's limits (FR-13) and builds the router the session group
 * starts. It holds no key longer than one call, and nothing it returns or logs
 * holds an address (SR-2).
 *
 * @example
 * const svc = await EndpointService.start({ config, credentials, lookup, probe, clock, log, planFile, workDir, image });
 * svc.statuses(); // [{ name: "lan", model: "qwen3", available: true }]
 * const r = await svc.route({ rung: { endpoint: "lan", model: "qwen3" }, role: "log-reader", allowed: ["lan"], promptTokens: 4000 });
 * if ("router" in r) r.finish({ inputTokens: 1, outputTokens: 1, requests: 1 }); // after a session on r.router, granted r.upstream, with model r.sdkModel
 */
export class EndpointService {
  private readonly status = new Map<string, EndpointStatus>();
  private readonly endpoints: Endpoint[];
  private readonly slots: EndpointSlots;
  private plans: PlanCounter;
  private readonly problem: string | null;

  private constructor(private readonly o: EndpointServiceOptions) {
    this.problem = "problem" in o.config ? o.config.problem : null;
    this.endpoints = "endpoints" in o.config ? o.config.endpoints : [];
    this.slots = new EndpointSlots(Object.fromEntries(this.endpoints.map((e) => [e.name, e.max_sessions])), o.clock);
    this.plans = new PlanCounter(o.clock);
    this.loadPlans();
  }

  /** Checks every configured endpoint once (FR-6) and returns the service. Never throws for an endpoint's fault. */
  static async start(o: EndpointServiceOptions): Promise<EndpointService> {
    const s = new EndpointService(o);
    if (s.problem) o.log.warn(`No model endpoint is available: ${s.problem}`);
    for (const e of s.endpoints) {
      const reason = await s.check(e);
      s.status.set(e.name, { name: e.name, model: e.model, available: reason === null, ...(reason ? { reason } : {}) });
      if (reason) o.log.warn(`Model endpoint ${e.name} is unavailable: ${reason}.`);
      else o.log.info(`Model endpoint ${e.name} is available.`);
    }
    return s;
  }

  /** Every configured endpoint with whether this PC can use it. Empty when the file was refused; see `fileProblem()`. */
  statuses(): EndpointStatus[] {
    return this.endpoints.map((e) => ({ ...this.status.get(e.name)! }));
  }

  /** Why the endpoints file as a whole was refused, or null. */
  fileProblem(): string | null {
    return this.problem;
  }

  /** Null when `r` can be used on this PC, else a plain reason; the planner's `unavailable` callback. */
  unavailable(r: RungRef): string | null {
    if (this.problem) return `the endpoints file was refused: ${this.problem}`;
    const e = this.endpoints.find((x) => x.name === r.endpoint);
    if (!e) return "this PC has no endpoint of that name";
    if (e.model !== r.model) return "the endpoint serves a different model than the rung names";
    const st = this.status.get(e.name)!;
    return st.available ? null : `unavailable since the engine started: ${st.reason}`;
  }

  /**
   * Takes a slot on the endpoint for one session, or says why the role runs on
   * Claude instead (FR-7, FR-13; AC-7, AC-9, AC-14). The address is resolved
   * and pinned again here, because a name can move between sessions.
   */
  async route(req: RouteRequest): Promise<EndpointRoute | { fallback: FallbackRecord }> {
    const began = this.o.clock.now();
    const fallback = (reason: string): { fallback: FallbackRecord } => {
      const f = { endpoint: req.rung.endpoint, reason, waited_s: Math.round((this.o.clock.now() - began) / 1000), prompt_tokens: req.promptTokens };
      this.o.log.info(`${req.role} runs on Claude instead of endpoint ${f.endpoint}: ${reason}.`);
      return { fallback: f };
    };
    if (!req.allowed.includes(req.rung.endpoint)) return fallback("the project's manifest doesn't list this endpoint (settings.endpoints)");
    const why = this.unavailable(req.rung);
    if (why) return fallback(why);
    const e = this.endpoints.find((x) => x.name === req.rung.endpoint)!;
    if (!this.o.image) return fallback("the engine has no Docker to run the model router");
    let pin: PinnedEndpoint;
    let keys: Map<string, string>;
    try {
      pin = await resolveEndpoint({ name: e.name, baseUrl: e.base_url, hasKey: e.api_key_ref !== undefined, billing: e.billing, allowLoopback: e.allow_loopback }, this.o.lookup);
      keys = await this.keysOf(e);
    } catch (err) {
      return fallback(err instanceof EndpointAddressError ? withoutHost(err.message, e) : err instanceof SecretError ? "its API key couldn't be read from the credential store" : "its address couldn't be checked");
    }
    const lease = await this.slots.acquire(e.name, this.o.slotWaitMs ?? DEFAULT_SLOT_WAIT_MS);
    if (lease === "timeout") return fallback(`no session slot was free within ${Math.round((this.o.slotWaitMs ?? DEFAULT_SLOT_WAIT_MS) / 60_000)} minutes`);
    if (e.billing === "subscription" && this.plans.wouldExceed(e.name, e.plan)) {
      lease.release();
      return fallback("the plan limit was reached");
    }
    let image: LitellmImage;
    try {
      image = await this.o.image();
    } catch (err) {
      lease.release();
      return fallback(`the model router can't be used (${(err as Error).message.slice(0, 200)})`);
    }
    return this.granted(e, req, image, pin, keys, lease, Math.round((this.o.clock.now() - began) / 1000));
  }

  private granted(e: Endpoint, req: RouteRequest, image: LitellmImage, pin: PinnedEndpoint, keys: Map<string, string>, lease: Lease, waitedS: number): EndpointRoute {
    let done = false;
    return {
      endpoint: e, sdkModel: e.name, reportModel: `${e.name}/${e.model}`, upstream: e.name, waitedS,
      router: { image, limits: this.o.routerLimits ?? ROUTER_LIMITS, endpoints: [e], pins: [pin], keys, workDir: this.o.workDir },
      finish: (u) => {
        const cost = costFor(billingOf(e), { inputTokens: u.inputTokens, outputTokens: u.outputTokens, requests: u.requests });
        if (!done) {
          done = true;
          if (e.billing === "subscription") this.countUse(e.name, u);
          lease.release();
        }
        return { costUsd: cost.usd, planShare: cost.planShare, chargesBudget: cost.chargesBudget };
      },
      abandon: () => {
        if (done) return;
        done = true;
        lease.release();
      },
    };
  }

  /** One check of an endpoint at engine start: null when usable, else the plain reason (AC-3, AC-6). */
  private async check(e: Endpoint): Promise<string | null> {
    if (this.problem) return `the endpoints file was refused: ${this.problem}`;
    try {
      const pin = await resolveEndpoint({ name: e.name, baseUrl: e.base_url, hasKey: e.api_key_ref !== undefined, billing: e.billing, allowLoopback: e.allow_loopback }, this.o.lookup);
      const keys = await this.keysOf(e);
      const r = await this.o.probe(e, pin, e.api_key_ref !== undefined ? keys.get(e.api_key_ref)! : null);
      return r.ok ? null : r.reason;
    } catch (err) {
      if (err instanceof EndpointAddressError) return withoutHost(err.message, e);
      if (err instanceof SecretError) return "its API key couldn't be read from the credential store";
      return "it couldn't be checked";
    }
  }

  private async keysOf(e: Endpoint): Promise<Map<string, string>> {
    const keys = new Map<string, string>();
    if (e.api_key_ref === undefined) return keys;
    const key = await this.o.credentials.get(endpointKeyName(e.api_key_ref));
    if (key === null) throw new SecretError("no key");
    keys.set(e.api_key_ref, key);
    return keys;
  }

  private countUse(endpoint: string, u: { inputTokens: number; outputTokens: number; requests: number }): void {
    // One event per request, the tokens on the first: PlanCounter counts requests as events.
    for (let i = 0; i < Math.max(1, u.requests); i++) this.plans.record(endpoint, i === 0 ? u : { inputTokens: 0, outputTokens: 0 });
    try {
      ensureOwnerDir(path.dirname(this.o.planFile));
      writeFileAtomic(this.o.planFile, JSON.stringify(this.plans.toJSON()));
    } catch {
      this.o.log.warn("The subscription usage counters couldn't be saved; they restart from this run's use after a restart.");
    }
  }

  private loadPlans(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.o.planFile, "utf8");
    } catch {
      return;
    }
    try {
      const state = JSON.parse(raw) as PlanCounterState;
      this.plans = PlanCounter.fromJSON(state, this.o.clock);
    } catch {
      this.o.log.warn("The subscription usage counters were unreadable and start again from zero.");
    }
  }

  /** The subscription counters, for tests and for the run review. */
  planUsed(endpoint: string, kind: "requests" | "input_tokens" | "output_tokens", window: "5h" | "day" | "week" | "month"): number {
    return this.plans.used(endpoint, kind, window);
  }
}
