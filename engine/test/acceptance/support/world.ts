// Builds a throwaway world for one test: a master repo clone with its
// projects file, one config repo and one managed repo per project (served by
// the fake GitHub), the fakes, and the engine started through the harness.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREDENTIAL_NAMES,
  callTool,
  confirmCommand,
  startEngine,
  logDir,
  type CredentialStore,
  type EngineHandle,
  type EngineOptions,
  type InterviewTools,
  type ResumedRun,
  type ToolOutcome,
} from "../harness";
import { drive, FakeClock, realDelay } from "./clock";
import { FakeGitHub } from "./fake-github";
import { fastImportStream } from "./fast-import";
import { FakeGitleaks, GitWrapper } from "./fake-tools";
import { ownerOnly, removeTree, WINDOWS_ENV } from "./platform";
import { RpcClient, rpcOnce, type RpcResponse } from "./rpc";
import { securityItemsIn } from "../../inbox-items";

/** The host's git, by absolute path, so the fixtures never run the logging
 * wrapper or anything a test puts on PATH. FACTORY_TEST_GIT overrides it. */
export const REAL_GIT = findGit();

function findGit(): string {
  const override = process.env.FACTORY_TEST_GIT;
  if (override) return override;
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("where.exe", ["git"], { encoding: "utf8" })
        : execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first) return first;
  } catch {
    // Not found: the error below says how to point the suite at git.
  }
  throw new Error("git not found on PATH; install it or set FACTORY_TEST_GIT to its absolute path");
}

/** A minimal PATH for fixture processes: git's own folder first, then the
 * system's. */
export const BASE_PATH = [
  ...new Set([
    dirname(REAL_GIT),
    ...(process.platform === "win32"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"]
      : ["/usr/bin", "/bin"]),
  ]),
].join(delimiter);
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const TEMPLATE = join(REPO_ROOT, "plugins/software-factory/skills/onboard-repo/templates/factory-project.yaml");

/** The fixtures' own git. It never runs repo hooks or fsmonitor, so markers
 * in the git-safety tests can only come from the engine. */
export function git(cwd: string, ...args: string[]): string {
  return gitWithInput(cwd, undefined, ...args);
}

/** {@link git} with `input` on stdin, for `git fast-import`. */
export function gitWithInput(cwd: string, input: Buffer | undefined, ...args: string[]): string {
  return execFileSync(REAL_GIT, ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", ...args], {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      PATH: BASE_PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
      ...WINDOWS_ENV,
    },
  });
}

export function tryGit(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000, what = "condition"): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await realDelay(25);
  }
}

export function rand(n = 8): string {
  return randomBytes(n).toString("hex");
}

export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  readonly accessed: string[] = [];
  async get(name: string) {
    this.accessed.push(name);
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.accessed.push(name);
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.accessed.push(name);
    return this.values.delete(name);
  }
}

export interface AnalystSession {
  feature: string;
  worktree: string;
  tools: InterviewTools;
}

/** Plays the requirements analyst: takes the feature's tools from the engine,
 * gives it a worktree of the feature branch, and pulls each turn message the
 * engine has for it. */
