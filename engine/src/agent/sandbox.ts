import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { DockerCli, DockerError, dockerName } from "../docker/cli";
import { ContainerLimits, ContainerSpec, MountSpec, inspectMismatches, internalNetworkArgs, networkMismatches, networkSubnets, outsideNetworkArgs, runArgs } from "../docker/plan";
import type { Logger } from "../log";
import type { RolePolicy } from "../policy/role-policy";
import type { FromProxy, ProxyStart, ToProxy } from "../proxy/main";
import { PROXY_PORT } from "../proxy/main";
import type { ModelCredential } from "../proxy/server";
import { AGENT_USER, CONTAINER_FLAGS, WORKSPACE } from "./session";

export const PROXY_ALIAS = "factory-proxy";
/** What agents send as their API key. It is no credential; the proxy swaps in the real one (SR-9). */
export const DUMMY_KEY = "factory-dummy-key-not-a-credential";
const PROXY_SCRIPT = "/factory/proxy.js";
const SESSION_HOME = "/home/node";
const START_TIMEOUT_MS = 30_000;

export interface GroupConfig {
  docker: DockerCli;
  /** The run this group serves; its id names every network, container and volume. */
  runId: string;
  project: string;
  /** The project's agent image, by id (built from the pinned base image). */
  agentImageId: string;
  /** The pinned base image, by id, for the proxy sidecar. */
  proxyImageId: string;
  /** The bundled proxy (dist/proxy.js) on the host, mounted read-only. */
  proxyScript: string;
  /** H-0087, by role name. A role without an entry gets no container. */
  agentLimits: Record<string, ContainerLimits>;
  proxyLimits: ContainerLimits;
  maxPageBytes: number;
  credential: ModelCredential;
  log: Logger;
  platform?: NodeJS.Platform;
  sleep?(ms: number): Promise<void>;
}

export interface AgentContainer {
  name: string;
  role: string;
  cred: string;
  cwd: string;
  sessionVolume?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The run's own session volume, kept across resumes until the run ends. */
export function runVolume(runId: string): string {
  return dockerName(runId.toLowerCase(), "session");
}

/** The engine's end of the proxy's stdio channel. */
export class ProxyClient {
  private next = 1;
  private readonly pending = new Map<number, (m: Extract<FromProxy, { t: "fetched" }>) => void>();
  private readyWait: { resolve(v: { address: string }): void; reject(e: Error): void } | null = null;

  constructor(private readonly child: Pick<ChildProcess, "stdin" | "stdout" | "on">, private readonly log: Logger) {
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    child.on("exit", () => {
      this.readyWait?.reject(new DockerError("the proxy stopped"));
      for (const r of this.pending.values()) r({ t: "fetched", id: 0, ok: false, status: 502, reason: "the proxy stopped" });
      this.pending.clear();
    });
  }

  private onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(raw)) return;
    const m = raw as unknown as FromProxy;
    if (m.t === "ready" && typeof m.address === "string") this.readyWait?.resolve({ address: m.address });
    else if (m.t === "error") this.readyWait?.reject(new DockerError(`proxy: ${String(m.reason).slice(0, 200)}`));
    else if (m.t === "fetched") {
      const r = this.pending.get(m.id);
      this.pending.delete(m.id);
      r?.(m);
    } else if (m.t === "log") {
      // The proxy's record of each connection (SR-4, SR-21). It never holds a credential.
      const { t: _t, ...rest } = m;
      this.log.info(`proxy ${JSON.stringify(rest).slice(0, 1000)}`);
    }
  }

  send(m: ToProxy): void {
    this.child.stdin!.write(`${JSON.stringify(m)}\n`);
  }

  start(m: ProxyStart, timeoutMs = START_TIMEOUT_MS): Promise<{ address: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DockerError("the proxy didn't start")), timeoutMs);
      this.readyWait = {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.send(m);
    });
  }

  fetch(cred: string, url: string): Promise<Extract<FromProxy, { t: "fetched" }>> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ t: "fetch", id, cred, url });
    });
  }
}

/**
 * One run's containers (FR-8, ADR 0015): an internal network with no route
 * out, an outside network only the proxy joins, the proxy sidecar, and an
 * agent container per session. Every container is checked with
 * `docker inspect` after it starts and stopped on any mismatch (SR-14).
 * Nothing is shared with another run or project (SR-16).
 */
