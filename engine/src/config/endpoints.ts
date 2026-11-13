import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { ENDPOINTS_FILE } from "../constants";
import { euid } from "../fsutil";
import type { OsApi } from "../os/ffi";
import { isOwnerWritableOnly } from "../os/sddl";
import { ENDPOINT_NAME_RE, MODEL_RE } from "./models";
import { ConfigError } from "./paths-file";

const MAX_FILE = 64 * 1024;
const KEY_REF_RE = /^[a-z0-9-]{1,32}$/;

export type EndpointApi = "anthropic" | "openai";
export type PlanKind = "requests" | "input_tokens" | "output_tokens";
export type PlanWindow = "5h" | "day" | "week" | "month";
export const PLAN_KINDS: readonly PlanKind[] = ["requests", "input_tokens", "output_tokens"];
export const PLAN_WINDOWS: readonly PlanWindow[] = ["5h", "day", "week", "month"];

/** One plan limit: at most `count` of `kind` per `window`. */
export interface PlanLimit {
  kind: PlanKind;
  count: number;
  window: PlanWindow;
}

/** How an endpoint's usage is counted (FR-13); the fields exist only for the mode that uses them. */
export type EndpointBilling =
  | { billing: "local" }
  | { billing: "per_token"; prices: { input_per_mtok: number; output_per_mtok: number } }
  | { billing: "subscription"; plan: { limits: PlanLimit[]; reserve_pct: number } };

/** A validated endpoint with every default applied. Holds an address, so never log it (SR-2). */
export type Endpoint = EndpointBilling & {
  name: string;
  base_url: string;
  model: string;
  api: EndpointApi;
  /** The credential store reference (see `endpointKeyName`); the key itself is never in this file. */
  api_key_ref?: string;
  max_sessions: number;
  deadline: { margin_s: number };
  allow_loopback: boolean;
};

/** The parsed endpoints file; empty when the file doesn't exist. */
export interface EndpointsConfig {
  endpoints: Endpoint[];
}

/** The endpoints file is unusable; the message never repeats a value from it, since a key could have been pasted there. */
export class EndpointsError extends ConfigError {
  override name = "EndpointsError";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Refuses any key outside `allowed`, naming where but not the key (it may be a pasted secret). */
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  if (Object.keys(o).some((k) => !allowed.includes(k))) throw new EndpointsError(`${ENDPOINTS_FILE}: ${where} has a key that isn't allowed there.`);
}

