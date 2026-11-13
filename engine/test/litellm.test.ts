import * as fs from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { ROUTER_TIMEOUT_S, litellmConfig, litellmEnv } from "../src/agent/litellm";
import { SessionGroup } from "../src/agent/sandbox";
import type { Endpoint } from "../src/config/endpoints";
import { DockerCli, DockerError } from "../src/docker/cli";
import { LITELLM_PIN, type LitellmPin, NoLitellmPinError, litellmImageId, litellmImageRef, litellmPinProblem } from "../src/docker/litellm-image";
import { inspectMismatches, runArgs } from "../src/docker/plan";
import type { ContainerSpec } from "../src/docker/plan";
import { MemoryLogger } from "../src/log";
import { effectiveRole } from "../src/policy/role-policy";
import type { PinnedEndpoint } from "../src/proxy/server";
import { FakeDocker, inspectFor } from "./fakes";
import { tmpdir } from "./helpers";
import { policyDoc } from "./policy-fixture";

const IMG = `sha256:${"a".repeat(64)}`;
const LIMITS = { cpus: 1.5, memoryBytes: 2 * 1024 ** 3, pids: 256, tmpBytes: 64 * 1024 ** 2 };
const CLAUDE_CRED = "sk-ant-api03-claude-credential-placeholder";

function endpoint(name: string, o: Partial<Endpoint> = {}): Endpoint {
  return { name, base_url: `http://${name}.local:8080`, model: "qwen3", api: "anthropic", max_sessions: 1, deadline: { margin_s: 60 }, allow_loopback: false, billing: "local", ...o } as Endpoint;
}

function pin(e: Endpoint, o: Partial<PinnedEndpoint> = {}): PinnedEndpoint {
  return { name: e.name, class: "private", scheme: "http", host: `${e.name}.local`, address: "192.168.1.20", port: 8080, basePath: "", ...o };
}

describe("litellmConfig (F-013 FR-5)", () => {
  it("makes one route per endpoint with the pinned address, the key as an env ref and the spike's system-message setting", () => {
    const a = endpoint("lan", { api_key_ref: "lan-key", model: "qwen3-27b" });
    const b = endpoint("cloud", { api: "openai", model: "gpt-x" });
    const doc = YAML.parse(litellmConfig([a, b], [pin(a), pin(b, { scheme: "https", host: "api.example.com", port: 443, basePath: "/v1" })]));
    expect(doc.model_list).toEqual([
      { model_name: "lan", litellm_params: { model: "anthropic/qwen3-27b", api_base: "http://lan.local:8080", api_key: "os.environ/FACTORY_EP_KEY_0", timeout: ROUTER_TIMEOUT_S }, model_info: { supports_mid_conversation_system: false } },
      { model_name: "cloud", litellm_params: { model: "openai/gpt-x", api_base: "https://api.example.com:443/v1", api_key: "none", timeout: ROUTER_TIMEOUT_S }, model_info: { supports_mid_conversation_system: false } },
    ]);
  });

  it("turns off telemetry, callbacks, caching, the database and spend logs", () => {
    const e = endpoint("lan");
    const doc = YAML.parse(litellmConfig([e], [pin(e)]));
    expect(doc.litellm_settings).toEqual({ telemetry: false, drop_params: true, cache: false });
    expect(doc.general_settings).toEqual({ master_key: "os.environ/LITELLM_MASTER_KEY", disable_spend_logs: true, store_model_in_db: false });
    expect(Object.keys(doc).sort()).toEqual(["general_settings", "litellm_settings", "model_list"]);
  });

  it("refuses an endpoint without a pin and a repeated name", () => {
    const e = endpoint("lan");
    expect(() => litellmConfig([e], [])).toThrow(DockerError);
    expect(() => litellmConfig([e, e], [pin(e)])).toThrow(DockerError);
  });
});

