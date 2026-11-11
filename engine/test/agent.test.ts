import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AnalystRunInput, SessionRefused, runAnalystSession } from "../src/agent/analyst";
import { analystTools, fetchPageTool, toCallResult, UNTRUSTED_LABEL } from "../src/agent/factory-tools";
import { DUMMY_KEY, ProxyClient, SessionGroup } from "../src/agent/sandbox";
import type { AgentSdk, SdkMessage, SessionOptions, UserTurn } from "../src/agent/sdk";
import { CLAUDE_BIN, CONTAINER_FLAGS, SessionCaps, containerSpawn, hostRelative, runSession, sessionOptions, toolGate } from "../src/agent/session";
import { DockerCli, DockerError, dockerName, isLocalEndpoint, localEndpoints, pickEndpoint } from "../src/docker/cli";
import { BASE_IMAGE, agentBuildArgs, skillsPluginDir, writeBuildContext } from "../src/docker/image";
import { ContainerLimits, ContainerSpec, bindSourceMatches, inspectMismatches, runArgs } from "../src/docker/plan";
import type { InterviewTools } from "../src/interview/tools";
import { MemoryLogger } from "../src/log";
import { effectiveRole } from "../src/policy/role-policy";
import { Children } from "../src/proc";
import { tmpdir } from "./helpers";
import { policyDoc } from "./policy-fixture";

const IMG = `sha256:${"a".repeat(64)}`;
const LIMITS = { cpus: 1.5, memoryBytes: 2 * 1024 ** 3, pids: 256, tmpBytes: 64 * 1024 ** 2 };
const CAPS: SessionCaps = { maxTurns: 50, maxOutputTokens: 1000, wallTimeMs: 60_000 };
const analyst = effectiveRole(policyDoc(), "requirements-analyst");
const reader = effectiveRole(policyDoc(), "web-reader");

describe("docker command line (SR-14)", () => {
  it("names come from validated ids only", () => {
    expect(dockerName("r-0a1b", "proxy")).toBe("factory-r-0a1b-proxy");
    for (const bad of ["../x", "a b", "a;b", "", "x".repeat(65)]) expect(() => dockerName(bad), bad).toThrow(DockerError);
  });

  it("uses only a local endpoint", () => {
    expect(localEndpoints("linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/o")).toEqual(["unix:///run/user/1000/docker.sock", "unix:///home/o/.docker/desktop/docker.sock", "unix:///var/run/docker.sock"]);
    expect(localEndpoints("win32", {})[0]).toBe("npipe:////./pipe/dockerDesktopLinuxEngine");
    for (const e of ["tcp://10.0.0.1:2376", "ssh://host", "unix://relative", "npipe:////remote/pipe/x"]) expect(isLocalEndpoint(e), e).toBe(false);
    expect(pickEndpoint("linux", {}, (p) => p === "/var/run/docker.sock")).toBe("unix:///var/run/docker.sock");
    expect(pickEndpoint("darwin", {}, () => false)).toBeNull();
    expect(pickEndpoint("win32", {}, (p) => p === "\\\\.\\pipe\\docker_engine")).toBe("npipe:////./pipe/docker_engine");
  });

  it("clears DOCKER_* and proxy variables, sets an engine-owned config, and passes --host first", () => {
    const dir = tmpdir();
    const d = new DockerCli({
      dockerPath: "/usr/bin/docker", host: "unix:///var/run/docker.sock", configDir: path.join(dir, "docker"), children: new Children(),
      env: { PATH: "/usr/bin", DOCKER_HOST: "tcp://evil:2375", DOCKER_CONTEXT: "remote", DOCKER_CONFIG: "/home/o/.docker", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/x", HTTPS_PROXY: "http://p" },
    });
    const env = d.env({ HTTPS_PROXY: "http://factory:cred@factory-proxy:3128" });
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(env.DOCKER_CERT_PATH).toBeUndefined();
    expect(env.DOCKER_CONFIG).toBe(path.join(dir, "docker"));
    expect(env.HTTPS_PROXY).toBe("http://factory:cred@factory-proxy:3128");
    expect(d.env().HTTPS_PROXY).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "docker", "config.json"), "utf8"))).toEqual({});
    expect(d.args(["ps"])).toEqual(["--host", "unix:///var/run/docker.sock", "ps"]);
    expect(() => d.env({ DOCKER_HOST: "x" })).toThrow();
    expect(() => new DockerCli({ dockerPath: "docker", host: "unix:///x", configDir: dir, children: new Children() })).toThrow(/absolute/);
    expect(() => new DockerCli({ dockerPath: "/d", host: "tcp://x:1", configDir: dir, children: new Children() })).toThrow(/local/);
  });

  it("builds the agent image from the pinned base only", () => {
    expect(BASE_IMAGE).toBe("node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072");
    const id = { project: "Proj", masterCommit: "c".repeat(40), skillsDigest: "d".repeat(64) };
    const a = agentBuildArgs("/e/ctx", "/e/w/iid", id);
    expect(a).toContain(`BASE_IMAGE=${BASE_IMAGE}`);
    expect(a.at(-1)).toBe("/e/ctx");
    // Spec v30: the image says which master commit and which skills it holds, so projects on different versions get different images.
    expect(a).toContain(`factory.master_commit=${"c".repeat(40)}`);
    expect(a).toContain(`factory.skills_sha256=${"d".repeat(64)}`);
    expect(a[a.indexOf("--tag") + 1]).toBe(`factory-agent:proj-${"c".repeat(12)}-${"d".repeat(12)}`);
    expect(() => agentBuildArgs("/e/ctx", "/e/w/iid", { ...id, masterCommit: "HEAD" })).toThrow(/identity/);
    const sha = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docker", "claude-sha256.json"), "utf8"));
    expect(sha.version).toBe("2.1.311");
  });

  it("bakes each role's resolved skills into the build context as a local plugin, and nothing else of a project", () => {
    const ctx = path.join(tmpdir(), "ctx");
    const file = (s: string, executable = false) => ({ content: Buffer.from(s), executable });
    const skill = (name: string, files: Record<string, ReturnType<typeof file>>) => ({ name, from: "master" as const, path: `skills/${name}`, files: new Map(Object.entries(files)) });
    writeBuildContext(path.join(__dirname, "..", "docker"), ctx, {
      skills: new Map([
        ["requirements-analyst", [skill("security-review", { "SKILL.md": file("sr"), "bin/run.sh": file("#!/bin/sh\n", true) })]],
        ["web-reader", []],
      ]),
    });
    const list = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name)).map((x) => `${e.name}/${x}`) : [e.name]));
    expect(list(ctx).sort()).toEqual([
      "agent.Dockerfile", "claude-code/package-lock.json", "claude-code/package.json", "claude-sha256.json",
      "skills/requirements-analyst/.claude-plugin/plugin.json", "skills/requirements-analyst/skills/security-review/SKILL.md",
      "skills/requirements-analyst/skills/security-review/bin/run.sh", "skills/web-reader/.claude-plugin/plugin.json", "verify-claude.cjs",
    ]);
    if (process.platform !== "win32") expect(fs.statSync(path.join(ctx, "skills/requirements-analyst/skills/security-review/bin/run.sh")).mode & 0o111).not.toBe(0);
    expect(skillsPluginDir("web-reader")).toBe("/opt/factory/skills/web-reader");
    expect(() => skillsPluginDir("../x")).toThrow();
    expect(fs.readFileSync(path.join(__dirname, "..", "docker", "agent.Dockerfile"), "utf8")).toContain("COPY skills/ /opt/factory/skills/");
  });
});