function checkBaseUrl(v: unknown, where: string): string {
  const fail = () => new EndpointsError(`${ENDPOINTS_FILE}: ${where}.base_url must be an absolute http or https URL without credentials, query or fragment.`);
  if (typeof v !== "string" || v.length > 2048 || /[\s?#]/.test(v)) throw fail();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw fail();
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) throw fail();
  return v;
}

function checkBilling(e: Record<string, unknown>, where: string): EndpointBilling {
  const fail = (m: string) => new EndpointsError(`${ENDPOINTS_FILE}: ${where} ${m}`);
  const mode = e.billing;
  if (mode !== "local" && mode !== "per_token" && mode !== "subscription") throw fail("needs billing: local, per_token or subscription.");
  if (mode !== "per_token" && e.prices !== undefined) throw fail("may give prices only with billing: per_token.");
  if (mode !== "subscription" && e.plan !== undefined) throw fail("may give a plan only with billing: subscription.");
  if (mode === "local") return { billing: "local" };
  if (mode === "per_token") {
    const p = e.prices;
    if (!isObj(p)) throw fail("needs prices for billing: per_token.");
    onlyKeys(p, ["input_per_mtok", "output_per_mtok"], `${where}.prices`);
    if (!isPrice(p.input_per_mtok) || !isPrice(p.output_per_mtok)) throw fail("prices need input_per_mtok and output_per_mtok as numbers of at least 0.");
    return { billing: "per_token", prices: { input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok } };
  }
  const plan = e.plan;
  if (!isObj(plan)) throw fail("needs a plan for billing: subscription.");
  onlyKeys(plan, ["limits", "reserve_pct"], `${where}.plan`);
  if (!Array.isArray(plan.limits) || plan.limits.length === 0) throw fail("plan needs at least one limit.");
  const limits = plan.limits.map((l: unknown, i: number): PlanLimit => {
    if (!isObj(l)) throw fail(`plan.limits[${i}] must be a mapping.`);
    onlyKeys(l, ["kind", "count", "window"], `${where}.plan.limits[${i}]`);
    if (!PLAN_KINDS.includes(l.kind as PlanKind)) throw fail(`plan.limits[${i}].kind must be requests, input_tokens or output_tokens.`);
    if (!isInt(l.count, 1, Number.MAX_SAFE_INTEGER)) throw fail(`plan.limits[${i}].count must be a positive integer.`);
    if (!PLAN_WINDOWS.includes(l.window as PlanWindow)) throw fail(`plan.limits[${i}].window must be 5h, day, week or month.`);
    return { kind: l.kind as PlanKind, count: l.count, window: l.window as PlanWindow };
  });
  const reserve = plan.reserve_pct ?? 10;
  if (!isInt(reserve, 0, 90)) throw fail("plan.reserve_pct must be an integer from 0 to 90.");
  return { billing: "subscription", plan: { limits, reserve_pct: reserve } };
}

function checkEndpoint(name: string, e: unknown): Endpoint {
  const where = `endpoint '${name}'`;
  const fail = (m: string) => new EndpointsError(`${ENDPOINTS_FILE}: ${where} ${m}`);
  if (!isObj(e)) throw fail("must be a mapping.");
  onlyKeys(e, ["base_url", "model", "api", "api_key_ref", "max_sessions", "billing", "prices", "plan", "deadline", "allow_loopback"], where);
  const base_url = checkBaseUrl(e.base_url, where);
  if (typeof e.model !== "string" || !MODEL_RE.test(e.model)) throw fail("needs a model id.");
  if (e.api !== "anthropic" && e.api !== "openai") throw fail("needs api: anthropic or openai.");
  if (e.api_key_ref !== undefined && (typeof e.api_key_ref !== "string" || !KEY_REF_RE.test(e.api_key_ref))) {
    throw fail("api_key_ref must be lower-case letters, digits and '-', up to 32 characters.");
  }
  const max_sessions = e.max_sessions ?? 1;
  if (!isInt(max_sessions, 1, 16)) throw fail("max_sessions must be an integer from 1 to 16.");
  let margin_s = 60;
  if (e.deadline !== undefined) {
    if (!isObj(e.deadline)) throw fail("deadline must be a mapping.");
    onlyKeys(e.deadline, ["margin_s"], `${where}.deadline`);
    if (e.deadline.margin_s !== undefined) {
      if (!isInt(e.deadline.margin_s, 10, 3600)) throw fail("deadline.margin_s must be an integer from 10 to 3600.");
      margin_s = e.deadline.margin_s;
    }
  }
  if (e.allow_loopback !== undefined && typeof e.allow_loopback !== "boolean") throw fail("allow_loopback must be true or false.");
  const billing = checkBilling(e, where);
  return {
    name,
    base_url,
    model: e.model,
    api: e.api,
    ...(e.api_key_ref !== undefined ? { api_key_ref: e.api_key_ref as string } : {}),
    max_sessions,
    deadline: { margin_s },
    allow_loopback: e.allow_loopback === true,
    ...billing,
  };
}

/**
 * Validates a parsed endpoints document (F-013 FR-2, H-0135): unknown keys,
 * bad names and every out-of-range value are refused, and defaults are filled
 * in. Split from the file reading so it can be tested without an owner-only file.
 *
 * @param doc the YAML document, `{ endpoints: { <name>: { ... } } }`.
 * @example
 * validateEndpoints({ endpoints: { lan: { base_url: "http://llm.example:8080", model: "qwen3", api: "anthropic", billing: "local" } } })
 *   .endpoints[0].max_sessions; // 1
 * @throws EndpointsError on the first problem found.
 */
export function validateEndpoints(doc: unknown): EndpointsConfig {
  if (!isObj(doc)) throw new EndpointsError(`${ENDPOINTS_FILE} must be a mapping with 'endpoints'.`);
  onlyKeys(doc, ["endpoints"], "the file");
  if (doc.endpoints === undefined || doc.endpoints === null) return { endpoints: [] };
  if (!isObj(doc.endpoints)) throw new EndpointsError(`${ENDPOINTS_FILE}: 'endpoints' must map each name to its settings.`);
  const endpoints = Object.entries(doc.endpoints).map(([name, e]) => {
    if (!ENDPOINT_NAME_RE.test(name) || name === "anthropic") {
      throw new EndpointsError(`${ENDPOINTS_FILE}: an endpoint name must be lower-case letters, digits and '-', up to 32 characters, and not 'anthropic'.`);
    }
    return checkEndpoint(name, e);
  });
  return { endpoints };
}

/**
 * Reads the git-ignored list of model endpoints from the master clone (F-013
 * FR-2). It holds addresses and the names of credential entries, so it is
 * refused unless only the owner can have written it (SR-13 as for the paths
 * file). A missing file means no endpoints, not an error.
 *
 * @param masterRepo the master repo clone the file sits in.
 * @example
 * readEndpointsFile("/home/me/software-factory", os).endpoints.map((e) => e.name); // ["lan"]
 * @throws EndpointsError when the file is a link, too big, not owner-only, not YAML or invalid.
 * @see readPathsFile
 */
export function readEndpointsFile(masterRepo: string, os: OsApi): EndpointsConfig {
  const file = path.join(masterRepo, ENDPOINTS_FILE);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { endpoints: [] };
    throw new EndpointsError(`${ENDPOINTS_FILE} couldn't be examined.`);
  }
  if (st.isSymbolicLink()) throw new EndpointsError(`${ENDPOINTS_FILE} is a symbolic link.`);
  if (!st.isFile() || st.size > MAX_FILE) throw new EndpointsError(`${ENDPOINTS_FILE} is not a small regular file.`);
  if (os.platform === "win32") {
    let ok = false;
    try {
      const w = os.windows();
      ok = isOwnerWritableOnly(w.fileSddl(file), w.currentUserSid());
    } catch {
      ok = false;
    }
    if (!ok) throw new EndpointsError(`${ENDPOINTS_FILE} must be owned by you and writable by nobody else.`);
  } else {
    if (st.uid !== euid()) throw new EndpointsError(`${ENDPOINTS_FILE} is not owned by you.`);
    if (st.mode & 0o022) throw new EndpointsError(`${ENDPOINTS_FILE} is group- or world-writable; run chmod go-w on it.`);
  }
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"), { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    throw new EndpointsError(`${ENDPOINTS_FILE} is not valid YAML.`);
  }
  return validateEndpoints(doc);
}