export class SessionGroup {
  readonly internal: string;
  readonly outside: string;
  readonly proxyName: string;
  private proxy: ProxyClient | null = null;
  private proxyChild: ChildProcess | null = null;
  private readonly agents = new Map<string, AgentContainer>();
  private readonly volumes = new Set<string>();
  private subnets: string[] = [];
  private seq = 0;

  constructor(private readonly c: GroupConfig) {
    const id = c.runId.toLowerCase();
    this.internal = dockerName(id, "int");
    this.outside = dockerName(id, "out");
    this.proxyName = dockerName(id, "proxy");
  }

  private labels(): Record<string, string> {
    return { "factory.run": this.c.runId, "factory.project": this.c.project };
  }

  private sleep(ms: number): Promise<void> {
    return this.c.sleep ? this.c.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private async inspect(kind: "container" | "network", name: string): Promise<unknown> {
    return JSON.parse(await this.c.docker.out([kind, "inspect", name]));
  }

  /** Waits for the container to run, then checks it; any mismatch stops it (SR-14, SR-2). */
  private async verify(spec: ContainerSpec): Promise<void> {
    let last: string[] = ["not running"];
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 250) {
      let doc: unknown = null;
      try {
        doc = await this.inspect("container", spec.name);
      } catch {
        // Not created yet.
      }
      if (doc) {
        last = inspectMismatches(spec, doc, this.c.platform);
        if (last.length === 0) return;
        if (!(last.length === 1 && last[0] === "not running")) break;
      }
      await this.sleep(250);
    }
    await this.c.docker.run(["rm", "--force", spec.name], { okCodes: [1] }).catch(() => undefined);
    throw new DockerError(`container ${spec.name} failed its check: ${last.join(", ")}`);
  }

  async open(): Promise<void> {
    await this.c.docker.run(internalNetworkArgs(this.internal, this.labels()));
    await this.c.docker.run(outsideNetworkArgs(this.outside, this.labels()));
    const bad = networkMismatches(this.internal, await this.inspect("network", this.internal), true);
    if (bad.length) throw new DockerError(`network ${this.internal}: ${bad.join(", ")}`);
    this.subnets = networkSubnets(await this.inspect("network", this.internal));
    const internalSubnet = this.subnets.find((s) => s.includes("."));
    if (!internalSubnet) throw new DockerError("the internal network has no IPv4 subnet");
    const outsideSubnets = networkSubnets(await this.inspect("network", this.outside));

    const spec: ContainerSpec = {
      name: this.proxyName,
      imageId: this.c.proxyImageId,
      user: AGENT_USER,
      networks: [this.internal, this.outside],
      alias: PROXY_ALIAS,
      mounts: [{ type: "bind", source: this.c.proxyScript, target: PROXY_SCRIPT, readOnly: true }],
      limits: this.c.proxyLimits,
      envNames: [],
      interactive: true,
      command: ["node", PROXY_SCRIPT],
      labels: this.labels(),
    };
    const child = this.c.docker.spawn(runArgs(spec));
    child.stderr?.resume();
    this.proxyChild = child;
    this.proxy = new ProxyClient(child, this.c.log);
    await this.verify(spec);
    // The credential goes over stdin only after the container passed its check.
    await this.proxy.start({
      t: "start",
      credential: this.c.credential,
      dummyKey: DUMMY_KEY,
      internalSubnet,
      blockedSubnets: [...this.subnets, ...outsideSubnets],
      maxPageBytes: this.c.maxPageBytes,
    });
  }