function spec(over: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "factory-r-1-requirements-analyst-1", imageId: IMG, user: "1000:1000", networks: ["factory-r-1-int"],
    mounts: [{ type: "bind", source: "/home/o/wt", target: "/workspace", readOnly: false }, { type: "volume", name: "factory-r-1-s", target: "/home/node/.claude", readOnly: false }],
    limits: LIMITS, envNames: ["ANTHROPIC_BASE_URL"], workdir: "/workspace", interactive: false, command: ["sleep", "infinity"], labels: { "factory.run": "R-1" }, ...over,
  };
}

/** What `docker inspect` would report for a container started with these arguments. */
function inspectFor(args: string[], running = true): Record<string, unknown> {
  const get = (f: string) => args[args.indexOf(f) + 1]!;
  const all = (f: string) => args.flatMap((a, i) => (a === f ? [args[i + 1]!] : []));
  const nets = all("--network").map((n) => (n.startsWith("name=") ? n.slice(5).split(",")[0]! : n));
  const mounts = all("--mount").map((m) => {
    const kv = Object.fromEntries(m.split(",").map((p) => p.split("=") as [string, string]));
    return { Type: kv.type, Source: kv.source, Name: kv.type === "volume" ? kv.source : undefined, Destination: kv.target, RW: !m.includes("readonly") };
  });
  const [tmpPath, tmpOpts] = get("--tmpfs").split(/:(.*)/s) as [string, string];
  return {
    Name: `/${get("--name")}`, Image: args.find((a) => a.startsWith("sha256:")),
    Config: { User: get("--user") }, State: { Running: running },
    HostConfig: {
      ReadonlyRootfs: args.includes("--read-only"), Privileged: false, CapDrop: [get("--cap-drop")], CapAdd: null,
      SecurityOpt: [get("--security-opt")], NanoCpus: Math.round(Number(get("--cpus")) * 1e9), Memory: Number(get("--memory").slice(0, -1)),
      PidsLimit: Number(get("--pids-limit")), Tmpfs: { [tmpPath]: tmpOpts }, NetworkMode: nets[0], LogConfig: { Type: get("--log-driver") }, Binds: null,
    },
    NetworkSettings: { Networks: Object.fromEntries(nets.map((n) => [n, {}])) },
    Mounts: mounts,
  };
}