export class FakeAnalyst {
  readonly starts: AnalystSession[] = [];
  /** Runs the engine handed back to resume at start (FR-14), in order. */
  readonly resumes: ResumedRun[] = [];
  readonly turns: Array<{ feature: string; message: string }> = [];
  readonly errors: unknown[] = [];
  /** Runs on each turn, e.g. to revise an item after `more_info`. */
  onTurn?: (feature: string, message: string, tools: InterviewTools) => void | Promise<void>;
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private world: World) {}

  latest(feature: string): AnalystSession | undefined {
    return [...this.starts].reverse().find((s) => s.feature === feature);
  }

  /** The analyst's session for a feature, made on first use for the running engine. */
  async session(feature: string): Promise<AnalystSession> {
    const e = this.world.engine;
    if (!e) throw new Error("no engine running");
    const have = this.latest(feature);
    if (have && have.tools && (have as any).engine === e) {
      this.ensurePolling();
      return have;
    }
    const worktree = have?.worktree ?? this.world.analystWorktree(feature);
    const s: AnalystSession & { engine?: unknown } = { feature, worktree, tools: e.interviewTools(feature, worktree) };
    Object.defineProperty(s, "engine", { value: e, enumerable: false });
    this.starts.push(s);
    this.ensurePolling();
    return s;
  }

  /** The engine's resumeAnalyst: continue the run with the tools it gives.
   * The engine calls this while starting, before the world holds its handle,
   * so `adopt` ties the session to that engine afterwards. */
  resume(r: ResumedRun) {
    this.resumes.push(r);
    this.starts.push({ feature: r.feature, worktree: r.worktree, tools: r.tools });
    this.ensurePolling();
  }

  adopt(e: EngineHandle) {
    for (const s of this.starts) {
      if (!Object.prototype.hasOwnProperty.call(s, "engine")) Object.defineProperty(s, "engine", { value: e, enumerable: false });
    }
  }

  private ensurePolling() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), 20);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const e = this.world.engine;
      if (!e) return;
      for (const feature of new Set(this.starts.map((s) => s.feature))) {
        const message = await e.takeTurn(feature).catch(() => null);
        if (!message) continue;
        this.turns.push({ feature, message });
        const handler = this.onTurn;
        const s = this.latest(feature);
        if (handler && s) Promise.resolve(handler(feature, message, s.tools)).catch((err) => this.errors.push(err));
      }
    } finally {
      this.polling = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stops polling and waits for a poll in flight, so the suite never calls
   * an engine that is stopping. Polling resumes on the next session(). */
  async quiesce() {
    this.stop();
    while (this.polling) await realDelay(5);
  }

  turnsFor(feature: string) {
    return this.turns.filter((t) => t.feature === feature);
  }
}

export interface ProjectSpec {
  name?: string;
  ownerId?: number;
  ownerLogin?: string;
  clientId?: string;
  repoOwner?: string;
  repoOwnerId?: number;
  repo?: string;
  /** Allow list; defaults to the repo owner. */
  allowed?: Array<{ login: string; id: number }>;
  enabled?: boolean;
  /** Project and repo maturity (default production-ready); at rapid-prototype interview sessions open without sign-in by default (F-018 FR-13). */
  maturity?: string;
  /** `settings.interview_sign_in` as YAML flow text, for example `{ every: engine_start }` (F-018 FR-15). */
  signIn?: string;
  budgetMode?: "subscription" | "tokens";
  /** Edits the generated manifest text. */
  editManifest?: (text: string) => string;
  /** Feature ids already present in the managed repo (spec file and branch). */
  existingFeatures?: string[];
  publicRepo?: boolean;
}

export interface Project {
  name: string;
  ownerId: number;
  ownerLogin: string;
  clientId: string;
  repoOwner: string;
  repoOwnerId: number;
  repo: string;
  url: string;
  configRepo: string;
  clone: string;
  bare: string;
}

let counter = 0;

export class World {
  readonly root: string;
  readonly clock = new FakeClock();
  readonly gh: FakeGitHub;
  readonly store = new MemoryCredentialStore();
  readonly gitleaks: FakeGitleaks;
  readonly gitw: GitWrapper;
  readonly analyst: FakeAnalyst = new FakeAnalyst(this);
  readonly projects: Project[] = [];
  readonly master: string;
  readonly projectsFile: string;
  readonly home: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly runtimeDir: string;
  readonly markers: string;
  readonly modelCredential = "sk-ant-oat01-TESTMODEL" + rand(16);
  readonly factoryToken = "github_pat_TESTFACTORY" + rand(16);
  engine?: EngineHandle;
  envOverrides: Record<string, string | undefined> = {};
  gitleaksSha?: string;
  /** Run the engine's git through the logging wrapper. Each wrapped call
   * starts a Node process (and on Windows a launcher too), which makes long
   * runs several times slower, so only tests that read the log turn it on. */
  logGit = false;
  readonly sessionTokens: string[] = [];
  /** Milestone 2: the engine's `agents` runtime (a fake or real Docker and an SDK); none means no agent runs. */
  agents?: unknown;

