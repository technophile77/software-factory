// AC-8, AC-14, AC-15 and AC-16 on a real Docker daemon. Gated like the
// engine's other real-Docker tests: they run only with
// FACTORY_DOCKER_TESTS=1, after `npm run build` (the proxy sidecar runs
// dist/proxy.js). Everything else is skipped, and says so.
//
// The whole engine runs, with real Docker: it builds the agent image, starts
// the run's networks, the proxy sidecar and the analyst's container the way
// it does for the owner. Only the model is missing: the Agent SDK is the
// test's (support/agents.ts), and its sessions wait while the test probes
// the containers the engine made, from inside, with `docker exec`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerCli, ENGINE_DOCKER_DIR, FakeSdk, type FakeSession } from "./support/agents";
import { rand, World } from "./support/world";

const ON = process.env.FACTORY_DOCKER_TESTS === "1";
const PROXY_JS = fileURLToPath(new URL("../../dist/proxy.js", import.meta.url));
const srcModule = (p: string) => fileURLToPath(new URL(`../../src/${p}.ts`, import.meta.url));
const SLOW = 30 * 60_000;

interface Gate {
  open(): void;
  wait: Promise<void>;
}
function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { open, wait };
}

// Probes run in the container with its own Node, as the agent's user; each prints one JSON line.
const PROBE_IDENTITY = `
const fs = require("fs");
const tryWrite = (p) => { try { fs.writeFileSync(p, "x"); fs.rmSync(p); return "written"; } catch (e) { return e.code; } };
console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), root: tryWrite("/probe-" + process.pid), usr: tryWrite("/usr/local/probe-" + process.pid), tmp: tryWrite("/tmp/probe-" + process.pid), dockerSock: fs.existsSync("/var/run/docker.sock") || fs.existsSync("/run/docker.sock") }));
`;

/** Walks the container's whole file system (but /proc, /sys, /dev) for any of the markers in names or contents, and for sockets. */
const probeWalk = (markers: string[]) => `
const fs = require("fs"), path = require("path");
const markers = ${JSON.stringify(markers)};
const hits = [], sockets = [], named = [];
let files = 0;
function walk(d) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (["/proc", "/sys", "/dev"].includes(p)) continue;
    if (e.name === "engine.json") named.push(p);
    if (e.isSocket()) sockets.push(p);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) {
      files++;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > 64 * 1024 * 1024) continue;
      let b; try { b = fs.readFileSync(p); } catch { continue; }
      for (const m of markers) if (b.includes(m)) hits.push([p, m]);
    }
  }
}
walk("/");
const environ = [];
for (const pid of fs.readdirSync("/proc").filter((x) => /^\\d+$/.test(x))) {
  try { const t = fs.readFileSync("/proc/" + pid + "/environ"); for (const m of markers) if (t.includes(m)) environ.push([pid, m]); } catch {}
}
console.log(JSON.stringify({ files, hits, sockets, named, environ, env: process.env }));
`;

/** Network attempts from inside a container: direct TCP, and CONNECT through the proxy with no, a wrong, or the container's own credential. */
const probeNet = (direct: Array<[string, number]>, connects: Array<{ target: string; cred: "none" | "wrong" | "own" }>) => `
const net = require("net");
const p = new URL(process.env.HTTPS_PROXY || "http://factory-proxy:3128");
const own = decodeURIComponent(p.password || "");
function tcp(host, port) {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); res("timeout"); }, 5000);
    s.once("connect", () => { clearTimeout(t); s.destroy(); res("connected"); });
    s.once("error", (e) => { clearTimeout(t); res(e.code || "error"); });
  });
}
function connect(target, cred) {
  return new Promise((res) => {
    const s = net.connect({ host: p.hostname, port: Number(p.port || 3128) });
    const t = setTimeout(() => { s.destroy(); res("timeout"); }, 15000);
    let buf = "";
    s.once("connect", () => {
      const auth = cred === "none" ? "" : "Proxy-Authorization: Basic " + Buffer.from("factory:" + (cred === "own" ? own : "x".repeat(43))).toString("base64") + "\\r\\n";
      s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n" + auth + "\\r\\n");
    });
    s.on("data", (d) => { buf += d; const m = /^HTTP\\/1\\.[01] (\\d{3})/.exec(buf); if (m) { clearTimeout(t); s.destroy(); res(Number(m[1])); } });
    s.once("error", (e) => { clearTimeout(t); res(e.code || "error"); });
    s.once("close", () => { clearTimeout(t); res(buf ? "closed:" + buf.slice(0, 40) : "closed"); });
  });
}
(async () => {
  const out = { hasProxyEnv: !!process.env.HTTPS_PROXY, direct: {}, connect: {} };
  for (const [h, port] of ${JSON.stringify(direct)}) out.direct[h + ":" + port] = await tcp(h, port);
  for (const c of ${JSON.stringify(connects)}) out.connect[c.target + " " + c.cred] = await connect(c.target, c.cred);
  console.log(JSON.stringify(out));
})();
`;