describe("container plan and post-start check (FR-8, SR-14)", () => {
  it("runs non-root, read-only, no capabilities, no new privileges, limited, by image id, without a log file", () => {
    const a = runArgs(spec());
    for (const f of ["--read-only", "--rm", "--init", "--detach"]) expect(a).toContain(f);
    expect(a.slice(a.indexOf("--cap-drop"), a.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
    expect(a).toContain("no-new-privileges:true");
    expect(a.slice(a.indexOf("--pull"), a.indexOf("--pull") + 2)).toEqual(["--pull", "never"]);
    expect(a.slice(a.indexOf("--log-driver"), a.indexOf("--log-driver") + 2)).toEqual(["--log-driver", "none"]);
    expect(a).toContain("type=bind,source=/home/o/wt,target=/workspace");
    expect(a).toContain("type=volume,source=factory-r-1-s,target=/home/node/.claude");
    expect(a.slice(-3)).toEqual([IMG, "sleep", "infinity"]);
    // Values never sit in the arguments: -e takes them from docker's own environment.
    expect(a.slice(a.indexOf("--env"), a.indexOf("--env") + 2)).toEqual(["--env", "ANTHROPIC_BASE_URL"]);
    expect(runArgs(spec({ interactive: true, networks: ["factory-r-1-int", "factory-r-1-out"], alias: "factory-proxy" }))).toContain("name=factory-r-1-int,alias=factory-proxy");
  });

  it("refuses specs that would widen the container", () => {
    expect(() => runArgs(spec({ user: "0:0" }))).toThrow();
    expect(() => runArgs(spec({ imageId: "node:latest" }))).toThrow();
    expect(() => runArgs(spec({ mounts: [{ type: "bind", source: "/a,target=/etc", target: "/x", readOnly: true }] }))).toThrow();
    expect(() => runArgs(spec({ mounts: [{ type: "bind", source: "relative", target: "/x", readOnly: true }] }))).toThrow();
    expect(() => runArgs(spec({ mounts: [{ type: "volume", name: "factory-v", target: "/tmp", readOnly: false }] }))).toThrow();
    expect(() => runArgs(spec({ envNames: ["A=B"] }))).toThrow();
    expect(() => runArgs(spec({ limits: { ...LIMITS, pids: 0 } }))).toThrow();
    expect(() => runArgs(spec({ name: "evil" }))).toThrow();
  });

  it("accepts exactly what was asked for and names every difference", () => {
    const s = spec();
    const good = inspectFor(runArgs(s));
    expect(inspectMismatches(s, [good], "linux")).toEqual([]);
    const tweak = (f: (d: Record<string, any>) => void) => {
      const d = structuredClone(good) as Record<string, any>;
      f(d);
      return inspectMismatches(s, d, "linux");
    };
    expect(tweak((d) => (d.Image = `sha256:${"b".repeat(64)}`))).toEqual(["image"]);
    expect(tweak((d) => (d.Config.User = "root"))).toEqual(["user"]);
    expect(tweak((d) => (d.HostConfig.ReadonlyRootfs = false))).toEqual(["root not read-only"]);
    expect(tweak((d) => (d.HostConfig.CapDrop = []))).toEqual(["capabilities not dropped"]);
    expect(tweak((d) => (d.HostConfig.CapAdd = ["NET_ADMIN"]))).toEqual(["capabilities added"]);
    expect(tweak((d) => (d.HostConfig.SecurityOpt = []))).toEqual(["no-new-privileges missing"]);
    expect(tweak((d) => (d.HostConfig.Memory = 0))).toEqual(["memory"]);
    expect(tweak((d) => (d.HostConfig.PidsLimit = -1))).toEqual(["pids"]);
    expect(tweak((d) => (d.HostConfig.NanoCpus = 0))).toEqual(["cpus"]);
    expect(tweak((d) => (d.HostConfig.Privileged = true))).toEqual(["privileged"]);
    expect(tweak((d) => (d.HostConfig.PidMode = "host"))).toEqual(["PidMode host"]);
    expect(tweak((d) => (d.NetworkSettings.Networks.bridge = {}))).toEqual(["networks"]);
    expect(tweak((d) => d.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }))).toEqual(["mount count"]);
    expect(tweak((d) => (d.Mounts[0].Source = "/home/o"))).toEqual(["mount /workspace source"]);
    expect(tweak((d) => (d.Mounts[0].RW = false))).toEqual(["mount /workspace"]);
    expect(tweak((d) => (d.HostConfig.LogConfig.Type = "json-file"))).toEqual(["log driver"]);
    expect(tweak((d) => (d.State.Running = false))).toEqual(["not running"]);
    expect(inspectMismatches(s, "nonsense")).toEqual(["inspect output is not a container"]);
  });

  it("knows how Docker Desktop reports bind sources", () => {
    expect(bindSourceMatches("darwin", "/Users/o/wt", "/host_mnt/Users/o/wt")).toBe(true);
    expect(bindSourceMatches("win32", "C:\\Users\\o\\wt", "/run/desktop/mnt/host/c/Users/o/wt")).toBe(true);
    expect(bindSourceMatches("linux", "/home/o/wt", "/host_mnt/home/o/wt")).toBe(false);
    expect(bindSourceMatches("win32", "C:\\Users\\o\\wt", "/run/desktop/mnt/host/c/Users/o")).toBe(false);
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => this.written.push(...d.toString().split("\n").filter(Boolean)));
  }
  sent(): Array<Record<string, any>> {
    return this.written.map((l) => JSON.parse(l));
  }
  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGKILL");
    return true;
  }
}

