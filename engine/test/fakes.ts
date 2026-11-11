// Fakes for docker and the Agent SDK, shared by the agent and engine tests.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import type { AgentSdk, SdkMessage, SessionOptions, UserTurn } from "../src/agent/sdk";
import { DockerError } from "../src/docker/cli";


/** What `docker inspect` would report for a container started with these arguments. */
export function inspectFor(args: string[], running = true): Record<string, unknown> {
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

export class FakeChild extends EventEmitter {
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
export class FakeDocker {
  calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  started = new Map<string, string[]>();
  spawned: Array<{ args: string[]; env: Record<string, string>; child: FakeChild }> = [];
  tamper: ((name: string, d: Record<string, any>) => void) | null = null;
  /** Volumes and images by name, with their labels. */
  volumes = new Map<string, Record<string, string>>();
  images = new Map<string, { Id: string; Config: { User: string; Labels: Record<string, string> } }>();
  /** What `ps`, `network ls` and `volume ls` list beyond what this fake made (an earlier engine's leftovers). */
  leftovers = { containers: [] as string[], networks: [] as string[] };
  /** Makes `buildx version` fail as a client without the plugin would. */
  noBuildx = false;
  /** Makes a call fail as a stopped daemon would. */
  down = false;

  async run(args: string[], o: { env?: Record<string, string>; okCodes?: number[] } = {}) {
    this.calls.push({ args, ...(o.env ? { env: o.env } : {}) });
    if (this.down) throw new DockerError("Cannot connect to the Docker daemon");
    if (args[0] === "run") this.started.set(args[args.indexOf("--name") + 1]!, args);
    const labels = () => Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "--label" ? [a.split(/=(.*)/s).slice(0, 2) as [string, string]] : [])));
    if (args[0] === "volume" && args[1] === "create") this.volumes.set(args.at(-1)!, labels());
    if (args[0] === "volume" && args[1] === "rm") this.volumes.delete(args.at(-1)!);
    if (args[0] === "rm") this.started.delete(args.at(-1)!);
    if (args[0] === "buildx" && args[1] === "version" && this.noBuildx) throw new DockerError("docker: 'buildx' is not a docker command.");
    if (args[0] === "buildx" && args[1] === "build") {
      const id = `sha256:${String(this.images.size + 1).padStart(64, "e")}`;
      const img = { Id: id, Config: { User: "1000:1000", Labels: labels() } };
      this.images.set(id, img);
      this.images.set(args[args.indexOf("--tag") + 1]!, img);
      fs.writeFileSync(args[args.indexOf("--iidfile") + 1]!, id);
    }
    let code = 0;
    let out = "";
    if (args[0] === "volume" && args[1] === "inspect") {
      const v = this.volumes.get(args[2]!);
      if (v) out = JSON.stringify([{ Name: args[2], Labels: v }]);
      else code = 1;
    } else if (args[0] === "image" && args[1] === "inspect") {
      const img = this.images.get(args[2]!);
      if (img) out = JSON.stringify([img]);
      else if (args[2]!.startsWith("node:")) out = JSON.stringify([{ Id: `sha256:${"b".repeat(64)}`, RepoDigests: [`node@${args[2]!.split("@")[1]}`] }]);
      else code = 1;
    } else if (args[0] === "ps") out = this.leftovers.containers.join("\n");
    else if (args[0] === "network" && args[1] === "ls") out = this.leftovers.networks.join("\n");
    else if (args[0] === "volume" && args[1] === "ls") out = [...this.volumes.keys()].join("\n");
    else out = this.answer(args);
    if (code !== 0 && !o.okCodes?.includes(code)) throw new DockerError(`docker ${args[0]} failed`);
    return { code, signal: null, stdout: Buffer.from(out), stderr: "", timedOut: false };
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

export function fakeSdk(messages: SdkMessage[], hang = false): AgentSdk & { seen: SessionOptions[] } {
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

export async function* oneTurn(): AsyncIterable<UserTurn> {
  yield { type: "user", message: { role: "user", content: "go" }, parent_tool_use_id: null, session_id: "" };
}
