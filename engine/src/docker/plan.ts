import * as path from "node:path";
import { DOCKER_NAME_RE, DockerError } from "./cli";

/** Container limits, all from change-controlled config (SR-18); none has a default. */
export interface ContainerLimits {
  cpus: number;
  memoryBytes: number;
  pids: number;
  tmpBytes: number;
}

export type MountSpec =
  | { type: "bind"; source: string; target: string; readOnly: boolean }
  | { type: "volume"; name: string; target: string; readOnly: boolean };

export interface ContainerSpec {
  name: string;
  /** The image id (`sha256:<64 hex>`), so what runs is exactly what was checked. */
  imageId: string;
  /** The agent image's non-root user; the base image's `node` user is 1000. */
  user: string;
  networks: string[];
  /** Another name on the first network, for the proxy only. */
  alias?: string;
  mounts: MountSpec[];
  limits: ContainerLimits;
  /** Variable names only: values reach docker through its own environment, never an argument (SR-1). */
  envNames: string[];
  workdir?: string;
  /** Keep stdin open (the proxy's control channel). */
  interactive: boolean;
  command: string[];
  labels: Record<string, string>;
  /**
   * Further size-capped tmpfs paths besides /tmp, for software that insists on
   * writing there under a read-only root (the LiteLLM router's cache folder).
   * Each is listed here, checked by `inspectMismatches`, and holds nothing across a restart.
   */
  extraTmpfs?: string[];
}

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const TARGET_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function checkNum(v: number, what: string, int: boolean): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (int && !Number.isSafeInteger(v))) throw new DockerError(`${what} must be a positive ${int ? "integer" : "number"}`);
}

export function checkLimits(l: ContainerLimits): void {
  checkNum(l.cpus, "cpus", false);
  checkNum(l.memoryBytes, "memory", true);
  checkNum(l.pids, "pids", true);
  checkNum(l.tmpBytes, "tmp size", true);
  if (Math.round(l.cpus * 1e9) !== l.cpus * 1e9) throw new DockerError("cpus has too many decimals");
}

/** A host path in a `--mount` value: absolute, and without the characters that syntax gives meaning to. */
function checkSource(p: string): void {
  if (!path.isAbsolute(p) || /[,"=\0\r\n]/.test(p)) throw new DockerError("a mount source must be an absolute path without , \" or =");
}

function checkSpec(s: ContainerSpec): void {
  if (!DOCKER_NAME_RE.test(s.name)) throw new DockerError("bad container name");
  if (!IMAGE_ID_RE.test(s.imageId)) throw new DockerError("the image must be named by id");
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(s.user)) throw new DockerError("the user must be a non-root uid:gid");
  if (s.networks.length === 0 || s.networks.some((n) => !DOCKER_NAME_RE.test(n))) throw new DockerError("bad network");
  if (s.alias !== undefined && !/^[a-z][a-z0-9-]{0,62}$/.test(s.alias)) throw new DockerError("bad alias");
  for (const m of s.mounts) {
    if (!TARGET_RE.test(m.target) || m.target.includes("..")) throw new DockerError("bad mount target");
    if (m.type === "bind") checkSource(m.source);
    else if (!DOCKER_NAME_RE.test(m.name)) throw new DockerError("bad volume name");
  }
  if (new Set(s.mounts.map((m) => m.target)).size !== s.mounts.length || s.mounts.some((m) => m.target === "/tmp")) throw new DockerError("mount targets must be distinct and not /tmp");
  const targets = new Set([...s.mounts.map((m) => m.target), "/tmp"]);
  for (const t of s.extraTmpfs ?? []) {
    if (!TARGET_RE.test(t) || t.includes("..") || targets.has(t)) throw new DockerError("bad tmpfs path");
    targets.add(t);
  }
  for (const n of s.envNames) if (!ENV_RE.test(n)) throw new DockerError("bad variable name");
  if (s.workdir !== undefined && !TARGET_RE.test(s.workdir)) throw new DockerError("bad workdir");
  for (const [k, v] of Object.entries(s.labels)) if (!/^factory\.[a-z.-]{1,40}$/.test(k) || !/^[A-Za-z0-9._:-]{0,200}$/.test(v)) throw new DockerError("bad label");
  checkLimits(s.limits);
}

