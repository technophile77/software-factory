// FR-15 conformance against the real, pinned LiteLLM image and a real model
// endpoint. Off by default: it needs a Docker daemon, a pull of the pinned image
// and a model server. The endpoint comes from the environment only, never from
// a committed value (SR-2). Run it once per format, after `npm run build`:
//   FACTORY_DOCKER_TESTS=1 FACTORY_CONFORMANCE_BASE_URL=<url> FACTORY_CONFORMANCE_MODEL=<model> \
//   FACTORY_CONFORMANCE_API=anthropic npx vitest run --project unit test/litellm-conformance-real.test.ts
// and again with FACTORY_CONFORMANCE_API=openai. The server must serve that
// format at the URL (an `openai` endpoint is what `api: openai` in endpoints.yaml names).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_ALIAS, ROUTER_PORT, litellmConfig, litellmEnv } from "../src/agent/litellm";
import { ROUTER_LIMITS } from "../src/agent/endpoint-service";
import type { Endpoint } from "../src/config/endpoints";
import { DockerCli, DockerError, dockerName, pickEndpoint } from "../src/docker/cli";
import { litellmImageId } from "../src/docker/litellm-image";
import { type ContainerSpec, inspectMismatches, outsideNetworkArgs, runArgs } from "../src/docker/plan";
import { findOnPath } from "../src/fsutil";
import { Children } from "../src/proc";
import { sanitizeEndpointBody } from "../src/proxy/server";
import { tmpdir } from "./helpers";

const ON = process.env.FACTORY_DOCKER_TESTS === "1";

// The first start of the read-only router took about 8 minutes in the A-1 spike
// (LiteLLM imports and builds its route table on a slow disk), and the engine
// waits 15; a model server may also load its weights on the first request.
const READY_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 5_000;
// A pull of the large image can take 30 minutes (the engine allows the same), then startup, so the hook gets both.
const SETUP_TIMEOUT_MS = 50 * 60_000;
// One request may wait for a cold model and a slow prompt pass, so each gets its own long limit.
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const TEST_TIMEOUT_MS = 12 * 60_000;
const ENDPOINT_NAME = "conformance";
const HEALTH_PY = `import sys,urllib.request as u;sys.exit(0 if u.build_opener(u.ProxyHandler({})).open("http://127.0.0.1:${ROUTER_PORT}/health/liveliness",timeout=5).status==200 else 1)`;
// Runs inside the router container and talks to its own loopback, so the empty ProxyHandler keeps it off any proxy.
// Prints the status on the first line and the raw reply after it, error replies included.
const POST_PY = `import os,sys,urllib.request as u,urllib.error as e
req=u.Request("http://127.0.0.1:${ROUTER_PORT}/v1/messages",data=sys.stdin.buffer.read(),headers={"content-type":"application/json","anthropic-version":"2023-06-01","authorization":"Bearer "+os.environ["FACTORY_CONF_KEY"]})
try:
    r=u.build_opener(u.ProxyHandler({})).open(req,timeout=${REQUEST_TIMEOUT_MS / 1000})
except e.HTTPError as x:
    r=x
sys.stdout.write(str(r.status)+"\\n")
sys.stdout.flush()
while True:
    c=r.read(4096)
    if not c:
        break
    sys.stdout.buffer.write(c)
    sys.stdout.buffer.flush()
`;

const TOOLS = [
  { name: "read_file", description: "Reads a text file and returns its content.", input_schema: { type: "object", properties: { path: { type: "string", description: "File path." } }, required: ["path"] } },
  { name: "list_dir", description: "Lists the names in a folder.", input_schema: { type: "object", properties: { path: { type: "string", description: "Folder path." } }, required: ["path"] } },
];
const TOOL_NAMES = TOOLS.map((t) => t.name);

