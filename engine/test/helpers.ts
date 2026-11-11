import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Clock } from "../src/clock";
import { DeviceCode, GitHubClient, PollResult, RepoInfo } from "../src/github";
import { PinStore, pinnedKeys } from "../src/config/pins";
import { validateManifest } from "../src/config/manifest";
import YAML from "yaml";
import { MemoryCredentialStore } from "../src/secrets";
import { MemoryLogger } from "../src/log";
import { findOnPath, realPath } from "../src/fsutil";
import { EngineHandle, EngineOptions, startEngine } from "../src/engine";
import { nodeProgram, ownerOnly } from "./acceptance/support/platform";

// Fixtures hold placeholders only (SR-13): example ids, example orgs, fake tokens.
export const OWNER_ID = 1000001;
export const OTHER_ID = 1000002;
export const ORG_ID = 2000001;
export const CLIENT_ID = "Iv1.placeholder0001";
export const MODEL_TOKEN = "sk-ant-oat01-placeholder-not-a-real-token";
export const FACTORY_TOKEN = "github_pat_placeholder_not_a_real_token";

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** The git the engine itself would pick, so the tests run wherever git is installed. */
export const GIT_PATH = (() => {
  const p = findOnPath("git");
  if (!p) throw new Error("git isn't on PATH");
  return p;
})();

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

export function tmpdir(prefix = "sf-"): string {
  // Short paths: Unix socket paths are limited to about 100 bytes.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(d, 0o700);
  return realPath(d);
}

export function initRepo(dir: string, files: Record<string, string>, origin?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  if (origin) git(dir, "remote", "add", "origin", origin);
}

export function manifestYaml(o: { name?: string; enabled?: boolean; ownerId?: number; mode?: string; allowed?: number; extra?: string } = {}): string {
  return [
    "schema: factory-project/1.0",
    `name: ${o.name ?? "acme"}`,
    "factory:",
    "  version: v0.1.0",
    "repos:",
    "  - name: acme-web",
    "    url: https://github.com/example-org/acme-web",
    "maturity: prototype",
    `enabled: ${o.enabled ?? true}`,
    "owner:",
    `  github_id: ${o.ownerId ?? OWNER_ID}`,
    `  oauth_client_id: ${CLIENT_ID}`,
    "allowed_repo_owners:",
    `  - { login: example-org, id: ${o.allowed ?? ORG_ID} }`,
    "settings:",
    "  budget:",
    `    mode: ${o.mode ?? "subscription"}`,
    o.extra ?? "",
  ].join("\n");
}

/** A stand-in for gitleaks: same flags, finds "FAKE-SECRET-" in staged blobs. */
export function fakeGitleaks(dir: string): { path: string; sha256: string; argsLog: string; failFlag: string } {
  fs.mkdirSync(dir, { recursive: true });
  const argsLog = path.join(dir, "args.log");
  const failFlag = path.join(dir, "fail");
  const p = nodeProgram(path.join(dir, "gitleaks"), String.raw`
const fs = require("fs"), path = require("path");
const here = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
// Writes to a pipe are asynchronous on Windows: exit only once it is flushed.
const finish = (code, out) => process.stdout.write(out, () => process.exit(code));
function scan() {
  fs.writeFileSync(path.join(here, "args.log"), argv.map((a) => a + "\n").join(""));
  fs.writeFileSync(path.join(here, "cwd.log"), process.cwd() + "\n");
  fs.writeFileSync(path.join(here, "env.log"), Object.entries(process.env).map(([k, v]) => k + "=" + v + "\n").join(""));
  if (fs.existsSync(path.join(here, "fail"))) process.exit(1);
  const hits = [];
  for (const f of fs.readdirSync(argv[1])) {
    const file = path.join(argv[1], f);
    if (fs.readFileSync(file, "latin1").includes("FAKE-SECRET-")) hits.push({ File: file, RuleID: "generic-api-key", Secret: "REDACTED" });
  }
  finish(hits.length ? 99 : 0, JSON.stringify(hits) + "\n");
}
if (argv[0] === "version") finish(0, "8.30.1\n");
else scan();
`);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  return { path: p, sha256, argsLog, failFlag };
}

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  t = Date.parse("2026-11-11T10:00:00Z");
  private sleepers: Array<{ at: number; resolve: () => void }> = [];
  now() {
    return this.t;
  }
  /** How many waits are parked on this clock. */
  get sleeping(): number {
    return this.sleepers.length;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted || ms <= 0) return resolve();
      const s = { at: this.t + ms, resolve };
      this.sleepers.push(s);
      signal?.addEventListener("abort", () => {
        this.sleepers = this.sleepers.filter((x) => x !== s);
        resolve();
      }, { once: true });
    });
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.sleepers.sort((a, b) => a.at - b.at);
      const next = this.sleepers[0];
      if (!next || next.at > end) break;
      this.sleepers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