describe("litellmEnv (SR-16)", () => {
  it("numbers the keys like the config, adds the master key and the router's proxy credential, and has no Claude credential", () => {
    const a = endpoint("lan", { api_key_ref: "lan-key" });
    const b = endpoint("open");
    const c = endpoint("two", { api_key_ref: "two-key" });
    const env = litellmEnv([a, b, c], new Map([["lan-key", "key-lan"], ["two-key", "key-two"]]), "master", "proxycred");
    expect(env.FACTORY_EP_KEY_0).toBe("key-lan");
    expect(env.FACTORY_EP_KEY_1).toBeUndefined();
    expect(env.FACTORY_EP_KEY_2).toBe("key-two");
    expect(env.LITELLM_MASTER_KEY).toBe("master");
    expect(env.HTTP_PROXY).toBe("http://factory:proxycred@factory-proxy:3128");
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
    expect(env.NO_PROXY).toBe("");
    expect(env.LITELLM_TELEMETRY).toBe("False");
    expect(JSON.stringify(env)).not.toContain(CLAUDE_CRED);
  });

  it("refuses an endpoint whose key isn't supplied", () => {
    expect(() => litellmEnv([endpoint("lan", { api_key_ref: "lan-key" })], new Map(), "m", "c")).toThrow(DockerError);
  });
});