/** A generic Claude Code shaped request: two tools and a system message after an assistant turn, which the gateway folds (FR-16). */
function requestBody(stream: boolean): Buffer {
  return Buffer.from(JSON.stringify({
    model: "ignored-the-gateway-names-the-endpoint",
    max_tokens: 2048,
    stream,
    tools: TOOLS,
    messages: [
      { role: "user", content: "Hello. I need help with a small task." },
      { role: "assistant", content: "Sure. What is the task?" },
      { role: "system", content: "Reminder: answer briefly and use the tools you are given." },
      { role: "user", content: "Use a tool to read the file named notes.txt. Do not answer from memory." },
    ],
  }));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The status line and the body of what the exec'd script printed. */
function splitReply(stdout: string): { status: number; text: string } {
  const nl = stdout.indexOf("\n");
  return { status: Number(stdout.slice(0, nl)), text: stdout.slice(nl + 1) };
}

/** A tool call as the test checks it: its name and its input, already parsed. */
interface ToolCall {
  name: string;
  input: unknown;
}

/** The tool calls and stop reason of an unstreamed Messages reply. */
function readMessage(text: string): { calls: ToolCall[]; stopReason: unknown } {
  const doc = JSON.parse(text) as { content?: unknown; stop_reason?: unknown };
  const blocks = Array.isArray(doc.content) ? doc.content : [];
  const calls = blocks.filter((b): b is Record<string, unknown> => isPlainObject(b) && b.type === "tool_use").map((b) => ({ name: String(b.name), input: b.input }));
  return { calls, stopReason: doc.stop_reason };
}

/** The tool calls and stop reason of a streamed reply: each call's input is its `input_json_delta` pieces joined, then parsed. */
function readStream(text: string): { calls: ToolCall[]; stopReason: unknown; events: string[] } {
  const events: string[] = [];
  const started = new Map<number, { name: string; json: string }>();
  let stopReason: unknown;
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!data) continue;
    const ev = JSON.parse(data.slice(5).trim()) as Record<string, unknown>;
    events.push(String(ev.type));
    const index = Number(ev.index);
    if (ev.type === "content_block_start" && isPlainObject(ev.content_block) && ev.content_block.type === "tool_use") {
      // An empty object here is the start value; the real input arrives as deltas.
      started.set(index, { name: String(ev.content_block.name), json: "" });
    } else if (ev.type === "content_block_delta" && isPlainObject(ev.delta) && ev.delta.type === "input_json_delta") {
      const call = started.get(index);
      if (call) call.json += String(ev.delta.partial_json ?? "");
    } else if (ev.type === "message_delta" && isPlainObject(ev.delta)) {
      stopReason = ev.delta.stop_reason;
    }
  }
  return { calls: [...started.values()].map((c) => ({ name: c.name, input: JSON.parse(c.json === "" ? "{}" : c.json) as unknown })), stopReason, events };
}

function expectToolUse(r: { calls: ToolCall[]; stopReason: unknown }): void {
  expect(r.stopReason).toBe("tool_use");
  expect(r.calls.length).toBeGreaterThan(0);
  for (const c of r.calls) {
    expect(TOOL_NAMES).toContain(c.name);
    expect(isPlainObject(c.input)).toBe(true);
  }
}