export const TMP_OPTIONS = (bytes: number) => `rw,nosuid,nodev,size=${bytes}`;

/**
 * `docker run` arguments for an agent or proxy container (ADR 0015, FR-8):
 * non-root, read-only root, every capability dropped, no new privileges,
 * CPU, memory and pids limits, a size-capped /tmp, exactly the given mounts
 * and networks, no log file (pages and answers pass through stdio), and the
 * image by id with no pull.
 */
export function runArgs(s: ContainerSpec): string[] {
  checkSpec(s);
  // An interactive container (the proxy) runs attached: its stdio is the engine's control channel.
  const a = ["run", ...(s.interactive ? ["--interactive"] : ["--detach"]), "--rm", "--init", "--pull", "never", "--name", s.name, "--user", s.user,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--cpus", String(s.limits.cpus), "--memory", `${s.limits.memoryBytes}b`, "--memory-swap", `${s.limits.memoryBytes}b`,
    "--pids-limit", String(s.limits.pids), "--tmpfs", `/tmp:${TMP_OPTIONS(s.limits.tmpBytes)}`,
    "--log-driver", "none", "--restart", "no"];
  for (const t of s.extraTmpfs ?? []) a.push("--tmpfs", `${t}:${TMP_OPTIONS(s.limits.tmpBytes)}`);
  s.networks.forEach((n, i) => a.push("--network", i === 0 && s.alias ? `name=${n},alias=${s.alias}` : n));
  for (const m of s.mounts) {
    const src = m.type === "bind" ? `type=bind,source=${m.source}` : `type=volume,source=${m.name}`;
    a.push("--mount", `${src},target=${m.target}${m.readOnly ? ",readonly" : ""}`);
  }
  for (const n of s.envNames) a.push("--env", n);
  if (s.workdir) a.push("--workdir", s.workdir);
  for (const [k, v] of Object.entries(s.labels)) a.push("--label", `${k}=${v}`);
  a.push(s.imageId, ...s.command);
  return a;
}

/** An internal network: no route out (SR-6). */
export function internalNetworkArgs(name: string, labels: Record<string, string>): string[] {
  if (!DOCKER_NAME_RE.test(name)) throw new DockerError("bad network name");
  const a = ["network", "create", "--driver", "bridge", "--internal"];
  for (const [k, v] of Object.entries(labels)) a.push("--label", `${k}=${v}`);
  return [...a, name];
}