describe("litellmConfig with random endpoint sets", () => {
  it("always has one route per endpoint, unique names, and no key material", () => {
    let seed = 20261113;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const count = 1 + rnd(8);
      const keys = new Map<string, string>();
      const endpoints = Array.from({ length: count }, (_, i) => {
        const ref = rnd(2) ? `ref-${i}` : undefined;
        if (ref) keys.set(ref, `SECRET-${round}-${i}-${rnd(1e9)}`);
        return endpoint(`ep-${i}`, { api: rnd(2) ? "openai" : "anthropic", model: `m${rnd(100)}`, ...(ref ? { api_key_ref: ref } : {}) });
      });
      const pins = endpoints.map((e) => pin(e, { port: 1 + rnd(65000), basePath: rnd(2) ? "/v1" : "", scheme: rnd(2) ? "https" : "http" }));
      const text = litellmConfig(endpoints, pins);
      const doc = YAML.parse(text);
      expect(doc.model_list).toHaveLength(count);
      expect(new Set(doc.model_list.map((m: { model_name: string }) => m.model_name)).size).toBe(count);
      for (const v of keys.values()) expect(text).not.toContain(v);
      for (const m of doc.model_list) expect(m.litellm_params.api_key === "none" || /^os\.environ\/FACTORY_EP_KEY_\d+$/.test(m.litellm_params.api_key)).toBe(true);
    }
  });
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-12-01T00:00:00Z");
const PIN: LitellmPin = { version: "1.108.2", digest: `sha256:${"e".repeat(64)}`, publishedAt: "2026-11-10T00:00:00Z" };
const ok = async () => undefined;

describe("litellmPinProblem (SR-17, OQ-12 (a))", () => {
  it("accepts a 1.108.x release at least 14 days old, and exactly 14 days", () => {
    expect(litellmPinProblem(PIN, NOW)).toBeNull();
    expect(litellmPinProblem({ ...PIN, publishedAt: new Date(NOW - 14 * DAY).toISOString() }, NOW)).toBeNull();
  });

  it("refuses a release under 14 days old, a future date and an unreadable date", () => {
    expect(litellmPinProblem({ ...PIN, publishedAt: new Date(NOW - 14 * DAY + 1).toISOString() }, NOW)).toMatch(/less than 14 days/);
    expect(litellmPinProblem({ ...PIN, publishedAt: new Date(NOW + DAY).toISOString() }, NOW)).toMatch(/less than 14 days/);
    expect(litellmPinProblem({ ...PIN, publishedAt: "yesterday" }, NOW)).toMatch(/isn't readable/);
  });

  it("refuses versions off the 1.108.x line", () => {
    for (const version of ["1.109.1", "1.107.9", "1.108", "1.1080.0", "1.108.x", "1.108.1-rc1", "2.108.0", "1x108.0"]) {
      expect(litellmPinProblem({ ...PIN, version }, NOW), version).toMatch(/LTS line/);
    }
  });

  it("accepts a version off the 1.108.x line only with a non-empty owner exception", () => {
    const off = { ...PIN, version: "1.106.4" };
    expect(litellmPinProblem(off, NOW)).toMatch(/LTS line.*no owner exception/);
    for (const exception of ["", "   "]) expect(litellmPinProblem({ ...off, exception }, NOW), JSON.stringify(exception)).toMatch(/LTS line/);
    expect(litellmPinProblem({ ...off, exception: "OQ-12: owner pinned non-LTS 1.106.4, 2026-11-13" }, NOW)).toBeNull();
  });

  it("applies the 14-day rule and the digest rule to an excepted pin too", () => {
    const off: LitellmPin = { ...PIN, version: "1.106.4", exception: "OQ-12" };
    expect(litellmPinProblem({ ...off, publishedAt: new Date(NOW - 14 * DAY + 1).toISOString() }, NOW)).toMatch(/less than 14 days/);
    expect(litellmPinProblem({ ...off, publishedAt: "yesterday" }, NOW)).toMatch(/isn't readable/);
    expect(litellmPinProblem({ ...off, digest: "latest" }, NOW)).toMatch(/digest/);
  });

  it("refuses a digest that isn't a sha256 image digest", () => {
    for (const digest of ["", "latest", `sha256:${"E".repeat(64)}`, `sha256:${"e".repeat(63)}`]) expect(litellmPinProblem({ ...PIN, digest }, NOW)).toMatch(/digest/);
  });
});

describe("the pinned LiteLLM image", () => {
  it("is the owner's OQ-12 exception 1.106.4, by the index digest, and passes the pin rule from 8 Nov 2026 (14 days after publication)", () => {
    expect(LITELLM_PIN).toEqual({
      version: "1.106.4",
      digest: "sha256:ee5cb38e33c8be6d6774f7db922396b6b04d1cd962e77521b6c892b8f1c70fd8",
      publishedAt: "2026-10-25T09:39:15Z",
      exception: "OQ-12: owner pinned non-LTS 1.106.4, 2026-11-13",
    });
    expect(litellmPinProblem(LITELLM_PIN!, Date.parse("2026-11-13T00:00:00Z"))).toBeNull();
    expect(litellmPinProblem(LITELLM_PIN!, Date.parse("2026-11-08T09:39:14Z"))).toMatch(/less than 14 days/);
  });

  it("refuses to run with no release pinned, before any docker call", async () => {
    const d = new FakeDocker();
    let verified = false;
    const verify = async () => { verified = true; };
    const err = await litellmImageId(d as unknown as DockerCli, { verify, pin: null }).catch((e) => e);
    expect(err).toBeInstanceOf(NoLitellmPinError);
    expect(err.message).toBe("no approved LiteLLM release pinned yet (SR-17)");
    expect(d.calls).toHaveLength(0);
    expect(verified).toBe(false);
    expect(() => litellmImageRef(null)).toThrow(NoLitellmPinError);
  });

  it("is used by digest, after the pin rule and the signature check, and never pulled when either refuses", async () => {
    expect(litellmImageRef(PIN)).toBe(`ghcr.io/berriai/litellm-non_root@${PIN.digest}`);
    const seen: string[] = [];
    const d = new FakeDocker();
    await litellmImageId(d as unknown as DockerCli, { pin: PIN, now: () => NOW, verify: async (ref) => void seen.push(ref) });
    expect(seen).toEqual([litellmImageRef(PIN)]);

    const young = new FakeDocker();
    await expect(litellmImageId(young as unknown as DockerCli, { pin: PIN, now: () => Date.parse(PIN.publishedAt) + DAY, verify: ok })).rejects.toThrow(/refused.*less than 14 days/);
    const bad = new FakeDocker();
    await expect(litellmImageId(bad as unknown as DockerCli, { pin: PIN, now: () => NOW, verify: async () => { throw new DockerError("cosign refused"); } })).rejects.toThrow("cosign refused");
    expect(young.calls).toHaveLength(0);
    expect(bad.calls).toHaveLength(0);
  });

  it("ignores the old environment claim: only verify counts", async () => {
    const d = new FakeDocker();
    const saved = process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED;
    process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED = PIN.digest;
    try {
      await expect(litellmImageId(d as unknown as DockerCli, { pin: PIN, now: () => NOW, verify: async () => { throw new DockerError("not signed"); } })).rejects.toThrow("not signed");
    } finally {
      if (saved === undefined) delete process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED;
      else process.env.FACTORY_LITELLM_SIGNATURE_VERIFIED = saved;
    }
    expect(d.calls).toHaveLength(0);
  });

  it("returns the id and the image's own numeric user after checking the digest", async () => {
    const d = new FakeDocker();
    const got = await litellmImageId(d as unknown as DockerCli, { pin: PIN, now: () => NOW, verify: ok });
    expect(got).toEqual({ id: `sha256:${"c".repeat(64)}`, user: "65532:65532" });
  });

  it("pairs a bare numeric uid with the same gid, as the real image reports 65534", async () => {
    const d = new FakeDocker();
    d.litellmUser = "65534";
    expect((await litellmImageId(d as unknown as DockerCli, { pin: PIN, now: () => NOW, verify: ok })).user).toBe("65534:65534");
  });

  it("refuses an image that runs as a user name or as root", async () => {
    for (const user of ["nobody", "0:0", ""]) {
      const d = new FakeDocker();
      d.litellmUser = user;
      await expect(litellmImageId(d as unknown as DockerCli, { pin: PIN, now: () => NOW, verify: ok })).rejects.toThrow(/non-root/);
    }
  });
});

function endpointsFixture() {
  const e = endpoint("lan", { api_key_ref: "lan-key" });
  return { e, p: pin(e, { address: "192.168.1.20" }) };
}

function group(d: FakeDocker, over: { workDir: string; readyTimeoutMs?: number; log?: MemoryLogger; keys?: Map<string, string> }) {
  const { e, p } = endpointsFixture();
  return new SessionGroup({
    docker: d as unknown as DockerCli, runId: "R-0a1b2c", project: "demo", agentImageId: IMG, proxyImageId: `sha256:${"b".repeat(64)}`,
    proxyScript: "/opt/engine/dist/proxy.js", agentLimits: { "requirements-analyst": LIMITS }, proxyLimits: { ...LIMITS, cpus: 0.5 }, maxPageBytes: 1 << 20,
    credential: { kind: "api_key", value: CLAUDE_CRED }, log: over.log ?? new MemoryLogger(), platform: "linux", sleep: async () => undefined,
    router: {
      image: { id: `sha256:${"c".repeat(64)}`, user: "65532:65532" }, limits: LIMITS, endpoints: [e], pins: [p],
      keys: over.keys ?? new Map([["lan-key", "lan-secret-key"]]), workDir: over.workDir, ...(over.readyTimeoutMs !== undefined ? { readyTimeoutMs: over.readyTimeoutMs } : {}),
    },
  });
}

describe("session group router (F-013 FR-5, SR-16)", () => {
  it("starts a locked-down router on its own internal network, hands the proxy its address and a router grant, and cleans up on close", async () => {
    const d = new FakeDocker();
    const dir = tmpdir();
    const g = group(d, { workDir: dir });
    await g.open();
    const args = d.calls.map((c) => c.args).find((a) => a[0] === "run" && a.includes("factory-r-0a1b2c-router"))!;
    const call = d.calls.find((c) => c.args === args)!;
    const val = (f: string) => args[args.indexOf(f) + 1];
    expect(val("--user")).toBe("65532:65532");
    expect(args).toContain("--read-only");
    expect(val("--cap-drop")).toBe("ALL");
    expect(val("--security-opt")).toBe("no-new-privileges:true");
    expect(args.flatMap((a, i) => (args[i - 1] === "--network" ? [a] : []))).toEqual(["name=factory-r-0a1b2c-rtr,alias=factory-router"]);
    expect(args.flatMap((a, i) => (args[i - 1] === "--tmpfs" ? [a.split(":")[0]] : []))).toEqual(["/tmp", "/app/.cache"]);
    const mount = args[args.indexOf("--mount") + 1]!;
    expect(mount).toMatch(/target=\/app\/config\.yaml,readonly$/);
    expect(args.slice(-4)).toEqual(["--config", "/app/config.yaml", "--port", "4000"]);
    expect(args[args.length - 5]).toBe(`sha256:${"c".repeat(64)}`);
    // Values only through the environment, never an argument.
    expect(args.join(" ")).not.toContain("lan-secret-key");
    expect(call.env!.FACTORY_EP_KEY_0).toBe("lan-secret-key");
    expect(call.env!.HTTP_PROXY).toMatch(/^http:\/\/factory:[A-Za-z0-9_-]{43}@factory-proxy:3128$/);
    expect(JSON.stringify(call.env)).not.toContain(CLAUDE_CRED);
    expect(args).not.toContain("lan-secret-key");

    const proxy = d.spawned[0]!.child.sent();
    const start = proxy.find((m) => m.t === "start")!;
    expect(start.router).toEqual({ address: "172.32.0.9", port: 4000, masterKey: call.env!.LITELLM_MASTER_KEY });
    expect(start.routerSubnet).toBe("172.32.0.0/16");
    expect(start.blockedSubnets).toContain("172.32.0.0/16");
    expect(start.router.masterKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const grant = proxy.find((m) => m.t === "grant")!;
    expect(grant).toMatchObject({ kind: "router", role: "router", allow: [] });
    expect(call.env!.HTTP_PROXY).toContain(`:${grant.cred}@`);
    expect(proxy.find((m) => m.t === "endpoints")!.list[0].address).toBe("192.168.1.20");
    expect(d.calls.some((c) => c.args[0] === "exec" && c.args[1] === "factory-r-0a1b2c-router")).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(1);

    await g.close();
    expect(d.calls.some((c) => c.args[0] === "rm" && c.args.includes("factory-r-0a1b2c-router"))).toBe(true);
    expect(d.spawned[0]!.child.sent().filter((m) => m.t === "revoke").map((m) => m.cred)).toEqual([grant.cred]);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("M1: the router is on a network shared only with the proxy; no agent container is on it", async () => {
    const d = new FakeDocker();
    const g = group(d, { workDir: tmpdir() });
    await g.open();
    const create = d.calls.filter((c) => c.args[0] === "network" && c.args[1] === "create").map((c) => c.args);
    expect(create.map((a) => a.at(-1))).toEqual(["factory-r-0a1b2c-int", "factory-r-0a1b2c-out", "factory-r-0a1b2c-rtr"]);
    expect(create[2]).toContain("--internal");
    const nets = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--network" ? [a] : []));
    const proxyNets = nets(d.spawned[0]!.args);
    expect(proxyNets).toEqual(["name=factory-r-0a1b2c-int,alias=factory-proxy", "factory-r-0a1b2c-out", "name=factory-r-0a1b2c-rtr,alias=factory-proxy"]);
    await g.startAgent(effectiveRole(policyDoc(), "requirements-analyst"), null, { upstream: "lan" });
    const agentRun = d.calls.find((c) => c.args[0] === "run" && c.args.some((a) => a.includes("requirements-analyst")))!;
    expect(nets(agentRun.args)).toEqual(["factory-r-0a1b2c-int"]);
    await g.close();
  });

  it("M1: refuses to start when the router network isn't internal", async () => {
    const d = new FakeDocker();
    const real = d.answer.bind(d);
    d.answer = (args) => (args[0] === "network" && args[1] === "inspect" && args[2]!.endsWith("-rtr") ? real(args).replace('"Internal":true', '"Internal":false') : real(args));
    const g = group(d, { workDir: tmpdir() });
    await expect(g.open()).rejects.toThrow(/-rtr: not internal/);
    expect(d.calls.some((c) => c.args[0] === "run" && c.args.includes("factory-r-0a1b2c-router"))).toBe(false);
  });

  it("M1: close removes the router network with the others", async () => {
    const d = new FakeDocker();
    const g = group(d, { workDir: tmpdir() });
    await g.open();
    await g.close();
    expect(d.calls.map((c) => c.args.join(" "))).toContain("network rm factory-r-0a1b2c-rtr");
  });

  it("keeps the config file free of keys", async () => {
    const d = new FakeDocker();
    const dir = tmpdir();
    const g = group(d, { workDir: dir });
    await g.open();
    const sub = fs.readdirSync(dir)[0]!;
    const text = fs.readFileSync(`${dir}/${sub}/config.yaml`, "utf8");
    expect(text).not.toContain("lan-secret-key");
    expect(text).toContain("os.environ/FACTORY_EP_KEY_0");
    await g.close();
  });

  it("waits through failed health checks and logs progress", async () => {
    const d = new FakeDocker();
    d.execFailures = 3;
    const g = group(d, { workDir: tmpdir() });
    await g.open();
    expect(d.calls.filter((c) => c.args[0] === "exec")).toHaveLength(4);
    await g.close();
  });

  it("removes the router and its folder when it never becomes ready", async () => {
    const d = new FakeDocker();
    d.execFailures = 1000;
    const dir = tmpdir();
    const g = group(d, { workDir: dir, readyTimeoutMs: 20_000 });
    await expect(g.open()).rejects.toThrow(/wasn't ready/);
    expect(d.calls.some((c) => c.args[0] === "rm" && c.args.includes("factory-r-0a1b2c-router"))).toBe(true);
    expect(d.spawned[0]!.child.sent().some((m) => m.t === "revoke")).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("removes the router when its check fails, and never starts the proxy", async () => {
    const d = new FakeDocker();
    d.tamper = (name, doc) => {
      if (name.endsWith("-router")) doc.HostConfig.ReadonlyRootfs = false;
    };
    const dir = tmpdir();
    const g = group(d, { workDir: dir });
    await expect(g.open()).rejects.toThrow(/failed its check: root not read-only/);
    expect(d.spawned[0]!.child.sent().some((m) => m.t === "start")).toBe(false);
    expect(d.started.has("factory-r-0a1b2c-router")).toBe(false);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("refuses to start without a key the endpoint needs", async () => {
    const d = new FakeDocker();
    const g = group(d, { workDir: tmpdir(), keys: new Map() });
    await expect(g.open()).rejects.toThrow(DockerError);
    expect(d.calls.some((c) => c.args[0] === "run" && c.args.includes("factory-r-0a1b2c-router"))).toBe(false);
  });
});

describe("router container spec (SR-14)", () => {
  const spec: ContainerSpec = {
    name: "factory-r-router", imageId: IMG, user: "65532:65532", networks: ["factory-r-rtr"], alias: "factory-router", mounts: [], limits: LIMITS,
    envNames: ["LITELLM_MASTER_KEY"], interactive: false, command: ["--port", "4000"], labels: { "factory.run": "r" }, extraTmpfs: ["/app/.cache"],
  };

  it("passes with the extra tmpfs and fails on a writable root, a missing or extra tmpfs", () => {
    const args = runArgs(spec);
    expect(inspectMismatches(spec, inspectFor(args), "linux")).toEqual([]);
    const writable = inspectFor(args) as any;
    writable.HostConfig.ReadonlyRootfs = false;
    expect(inspectMismatches(spec, writable, "linux")).toEqual(["root not read-only"]);
    const missing = inspectFor(args) as any;
    delete missing.HostConfig.Tmpfs["/app/.cache"];
    expect(inspectMismatches(spec, missing, "linux")).toEqual(["tmpfs"]);
    const extra = inspectFor(args) as any;
    extra.HostConfig.Tmpfs["/etc"] = "rw";
    expect(inspectMismatches(spec, extra, "linux")).toEqual(["tmpfs"]);
    expect(inspectMismatches({ ...spec, extraTmpfs: undefined }, inspectFor(args), "linux")).toEqual(["tmpfs"]);
  });

  it("refuses a root user and a tmpfs path that clashes with a mount or /tmp", () => {
    expect(() => runArgs({ ...spec, user: "0:0" })).toThrow(DockerError);
    expect(() => runArgs({ ...spec, extraTmpfs: ["/tmp"] })).toThrow(DockerError);
    expect(() => runArgs({ ...spec, extraTmpfs: ["/a/../b"] })).toThrow(DockerError);
    expect(() => runArgs({ ...spec, mounts: [{ type: "volume", name: "factory-v", target: "/app/.cache", readOnly: false }] })).toThrow(DockerError);
  });
});