/** Docker as the engine sees it: records each call and answers inspect from the arguments it was given. */
class FakeDocker {
  calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  started = new Map<string, string[]>();
  spawned: Array<{ args: string[]; env: Record<string, string>; child: FakeChild }> = [];
  tamper: ((name: string, d: Record<string, any>) => void) | null = null;

  async run(args: string[], o: { env?: Record<string, string> } = {}) {
    this.calls.push({ args, ...(o.env ? { env: o.env } : {}) });
    if (args[0] === "run") this.started.set(args[args.indexOf("--name") + 1]!, args);
    return { code: 0, signal: null, stdout: Buffer.from(this.answer(args)), stderr: "", timedOut: false };
  }
  async out(args: string[]) {
    return (await this.run(args)).stdout.toString().trim();
  }
  answer(args: string[]): string {
    if (args[0] === "network" && args[1] === "inspect") {
      const internal = args[2]!.endsWith("-int");
      return JSON.stringify([{ Name: args[2], Internal: internal, Driver: "bridge", IPAM: { Config: [{ Subnet: internal ? "172.30.0.0/16" : "172.31.0.0/16" }] } }]);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const a = this.started.get(args[2]!);
      if (!a) throw new Error("no such container");
      const d = inspectFor(a);
      this.tamper?.(args[2]!, d);
      return JSON.stringify([d]);
    }
    return "";
  }
  spawn(args: string[], env: Record<string, string> = {}) {
    const child = new FakeChild();
    this.spawned.push({ args, env, child });
    if (args[0] === "run") {
      this.started.set(args[args.indexOf("--name") + 1]!, args);
      // The proxy: answers start with ready, as dist/proxy.js does.
      child.stdin.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n").filter(Boolean)) {
          const m = JSON.parse(line);
          if (m.t === "start") child.stdout.write(`${JSON.stringify({ t: "ready", address: "172.30.0.2", port: 3128 })}\n`);
          if (m.t === "fetch") child.stdout.write(`${JSON.stringify({ t: "fetched", id: m.id, ok: true, url: m.url, status: 200, contentType: "text/html", body: Buffer.from("<p>hi</p>").toString("base64"), truncated: false })}\n`);
        }
      });
    }
    return child as never;
  }
}

function group(docker: FakeDocker, log = new MemoryLogger(), agentLimits: Record<string, ContainerLimits> = { "requirements-analyst": LIMITS, "web-reader": LIMITS }) {
  return new SessionGroup({
    docker: docker as unknown as DockerCli, runId: "R-0a1b2c", project: "demo", agentImageId: IMG, proxyImageId: `sha256:${"b".repeat(64)}`,
    proxyScript: "/opt/engine/dist/proxy.js", agentLimits, proxyLimits: { ...LIMITS, cpus: 0.5 }, maxPageBytes: 1 << 20,
    credential: { kind: "api_key", value: "sk-ant-api03-placeholder" }, log, platform: "linux", sleep: async () => undefined,
  });
}