  private constructor(tls?: { key: string; cert: string }) {
    this.root = mkdtempSync(join(tmpdir(), `f007-${++counter}-`));
    chmodSync(this.root, 0o755);
    for (const d of ["git", "bin", "home", "state", "run", "markers", "clones", "config", "outside", "worktrees"]) {
      mkdirSync(join(this.root, d), { recursive: true });
    }
    this.gh = new FakeGitHub(this.clock, join(this.root, "git"), tls);
    this.gh.factoryToken = this.factoryToken;
    this.gitleaks = new FakeGitleaks(join(this.root, "bin"));
    this.gitw = new GitWrapper(join(this.root, "bin"), REAL_GIT);
    this.home = join(this.root, "home");
    writeFileSync(join(this.home, ".gitconfig"), "[user]\n\tname = Owner\n\temail = owner@example.invalid\n");
    this.stateDir = join(this.root, "state");
    this.logDir = logDir(this.stateDir);
    this.runtimeDir = join(this.root, "run");
    this.markers = join(this.root, "markers");
    this.master = join(this.root, "master");
    this.projectsFile = join(this.master, "factory-projects.local.yaml");
    this.store.values.set(CREDENTIAL_NAMES.model, this.modelCredential);
  }

  static async create(
    specs: ProjectSpec[] = [{}],
    opts: { tls?: { key: string; cert: string }; writeProjectsFile?: boolean; logGit?: boolean; agentFiles?: boolean } = {},
  ): Promise<World> {
    const w = new World(opts.tls);
    w.logGit = opts.logGit ?? false;
    await w.gh.start();
    w.makeMaster(opts.agentFiles ?? false);
    specs.forEach((s, i) => w.addProject(s, i));
    if (opts.writeProjectsFile !== false) w.writeProjectsFile(w.projects.map((p) => p.configRepo));
    return w;
  }

  private makeMaster(agentFiles: boolean) {
    mkdirSync(this.master);
    git(this.master, "init", "-q", "-b", "main");
    writeFileSync(join(this.master, "README.md"), "# software-factory (fixture)\n");
    writeFileSync(join(this.master, ".gitignore"), ".factory/\n/factory-projects.local.yaml\n");
    // The engine reads its limit and model defaults from the commit factory.version names (spec v30, v32).
    mkdirSync(join(this.master, "engine", "config"), { recursive: true });
    writeFileSync(join(this.master, "engine", "config", "limits.yaml"), readFileSync(join(REPO_ROOT, "engine", "config", "limits.yaml")));
    writeFileSync(join(this.master, "engine", "config", "models.yaml"), readFileSync(join(REPO_ROOT, "engine", "config", "models.yaml")));
    // A role runs only with an AGENT.md at factory.version (SR-10), so worlds that run agents carry the real two.
    if (agentFiles) {
      for (const role of ["requirements-analyst", "web-reader"]) {
        mkdirSync(join(this.master, "agents", role), { recursive: true });
        writeFileSync(join(this.master, "agents", role, "AGENT.md"), readFileSync(join(REPO_ROOT, "agents", role, "AGENT.md")));
      }
    }
    git(this.master, "add", "-A");
    git(this.master, "commit", "-q", "-m", "master root");
    git(this.master, "tag", "v0.1.0");
    git(this.master, "remote", "add", "origin", "https://github.com/example-owner/software-factory");
  }

  writeProjectsFile(paths: string[], mode = 0o600) {
    const body = "projects:\n" + paths.map((p) => `  - path: ${JSON.stringify(p)}\n`).join("");
    writeFileSync(this.projectsFile, body);
    chmodSync(this.projectsFile, mode);
    ownerOnly(this.projectsFile);
  }

