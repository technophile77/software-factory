// A fake `docker` client program for the milestone 2 tests that run without
// Docker (AC-9, AC-13, AC-21). The engine drives Docker only through the
// `docker` command line (OQ-5), so the fake sits at that process boundary,
// like the fake gitleaks: it keeps containers, networks, volumes and images
// as files, answers `inspect` from what `run` was really asked for, and
// refuses what a real daemon would refuse (an unknown flag, a missing image,
// a write to a read-only root or mount). Nothing here knows the engine's
// code; it follows Docker's own command line and inspect format.
//
// - The proxy sidecar (`run --interactive`) is played by a stand-in that
//   speaks the engine's stdio protocol and serves pages from the control
//   file's `web` map, standing in for the network.
// - `exec` is the agent process in its container: it applies the control
//   file's `exec` actions through the container's mounts, then exits.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeProgram } from "./platform";

export interface WebPage {
  status?: number;
  contentType?: string;
  body: string;
}

/** What the agent does inside its container when the engine starts Claude Code there. */
export type ExecAction =
  | { write: string; content: string }
  | { symlink: string; target: string }
  | { remove: string };

export interface DockerControl {
  /** The daemon is stopped: every command fails as the real client does. */
  down?: boolean;
  /** Pages the stand-in proxy serves, by URL. */
  web?: Record<string, WebPage>;
  /** Actions for the next `exec`. */
  exec?: ExecAction[];
}

export interface DockerCall {
  argv: string[];
  env: Record<string, string>;
  exit: number;
  stderr?: string;
  results?: string[];
}

