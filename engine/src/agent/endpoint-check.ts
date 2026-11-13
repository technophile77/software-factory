import * as http from "node:http";
import * as https from "node:https";
import type { PinnedEndpoint } from "../config/endpoint-address";
import type { Endpoint } from "../config/endpoints";

/** What the start-time check (F-013 FR-6) found: usable, or why not in words fit for the owner. */
export type ProbeResult =
  | { ok: true; toolChecked: boolean }
  | { ok: false; reason: string };

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
  if (e.api === "openai") return { ok: true, toolChecked: false };
  const body = JSON.stringify({
    model: e.model, max_tokens: 64,
    tools: [{ name: TOOL_NAME, description: "Reports the status.", input_schema: { type: "object", properties: {}, required: [] } }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: "Call the tool." }],
  });
  let reply: Reply;
  try {
    reply = await request(pin, "POST", "/v1/messages", { ...headers, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body, TOOL_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, reason: `${failure(err)} (tool call)` };
  }
  if (reply.status < 200 || reply.status > 299) return { ok: false, reason: `it answered the tool-call test with status ${reply.status}` };
  if (!hasToolUse(reply.body)) return { ok: false, reason: "it didn't answer the tool-call test with a tool call" };
  return { ok: true, toolChecked: true };
};
