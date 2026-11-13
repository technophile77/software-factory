import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { httpProbe, identityOf, timingOf } from "../src/agent/endpoint-check";
import type { PinnedEndpoint } from "../src/config/endpoint-address";
import { type Endpoint, validateEndpoints } from "../src/config/endpoints";

// The check of F-013 FR-6 against a stand-in server on the loopback address, reached the way the engine reaches an endpoint: by pinned address.
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function serve(answer: (req: Seen) => { status?: number; body: unknown }): Promise<{ pin: PinnedEndpoint; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(s);
      const a = answer(s);
      res.writeHead(a.status ?? 200, { "content-type": "application/json" });
      res.end(typeof a.body === "string" ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { seen, pin: { name: "lan", class: "private", scheme: "http", host: "llm.example", address: "127.0.0.1", port, basePath: "" } };
}

const endpoint = (over: Record<string, unknown> = {}): Endpoint =>
  validateEndpoints({ endpoints: { lan: { base_url: "http://llm.example:8080", model: "qwen3", api: "anthropic", billing: "local", ...over } } }).endpoints[0]!;

const MODELS = { data: [{ id: "qwen3" }] };
const TOOL_USE = { content: [{ type: "tool_use", id: "t1", name: "get_status", input: {} }], stop_reason: "tool_use" };

describe("httpProbe (F-013 FR-6)", () => {
  it("AC-6: passes an Anthropic-format endpoint that lists the model and answers the tool request with a tool_use, sending the key as x-api-key", async () => {
    const { pin, seen } = await serve((r) => ({ body: r.url === "/v1/models" ? MODELS : TOOL_USE }));
    expect(await httpProbe(endpoint({ api_key_ref: "lan-key" }), pin, "the-key")).toMatchObject({ ok: true, toolChecked: true });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /v1/models", "POST /v1/messages"]);
    expect(seen.every((s) => s.headers["x-api-key"] === "the-key" && s.headers.authorization === undefined)).toBe(true);
    expect(seen[0]!.headers.host).toBe(`llm.example:${pin.port}`);
    const sent = JSON.parse(seen[1]!.body) as { model: string; tools: unknown[]; max_tokens: number };
    expect(sent).toMatchObject({ model: "qwen3", max_tokens: 64 });
    expect(sent.tools).toHaveLength(1);
  });

  it("accepts llama-server's model list shape, and sends no key header when there is none", async () => {
    const { pin, seen } = await serve((r) => ({ body: r.url === "/v1/models" ? { models: [{ name: "qwen3", model: "qwen3" }] } : TOOL_USE }));
    expect(await httpProbe(endpoint(), pin, null)).toMatchObject({ ok: true, toolChecked: true });
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("AC-6: refuses an endpoint that doesn't list the configured model, without asking for a tool call", async () => {
    const { pin, seen } = await serve(() => ({ body: { data: [{ id: "other" }] } }));
    expect(await httpProbe(endpoint(), pin, null)).toEqual({ ok: false, reason: "it doesn't list the configured model" });
    expect(seen).toHaveLength(1);
  });

  it("refuses an endpoint whose answer to the tool request has no tool_use, or whose status is an error", async () => {
    const text = await serve((r) => ({ body: r.url === "/v1/models" ? MODELS : { content: [{ type: "text", text: "hello" }] } }));
    expect(await httpProbe(endpoint(), text.pin, null)).toEqual({ ok: false, reason: "it didn't answer the tool-call test with a tool call" });
    const down = await serve(() => ({ status: 503, body: "busy" }));
    expect(await httpProbe(endpoint(), down.pin, null)).toEqual({ ok: false, reason: "it answered the model list with status 503" });
    const bad = await serve((r) => (r.url === "/v1/models" ? { body: MODELS } : { status: 400, body: "no tools" }));
    expect(await httpProbe(endpoint(), bad.pin, null)).toEqual({ ok: false, reason: "it answered the tool-call test with status 400" });
  });

  it("checks an OpenAI-format endpoint's model list only, sending the key as a bearer token", async () => {
    const { pin, seen } = await serve(() => ({ body: MODELS }));
    expect(await httpProbe(endpoint({ api: "openai", api_key_ref: "lan-key" }), pin, "the-key")).toMatchObject({ ok: true, toolChecked: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe("Bearer the-key");
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("says it couldn't be reached, without the address, when nothing listens", async () => {
    const { pin } = await serve(() => ({ body: MODELS }));
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    servers = [];
    const out = await httpProbe(endpoint(), pin, null);
    expect(out).toEqual({ ok: false, reason: "it couldn't be reached (GET /v1/models)" });
    expect(JSON.stringify(out)).not.toContain("127.0.0.1");
  });

  it("follows no redirect: a 302 is a failure, and the key goes nowhere else (SR-13)", async () => {
    const other = await serve(() => ({ body: MODELS }));
    const { pin } = await serve(() => ({ status: 302, body: "" }));
    expect((await httpProbe(endpoint(), pin, "k")).ok).toBe(false);
    expect(other.seen).toHaveLength(0);
  });
});

describe("what the check learns for SR-11 and FR-12", () => {
  const LLAMA_MODELS = { data: [{ id: "qwen3", owned_by: "llamacpp", meta: { n_params: 8_190_735_360, size: 5_027_783_680 } }] };

  it("identityOf keeps whatever the model list reports for the configured model, and nothing else", () => {
    expect(identityOf(JSON.stringify(LLAMA_MODELS), "qwen3")).toEqual({ name: "qwen3", params: 8_190_735_360, sizeBytes: 5_027_783_680, ownedBy: "llamacpp" });
    expect(identityOf(JSON.stringify({ models: [{ name: "qwen3", size: 42, details: { quantization_level: "Q4_K_M", parameter_count: 7 } }] }), "qwen3")).toEqual({ name: "qwen3", params: 7, sizeBytes: 42, quant: "Q4_K_M" });
    expect(identityOf(JSON.stringify({ data: [{ id: "qwen3" }] }), "qwen3")).toEqual({ name: "qwen3" });
    expect(identityOf(JSON.stringify(LLAMA_MODELS), "other")).toBeUndefined();
    expect(identityOf("not json", "qwen3")).toBeUndefined();
  });

  it("timingOf prefers the server's timings, else the usage token counts with the wall time", () => {
    expect(timingOf(JSON.stringify({ timings: { prompt_n: 100, prompt_ms: 500, predicted_n: 20, predicted_ms: 2000 } }), 3000)).toEqual({ promptTokens: 100, generatedTokens: 20, promptMs: 500, generatedMs: 2000, wallMs: 3000 });
    expect(timingOf(JSON.stringify({ usage: { input_tokens: 30, output_tokens: 10 } }), 4000)).toEqual({ promptTokens: 30, generatedTokens: 10, wallMs: 4000 });
    expect(timingOf(JSON.stringify({ content: [] }), 4000)).toBeUndefined();
    expect(timingOf("nope", 4000)).toBeUndefined();
  });

  it("httpProbe returns the identity and the measured timing of the endpoint it checked", async () => {
    const { pin } = await serve((req) => (req.method === "GET"
      ? { body: LLAMA_MODELS }
      : { body: { content: [{ type: "tool_use", name: "get_status", input: {} }], usage: { input_tokens: 40, output_tokens: 12 }, timings: { prompt_n: 40, prompt_ms: 200, predicted_n: 12, predicted_ms: 1200 } } }));
    const r = await httpProbe(endpoint(), pin, null);
    expect(r).toMatchObject({ ok: true, toolChecked: true, identity: { name: "qwen3", params: 8_190_735_360 }, timing: { promptTokens: 40, generatedTokens: 12, promptMs: 200, generatedMs: 1200 } });
  });
});
