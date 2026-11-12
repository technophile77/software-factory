// Real Docker, off by default: no daemon in CI. Run on a machine with Docker
// Desktop (or rootless Docker) after `npm run build`:
//   FACTORY_DOCKER_TESTS=1 npx vitest run --project unit test/docker-real.test.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionGroup, AgentContainer } from "../src/agent/sandbox";
import { DockerCli, pickEndpoint } from "../src/docker/cli";
import { baseImageId, buildAgentImage } from "../src/docker/image";
import { findOnPath } from "../src/fsutil";
import { MemoryLogger } from "../src/log";
import { effectiveRole } from "../src/policy/role-policy";
import { Children } from "../src/proc";
import { tmpdir } from "./helpers";
import { policyDoc } from "./policy-fixture";

const ON = process.env.FACTORY_DOCKER_TESTS === "1";
const PLACEHOLDER = "sk-ant-api03-placeholder-not-a-real-key";
const LIMITS = { cpus: 1, memoryBytes: 1024 ** 3, pids: 256, tmpBytes: 64 * 1024 ** 2 };

describe.skipIf(!ON)("agent containers on a real Docker daemon (AC-8, AC-13 to AC-16)", () => {
  let docker: DockerCli;
  let group: SessionGroup;
  let analyst: AgentContainer;
  let reader: AgentContainer;
  const log = new MemoryLogger();

  /** Runs a Node one-liner inside a container as the agent user; resolves to its stdout. */
  const inside = async (c: AgentContainer, script: string) =>
    (await docker.run(["exec", "--user", "1000:1000", c.name, "node", "-e", script], { okCodes: [1, 2], timeoutMs: 60_000 })).stdout.toString().trim();

  beforeAll(async () => {
    const bin = findOnPath(process.platform === "win32" ? "docker.exe" : "docker");
    const host = await pickEndpoint(process.platform, process.env);
    if (!bin || !host) throw new Error("AC-13: no docker client or local daemon, so no session may start");
    const work = tmpdir();
    docker = new DockerCli({ dockerPath: bin, host, configDir: path.join(work, "docker"), children: new Children() });
    const proxyScript = path.join(__dirname, "..", "dist", "proxy.js");
    if (!fs.existsSync(proxyScript)) throw new Error("run npm run build first (dist/proxy.js)");
    const proxyImageId = await baseImageId(docker);
    const agentImageId = await buildAgentImage(docker, path.join(__dirname, "..", "docker"), work, { project: "docker-test", masterCommit: "0".repeat(40), skillsDigest: "0".repeat(64) }, { skills: new Map([["requirements-analyst", []]]) });
    group = new SessionGroup({
      docker, runId: `R-${Date.now().toString(16)}`, project: "docker-test", agentImageId, proxyImageId, proxyScript,
      agentLimits: { "requirements-analyst": LIMITS, "web-reader": LIMITS }, proxyLimits: LIMITS, maxPageBytes: 1 << 20, credential: { kind: "api_key", value: PLACEHOLDER }, log,
    });
    await group.open();
    const wt = tmpdir();
    fs.mkdirSync(path.join(wt, "docs"));
    analyst = await group.startAgent(effectiveRole(policyDoc(), "requirements-analyst"), wt, { sessionVolume: true });
    reader = await group.startAgent(effectiveRole(policyDoc(), "web-reader"), null);
  }, 30 * 60_000);

  afterAll(async () => {
    await group?.close();
  }, 120_000);

  it("AC-8: non-root, read-only root, no engine socket or owner home", async () => {
    expect(await inside(analyst, "console.log(process.getuid())")).toBe("1000");
    expect(await inside(analyst, "try{require('fs').writeFileSync('/x','x');console.log('wrote')}catch{console.log('refused')}")).toBe("refused");
    expect(await inside(analyst, "console.log(require('fs').existsSync('/var/run/docker.sock'))")).toBe("false");
    expect(await inside(analyst, "console.log(require('fs').existsSync('/usr/local/bin/npm'))")).toBe("false");
  });

  it("AC-14: direct connections out and to host.docker.internal fail; the proxy refuses no credential", async () => {
    const tcp = (host: string) => `const s=require('net').connect(443,'${host}');s.setTimeout(5000);s.on('connect',()=>{console.log('open');process.exit(0)});s.on('error',()=>{console.log('failed');process.exit(0)});s.on('timeout',()=>{console.log('failed');process.exit(0)})`;
    expect(await inside(analyst, tcp("1.1.1.1"))).toBe("failed");
    expect(await inside(analyst, tcp("host.docker.internal"))).toBe("failed");
    const noCred = "const s=require('net').connect(3128,'factory-proxy',()=>s.write('CONNECT example.org:443 HTTP/1.1\\r\\n\\r\\n'));s.on('data',d=>{console.log(String(d).split(' ')[1]);process.exit(0)})";
    expect(await inside(analyst, noCred)).toBe("407");
  });

  it("AC-15: the proxy refuses private addresses and localhost for the open-web reader", async () => {
    const via = (target: string) => `const u=new URL(process.env.HTTPS_PROXY);const s=require('net').connect(3128,'factory-proxy',()=>s.write('CONNECT ${target} HTTP/1.1\\r\\nProxy-Authorization: Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64')+'\\r\\n\\r\\n'));s.on('data',d=>{console.log(String(d).split(' ')[1]);process.exit(0)})`;
    expect(await inside(reader, via("127.0.0.1:443"))).toBe("403");
    expect(await inside(reader, via("169.254.169.254:443"))).toBe("403");
    expect(["403", "502"]).toContain(await inside(reader, via("localhost:443")));
    // The analyst's network list is empty: every host is refused.
    expect(await inside(analyst, via("example.org:443"))).toBe("403");
  });

  it("AC-16: the model credential is nowhere in the container's environment", async () => {
    const env = await inside(analyst, "console.log(JSON.stringify(process.env))");
    expect(env).not.toContain(PLACEHOLDER);
    expect(env).toContain("factory-dummy-key");
  });
});