  addProject(s: ProjectSpec, i = this.projects.length): Project {
    const name = s.name ?? `proj${i}`;
    const repoOwner = s.repoOwner ?? `org${i}`;
    const repo = s.repo ?? `app${i}`;
    const p: Project = {
      name,
      ownerId: s.ownerId ?? 1001 + i,
      ownerLogin: s.ownerLogin ?? `owner${i}`,
      clientId: s.clientId ?? `Iv1.client${i}${rand(4)}`,
      repoOwner,
      repoOwnerId: s.repoOwnerId ?? 5001 + i,
      repo,
      url: `https://github.com/${repoOwner}/${repo}`,
      configRepo: join(this.root, "config", name),
      // The engine keeps .factory, engine.json and feature branches in the
      // listed config repo, so the project's repo is that one clone.
      clone: join(this.root, "config", name),
      bare: join(this.root, "git", repoOwner, `${repo}.git`),
    };
    this.gh.addUser(p.ownerId, p.ownerLogin);
    this.store.values.set(CREDENTIAL_NAMES.factoryToken(name), this.factoryToken);
    this.gh.addRepo(repoOwner, repo, p.repoOwnerId, !s.publicRepo);

    // The repo on the fake GitHub, with main (holding the manifest) and
    // factory/state, and the owner's clone of it, which the projects file
    // lists. One fast-import run builds the bare repo (H-0132).
    mkdirSync(dirname(p.bare), { recursive: true });
    git(this.root, "init", "-q", "--bare", "-b", "main", p.bare);
    const main: Record<string, string> = {
      "README.md": `# ${repo}\n`,
      ".gitignore": ".factory/\n",
      "docs/features/.keep": "",
      "factory-project.yaml": this.manifestText(p, s),
    };
    for (const f of s.existingFeatures ?? []) main[`docs/features/${f}-existing.md`] = `# Feature: existing\n\n- **Id:** ${f}\n`;
    const time = Math.floor(Date.now() / 1000);
    const stream = fastImportStream([
      { ref: "refs/heads/main", message: "initial", files: main, time, alsoAt: (s.existingFeatures ?? []).map((f) => `refs/heads/feature/${f}-existing`) },
      { ref: "refs/heads/factory/state", message: "factory/state root", files: { "README.md": "factory state\n" }, time },
    ]);
    gitWithInput(p.bare, stream, "fast-import", "--quiet");
    git(this.root, "clone", "-q", "-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", p.bare, p.clone);
    git(p.clone, "remote", "set-url", "origin", this.gh.gitUrl(repoOwner, repo));

    this.projects.push(p);
    return p;
  }

  manifestText(p: Project, s: ProjectSpec = {}): string {
    // A Windows checkout may have CRLF line endings.
    const template = readFileSync(TEMPLATE, "utf8").replace(/\r\n/g, "\n");
    const policy = template.slice(template.indexOf("\npolicy:\n") + 1, template.indexOf("\nnotes:"));
    const allowed = s.allowed ?? [{ login: p.repoOwner, id: p.repoOwnerId }];
    let text =
      `schema: factory-project/1.0\n` +
      `name: ${p.name}\n` +
      `description: Fixture project ${p.name}\n\n` +
      `factory:\n  version: v0.1.0\n\n` +
      `enabled: ${s.enabled ?? true}\n` +
      `owner:\n  github_id: ${p.ownerId}\n  oauth_client_id: ${p.clientId}\n` +
      `allowed_repo_owners:\n` +
      allowed.map((a) => `  - { login: ${a.login}, id: ${a.id} }\n`).join("") +
      // Production ready by default, so the Security and Testability Review fixtures' High and Medium findings block (F-016 FR-19).
      `\nrepos:\n  - name: ${p.repo}\n    url: ${p.url}\n    maturity: ${s.maturity ?? "production-ready"}\n` +
      `maturity: ${s.maturity ?? "production-ready"}\n\n` +
      `skills:\n  custom: []\n  override: []\n  exclude: []\n\n` +
      `agents:\n  custom: []\n  override: []\n\n` +
      `standards: {}\n\n` +
      `settings:\n` +
      (s.signIn ? `  interview_sign_in: ${s.signIn}\n` : "") +
      `  budget:\n    mode: ${s.budgetMode ?? "subscription"}\n\n` +
      policy +
      `\nnotes: |\n  Fixture.\n`;
    if (s.editManifest) text = s.editManifest(text);
    return text;
  }