describe.skipIf(!ON)(`FR-15: pinned LiteLLM translates tool calls for the ${process.env.FACTORY_CONFORMANCE_API ?? "(unset)"} endpoint format`, () => {
  let docker: DockerCli;
  let work: string;
  const runId = crypto.randomBytes(4).toString("hex");
  const container = dockerName("conf", runId, "router");
  const network = dockerName("conf", runId, "net");
  const masterKey = crypto.randomBytes(32).toString("base64url");
  let networkMade = false;

  /**
   * The endpoint and its pinned address parts, from the environment only: no value of it is ever committed.
   * @throws Error when a variable is missing or the format isn't `anthropic` or `openai`.
   */
  function endpointFromEnv(): { endpoint: Endpoint; pin: { name: string; scheme: "http" | "https"; host: string; port: number; basePath: string } } {
    const { FACTORY_CONFORMANCE_BASE_URL: base, FACTORY_CONFORMANCE_MODEL: model, FACTORY_CONFORMANCE_API: api } = process.env;
    if (!base || !model || (api !== "anthropic" && api !== "openai")) {
      throw new Error("set FACTORY_CONFORMANCE_BASE_URL, FACTORY_CONFORMANCE_MODEL and FACTORY_CONFORMANCE_API (anthropic or openai)");
    }
    const u = new URL(base);
    const scheme = u.protocol === "https:" ? "https" : "http";
    const endpoint: Endpoint = { name: ENDPOINT_NAME, base_url: base, model, api, max_sessions: 1, deadline: { margin_s: 60 }, allow_loopback: false, billing: "local" };
    return { endpoint, pin: { name: ENDPOINT_NAME, scheme, host: u.hostname, port: u.port ? Number(u.port) : scheme === "https" ? 443 : 80, basePath: u.pathname.replace(/\/+$/, "") } };
  }

  async function waitForRouter(): Promise<void> {
    for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += POLL_MS) {
      try {
        await docker.run(["exec", container, "python3", "-c", HEALTH_PY], { timeoutMs: 15_000 });
        return;
      } catch {
        // Not up yet; the inspect tells a router that stopped from one that is still starting.
      }
      await docker.run(["inspect", container]).catch(() => {
        throw new DockerError("the router stopped before it was ready");
      });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new DockerError(`the router wasn't ready after ${READY_TIMEOUT_MS / 1000}s`);
  }

  /** Sends the body the way the gateway does (after `sanitizeEndpointBody`) to the router's `/v1/messages` from inside its container. */
  async function post(body: Buffer): Promise<{ status: number; text: string }> {
    const clean = sanitizeEndpointBody(body, ENDPOINT_NAME).body;
    const parsed = JSON.parse(clean.toString("utf8")) as { messages: { role: string }[]; model: string };
    // The fold must have run: no system role is left in messages, and the model is the endpoint's name.
    expect(parsed.messages.some((m) => m.role === "system")).toBe(false);
    expect(parsed.model).toBe(ENDPOINT_NAME);
    const res = await docker.run(["exec", "--interactive", "--env", "FACTORY_CONF_KEY", container, "python3", "-c", POST_PY], { input: clean, env: { FACTORY_CONF_KEY: masterKey }, timeoutMs: REQUEST_TIMEOUT_MS + 30_000 });
    return splitReply(res.stdout.toString("utf8"));
  }

  beforeAll(async () => {
    const { endpoint, pin } = endpointFromEnv();
    const bin = findOnPath(process.platform === "win32" ? "docker.exe" : "docker");
    const host = await pickEndpoint(process.platform, process.env);
    if (!bin || !host) throw new Error("AC-13: no docker client or local daemon");
    work = tmpdir();
    docker = new DockerCli({ dockerPath: bin, host, configDir: path.join(work, "docker"), children: new Children() });
    // The signature check has its own tests and needs the cosign binary; this test is about what the image does with a request.
    const image = await litellmImageId(docker, { verify: async () => undefined });
    const configDir = path.join(work, "router");
    fs.mkdirSync(configDir);
    const file = path.join(configDir, "config.yaml");
    fs.writeFileSync(file, litellmConfig([endpoint], [pin]), { mode: 0o644 });
    // No egress proxy runs in this test, so the proxy variables point nowhere and are removed; the endpoint is reached directly.
    const env = litellmEnv([endpoint], new Map(), masterKey, "unused");
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) delete env[k];
    // A plain bridge, not the engine's internal one: the router must reach the endpoint without the proxy.
    await docker.run(outsideNetworkArgs(network, { "factory.run": runId }));
    networkMade = true;
    const spec: ContainerSpec = {
      name: container, imageId: image.id, user: image.user, networks: [network], alias: ROUTER_ALIAS,
      mounts: [{ type: "bind", source: file, target: "/app/config.yaml", readOnly: true }],
      limits: ROUTER_LIMITS, envNames: Object.keys(env), interactive: false,
      command: ["--config", "/app/config.yaml", "--port", String(ROUTER_PORT)],
      labels: { "factory.run": runId, "factory.role": "router" }, extraTmpfs: ["/app/.cache"],
    };
    await docker.run(runArgs(spec), { env });
    const inspected = JSON.parse(await docker.out(["inspect", container])) as unknown;
    expect(inspectMismatches(spec, inspected)).toEqual([]);
    await waitForRouter();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (!docker) return;
    await docker.run(["rm", "--force", container], { okCodes: [1] }).catch(() => undefined);
    if (networkMade) await docker.run(["network", "rm", network], { okCodes: [1] }).catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }, 120_000);

  it("unstreamed: a tool_use with a listed name, a JSON-object input and stop_reason tool_use", async () => {
    const r = await post(requestBody(false));
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expectToolUse(readMessage(r.text));
  }, TEST_TIMEOUT_MS);

  it("streamed: the same call arrives as tool_use deltas that join into a JSON object, and the stream stops with tool_use", async () => {
    const r = await post(requestBody(true));
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const s = readStream(r.text);
    expect(s.events[0]).toBe("message_start");
    expect(s.events.at(-1)).toBe("message_stop");
    expectToolUse(s);
  }, TEST_TIMEOUT_MS);
});
