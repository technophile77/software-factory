import * as http from "node:http";
import * as https from "node:https";
import type { PinnedEndpoint } from "../config/endpoint-address";
import type { Endpoint } from "../config/endpoints";
import type { RateSample } from "./endpoint-usage";

/** What the start-time check (F-013 FR-6) found: usable, or why not in words fit for the owner. */
export type ProbeResult =
  | { ok: true; toolChecked: boolean; identity?: ModelIdentity; timing?: RateSample }
  | { ok: false; reason: string };

/**
 * What an endpoint's model list says about the model (SR-11): only the fields
 * it reports are present. Compared as a whole, so any change is a new model.
 */
export interface ModelIdentity {
  name?: string;
  /** Parameter count. */
  params?: number;
  /** Size in bytes. */
  sizeBytes?: number;
  /** Quantisation type. */
  quant?: string;
  ownedBy?: string;
}

/**
 * The check of one endpoint, injectable so tests need no network. `key` is the
 * API key value or null; it goes only to this endpoint (SR-13).
 */
export type EndpointProbe = (e: Endpoint, pin: PinnedEndpoint, key: string | null) => Promise<ProbeResult>;

const MODELS_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 60_000;
const MAX_REPLY = 1 << 20;
const TOOL_NAME = "get_status";

interface Reply {
  status: number;
  body: string;
}

/**
 * One request to the pinned address: no redirects are followed and nothing is
 * looked up (SR-3, SR-13). The Host header and TLS server name stay the URL's
 * host, so certificate and host-name checks still apply to a public endpoint.
 */