  /** Commits a new manifest on the config repo's main. */
  commitManifest(p: Project, edit: (text: string) => string) {
    const f = join(p.configRepo, "factory-project.yaml");
    writeFileSync(f, edit(readFileSync(f, "utf8")));
    git(p.configRepo, "commit", "-q", "-am", "manifest change");
  }

  options(): EngineOptions {
    const env: Record<string, string> = {
      HOME: this.home,
      PATH: [join(this.root, "bin"), BASE_PATH].join(delimiter),
      LANG: "C.UTF-8",
      TMPDIR: join(this.root, "run"),
      GITLEAKS_CONFIG: join(this.root, "outside", "evil-gitleaks.toml"),
      GITLEAKS_CONFIG_TOML: '[allowlist]\npaths = [".*"]\n',
    };
    for (const [k, v] of Object.entries(this.envOverrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return {
      clock: this.clock,
      env,
      github: { webBaseUrl: this.gh.webBaseUrl, apiBaseUrl: this.gh.apiBaseUrl },
      credentialStore: this.store,
      gitleaks: { path: this.gitleaks.path, sha256: this.gitleaksSha ?? this.gitleaks.sha256 },
      gitPath: this.logGit ? this.gitw.path : REAL_GIT,
      paths: {
        masterRepo: this.master,
        stateDir: this.stateDir,
        runtimeDir: this.runtimeDir,
      },
      resumeAnalyst: (r) => this.analyst.resume(r),
      ...(this.agents ? { agents: this.agents } : {}),
    };
  }

  /** Starts the engine. With `confirm`, first approves each project the
   * engine holds no pin for (new path, SR-5) as its manifest owner, through
   * the same confirm command the owner runs, so the engine starts once
   * instead of starting, stopping on the new path and restarting (H-0151).
   * Projects the confirm command refuses stay unpinned and stopped; the
   * test checks that. */
  async boot(opts: { confirm?: boolean } = {}): Promise<EngineHandle> {
    if (opts.confirm ?? true) {
      for (const p of this.projects) {
        if (this.pinned(p)) continue;
        try {
          await this.confirmBeforeStart(p, p.ownerId);
        } catch {
          // Refused: the engine will stop this project and file why.
        }
      }
    }
    this.engine = await startEngine(this.options());
    this.analyst.adopt(this.engine);
    return this.engine;
  }

  /** Whether the engine's pin store holds this project's path. */
  pinned(p: Project): boolean {
    const file = join(this.stateDir, "pins.json");
    if (!existsSync(file)) return false;
    const projects = (JSON.parse(readFileSync(file, "utf8")) as { projects?: Record<string, unknown> }).projects ?? {};
    return Object.keys(projects).some((k) => samePath(realpathSync.native(k), realpathSync.native(p.configRepo)));
  }

  /** The SR-5 confirm command with no engine running, approved as `asUserId`. */
  async confirmBeforeStart(p: Project, asUserId: number): Promise<void> {
    const r = await confirmCommand(this.options(), p.configRepo);
    if (r.approval) this.gh.approve(r.approval.user_code, asUserId);
    await drive(this.clock, Promise.resolve(r.done), { maxMs: 1000 * 1000 });
  }

  /** Runs the SR-5 confirm command, approves its sign-in as `asUserId`, and
   * restarts the engine, as the command tells the owner to. */
  async confirm(p: Project, asUserId: number, restart = true): Promise<void> {
    const r = await this.engine!.confirmProject(p.configRepo);
    if (r.approval) this.gh.approve(r.approval.user_code, asUserId);
    await drive(this.clock, Promise.resolve(r.done), { maxMs: 1000 * 1000 });
    if (restart) await this.restart();
  }

  async isRunning(p: Project): Promise<boolean> {
    const all = await this.engine!.projects();
    return all.some((x) => samePath(x.path, p.configRepo) && x.state === "running");
  }

  async stop() {
    if (this.engine) {
      await this.analyst.quiesce();
      const e = this.engine;
      this.engine = undefined;
      await e.stop();
    }
  }

  async restart(opts: { confirm?: boolean } = {}) {
    await this.stop();
    return this.boot({ confirm: opts.confirm ?? false });
  }

  async sync() {
    if (this.engine?.sync) await this.engine.sync();
    else await this.restart();
  }

  async settle() {
    if (this.engine?.flush) await this.engine.flush();
    await realDelay(300);
  }

  engineJsonPath(p: Project = this.project()) {
    return join(p.clone, ".factory", "engine.json");
  }

  engineJson(p: Project = this.project()): { version: string; capabilities?: string[]; path: string; pid: number } {
    return JSON.parse(readFileSync(this.engineJsonPath(p), "utf8"));
  }

  socket(p: Project = this.project()): string {
    return this.engineJson(p).path;
  }

  rpc(method: string, params?: unknown, timeoutMs?: number): Promise<RpcResponse> {
    return rpcOnce(this.socket(), method, params, timeoutMs);
  }

  async connect(): Promise<RpcClient> {
    return RpcClient.connect(this.socket());
  }

  async ok(method: string, params?: unknown): Promise<any> {
    const r = await this.rpc(method, params);
    if (r.error || r.result === undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(r.error ?? r)}${r.error?.message === "connection closed" ? this.channelLog() : ""}`);
    }
    return r.result;
  }

  /** A connection the engine closes without an answer is usually a refusal; its reason is only in the log. */
  private channelLog(): string {
    let lines: string[] = [];
    try {
      lines = listFiles(this.logDir).flatMap((f) => readFileSync(f, "utf8").split("\n")).filter((l) => /channel/i.test(l));
    } catch {
      // no log yet
    }
    return lines.length ? `\nchannel log lines:\n${lines.slice(-10).join("\n")}` : "\n(no channel lines in the engine log)";
  }

  async startFeature(request = "Let people export their data as CSV"): Promise<string> {
    const r = await this.ok("feature.start", { request });
    return r.feature;
  }

  /** Opens a session and approves it on the fake phone, unless this run's earlier approval covers it (F-018 FR-13). */
  async approvedSession(feature: string, asUserId?: number): Promise<string> {
    const open = await this.ok("interview.open", { feature });
    this.sessionTokens.push(open.session);
    if (open.approval === undefined) return open.session;
    const p = this.projectOf(feature) ?? this.project();
    this.gh.approve(open.approval.user_code, asUserId ?? p.ownerId);
    const r = await drive(this.clock, this.rpc("interview.awaitApproval", { session: open.session, wait_s: 900 }, 120_000));
    if (!r.result?.approved) throw new Error(`approval failed: ${JSON.stringify(r)}`);
    return open.session;
  }

  /** A checkout of the feature branch for the analyst, as milestone 2's
   * session would get. */
  analystWorktree(feature: string): string {
    const p = this.projectOf(feature) ?? this.project();
    const ref = git(p.clone, "for-each-ref", "--format=%(refname:short)", `refs/heads/feature/${feature}-*`).trim().split("\n")[0];
    if (!ref) throw new Error(`no feature branch for ${feature}`);
    const dir = join(this.root, "worktrees", `${feature}-${rand(3)}`);
    git(p.clone, "worktree", "add", "-q", "--detach", dir, ref);
    return dir;
  }

  async tools(feature: string): Promise<InterviewTools> {
    return (await this.analyst.session(feature)).tools;
  }

  async tool(feature: string, name: string, args: unknown): Promise<ToolOutcome> {
    return callTool(await this.tools(feature), name, args);
  }

  async ask(feature: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.tool(feature, "interview_ask", { text: `Question ${rand(3)}?`, why: "Needed for the spec.", ...args });
    if (!r.ok) throw new Error(`interview_ask refused: ${r.code} ${r.message}`);
    return r.value.item;
  }

  async propose(feature: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.tool(feature, "interview_propose_assumption", { text: `Assume ${rand(3)}.`, why: "Simplest.", ...args });
    if (!r.ok) throw new Error(`interview_propose_assumption refused: ${r.code} ${r.message}`);
    return r.value.item;
  }

  async reply(session: string, item: { id: string; revision: number }, kind: string, text = "", replyId = rand(8)) {
    return this.rpc("interview.reply", { session, item: item.id, revision: item.revision, reply_id: replyId, kind, text });
  }

  /** The world's i-th project; throws if the world was built with fewer. */
  project(i = 0): Project {
    const p = this.projects[i];
    if (!p) throw new Error(`world has no project ${i}`);
    return p;
  }

  /** Which project a feature landed in, by its branch. */
  projectOf(feature: string): Project | undefined {
    return this.projects.find((p) => {
      const local = tryGit(p.clone, "for-each-ref", "--format=%(refname)", `refs/heads/feature/${feature}-*`);
      const remote = tryGit(p.bare, "for-each-ref", "--format=%(refname)", `refs/heads/feature/${feature}-*`);
      return Boolean(local?.trim() || remote?.trim());
    });
  }

  /** Every inbox item with `category: Security`, wherever the engine put it:
   * the `.factory` worktree or the `factory/state` branch, local or remote. */
  securityItems(): Array<{ where: string; id: string; text: string }> {
    const byId = new Map<string, { where: string; id: string; text: string }>();
    for (const r of this.projects.flatMap((p) => [p.clone, p.bare, p.configRepo])) {
      // The clone and its bare remote hold the same item once.
      for (const i of securityItemsIn(r)) byId.set(`${r.replace(/\.git$/, "")}:${i.id}`, { where: r, id: i.id, text: i.text });
    }
    return [...byId.values()];
  }

  /** All text reachable in a repo's history, every ref. */
  history(repo: string): string {
    return tryGit(repo, "log", "--all", "-p", "--text", "--format=%H %s%n%b") ?? "";
  }

  transcriptText(p: Project, feature: string): string {
    const dir = join(p.clone, ".factory", "interviews", feature);
    if (!existsSync(dir)) return "";
    return listFiles(dir)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
  }

  async cleanup() {
    this.analyst.stop();
    // After a test timed out, its engine may still be mid-call: don't wait on it for long.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.stop().catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, 15_000)))]);
    clearTimeout(timer);
    await this.gh.stop().catch(() => undefined);
    // F-014 readers outside the engine (the confirm command's) hold their repo on Windows until they exit.
    const { Git } = await import(/* @vite-ignore */ fileURLToPath(new URL("../../../src/git.ts", import.meta.url)));
    await Git.closeAllReaders();
    removeTree(this.root);
  }
}

export function samePath(a: string, b: string) {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

/** Text that shows the owner's words survived: Unicode, Markdown, newlines,
 * trailing spaces, things that look like frames or JSON-RPC. */
export const AWKWARD_TEXT =
  "Yes — ship it to 🇳🇿 users first.\n\n" +
  "## Not a heading the engine should act on\n" +
  "```\n}\n```\n" +
  '{"jsonrpc":"2.0","id":99,"method":"engine.shutdown"}\n' +
  "--- END OF OWNER REPLY ---\n" +
  "trailing spaces   \n" +
  "$(echo injected) `uname` {{template}} ${HOME}";