  /** An agent container for one session, with its own proxy credential bound to its role (SR-7). */
  /**
   * `sessionVolume: true` gives the session a volume that `close()` removes.
   * `"run"` gives it the run's own volume (`runVolume`), created if missing
   * and kept across groups, so a resumed run finds its SDK session (FR-14);
   * the caller removes it when the run ends.
   */
  async startAgent(policy: RolePolicy, worktree: string | null, o: { sessionVolume?: boolean | "run" } = {}): Promise<AgentContainer> {
    if (!this.proxy) throw new DockerError("the group isn't open");
    const limits = Object.prototype.hasOwnProperty.call(this.c.agentLimits, policy.role) ? this.c.agentLimits[policy.role] : undefined;
    if (!limits) throw new DockerError(`no container limits for the ${policy.role} role`);
    const n = ++this.seq;
    const name = dockerName(this.c.runId.toLowerCase(), policy.role, String(n));
    const cred = crypto.randomBytes(32).toString("base64url");
    const mounts: MountSpec[] = [];
    if (worktree) {
      const writes = policy.write.allow.some((g) => !g.startsWith(".factory/"));
      mounts.push({ type: "bind", source: worktree, target: WORKSPACE, readOnly: !writes });
    }
    let volume: string | undefined;
    if (o.sessionVolume === "run") {
      volume = runVolume(this.c.runId);
      const have = await this.c.docker.run(["volume", "inspect", volume], { okCodes: [1] });
      if (have.code === 0) {
        // Only a volume this run made is mounted: a name alone could be anyone's.
        const doc = JSON.parse(have.stdout.toString()) as unknown;
        const v = Array.isArray(doc) ? doc[0] : doc;
        const labels = isObj(v) && isObj(v.Labels) ? v.Labels : {};
        if (labels["factory.run"] !== this.c.runId || labels["factory.project"] !== this.c.project) throw new DockerError(`volume ${volume} isn't this run's`);
      } else {
        await this.c.docker.run(["volume", "create", ...Object.entries(this.labels()).flatMap(([k, v]) => ["--label", `${k}=${v}`]), volume]);
      }
      mounts.push({ type: "volume", name: volume, target: `${SESSION_HOME}/.claude`, readOnly: false });
    } else if (o.sessionVolume) {
      volume = dockerName(this.c.runId.toLowerCase(), policy.role, String(n), "session");
      await this.c.docker.run(["volume", "create", ...Object.entries(this.labels()).flatMap(([k, v]) => ["--label", `${k}=${v}`]), volume]);
      this.volumes.add(volume);
      mounts.push({ type: "volume", name: volume, target: `${SESSION_HOME}/.claude`, readOnly: false });
    }
    const values: Record<string, string> = {
      ...CONTAINER_FLAGS,
      ANTHROPIC_BASE_URL: `http://${PROXY_ALIAS}:${PROXY_PORT}/gw/${cred}`,
      ANTHROPIC_API_KEY: DUMMY_KEY,
      HTTPS_PROXY: `http://factory:${cred}@${PROXY_ALIAS}:${PROXY_PORT}`,
      NO_PROXY: PROXY_ALIAS,
      HOME: SESSION_HOME,
      CLAUDE_CONFIG_DIR: o.sessionVolume ? `${SESSION_HOME}/.claude` : "/tmp/claude",
    };
    const cwd = worktree ? WORKSPACE : "/tmp";
    const spec: ContainerSpec = {
      name,
      imageId: this.c.agentImageId,
      user: AGENT_USER,
      networks: [this.internal],
      mounts,
      limits,
      envNames: Object.keys(values),
      workdir: cwd,
      interactive: false,
      command: ["sleep", "infinity"],
      labels: { ...this.labels(), "factory.role": policy.role },
    };
    this.proxy.send({ t: "grant", cred, session: name, role: policy.role, allow: policy.network });
    try {
      await this.c.docker.run(runArgs(spec), { env: values });
      await this.verify(spec);
    } catch (e) {
      this.proxy.send({ t: "revoke", cred });
      throw e;
    }
    const a: AgentContainer = { name, role: policy.role, cred, cwd, ...(volume ? { sessionVolume: volume } : {}) };
    this.agents.set(name, a);
    return a;
  }

  /** fetch_page's network half, as the web reader session `a` (SR-21). */
  fetch(a: AgentContainer, url: string): ReturnType<ProxyClient["fetch"]> {
    if (!this.proxy || !this.agents.has(a.name)) throw new DockerError("no such session");
    return this.proxy.fetch(a.cred, url);
  }

  /** Ends a session: its credential is dropped at once (SR-7), then its container goes. */
  async stopAgent(a: AgentContainer): Promise<void> {
    this.proxy?.send({ t: "revoke", cred: a.cred });
    this.agents.delete(a.name);
    await this.c.docker.run(["rm", "--force", a.name], { okCodes: [1] }).catch(() => undefined);
  }

  /** Ends the run: every container, both networks, and the session volumes, whose files are sensitive. */
  async close(): Promise<void> {
    for (const a of [...this.agents.values()]) await this.stopAgent(a);
    this.proxyChild?.stdin?.end();
    const d = this.c.docker;
    await d.run(["rm", "--force", this.proxyName], { okCodes: [1] }).catch(() => undefined);
    for (const v of this.volumes) await d.run(["volume", "rm", "--force", v], { okCodes: [1] }).catch(() => this.c.log.warn(`volume ${v} wasn't removed`));
    this.volumes.clear();
    for (const n of [this.internal, this.outside]) await d.run(["network", "rm", n], { okCodes: [1] }).catch(() => this.c.log.warn(`network ${n} wasn't removed`));
  }
}