function request(pin: PinnedEndpoint, method: "GET" | "POST", path: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const mod = pin.scheme === "https" ? https : http;
    const req = mod.request({
      host: pin.address, port: pin.port, method, path: `${pin.basePath}${path}`,
      headers: { ...headers, Host: pin.port === (pin.scheme === "https" ? 443 : 80) ? pin.host : `${pin.host}:${pin.port}`, ...(body !== null ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) },
      ...(pin.scheme === "https" ? { servername: pin.host, minVersion: "TLSv1.2" as const, rejectUnauthorized: true } : {}),
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_REPLY) {
          req.destroy(new Error("reply too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

function authHeaders(e: Endpoint, key: string | null): Record<string, string> {
  if (key === null) return {};
  return e.api === "openai" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
}

function listsModel(body: string, model: string): boolean {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return false;
  }
  const data = doc && typeof doc === "object" ? (doc as { data?: unknown; models?: unknown }) : {};
  const entries = [...(Array.isArray(data.data) ? data.data : []), ...(Array.isArray(data.models) ? data.models : [])];
  return entries.some((x) => x && typeof x === "object" && ((x as { id?: unknown }).id === model || (x as { model?: unknown }).model === model || (x as { name?: unknown }).name === model));
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * The identity the model list gives for `model`, whatever of it is present:
 * `llama-server` reports `meta.n_params` and `meta.size`; other servers put the
 * parameter count, size and quantisation level under `details` or `meta`.
 *
 * @example
 * identityOf('{"data":[{"id":"qwen3","owned_by":"llamacpp","meta":{"n_params":8190735360,"size":5027783680}}]}', "qwen3");
 * // { name: "qwen3", params: 8190735360, sizeBytes: 5027783680, ownedBy: "llamacpp" }
 */
export function identityOf(body: string, model: string): ModelIdentity | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return undefined;
  }
  const d = rec(doc);
  const entries = [...(Array.isArray(d.data) ? d.data : []), ...(Array.isArray(d.models) ? d.models : [])].map(rec);
  const x = entries.find((m) => m.id === model || m.model === model || m.name === model);
  if (!x) return undefined;
  const meta = rec(x.meta);
  const details = rec(x.details);
  const id: ModelIdentity = {};
  const name = str(x.id) ?? str(x.model) ?? str(x.name);
  const params = num(meta.n_params) ?? num(details.parameter_count);
  const sizeBytes = num(meta.size) ?? num(x.size);
  const quant = str(meta.ftype) ?? str(meta.quantization) ?? str(details.quantization_level);
  const ownedBy = str(x.owned_by);
  if (name) id.name = name;
  if (params) id.params = params;
  if (sizeBytes) id.sizeBytes = sizeBytes;
  if (quant) id.quant = quant;
  if (ownedBy) id.ownedBy = ownedBy;
  return id;
}

/**
 * The timing of the tool-call reply for FR-12: the server's own `timings`
 * (`llama-server`) where it reports them, else the `usage` token counts with
 * the wall time. Undefined when the reply gives no token counts.
 *
 * @example
 * timingOf('{"timings":{"prompt_n":100,"prompt_ms":500,"predicted_n":20,"predicted_ms":2000}}', 3000);
 * // { promptTokens: 100, generatedTokens: 20, promptMs: 500, generatedMs: 2000 }
 */
export function timingOf(body: string, wallMs: number): RateSample | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return undefined;
  }
  const d = rec(doc);
  const t = rec(d.timings);
  if (num(t.prompt_n) !== undefined && num(t.predicted_n) !== undefined) {
    return { promptTokens: num(t.prompt_n)!, generatedTokens: num(t.predicted_n)!, ...(num(t.prompt_ms) !== undefined ? { promptMs: num(t.prompt_ms)! } : {}), ...(num(t.predicted_ms) !== undefined ? { generatedMs: num(t.predicted_ms)! } : {}), wallMs };
  }
  const u = rec(d.usage);
  const promptTokens = num(u.input_tokens);
  const generatedTokens = num(u.output_tokens);
  return promptTokens !== undefined && generatedTokens !== undefined ? { promptTokens, generatedTokens, wallMs } : undefined;
}

function hasToolUse(body: string): boolean {
  try {
    const doc = JSON.parse(body) as { content?: unknown };
    return Array.isArray(doc.content) && doc.content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_use");
  } catch {
    return false;
  }
}

const failure = (e: unknown): string => {
  const m = e instanceof Error ? e.message : "";
  // A network error's text can hold the address; only these plain forms are passed on.
  return /timed out/.test(m) ? "it didn't answer in time" : /reply too large/.test(m) ? "its reply was too large" : /certificate|self[- ]signed|altnames|TLS|SSL/i.test(m) ? "its certificate or TLS check failed" : "it couldn't be reached";
};

/**
 * The real FR-6 check, run on the host against the address pinned for this
 * check: `GET /v1/models` must list the configured model, and for an
 * Anthropic-format endpoint one tiny Messages request with one tool must come
 * back with a `tool_use` block. An OpenAI-format endpoint gets the model list
 * only; its tool call is checked through LiteLLM at first use. Reasons never
 * hold an address or a key (SR-2).
 *
 * @example
 * await httpProbe(endpoint, pin, null); // { ok: true, toolChecked: true }
 */
export const httpProbe: EndpointProbe = async (e, pin, key) => {
  const headers = authHeaders(e, key);
  let models: Reply;
  try {
    models = await request(pin, "GET", "/v1/models", headers, null, MODELS_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, reason: `${failure(err)} (GET /v1/models)` };
  }
  if (models.status < 200 || models.status > 299) return { ok: false, reason: `it answered the model list with status ${models.status}` };
  if (!listsModel(models.body, e.model)) return { ok: false, reason: "it doesn't list the configured model" };
  const identity = identityOf(models.body, e.model);
  if (e.api === "openai") return { ok: true, toolChecked: false, ...(identity ? { identity } : {}) };
  const body = JSON.stringify({
    model: e.model, max_tokens: 64,
    tools: [{ name: TOOL_NAME, description: "Reports the status.", input_schema: { type: "object", properties: {}, required: [] } }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: "Call the tool." }],
  });
  let reply: Reply;
  const began = Date.now();
  try {
    reply = await request(pin, "POST", "/v1/messages", { ...headers, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body, TOOL_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, reason: `${failure(err)} (tool call)` };
  }
  if (reply.status < 200 || reply.status > 299) return { ok: false, reason: `it answered the tool-call test with status ${reply.status}` };
  if (!hasToolUse(reply.body)) return { ok: false, reason: "it didn't answer the tool-call test with a tool call" };
  const timing = timingOf(reply.body, Date.now() - began);
  return { ok: true, toolChecked: true, ...(identity ? { identity } : {}), ...(timing ? { timing } : {}) };
};