export async function settle(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** GitHub as the engine sees it, without a network. */
export class FakeGitHub implements GitHubClient {
  repos = new Map<string, RepoInfo>([["example-org/acme-web", { status: 200, ownerId: ORG_ID, private: true }]]);
  deviceCalls = 0;
  pollCalls = 0;
  approver: number | null = null;
  outcome: "pending" | "denied" | "expired" | "down" = "pending";
  deviceAnswer: Partial<DeviceCode> = {};
  slowDownOnce = false;
  tokensIssued: string[] = [];
  deviceDown = false;
  webBase?: string;

  async requestDeviceCode(clientId: string): Promise<DeviceCode> {
    this.deviceCalls++;
    if (this.deviceDown) throw new Error("unreachable");
    if (clientId !== CLIENT_ID) throw new Error("wrong client id");
    return { deviceCode: "d".repeat(40), userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5, ...this.deviceAnswer };
  }
  async pollToken(): Promise<PollResult> {
    this.pollCalls++;
    if (this.outcome === "down") throw new Error("unreachable");
    if (this.slowDownOnce) {
      this.slowDownOnce = false;
      return { kind: "slow_down", interval: null };
    }
    if (this.approver !== null) {
      const token = `gho_fake_${this.approver}_${this.pollCalls}`;
      this.tokensIssued.push(token);
      return { kind: "token", token };
    }
    if (this.outcome === "pending") return { kind: "pending" };
    return { kind: this.outcome };
  }
  async userId(token: string): Promise<number> {
    const m = /^gho_fake_(\d+)_/.exec(token);
    if (!m) throw new Error("bad token");
    return Number(m[1]);
  }
  async repo(owner: string, name: string): Promise<RepoInfo> {
    return this.repos.get(`${owner}/${name}`) ?? { status: 404 };
  }
}

export interface World {
  root: string;
  master: string;
  config: string;
  home: string;
  worktree: string;
  gitleaks: ReturnType<typeof fakeGitleaks>;
  github: FakeGitHub;
  clock: FakeClock;
  credentials: MemoryCredentialStore;
  log: MemoryLogger;
  options(extra?: Partial<EngineOptions>): EngineOptions;
  pin(projectPath?: string, manifest?: string): void;
}

export function makeWorld(o: { manifest?: string; pinned?: boolean } = {}): World {
  const root = tmpdir();
  const master = path.join(root, "master");
  const config = path.join(root, "acme-config");
  const home = path.join(root, "home");
  const worktree = path.join(root, "analyst");
  initRepo(master, { "README.md": "master\n" }, "https://github.com/example-org/software-factory");
  const manifest = o.manifest ?? manifestYaml();
  initRepo(config, { "factory-project.yaml": manifest, "README.md": "config\n" }, "https://github.com/example-org/acme-config");
  fs.writeFileSync(path.join(master, "factory-projects.local.yaml"), `projects:\n  - path: ${config}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(master, "factory-projects.local.yaml"), 0o600);
  ownerOnly(path.join(master, "factory-projects.local.yaml"));
  fs.mkdirSync(worktree, { recursive: true });
  const w: World = {
    root, master, config, home, worktree,
    gitleaks: fakeGitleaks(path.join(root, "bin")),
    github: new FakeGitHub(),
    clock: new FakeClock(),
    credentials: new MemoryCredentialStore({ "model-credential": MODEL_TOKEN, "factory-token/acme": FACTORY_TOKEN }),
    log: new MemoryLogger(),
    options(extra = {}) {
      return {
        masterRepo: master, engineHome: home, runtimeDir: path.join(root, "run"),
        gitleaks: { path: w.gitleaks.path, expectSha256: w.gitleaks.sha256 },
        credentials: w.credentials, github: w.github, clock: w.clock, logger: w.log, env: {},
        // The test process hosts the engine, so a client it spawns would count as the engine's child.
        parentOf: () => null,
        ...extra,
      };
    },
    pin(projectPath = config, text = manifest) {
      const m = validateManifest(YAML.parse(text), "0".repeat(40));
      new PinStore(home).set(projectPath, { ...pinnedKeys(m), pinned_at: "2026-11-11T09:00:00Z", commit: m.commit });
    },
  };
  if (o.pinned !== false) w.pin();
  return w;
}

export async function start(w: World, extra: Partial<EngineOptions> = {}): Promise<EngineHandle> {
  return startEngine(w.options(extra));
}

/** A line-framed JSON-RPC client over the engine's socket. */
export class RpcClient {
  private buf = "";
  private id = 0;
  private waiting = new Map<number, (m: Record<string, unknown>) => void>();
  readonly notifications: Array<Record<string, unknown>> = [];
  closed: Promise<void>;
  constructor(readonly sock: net.Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const m = JSON.parse(line) as Record<string, unknown>;
        if ("method" in m) this.notifications.push(m);
        else this.waiting.get(m.id as number)?.(m);
      }
    });
    this.closed = new Promise((r) => sock.on("close", () => r()));
  }
  static connect(p: string): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const s = net.connect(p, () => resolve(new RpcClient(s)));
      s.on("error", reject);
    });
  }
  raw(line: string): void {
    this.sock.write(line);
  }
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  }
  async ok(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.call(method, params);
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
    return r.result as Record<string, unknown>;
  }
  close(): void {
    this.sock.destroy();
  }
}

export function engineJson(w: World): { version: string; path: string; pid: number } {
  return JSON.parse(fs.readFileSync(path.join(w.config, ".factory", "engine.json"), "utf8"));
}

/** Opens a session and has the owner approve it on the fake GitHub. */
export async function approvedSession(w: World, c: RpcClient, feature: string, approver = OWNER_ID, takeover = false): Promise<string> {
  const open = await c.ok("interview.open", { feature, ...(takeover ? { takeover } : {}) });
  w.github.approver = approver;
  await w.clock.advance(5000);
  w.github.approver = null;
  // The approval lands once its transcript entry is committed (real git, so real time).
  for (let i = 0; i < 200; i++) {
    const r = await c.call("interview.awaitApproval", { session: open.session, wait_s: 0 });
    if (!r.error || (r.error as { code: number }).code !== -32006) break;
    await new Promise((res) => setTimeout(res, 10));
  }
  return open.session as string;
}

/**
 * Settles `p`, moving the fake clock `stepMs` at a time, but only while
 * something is waiting on it. A fixed number of steps raced the work before
 * the first wait: on a slow runner (git spawns on Windows) the steps ran out
 * before the device poll began sleeping, and the poll then waited forever.
 */
export async function driveClock<T>(w: { clock: FakeClock }, p: Promise<T>, stepMs: number, realLimitMs = 25_000): Promise<T> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  const deadline = Date.now() + realLimitMs;
  while (!done && Date.now() < deadline) {
    if (w.clock.sleeping > 0) await w.clock.advance(stepMs);
    else await new Promise((r) => setTimeout(r, 10));
  }
  return p;
}

/** Advances the clock once a request has had time to reach the engine and start waiting. */
export async function advanceSoon(w: World, ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
  await w.clock.advance(ms);
}