describe("session group (SR-6, SR-7, SR-9, SR-14)", () => {
  it("opens an internal network, starts and checks the proxy, then hands it the credential over stdin", async () => {
    const d = new FakeDocker();
    const g = group(d);
    await g.open();
    const create = d.calls.filter((c) => c.args[0] === "network" && c.args[1] === "create").map((c) => c.args);
    expect(create[0]).toContain("--internal");
    expect(create[1]).not.toContain("--internal");
    const proxy = d.spawned[0]!;
    expect(proxy.args).toContain("name=factory-r-0a1b2c-int,alias=factory-proxy");
    expect(proxy.args).toContain("factory-r-0a1b2c-out");
    expect(proxy.args.join(" ")).not.toContain("sk-ant");
    expect(proxy.child.sent()[0]).toMatchObject({ t: "start", credential: { kind: "api_key", value: "sk-ant-api03-placeholder" }, dummyKey: DUMMY_KEY, internalSubnet: "172.30.0.0/16", blockedSubnets: ["172.30.0.0/16", "172.31.0.0/16"] });
  });

  it("starts an agent with a fresh credential, the dummy key, only the internal network, and values outside its arguments", async () => {
    const d = new FakeDocker();
    const g = group(d);
    await g.open();
    const wt = tmpdir();
    const a = await g.startAgent(analyst, wt, { sessionVolume: true });
    const run = d.calls.find((c) => c.args[0] === "run")!;
    expect(run.args.filter((x, i) => run.args[i - 1] === "--network")).toEqual(["factory-r-0a1b2c-int"]);
    expect(run.args.join(" ")).not.toContain(a.cred);
    expect(run.env!.ANTHROPIC_API_KEY).toBe(DUMMY_KEY);
    expect(run.env!.ANTHROPIC_BASE_URL).toBe(`http://factory-proxy:3128/gw/${a.cred}`);
    expect(run.env!.HTTPS_PROXY).toBe(`http://factory:${a.cred}@factory-proxy:3128`);
    for (const [k, v] of Object.entries(CONTAINER_FLAGS)) expect(run.env![k]).toBe(v);
    expect(Object.values(run.env!).join(" ")).not.toContain("sk-ant");
    expect(run.args).toContain(`type=bind,source=${wt},target=/workspace`);
    expect(run.args.some((x) => x.startsWith("type=volume,source=factory-r-0a1b2c-requirements-analyst-1-session"))).toBe(true);
    const b = await g.startAgent(reader, null);
    expect(b.cred).not.toBe(a.cred);
    const proxyIn = d.spawned[0]!.child.sent();
    expect(proxyIn.filter((m) => m.t === "grant").map((m) => [m.role, m.allow])).toEqual([["requirements-analyst", []], ["web-reader", ["*"]]]);
  });

  it("H-0087: each role's container gets that role's limits; a role without limits gets no container", async () => {
    const d = new FakeDocker();
    const small = { cpus: 1, memoryBytes: 1024 ** 3, pids: 128, tmpBytes: 256 * 1024 ** 2 };
    const g = group(d, new MemoryLogger(), { "requirements-analyst": LIMITS, "web-reader": small });
    await g.open();
    const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];
    await g.startAgent(analyst, tmpdir());
    await g.startAgent(reader, null);
    const runs = d.calls.filter((c) => c.args[0] === "run").map((c) => c.args);
    expect(runs.map((a) => [flag(a, "--cpus"), flag(a, "--memory"), flag(a, "--pids-limit")])).toEqual([
      ["1.5", `${LIMITS.memoryBytes}b`, "256"],
      ["1", `${small.memoryBytes}b`, "128"],
    ]);
    const proxy = d.spawned[0]!.args;
    expect([flag(proxy, "--cpus"), flag(proxy, "--pids-limit")]).toEqual(["0.5", "256"]);

    const bare = group(new FakeDocker(), new MemoryLogger(), { "requirements-analyst": LIMITS });
    await bare.open();
    await expect(bare.startAgent(reader, null)).rejects.toThrow(/no container limits for the web-reader role/);
  });

  it("stops a container that fails its check and revokes its credential; no session starts", async () => {
    const d = new FakeDocker();
    const g = group(d);
    await g.open();
    d.tamper = (name, doc) => {
      if (name.includes("analyst")) doc.HostConfig.CapAdd = ["SYS_ADMIN"];
    };
    await expect(g.startAgent(analyst, tmpdir())).rejects.toThrow(/capabilities added/);
    expect(d.calls.some((c) => c.args[0] === "rm" && c.args.includes("factory-r-0a1b2c-requirements-analyst-1"))).toBe(true);
    expect(d.spawned[0]!.child.sent().at(-1)!.t).toBe("revoke");
  });

  it("refuses to hand over the credential when the proxy fails its check", async () => {
    const d = new FakeDocker();
    d.tamper = (name, doc) => {
      if (name.endsWith("-proxy")) doc.Mounts.push({ Type: "bind", Source: "/", Destination: "/host", RW: true });
    };
    await expect(group(d).open()).rejects.toThrow(/failed its check/);
    expect(d.spawned[0]!.child.written).toEqual([]);
  });

  it("close removes containers, session volumes and networks", async () => {
    const d = new FakeDocker();
    const g = group(d);
    await g.open();
    await g.startAgent(analyst, tmpdir(), { sessionVolume: true });
    await g.close();
    const rm = d.calls.map((c) => c.args.join(" "));
    expect(rm).toContain("rm --force factory-r-0a1b2c-requirements-analyst-1");
    expect(rm).toContain("rm --force factory-r-0a1b2c-proxy");
    expect(rm).toContain("volume rm --force factory-r-0a1b2c-requirements-analyst-1-session");
    expect(rm).toContain("network rm factory-r-0a1b2c-int");
  });

  it("the proxy client resolves fetches by id and logs connections", async () => {
    const child = new FakeChild();
    const log = new MemoryLogger();
    const c = new ProxyClient(child as never, log);
    child.stdin.on("data", (d: Buffer) => {
      const m = JSON.parse(d.toString());
      child.stdout.write(`${JSON.stringify({ t: "log", kind: "fetch", host: "example.org" })}\n${JSON.stringify({ t: "fetched", id: m.id, ok: false, status: 403, reason: "host refused" })}\n`);
    });
    expect(await c.fetch("x".repeat(43), "https://example.org/")).toMatchObject({ ok: false, status: 403 });
    expect(log.text()).toContain('proxy {\\"kind\\":\\"fetch\\",\\"host\\":\\"example.org\\"}');
  });
});