export function outsideNetworkArgs(name: string, labels: Record<string, string>): string[] {
  if (!DOCKER_NAME_RE.test(name)) throw new DockerError("bad network name");
  const a = ["network", "create", "--driver", "bridge"];
  for (const [k, v] of Object.entries(labels)) a.push("--label", `${k}=${v}`);
  return [...a, name];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * How Docker Desktop reports a bind source: on Linux the path itself; on
 * macOS and Windows the daemon runs in a VM and may prefix or rewrite it.
 */
export function bindSourceMatches(platform: NodeJS.Platform, expected: string, reported: string): boolean {
  if (reported === expected) return true;
  if (platform === "darwin") return reported === `/host_mnt${expected}`;
  if (platform === "win32") {
    const m = /^([A-Za-z]):\\(.*)$/.exec(expected);
    if (!m) return false;
    const unix = `${m[1]!.toLowerCase()}/${m[2]!.split("\\").join("/")}`;
    return reported === `/run/desktop/mnt/host/${unix}` || reported === `/mnt/host/${unix}` || reported === expected.split("\\").join("/");
  }
  return false;
}

/**
 * SR-14: after each start, `docker inspect` must show exactly what was asked
 * for. Returns the mismatches; any one stops the container.
 */
export function inspectMismatches(spec: ContainerSpec, inspected: unknown, platform: NodeJS.Platform = process.platform): string[] {
  const bad: string[] = [];
  const doc = Array.isArray(inspected) ? inspected[0] : inspected;
  if (!isObj(doc) || !isObj(doc.HostConfig) || !isObj(doc.Config) || !isObj(doc.State)) return ["inspect output is not a container"];
  const h = doc.HostConfig;
  const c = doc.Config;
  if (doc.Name !== `/${spec.name}`) bad.push("name");
  if (doc.Image !== spec.imageId) bad.push("image");
  if (c.User !== spec.user) bad.push("user");
  if (doc.State.Running !== true) bad.push("not running");
  if (h.ReadonlyRootfs !== true) bad.push("root not read-only");
  if (h.Privileged !== false) bad.push("privileged");
  const capDrop = Array.isArray(h.CapDrop) ? h.CapDrop.map(String) : [];
  if (!capDrop.some((x) => x.toUpperCase() === "ALL" || x.toUpperCase() === "CAP_ALL")) bad.push("capabilities not dropped");
  if (Array.isArray(h.CapAdd) && h.CapAdd.length > 0) bad.push("capabilities added");
  const so = Array.isArray(h.SecurityOpt) ? h.SecurityOpt.map(String) : [];
  if (!so.includes("no-new-privileges:true") && !so.includes("no-new-privileges")) bad.push("no-new-privileges missing");
  if (so.some((x) => /unconfined/.test(x))) bad.push("unconfined security profile");
  if (h.NanoCpus !== Math.round(spec.limits.cpus * 1e9)) bad.push("cpus");
  if (h.Memory !== spec.limits.memoryBytes) bad.push("memory");
  if (h.PidsLimit !== spec.limits.pids) bad.push("pids");
  for (const k of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"]) if (h[k] === "host") bad.push(`${k} host`);
  if (Array.isArray(h.Devices) && h.Devices.length > 0) bad.push("devices");
  if (Array.isArray(h.Binds) && h.Binds.length > 0) bad.push("binds");
  if (Array.isArray(h.VolumesFrom) && h.VolumesFrom.length > 0) bad.push("volumes-from");
  if (!isObj(h.LogConfig) || h.LogConfig.Type !== "none") bad.push("log driver");
  const tmpfs = isObj(h.Tmpfs) ? h.Tmpfs : {};
  const wantTmpfs = ["/tmp", ...(spec.extraTmpfs ?? [])];
  if (Object.keys(tmpfs).sort().join() !== [...wantTmpfs].sort().join() || wantTmpfs.some((t) => tmpfs[t] !== TMP_OPTIONS(spec.limits.tmpBytes))) bad.push("tmpfs");
  if (h.NetworkMode !== spec.networks[0]) bad.push("network mode");
  const nets = isObj(doc.NetworkSettings) && isObj(doc.NetworkSettings.Networks) ? Object.keys(doc.NetworkSettings.Networks).sort() : [];
  if (nets.join() !== [...spec.networks].sort().join()) bad.push("networks");
  const mounts = Array.isArray(doc.Mounts) ? doc.Mounts : [];
  if (mounts.length !== spec.mounts.length) bad.push("mount count");
  for (const want of spec.mounts) {
    const got = mounts.find((m) => isObj(m) && m.Destination === want.target) as Record<string, unknown> | undefined;
    if (!got) {
      bad.push(`mount ${want.target} missing`);
      continue;
    }
    if (got.Type !== want.type || got.RW !== !want.readOnly) bad.push(`mount ${want.target}`);
    if (want.type === "bind" && !(typeof got.Source === "string" && bindSourceMatches(platform, want.source, got.Source))) bad.push(`mount ${want.target} source`);
    if (want.type === "volume" && got.Name !== want.name) bad.push(`mount ${want.target} volume`);
  }
  return bad;
}

/** SR-6: the agents' network must be internal. */
export function networkMismatches(name: string, inspected: unknown, internal: boolean): string[] {
  const doc = Array.isArray(inspected) ? inspected[0] : inspected;
  if (!isObj(doc)) return ["inspect output is not a network"];
  const bad: string[] = [];
  if (doc.Name !== name) bad.push("name");
  if (doc.Internal !== internal) bad.push(internal ? "not internal" : "internal");
  if (doc.Driver !== "bridge") bad.push("driver");
  return bad;
}

/** The subnets of a network, which the proxy refuses as destinations (SR-8). */
export function networkSubnets(inspected: unknown): string[] {
  const doc = Array.isArray(inspected) ? inspected[0] : inspected;
  const cfg = isObj(doc) && isObj(doc.IPAM) && Array.isArray(doc.IPAM.Config) ? doc.IPAM.Config : [];
  return cfg.filter(isObj).map((x) => x.Subnet).filter((s): s is string => typeof s === "string");
}