const SCRIPT = String.raw`
const fs = require("fs"), path = require("path"), crypto = require("crypto"), readline = require("readline");
const ROOT = __ROOT__;
const LOG = path.join(ROOT, "calls.jsonl"), CONTROL = path.join(ROOT, "control.json"), STATE = path.join(ROOT, "state");
for (const d of ["containers", "networks", "volumes", "images", "tmp"]) fs.mkdirSync(path.join(STATE, d), { recursive: true });
const control = () => (fs.existsSync(CONTROL) ? JSON.parse(fs.readFileSync(CONTROL, "utf8")) : {});
let argv = process.argv.slice(2);
const call = { argv: argv.slice(), env: { ...process.env }, exit: 0 };
let host = null;
if (argv[0] === "--host") { host = argv[1]; argv = argv.slice(2); }
const out = (s) => process.stdout.write(s);
function finish(code, stdout, stderr) {
  call.exit = code;
  if (stderr) call.stderr = stderr;
  fs.appendFileSync(LOG, JSON.stringify(call) + "\n");
  const end = () => (stderr ? process.stderr.write(stderr + "\n", () => process.exit(code)) : process.exit(code));
  if (stdout) process.stdout.write(stdout, end); else end();
}
const file = (kind, name) => path.join(STATE, kind, encodeURIComponent(name) + ".json");
const load = (kind, name) => (fs.existsSync(file(kind, name)) ? JSON.parse(fs.readFileSync(file(kind, name), "utf8")) : null);
const save = (kind, name, doc) => fs.writeFileSync(file(kind, name), JSON.stringify(doc));
const all = (kind) => fs.readdirSync(path.join(STATE, kind)).map((f) => JSON.parse(fs.readFileSync(path.join(STATE, kind, f), "utf8")));
const drop = (kind, name) => fs.rmSync(file(kind, name), { force: true });
const id = () => "sha256:" + crypto.randomBytes(32).toString("hex");
const labelsOf = (list) => Object.fromEntries(list.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const filterLabel = (args) => { const i = args.indexOf("--filter"); const f = i >= 0 ? args[i + 1] : ""; return f.startsWith("label=") ? f.slice(6) : null; };

if (control().down) finish(1, "", "Cannot connect to the Docker daemon at " + (host || "unix:///var/run/docker.sock") + ". Is the docker daemon running?");
else main();

function image(ref) {
  for (const img of all("images")) if (img.Id === ref || (img.RepoTags || []).includes(ref)) return img;
  // The pinned base image is present, named by its digest.
  const at = ref.indexOf("@sha256:");
  if (at > 0) {
    const doc = { Id: "sha256:" + crypto.createHash("sha256").update(ref).digest("hex"), RepoTags: [ref], RepoDigests: [ref.slice(0, at).split(":")[0] + ref.slice(at)], Config: { User: "", Labels: {} } };
    save("images", doc.Id, doc);
    return doc;
  }
  return null;
}

function parseRun(args) {
  const o = { interactive: false, detach: false, rm: false, init: false, pull: null, name: null, user: "", readOnly: false, capDrop: [], capAdd: [], securityOpt: [], cpus: 0, memory: 0, memorySwap: 0, pids: 0, tmpfs: {}, logDriver: "json-file", restart: "", networks: [], aliases: {}, mounts: [], env: [], workdir: "", labels: [], privileged: false };
  let i = 0;
  const val = () => args[++i];
  const bytes = (s) => { const m = /^(\d+)([bkmg]?)$/i.exec(s); if (!m) throw new Error("invalid size " + s); return Number(m[1]) * ({ "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 })[m[2].toLowerCase()]; };
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) break;
    switch (a) {
      case "--interactive": case "-i": o.interactive = true; break;
      case "--detach": case "-d": o.detach = true; break;
      case "--rm": o.rm = true; break;
      case "--init": o.init = true; break;
      case "--privileged": o.privileged = true; break;
      case "--read-only": o.readOnly = true; break;
      case "--pull": o.pull = val(); break;
      case "--name": o.name = val(); break;
      case "--user": case "-u": o.user = val(); break;
      case "--cap-drop": o.capDrop.push(val()); break;
      case "--cap-add": o.capAdd.push(val()); break;
      case "--security-opt": o.securityOpt.push(val()); break;
      case "--cpus": o.cpus = Number(val()); break;
      case "--memory": o.memory = bytes(val()); break;
      case "--memory-swap": o.memorySwap = bytes(val()); break;
      case "--pids-limit": o.pids = Number(val()); break;
      case "--tmpfs": { const v = val(); const c = v.indexOf(":"); o.tmpfs[c < 0 ? v : v.slice(0, c)] = c < 0 ? "" : v.slice(c + 1); break; }
      case "--log-driver": o.logDriver = val(); break;
      case "--restart": o.restart = val(); break;
      case "--network": {
        const v = val();
        if (v.includes("=")) { const kv = Object.fromEntries(v.split(",").map((p) => p.split("="))); o.networks.push(kv.name); if (kv.alias) o.aliases[kv.name] = [kv.alias]; }
        else o.networks.push(v);
        break;
      }
      case "--mount": {
        const kv = {};
        for (const p of val().split(",")) { const e = p.indexOf("="); kv[e < 0 ? p : p.slice(0, e)] = e < 0 ? true : p.slice(e + 1); }
        o.mounts.push({ type: kv.type || "volume", source: kv.source || kv.src, target: kv.target || kv.destination || kv.dst, readOnly: kv.readonly === true || kv.readonly === "true" || kv.ro === true });
        break;
      }
      case "--env": case "-e": o.env.push(val()); break;
      case "--workdir": case "-w": o.workdir = val(); break;
      case "--label": case "-l": o.labels.push(val()); break;
      default: throw new Error("unknown flag: " + a);
    }
  }
  o.image = args[i];
  o.command = args.slice(i + 1);
  return o;
}

function containerDoc(o, img) {
  const env = o.env.map((e) => (e.includes("=") ? e : process.env[e] !== undefined ? e + "=" + process.env[e] : null)).filter(Boolean);
  const mounts = o.mounts.map((m) => {
    if (m.type === "bind") return { Type: "bind", Source: m.source, Destination: m.target, RW: !m.readOnly };
    let v = load("volumes", m.source);
    if (!v) { v = { Name: m.source, Labels: {}, Mountpoint: path.join(STATE, "tmp", "vol-" + m.source) }; save("volumes", m.source, v); }
    fs.mkdirSync(v.Mountpoint, { recursive: true });
    return { Type: "volume", Name: m.source, Source: v.Mountpoint, Destination: m.target, RW: !m.readOnly };
  });
  return {
    Id: crypto.randomBytes(32).toString("hex"),
    Name: "/" + o.name,
    Image: img.Id,
    Config: { User: o.user || img.Config.User || "", Env: env, Labels: labelsOf(o.labels), WorkingDir: o.workdir, Cmd: o.command, Image: o.image },
    State: { Running: true, Pid: process.pid },
    HostConfig: {
      ReadonlyRootfs: o.readOnly, Privileged: o.privileged, CapDrop: o.capDrop, CapAdd: o.capAdd.length ? o.capAdd : null, SecurityOpt: o.securityOpt,
      NanoCpus: Math.round(o.cpus * 1e9), Memory: o.memory, MemorySwap: o.memorySwap, PidsLimit: o.pids, Tmpfs: o.tmpfs, LogConfig: { Type: o.logDriver, Config: {} },
      NetworkMode: o.networks[0] || "bridge", Binds: null, AutoRemove: o.rm, Init: o.init, RestartPolicy: { Name: o.restart || "no" },
    },
    NetworkSettings: { Networks: Object.fromEntries((o.networks.length ? o.networks : ["bridge"]).map((n) => [n, { Aliases: o.aliases[n] || null }])) },
    Mounts: mounts,
  };
}

/** A container path as a host path, through the container's mounts; null on the read-only root. */
function hostPath(c, p) {
  const ms = [...c.Mounts].sort((a, b) => b.Destination.length - a.Destination.length);
  for (const m of ms) {
    if (p === m.Destination || p.startsWith(m.Destination + "/")) {
      if (!m.RW) return { error: "Read-only file system" };
      return { path: path.join(m.Source, ...p.slice(m.Destination.length).split("/").filter(Boolean)) };
    }
  }
  if (p === "/tmp" || p.startsWith("/tmp/")) return { path: path.join(STATE, "tmp", c.Name.slice(1), ...p.slice(4).split("/").filter(Boolean)) };
  return { error: c.HostConfig.ReadonlyRootfs ? "Read-only file system" : "no such path in the fake" };
}

function execIn(c, args) {
  const ctl = control();
  const actions = ctl.exec || [];
  const results = [];
  for (const a of actions) {
    const target = a.write || a.symlink || a.remove;
    const h = hostPath(c, target);
    if (h.error) { results.push(target + ": " + h.error); continue; }
    try {
      if (a.write !== undefined) { fs.mkdirSync(path.dirname(h.path), { recursive: true }); fs.writeFileSync(h.path, a.content); }
      else if (a.symlink !== undefined) { fs.mkdirSync(path.dirname(h.path), { recursive: true }); fs.symlinkSync(a.target, h.path); }
      else fs.rmSync(h.path, { force: true, recursive: true });
      results.push(target + ": ok");
    } catch (e) { results.push(target + ": " + e.code); }
  }
  delete ctl.exec;
  fs.writeFileSync(CONTROL, JSON.stringify(ctl));
  call.results = results;
  finish(0, "", "");
}

/** The stand-in proxy: the engine's stdio protocol, with pages from the control file. */
function proxy(c, o) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const subnet = load("networks", o.networks[0]).IPAM.Config[0].Subnet;
  rl.on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    fs.appendFileSync(path.join(ROOT, "proxy-messages.jsonl"), JSON.stringify({ t: m.t, cred: m.cred, role: m.role, session: m.session, allow: m.allow, url: m.url, hasCredential: !!m.credential }) + "\n");
    if (m.t === "start") send({ t: "ready", address: subnet.replace(/\.0\/\d+$/, ".2"), port: 3128 });
    else if (m.t === "fetch") {
      const page = (control().web || {})[m.url];
      if (!page) send({ t: "fetched", id: m.id, ok: false, status: 502, reason: "the page couldn't be fetched" });
      else send({ t: "fetched", id: m.id, ok: true, url: m.url, status: page.status || 200, contentType: page.contentType || "text/html; charset=utf-8", body: Buffer.from(page.body, "utf8").toString("base64"), truncated: false });
    }
  });
  rl.on("close", () => { if (o.rm) drop("containers", o.name); process.exit(0); });
}

function main() {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "version") return finish(0, "Client: fake\nServer: fake\n");
    if (cmd === "buildx" && rest[0] === "version") return finish(0, "github.com/docker/buildx v0.0.0-fake\n");
    if (cmd === "buildx" && rest[0] === "build") {
      const a = rest.slice(1);
      const flag = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
      const doc = { Id: id(), RepoTags: flag("--tag"), RepoDigests: [], Config: { User: "1000:1000", Labels: labelsOf(flag("--label")) } };
      save("images", doc.Id, doc);
      fs.writeFileSync(flag("--iidfile")[0], doc.Id);
      return finish(0, "");
    }
    if (cmd === "pull") return image(rest[0]) ? finish(0, "") : finish(1, "", "pull access denied");
    if (cmd === "image" && rest[0] === "inspect") { const img = image(rest[1]); return img ? finish(0, JSON.stringify([img])) : finish(1, "[]", "Error: No such image: " + rest[1]); }
    if (cmd === "network" && rest[0] === "create") {
      const a = rest.slice(1), name = a[a.length - 1];
      if (load("networks", name)) return finish(1, "", "network with name " + name + " already exists");
      const n = all("networks").length + 1;
      save("networks", name, { Name: name, Driver: a[a.indexOf("--driver") + 1] || "bridge", Internal: a.includes("--internal"), Labels: labelsOf(a.flatMap((x, i) => (x === "--label" ? [a[i + 1]] : []))), IPAM: { Config: [{ Subnet: "172.31." + (n % 250) + ".0/24", Gateway: "172.31." + (n % 250) + ".1" }] } });
      return finish(0, crypto.randomBytes(32).toString("hex") + "\n");
    }
    if (cmd === "network" && rest[0] === "inspect") { const d = load("networks", rest[1]); return d ? finish(0, JSON.stringify([d])) : finish(1, "[]", "Error: network " + rest[1] + " not found"); }
    if (cmd === "network" && rest[0] === "rm") { const ok = !!load("networks", rest[1]); drop("networks", rest[1]); return ok ? finish(0, rest[1] + "\n") : finish(1, "", "Error: No such network: " + rest[1]); }
    if ((cmd === "network" || cmd === "volume") && rest[0] === "ls") {
      const l = filterLabel(rest), kind = cmd === "network" ? "networks" : "volumes";
      return finish(0, all(kind).filter((d) => !l || (d.Labels || {})[l] !== undefined).map((d) => d.Name + "\n").join(""));
    }
    if (cmd === "volume" && rest[0] === "create") {
      const a = rest.slice(1), name = a[a.length - 1];
      save("volumes", name, { Name: name, Labels: labelsOf(a.flatMap((x, i) => (x === "--label" ? [a[i + 1]] : []))), Mountpoint: path.join(STATE, "tmp", "vol-" + name) });
      return finish(0, name + "\n");
    }
    if (cmd === "volume" && rest[0] === "inspect") { const d = load("volumes", rest[1]); return d ? finish(0, JSON.stringify([d])) : finish(1, "[]", "Error: no such volume: " + rest[1]); }
    if (cmd === "volume" && rest[0] === "rm") { const name = rest[rest.length - 1]; const ok = !!load("volumes", name); drop("volumes", name); return ok ? finish(0, name + "\n") : finish(1, "", "Error: no such volume: " + name); }
    if (cmd === "ps") { const l = filterLabel(rest); return finish(0, all("containers").filter((d) => !l || d.Config.Labels[l] !== undefined).map((d) => d.Name.slice(1) + "\n").join("")); }
    if ((cmd === "container" && rest[0] === "inspect") || cmd === "inspect") { const name = cmd === "inspect" ? rest[0] : rest[1]; const d = load("containers", name); return d ? finish(0, JSON.stringify([d])) : finish(1, "[]", "Error: No such container: " + name); }
    if (cmd === "rm") {
      const name = rest[rest.length - 1], d = load("containers", name);
      if (!d) return finish(1, "", "Error response from daemon: No such container: " + name);
      drop("containers", name);
      if (d.State.Pid && d.State.Pid !== process.pid) { try { process.kill(d.State.Pid); } catch {} }
      return finish(0, name + "\n");
    }
    if (cmd === "exec") {
      let i = 0;
      for (; i < rest.length && rest[i].startsWith("-"); i++) if (["--user", "--workdir", "--env", "-u", "-w", "-e"].includes(rest[i])) i++;
      const c = load("containers", rest[i]);
      if (!c) return finish(1, "", "Error response from daemon: No such container: " + rest[i]);
      return execIn(c, rest.slice(i + 1));
    }
    if (cmd === "run") {
      const o = parseRun(rest);
      if (!o.name) return finish(125, "", "the fake needs --name");
      if (load("containers", o.name)) return finish(125, "", "Conflict. The container name \"/" + o.name + "\" is already in use");
      const img = image(o.image);
      if (!img) return finish(125, "", "Unable to find image '" + o.image + "' locally");
      for (const n of o.networks) if (!load("networks", n)) return finish(125, "", "network " + n + " not found");
      for (const m of o.mounts) if (m.type === "bind" && !fs.existsSync(m.source)) return finish(125, "", "invalid mount config: bind source path does not exist: " + m.source);
      const doc = containerDoc(o, img);
      // A started container's call is logged at once: the proxy's runs as long as the session group.
      if (o.interactive) { save("containers", o.name, doc); fs.appendFileSync(LOG, JSON.stringify(call) + "\n"); return proxy(doc, o); }
      doc.State.Pid = 0;
      save("containers", o.name, doc);
      return finish(0, doc.Id + "\n");
    }
    return finish(1, "", "fake docker: unsupported command: " + argv.join(" "));
  } catch (e) {
    return finish(125, "", "docker: " + e.message);
  }
}
`;