describe("SR-10 session options and the FR-9 tool gate", () => {
  const log = new MemoryLogger();
  const base = { policy: analyst, worktree: tmpdir(), instructions: "You are the analyst.", factoryServer: { s: 1 }, factoryTools: ["interview_ask"], caps: CAPS, skillsPluginDir: "/opt/factory/skills", spawn: () => null as never, log };

  it("fixes the options", () => {
    const o = sessionOptions(base, new AbortController());
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers)).toEqual(["factory"]);
    expect(o.tools).toEqual(["Read", "Grep", "Glob", "Write", "Edit", "Skill"]);
    expect(o.allowedTools).toEqual(["mcp__factory__interview_ask"]);
    expect(o.disallowedTools).toEqual(["WebFetch"]);
    expect(o.permissionMode).toBe("default");
    expect(o.hooks).toEqual({});
    expect(o.systemPrompt).toBe("You are the analyst.");
    expect(o.plugins).toEqual([{ type: "local", path: "/opt/factory/skills" }]);
    expect(o.maxTurns).toBe(50);
    expect(o.env).toEqual(CONTAINER_FLAGS);
    expect(o.cwd).toBe("/workspace");
    const r = sessionOptions({ ...base, policy: reader, worktree: null, cwd: "/tmp", factoryTools: ["fetch_page"] }, new AbortController());
    expect(r.tools).toEqual(["WebSearch"]);
    expect(r.allowedTools).toEqual(["mcp__factory__fetch_page"]);
    expect(r.plugins).toEqual([]);
  });

  it("refuses to start without caps, instructions, or baked skills for a Skill role", () => {
    expect(() => sessionOptions({ ...base, caps: { maxTurns: 5, wallTimeMs: 1 } }, new AbortController())).toThrow(/maxOutputTokens or maxBudgetUsd/);
    expect(() => sessionOptions({ ...base, caps: { ...CAPS, maxTurns: 0 } }, new AbortController())).toThrow(/maxTurns/);
    expect(() => sessionOptions({ ...base, instructions: " " }, new AbortController())).toThrow(/instructions/);
    const { skillsPluginDir: _s, ...noSkills } = base;
    expect(() => sessionOptions(noSkills, new AbortController())).toThrow(/baked skills/);
  });

  it("maps container paths to the worktree and refuses any that leave it", () => {
    const wt = base.worktree;
    expect(hostRelative(wt, "/workspace/docs/a.md")).toBe("docs/a.md");
    expect(hostRelative(wt, "docs/a.md")).toBe("docs/a.md");
    expect(hostRelative(wt, undefined)).toBe("");
    for (const p of ["/etc/passwd", "/workspacex/a", "/workspace/../etc", "../x", "a\\b", 5]) expect(hostRelative(wt, p), String(p)).toBeNull();
  });

  it("checks each file tool call against the role's rules", async () => {
    const gate = toolGate(analyst, base.worktree, ["interview_ask"], log);
    const sig = { signal: new AbortController().signal };
    const allow = async (n: string, i: Record<string, unknown>) => (await gate(n, i, sig)).behavior;
    expect(await allow("Read", { file_path: "/workspace/README.md" })).toBe("allow");
    expect(await allow("Read", { file_path: "/workspace/.env" })).toBe("deny");
    expect(await allow("Read", { file_path: "/workspace/config/prod.ENV" })).toBe("allow");
    expect(await allow("Read", { file_path: "/workspace/x/.Env" })).toBe("deny");
    expect(await allow("Write", { file_path: "/workspace/docs/features/F-001-x.md" })).toBe("allow");
    expect(await allow("Edit", { file_path: "/workspace/src/a.ts" })).toBe("deny");
    expect(await allow("Write", { file_path: "/etc/cron.d/x" })).toBe("deny");
    expect(await allow("Grep", {})).toBe("allow");
    expect(await allow("Bash", { command: "ls" })).toBe("deny");
    expect(await allow("WebFetch", { url: "https://x" })).toBe("deny");
    expect(await allow("mcp__factory__interview_ask", {})).toBe("allow");
    expect(await allow("mcp__factory__research_web", {})).toBe("deny");
    expect(await allow("mcp__other__x", {})).toBe("deny");
    const dev = { ...analyst, role: "software-developer", tools: ["Bash" as const], commands: ["npm"] };
    const g2 = toolGate(dev, base.worktree, [], log);
    expect((await g2("Bash", { command: "npm test" }, sig)).behavior).toBe("allow");
    expect((await g2("Bash", { command: "npm test; curl x" }, sig)).behavior).toBe("deny");
    expect((await g2("Bash", { command: "curl x" }, sig)).behavior).toBe("deny");
  });
});