describe.skipIf(!ON)(`F-007 milestone 2 on a real Docker daemon (AC-8, AC-14, AC-15, AC-16)${ON ? "" : " (skipped: set FACTORY_DOCKER_TESTS=1 on a machine with Docker, after npm run build)"}`, () => {
  let w: World;
  let docker: any;
  let host = "";
  const sdk = new FakeSdk(null);
  const analystIn = gate();
  const analystGo = gate();
  const readerIn = gate();
  const readerGo = gate();
  let analyst: FakeSession | undefined;
  let reader: FakeSession | undefined;
  let analystName = "";
  let readerName = "";
  let homeMarker = "";
  let homeDir = "";
  const fetches: Record<string, { isError: boolean; value: unknown }> = {};
  const REFUSED_URLS = ["https://127.0.0.1/", "https://localhost/", "https://10.0.0.1/", "https://192.168.1.1/", "https://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://localtest.me/"];
  const CONTROL_URL = "https://example.com/";

  const exec = async (container: string, script: string) => JSON.parse(await docker.out(["exec", container, "node", "-e", script], { timeoutMs: 300_000 }));
  const byRole = async (role: string) => {
    const runs = (await w.engine!.runs()).filter((r) => r.role === "requirements-analyst");
    const run = runs[runs.length - 1]!;
    const names = (await docker.out(["ps", "--filter", `label=factory.run=${run.id}`, "--filter", `label=factory.role=${role}`, "--format", "{{.Names}}"])).split("\n").filter(Boolean);
    expect(names, `one ${role} container for run ${run.id}`).toHaveLength(1);
    return names[0]!;
  };

  beforeAll(async () => {
    expect(() => readFileSync(PROXY_JS), "dist/proxy.js is missing: run `npm run build` first").not.toThrow();
    const [{ pickEndpoint }, { findOnPath }] = await Promise.all(["docker/cli", "fsutil"].map((m) => import(/* @vite-ignore */ srcModule(m))));
    const dockerPath = findOnPath("docker");
    host = await pickEndpoint(process.platform, process.env);
    expect(dockerPath, "no docker client on PATH").toBeTruthy();
    expect(host, "no local Docker daemon found").toBeTruthy();

    // The owner's real home holds a file the containers must never see (AC-8). Removed in afterAll.
    homeMarker = `F007-OWNER-HOME-${rand(12)}`;
    homeDir = mkdtempSync(join(homedir(), ".f007-ac8-"));
    writeFileSync(join(homeDir, "sentinel.txt"), `${homeMarker}\n`);

    w = await World.create([{}], { agentFiles: true });
    docker = await dockerCli(dockerPath, host, join(w.root, "docker-config"));
    w.agents = { docker, sdk: async () => sdk, dockerDir: ENGINE_DOCKER_DIR, proxyScript: PROXY_JS };
    sdk.behaviours.analyst = async (s) => {
      analyst = s;
      analystIn.open();
      await analystGo.wait;
      const asked = await s.call("interview_ask", { text: "Which formats?", why: "Needed for the spec." });
      if (asked.isError) throw new Error(`interview_ask refused: ${JSON.stringify(asked.value)}`);
      await s.call("research_web", { query: "CSV export conventions" });
    };
    sdk.behaviours.reader = async (s) => {
      reader = s;
      for (const url of [...REFUSED_URLS, CONTROL_URL]) fetches[url] = await s.call("fetch_page", { url });
      readerIn.open();
      await readerGo.wait;
      s.result = "Nothing useful.";
    };
    await w.boot();
    await w.startFeature();
    // The first run builds the agent image, which takes minutes; a run that ends first never got its session.
    let inside = false;
    void analystIn.wait.then(() => (inside = true));
    while (!inside) {
      const ended = (await w.engine!.runs()).find((r) => r.status !== "running");
      if (ended) throw new Error(`the analyst session didn't start: run ${ended.id} is ${ended.status}: ${ended.reason ?? ""}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    analystName = await byRole("requirements-analyst");
  }, SLOW);

  afterAll(async () => {
    analystGo.open();
    readerGo.open();
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    await w?.cleanup();
  }, 120_000);

  it("[DR-1] AC-8: the analyst runs as a non-root user with a read-only root file system, and no Docker socket", { timeout: 300_000 }, async () => {
    const id = await exec(analystName, PROBE_IDENTITY);
    expect(id.uid).not.toBe(0);
    expect(id.gid).not.toBe(0);
    expect(id.root).toBe("EROFS");
    expect(id.usr).toBe("EROFS");
    expect(id.tmp).toBe("written");
    expect(id.dockerSock).toBe(false);
    const doc = JSON.parse(await docker.out(["container", "inspect", analystName]))[0];
    expect(doc.HostConfig.ReadonlyRootfs).toBe(true);
    expect(doc.HostConfig.Privileged).toBe(false);
    expect(doc.HostConfig.CapDrop.map((c: string) => c.toUpperCase())).toContain("ALL");
  });

  it("[DR-2] AC-8 / AC-16: nothing of the owner's home, no engine.json and no engine socket, and the model credential nowhere in the analyst's files or process environments", { timeout: 600_000 }, async () => {
    const engineJson = JSON.parse(readFileSync(w.engineJsonPath(), "utf8"));
    const markers = [homeMarker, w.modelCredential, String(engineJson.path)];
    const r = await exec(analystName, probeWalk(markers));
    expect(r.files, "the walk saw the image's files").toBeGreaterThan(1000);
    expect(r.hits).toEqual([]);
    expect(r.named).toEqual([]);
    expect(r.sockets.filter((s: string) => /docker|engine|factory/i.test(s))).toEqual([]);
    expect(r.environ).toEqual([]);
    expect(JSON.stringify(r.env)).not.toContain(w.modelCredential);
    // Its API key is a dummy the proxy swaps (SR-9), never the credential.
    expect(r.env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(r.env.ANTHROPIC_API_KEY).not.toBe(w.modelCredential);
    const doc = JSON.parse(await docker.out(["container", "inspect", analystName]))[0];
    expect(JSON.stringify(doc.Config.Env)).not.toContain(w.modelCredential);
    // Its only host folder is its own worktree, which the engine keeps outside every repo (FR-8).
    const binds = doc.Mounts.filter((m: any) => m.Type === "bind");
    expect(binds.map((m: any) => m.Destination)).toEqual(["/workspace"]);
    expect(String(binds[0].Source).toLowerCase()).not.toContain(".factory");
  });

  it("[DR-3] AC-14 / AC-8: direct connections from the analyst to an outside address or host.docker.internal fail, and the proxy refuses a missing or wrong credential and a host outside the analyst's policy", { timeout: 300_000 }, async () => {
    const r = await exec(analystName, probeNet(
      [["1.1.1.1", 443], ["8.8.8.8", 53], ["example.com", 443], ["host.docker.internal", 443], ["host.docker.internal", 80]],
      [
        { target: "api.anthropic.com:443", cred: "none" },
        { target: "example.com:443", cred: "none" },
        { target: "example.com:443", cred: "wrong" },
        { target: "example.com:443", cred: "own" },
      ],
    ));
    expect(r.hasProxyEnv).toBe(true);
    for (const [k, v] of Object.entries(r.direct)) expect(v, `direct ${k}`).not.toBe("connected");
    expect(r.connect["api.anthropic.com:443 none"]).toBe(407);
    expect(r.connect["example.com:443 none"]).toBe(407);
    expect(r.connect["example.com:443 wrong"]).toBe(407);
    // The analyst's own credential is good but its policy has no outside hosts (Role policy v2.5).
    expect(r.connect["example.com:443 own"]).toBe(403);
  });

  it("[DR-4] AC-15: the web reader's fetch_page refuses private and loopback addresses and a name resolving to 127.0.0.1", { timeout: SLOW }, async () => {
    analystGo.open();
    await readerIn.wait;
    readerName = await byRole("web-reader");
    for (const url of REFUSED_URLS) {
      const f = fetches[url]!;
      expect(f.isError, `${url}: ${JSON.stringify(f.value)}`).toBe(true);
      expect(JSON.stringify(f.value), url).not.toMatch(/"text"/);
    }
  });

  it("[DR-5] AC-15 (control): the same fetch_page reaches a public page (needs the internet)", () => {
    const f = fetches[CONTROL_URL]!;
    expect(f.isError, JSON.stringify(f.value)).toBe(false);
    expect(String((f.value as any).text)).toMatch(/Example Domain/);
  });

  it("[DR-6] AC-15 / SR-8: CONNECT from the web reader's container with its own credential is refused for loopback, private and link-local addresses, a name resolving to 127.0.0.1, and any port but 443", { timeout: 300_000 }, async () => {
    expect(reader).toBeTruthy();
    const r = await exec(readerName, probeNet(
      [["1.1.1.1", 443]],
      [
        { target: "127.0.0.1:443", cred: "own" },
        { target: "localhost:443", cred: "own" },
        { target: "10.0.0.1:443", cred: "own" },
        { target: "169.254.169.254:443", cred: "own" },
        { target: "[::1]:443", cred: "own" },
        { target: "localtest.me:443", cred: "own" },
        { target: "example.com:80", cred: "own" },
        { target: "example.com:443", cred: "none" },
        { target: "example.com:443", cred: "own" },
      ],
    ));
    expect(r.direct["1.1.1.1:443"]).not.toBe("connected");
    for (const t of ["127.0.0.1:443", "localhost:443", "10.0.0.1:443", "169.254.169.254:443", "[::1]:443", "localtest.me:443", "example.com:80"]) {
      expect(r.connect[`${t} own`], t).toBe(403);
    }
    expect(r.connect["example.com:443 none"]).toBe(407);
    // Control: the reader's policy allows any public host on 443 (Role policy v2.5), so the refusals above are SR-8's.
    expect(r.connect["example.com:443 own"]).toBe(200);
  });

  it("[DR-7] AC-16: the web reader's container has no model credential in its environment or files either", { timeout: 600_000 }, async () => {
    const r = await exec(readerName, probeWalk([w.modelCredential]));
    expect(r.hits).toEqual([]);
    expect(r.environ).toEqual([]);
    expect(JSON.stringify(r.env)).not.toContain(w.modelCredential);
    readerGo.open();
  });
});