export class FakeDocker {
  readonly path: string;
  readonly root: string;
  /** A local endpoint of the shape the engine accepts; the fake ignores it. */
  readonly host: string;

  constructor(dir: string) {
    this.root = join(dir, "docker");
    mkdirSync(this.root, { recursive: true });
    this.path = nodeProgram(join(dir, "docker-client"), SCRIPT.replace("__ROOT__", JSON.stringify(this.root)));
    this.host = process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/fake-docker.sock";
  }

  private get controlPath() {
    return join(this.root, "control.json");
  }

  control(): DockerControl {
    return existsSync(this.controlPath) ? JSON.parse(readFileSync(this.controlPath, "utf8")) : {};
  }

  set(c: Partial<DockerControl>) {
    writeFileSync(this.controlPath, JSON.stringify({ ...this.control(), ...c }));
  }

  calls(): DockerCall[] {
    const f = join(this.root, "calls.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  /** The docker subcommand of each call, without the `--host` prefix. */
  commands(): string[][] {
    return this.calls().map((c) => (c.argv[0] === "--host" ? c.argv.slice(2) : c.argv));
  }

  proxyMessages(): Array<{ t: string; cred?: string; role?: string; session?: string; allow?: string[]; url?: string; hasCredential: boolean }> {
    const f = join(this.root, "proxy-messages.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}
