// F-013 FR-15 / AC-15 / AC-17, the part that runs without Docker: a recorded
// stub stands in for the router and answers one tool-call conversation in
// each endpoint format (fixtures/conformance). The gateway must hand Claude
// Code the same tool_use name, arguments and stop reason for both, streamed
// and unstreamed. It does not test LiteLLM's own translation.
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EgressProxy, PinnedEndpoint, ProxyDeps } from "../src/proxy/server";

const FIXTURES = path.join(__dirname, "fixtures", "conformance");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const AGENT = "a".repeat(43);
const DUMMY = "dummy-key";
const ROUTER = { address: "172.40.0.9", port: 4000, masterKey: "master-key-for-this-run" };
const pin = (name: string): PinnedEndpoint => ({ name, class: "public", scheme: "https", host: `${name}.cloud.test`, address: "93.184.216.40", port: 443, basePath: "" });
const CONVERSATION = {
  model: "claude-sonnet-4-5", max_tokens: 100,
  tools: [{ name: "get_status", description: "Reports the status.", input_schema: { type: "object", properties: { service: { type: "string" }, verbose: { type: "boolean" } } } }],
  messages: [{ role: "user", content: "Call the tool." }],
};

let closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers) c();
  closers = [];
});

const listen = (s: net.Server): Promise<number> => new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));

/** The gateway with a stub router: it answers from the fixture of the `model` it is asked for, as SSE if `stream` is set. */
async function rig(): Promise<{ port: number; stubSaw: Array<Record<string, unknown>> }> {
  const stubSaw: Array<Record<string, unknown>> = [];
  const stub = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b) as { model: string; stream?: boolean };
      stubSaw.push(body as Record<string, unknown>);
      if (body.stream) res.writeHead(200, { "content-type": "text/event-stream" }).end(fixture(`${body.model}.sse`));
      else res.writeHead(200, { "content-type": "application/json" }).end(fixture(`${body.model}.json`));
    });
  });
  const stubPort = await listen(stub);
  const deps = {
    lookup: async () => [],
    connect: () => net.connect(1, "127.0.0.1"),
    request: () => http.request({ host: "127.0.0.1", port: 1 }),
    httpRequest: (_a: string, _p: number, r: { method: string; path: string; headers: http.OutgoingHttpHeaders }) =>
      http.request({ host: "127.0.0.1", port: stubPort, method: r.method, path: r.path, headers: r.headers, agent: false }),
  } as unknown as ProxyDeps;
  const proxy = new EgressProxy({ credential: { kind: "api_key", value: "sk-ant-api03-placeholder-not-real" }, dummyKey: DUMMY, blockedSubnets: [], maxPageBytes: 64, log: () => undefined, deps, router: ROUTER });
  const port = await listen(proxy.server);
  closers.push(() => proxy.server.close(), () => stub.close());
  proxy.setEndpoints([pin("native"), pin("translated")]);
  for (const name of ["native", "translated"]) proxy.grant(name === "native" ? AGENT : "b".repeat(43), { session: name, role: "log-reader", allow: [], upstream: name, kind: "agent" });
  return { port, stubSaw };
}

function ask(port: number, cred: string, stream: boolean): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/gw/${cred}/v1/messages`, headers: { "x-api-key": DUMMY, "content-type": "application/json" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ ...CONVERSATION, stream }));
  });
}

interface ToolCall {
  name: string;
  input: unknown;
  stopReason: unknown;
}

/** What Claude Code reads from an unstreamed Messages reply. */
function toolCallOf(json: string): ToolCall {
  const m = JSON.parse(json) as { content: Array<{ type: string; name?: string; input?: unknown }>; stop_reason: unknown };
  const use = m.content.find((b) => b.type === "tool_use")!;
  return { name: use.name!, input: use.input, stopReason: m.stop_reason };
}

/** What Claude Code reads from a streamed reply: the tool_use block's argument fragments joined, and the stop reason from the final delta. */
function toolCallOfStream(sse: string): ToolCall {
  const events = sse.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, any>);
  const start = events.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use")!;
  const fragments = events.filter((e) => e.type === "content_block_delta" && e.index === start.index && e.delta.type === "input_json_delta").map((e) => e.delta.partial_json as string);
  return { name: start.content_block.name, input: JSON.parse(fragments.join("")), stopReason: events.find((e) => e.type === "message_delta")!.delta.stop_reason };
}

describe("FR-15 conformance through the gateway (stub router)", () => {
  it("AC-15: both endpoint formats give Claude Code the same tool_use name, arguments and stop reason, unstreamed", async () => {
    const h = await rig();
    const native = await ask(h.port, AGENT, false);
    const translated = await ask(h.port, "b".repeat(43), false);
    expect([native.status, translated.status]).toEqual([200, 200]);
    expect(toolCallOf(native.body)).toEqual({ name: "get_status", input: { service: "api", verbose: true }, stopReason: "tool_use" });
    expect(toolCallOf(translated.body)).toEqual(toolCallOf(native.body));
  });

  it("AC-15: the same, streamed", async () => {
    const h = await rig();
    const native = await ask(h.port, AGENT, true);
    const translated = await ask(h.port, "b".repeat(43), true);
    expect(native.type).toBe("text/event-stream");
    expect(toolCallOfStream(native.body)).toEqual({ name: "get_status", input: { service: "api", verbose: true }, stopReason: "tool_use" });
    expect(toolCallOfStream(translated.body)).toEqual(toolCallOfStream(native.body));
  });

  it("passes the reply through byte for byte and sends the router each session's own endpoint with the tool definitions intact", async () => {
    const h = await rig();
    expect((await ask(h.port, AGENT, false)).body).toBe(fixture("native.json"));
    expect((await ask(h.port, "b".repeat(43), true)).body).toBe(fixture("translated.sse"));
    expect(h.stubSaw.map((b) => b.model)).toEqual(["native", "translated"]);
    for (const b of h.stubSaw) expect(b.tools).toEqual(CONVERSATION.tools);
  });
});