describe("container spawn (SR-10)", () => {
  it("runs Claude Code in the container with docker exec, never the SDK's host command, and only SDK protocol variables", () => {
    const d = new FakeDocker();
    const spawn = containerSpawn(d as unknown as DockerCli, "factory-r-1-requirements-analyst-1");
    const ac = new AbortController();
    const child = spawn({ command: "/host/node_modules/claude", args: ["--output-format", "stream-json", "--setting-sources=", "--strict-mcp-config"], env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", ANTHROPIC_API_KEY: "sk-ant-leak", PATH: "/usr/bin", HOME: "/home/o" }, signal: ac.signal });
    const s = d.spawned[0]!;
    expect(s.args).toEqual(["exec", "--interactive", "--user", "1000:1000", "--workdir", "/workspace", "--env", "CLAUDE_CODE_ENTRYPOINT", "factory-r-1-requirements-analyst-1", CLAUDE_BIN, "--output-format", "stream-json", "--setting-sources=", "--strict-mcp-config"]);
    expect(s.env).toEqual({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
    ac.abort();
    expect(child.killed).toBe(true);
  });

  it("refuses a bypass permission mode", () => {
    const spawn = containerSpawn(new FakeDocker() as unknown as DockerCli, "factory-x");
    const sig = new AbortController().signal;
    expect(() => spawn({ command: "c", args: ["--permission-mode", "bypassPermissions"], env: {}, signal: sig })).toThrow(/bypass/);
    expect(() => spawn({ command: "c", args: ["--dangerously-skip-permissions"], env: {}, signal: sig })).toThrow(/bypass/);
    expect(() => spawn({ command: "c", args: ["--permission-mode=bypassPermissions", "--setting-sources=", "--strict-mcp-config"], env: {}, signal: sig })).toThrow(/bypass/);
    expect(() => spawn({ command: "c", args: ["--strict-mcp-config"], env: {}, signal: sig })).toThrow(/setting-sources/);
  });
});

function fakeSdk(messages: SdkMessage[], hang = false): AgentSdk & { seen: SessionOptions[] } {
  const seen: SessionOptions[] = [];
  return {
    seen,
    createFactoryServer: (tools) => ({ tools: tools.map((t) => t.name) }),
    query: ({ options }) => {
      seen.push(options);
      return (async function* () {
        for (const m of messages) {
          if (options.abortController.signal.aborted) return;
          yield m;
        }
        if (hang) await new Promise((_r, rej) => options.abortController.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      })();
    },
  };
}

async function* oneTurn(): AsyncIterable<UserTurn> {
  yield { type: "user", message: { role: "user", content: "go" }, parent_tool_use_id: null, session_id: "" };
}

describe("running a session under SR-18 caps", () => {
  const opts = () => sessionOptions({ policy: analyst, worktree: tmpdir(), instructions: "i", factoryServer: {}, factoryTools: [], caps: CAPS, skillsPluginDir: "/s", spawn: () => null as never, log: new MemoryLogger() }, new AbortController());

  it("records the session id, logs WebSearch queries and reports usage", async () => {
    const ids: string[] = [];
    const searches: string[] = [];
    const sdk = fakeSdk([
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", session_id: "s-1", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "csv export libraries" } }], usage: { output_tokens: 10 } } },
      { type: "result", subtype: "success", session_id: "s-1", num_turns: 3, total_cost_usd: 0.02, usage: { input_tokens: 500, output_tokens: 12 }, result: "done" },
    ]);
    const out = await runSession(sdk, opts(), oneTurn(), CAPS, { onSessionId: (i) => ids.push(i), onWebSearch: (q) => searches.push(q) });
    expect(out).toMatchObject({ status: "complete", sessionId: "s-1", turns: 3, costUsd: 0.02, inputTokens: 500, outputTokens: 12, result: "done" });
    expect(ids).toEqual(["s-1"]);
    expect(searches).toEqual(["csv export libraries"]);
  });

  it("stops at the output-token cap and at the turn cap", async () => {
    const big = fakeSdk([
      { type: "assistant", session_id: "s", message: { usage: { output_tokens: 900 } } },
      { type: "assistant", session_id: "s", message: { usage: { output_tokens: 200 } } },
      { type: "result", subtype: "success", session_id: "s" },
    ]);
    const o = opts();
    expect(await runSession(big, o, oneTurn(), CAPS, {})).toMatchObject({ status: "cap", reason: "output tokens" });
    expect(o.abortController.signal.aborted).toBe(true);
    const turns = fakeSdk([{ type: "result", subtype: "error_max_turns", session_id: "s" }]);
    expect(await runSession(turns, opts(), oneTurn(), CAPS, {})).toMatchObject({ status: "cap", reason: "turns" });
  });

  it("stops at the wall-time cap", async () => {
    const sdk = fakeSdk([{ type: "system", subtype: "init", session_id: "s" }], true);
    const out = await runSession(sdk, opts(), oneTurn(), { ...CAPS, wallTimeMs: 20 }, {});
    expect(out).toMatchObject({ status: "cap", reason: "wall time" });
  });
});

describe("factory MCP tools (Interview tools v1.0, H-0083)", () => {
  it("exposes exactly the five interview tools, and labels research as untrusted", async () => {
    const calls: string[] = [];
    const t = Object.fromEntries(["interview_ask", "interview_propose_assumption", "interview_revise", "research_web", "interview_spec_ready"].map((n) => [n, async () => {
      calls.push(n);
      return n === "research_web" ? { ok: true, result: { summary: "s", sources: ["https://example.org/"] } } : { ok: false, error: { code: "invalid", message: "m" } };
    }])) as unknown as InterviewTools;
    const tools = analystTools(t);
    expect(tools.map((x) => x.name)).toEqual(["interview_ask", "interview_propose_assumption", "interview_revise", "research_web", "interview_spec_ready"]);
    for (const x of tools) expect(x.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    const r = await tools[3]!.handler({ query: "q" });
    expect(r.content[0]!.text).toBe(UNTRUSTED_LABEL);
    expect(JSON.parse(r.content[1]!.text)).toEqual({ summary: "s", sources: ["https://example.org/"] });
    expect(await tools[0]!.handler({})).toEqual({ content: [{ type: "text", text: JSON.stringify({ error: { code: "invalid", message: "m" } }) }], isError: true });
    expect(toCallResult({ ok: true, result: { item: 1 } })).toEqual({ content: [{ type: "text", text: '{"item":1}' }] });
  });

  it("fetch_page: strips the page, records its address as a source, and refuses non-https", async () => {
    const sources: string[] = [];
    const tool = fetchPageTool(async (url) => ({ ok: true, url, status: 200, contentType: "text/html", body: Buffer.from("<p>Hi<!-- secret --></p>\u200b").toString("base64"), truncated: false }), { maxChars: 100 }, (u) => sources.push(u));
    const r = await tool.handler({ url: "https://example.org/a" });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ url: "https://example.org/a", text: "Hi", truncated: false });
    expect(sources).toEqual(["https://example.org/a"]);
    for (const bad of [{ url: "http://example.org" }, { url: "file:///etc/passwd" }, { url: "https://x", extra: 1 }, {}, null]) {
      expect((await tool.handler(bad)).isError, JSON.stringify(bad)).toBe(true);
    }
    const refused = fetchPageTool(async () => ({ ok: false, status: 403 }), { maxChars: 10 }, () => undefined);
    expect(JSON.parse((await refused.handler({ url: "https://10.0.0.1/" })).content[0]!.text).error.code).toBe("refused");
  });
});

describe("an analyst session end to end, with fakes (FR-8 to FR-11)", () => {
  const limits = {
    analyst: CAPS, reader: CAPS, research: { perQuestion: 2, perSession: 4 }, page: { maxChars: 1000 }, summaryMaxChars: 2000, maxSources: 10,
  };
  function input(d: FakeDocker, sdk: AgentSdk, over: Partial<AnalystRunInput> = {}): AnalystRunInput & { order: string[] } {
    const order: string[] = [];
    const tools = Object.fromEntries(["interview_ask", "interview_propose_assumption", "interview_revise", "research_web", "interview_spec_ready"].map((n) => [n, async () => ({ ok: true, result: {} })])) as unknown as InterviewTools;
    return {
      order, sdk, docker: d as unknown as DockerCli, group: group(d), manifest: policyDoc(), worktree: tmpdir(),
      instructions: { analyst: "analyst instructions", reader: "reader instructions" }, limits, skillsPluginDir: "/opt/factory/skills",
      billingCheck: () => null, tools: (r) => (order.push(r ? "tools+research" : "tools"), tools), turns: oneTurn(),
      commit: async () => ({ status: "unchanged" }),
      onSessionId: (id) => void order.push(`session ${id}`), onBreach: async () => void order.push("breach"), log: new MemoryLogger(), ...over,
    };
  }

  it("refuses before touching docker when billing or the policy is wrong", async () => {
    const d = new FakeDocker();
    const sdk = fakeSdk([]);
    await expect(runAnalystSession(input(d, sdk, { billingCheck: () => "tokens mode, subscription login" }))).rejects.toBeInstanceOf(SessionRefused);
    await expect(runAnalystSession(input(d, sdk, { manifest: policyDoc({ "requirements-analyst": undefined }) }))).rejects.toThrow(/Role policy/);
    expect(d.calls).toEqual([]);
    expect(sdk.seen).toEqual([]);
  });

  it("runs the session in its container, stops it before the commit, files a breach, and cleans up", async () => {
    const d = new FakeDocker();
    const sdk = fakeSdk([{ type: "system", subtype: "init", session_id: "s-9" }, { type: "result", subtype: "success", session_id: "s-9", result: "ok" }]);
    const agentGone = () => d.calls.some((c) => c.args.join(" ") === "rm --force factory-r-0a1b2c-requirements-analyst-1");
    const i = input(d, sdk);
    i.commit = async () => (i.order.push(`commit, container gone: ${agentGone()}`), { status: "rejected", breaches: [{ path: ".github/x", reason: "not_allowed" }] });
    const r = await runAnalystSession(i);
    expect(r.outcome.status).toBe("complete");
    expect(r.commit.status).toBe("rejected");
    expect(i.order).toEqual(["tools+research", "session s-9", "commit, container gone: true", "breach"]);
    const o = sdk.seen[0]!;
    expect(o.systemPrompt).toBe("analyst instructions");
    expect(o.allowedTools).toHaveLength(5);
    expect(d.calls.map((c) => c.args.join(" "))).toContain("network rm factory-r-0a1b2c-int");
  });
});
