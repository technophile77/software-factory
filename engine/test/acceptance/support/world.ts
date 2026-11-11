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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREDENTIAL_NAMES,
  callTool,
  startEngine,
  type AnalystSeam,
  type AnalystStart,
  type CredentialStore,
  type EngineHandle,
  type EngineOptions,
  type InterviewTools,
  type ToolOutcome,
} from "../harness";
import { drive, FakeClock, realDelay } from "./clock";
import { FakeGitHub } from "./fake-github";
import { FakeGitleaks, GitWrapper } from "./fake-tools";
import { RpcClient, rpcOnce, type RpcResponse } from "./rpc";

export const REAL_GIT = "/usr/bin/git";
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const TEMPLATE = join(REPO_ROOT, "plugins/software-factory/skills/onboard-repo/templates/factory-project.yaml");

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
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
    return this.values.get(name);
  }
  async set(name: string, value: string) {
    this.accessed.push(name);
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.accessed.push(name);
    this.values.delete(name);
  }
}

export class FakeAnalyst implements AnalystSeam {
  readonly starts: AnalystStart[] = [];
  readonly turns: Array<{ feature: string; message: string }> = [];
  /** Runs on each turn, e.g. to revise an item after `more_info`. */
  onTurn?: (feature: string, message: string, tools: InterviewTools) => void | Promise<void>;

  start(ctx: AnalystStart) {
    this.starts.push(ctx);
  }

  readonly errors: unknown[] = [];

  turn(ctx: { feature: string; message: string }) {
    this.turns.push(ctx);
    const s = this.latest(ctx.feature);
    const handler = this.onTurn;
    // The analyst acts after the engine hands over the turn, as a separate
    // session would, so an engine that awaits this call can't deadlock.
    if (handler && s) {
      setImmediate(() => {
        Promise.resolve(handler(ctx.feature, ctx.message, s.tools)).catch((e) => this.errors.push(e));
      });
    }
  }

  latest(feature: string): AnalystStart | undefined {
    return [...this.starts].reverse().find((s) => s.feature === feature);
  }

  async session(feature: string, timeoutMs = 10_000): Promise<AnalystStart> {
    return waitFor(() => this.latest(feature), timeoutMs, `the engine to start the analyst for ${feature}`);
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
  readonly analyst = new FakeAnalyst();
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
  readonly sessionTokens: string[] = [];

  private constructor(tls?: { key: string; cert: string }) {
    this.root = mkdtempSync(join(tmpdir(), `f007-${++counter}-`));
    chmodSync(this.root, 0o755);
    for (const d of ["git", "bin", "home", "state", "logs", "run", "markers", "clones", "config", "outside"]) {
      mkdirSync(join(this.root, d), { recursive: true });
    }
    this.gh = new FakeGitHub(this.clock, join(this.root, "git"), tls);
    this.gh.factoryToken = this.factoryToken;
    this.gitleaks = new FakeGitleaks(join(this.root, "bin"));
    this.gitw = new GitWrapper(join(this.root, "bin"), REAL_GIT);
    this.home = join(this.root, "home");
    writeFileSync(join(this.home, ".gitconfig"), "[user]\n\tname = Owner\n\temail = owner@example.invalid\n");
    this.stateDir = join(this.root, "state");
    this.logDir = join(this.root, "logs");
    this.runtimeDir = join(this.root, "run");
    this.markers = join(this.root, "markers");
    this.master = join(this.root, "master");
    this.projectsFile = join(this.master, "factory-projects.local.yaml");
    this.store.values.set(CREDENTIAL_NAMES.model, this.modelCredential);
    this.store.values.set(CREDENTIAL_NAMES.factoryToken, this.factoryToken);
  }

  static async create(
    specs: ProjectSpec[] = [{}],
    opts: { tls?: { key: string; cert: string }; writeProjectsFile?: boolean } = {},
  ): Promise<World> {
    const w = new World(opts.tls);
    await w.gh.start();
    w.makeMaster();
    specs.forEach((s, i) => w.addProject(s, i));
    if (opts.writeProjectsFile !== false) w.writeProjectsFile(w.projects.map((p) => p.configRepo));
    return w;
  }

  private makeMaster() {
    mkdirSync(this.master);
    git(this.master, "init", "-q", "-b", "main");
    writeFileSync(join(this.master, "README.md"), "# software-factory (fixture)\n");
    writeFileSync(join(this.master, ".gitignore"), ".factory/\n/factory-projects.local.yaml\n");
    git(this.master, "add", "-A");
    git(this.master, "commit", "-q", "-m", "master root");
    git(this.master, "tag", "v0.1.0");
    git(this.master, "remote", "add", "origin", "https://github.com/technophile77/software-factory");
  }

  writeProjectsFile(paths: string[], mode = 0o600) {
    const body = "projects:\n" + paths.map((p) => `  - path: ${JSON.stringify(p)}\n`).join("");
    writeFileSync(this.projectsFile, body);
    chmodSync(this.projectsFile, mode);
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
      clone: join(this.root, "clones", `${repoOwner}-${repo}`),
      bare: join(this.root, "git", repoOwner, `${repo}.git`),
    };
    this.gh.addUser(p.ownerId, p.ownerLogin);
    this.gh.addRepo(repoOwner, repo, p.repoOwnerId, !s.publicRepo);

    // Managed repo: bare remote with main and factory/state, plus a local clone.
    mkdirSync(dirname(p.bare), { recursive: true });
    git(this.root, "init", "-q", "--bare", "-b", "main", p.bare);
    const seed = join(this.root, "seed-" + rand(4));
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), `# ${repo}\n`);
    writeFileSync(join(seed, ".gitignore"), ".factory/\n");
    mkdirSync(join(seed, "docs", "features"), { recursive: true });
    for (const f of s.existingFeatures ?? []) {
      writeFileSync(join(seed, "docs", "features", `${f}-existing.md`), `# Feature: existing\n\n- **Id:** ${f}\n`);
    }
    writeFileSync(join(seed, "docs", "features", ".keep"), "");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "initial");
    for (const f of s.existingFeatures ?? []) git(seed, "branch", `feature/${f}-existing`);
    git(seed, "checkout", "-q", "--orphan", "factory/state");
    git(seed, "rm", "-rq", "--cached", ".");
    for (const e of readdirSync(seed)) if (e !== ".git") rmSync(join(seed, e), { recursive: true, force: true });
    writeFileSync(join(seed, "README.md"), "factory state\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "-q", "-m", "factory/state root");
    git(seed, "push", "-q", p.bare, "--all");
    rmSync(seed, { recursive: true, force: true });
    git(this.root, "clone", "-q", p.bare, p.clone);
    git(p.clone, "remote", "set-url", "origin", this.gh.gitUrl(repoOwner, repo));
    git(p.clone, "config", "user.name", "Owner");
    git(p.clone, "config", "user.email", "owner@example.invalid");

    // Config repo with the manifest committed on main.
    mkdirSync(p.configRepo, { recursive: true });
    git(p.configRepo, "init", "-q", "-b", "main");
    writeFileSync(join(p.configRepo, "factory-project.yaml"), this.manifestText(p, s));
    git(p.configRepo, "add", "-A");
    git(p.configRepo, "commit", "-q", "-m", "manifest");

    this.projects.push(p);
    return p;
  }

  manifestText(p: Project, s: ProjectSpec = {}): string {
    const template = readFileSync(TEMPLATE, "utf8");
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
      `\nrepos:\n  - name: ${p.repo}\n    url: ${p.url}\n    maturity: rapid-prototype\n` +
      `maturity: rapid-prototype\n\n` +
      `skills:\n  custom: []\n  override: []\n  exclude: []\n\n` +
      `agents:\n  custom: []\n  override: []\n\n` +
      `standards: {}\n\n` +
      `settings:\n  budget:\n    mode: ${s.budgetMode ?? "subscription"}\n\n` +
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
      PATH: `${join(this.root, "bin")}:/usr/bin:/bin`,
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
      gitPath: this.gitw.path,
      paths: {
        masterRepo: this.master,
        projectsFile: this.projectsFile,
        stateDir: this.stateDir,
        logDir: this.logDir,
        runtimeDir: this.runtimeDir,
        repoClones: Object.fromEntries(this.projects.map((p) => [p.url, p.clone])),
      },
      analyst: this.analyst,
    };
  }

  /** Starts the engine. With `confirm`, approves each project the engine
   * holds for a first confirmation (new path, SR-5) as its manifest owner. */
  async boot(opts: { confirm?: boolean } = {}): Promise<EngineHandle> {
    this.engine = await startEngine(this.options());
    if (opts.confirm ?? true) {
      for (const p of this.projects) {
        if (await this.isRunning(p)) continue;
        try {
          await this.confirm(p, p.ownerId);
        } catch {
          // A project the engine refuses stays stopped; the test checks that.
        }
      }
    }
    return this.engine;
  }

  async confirm(p: Project, asUserId: number): Promise<void> {
    const r = await this.engine!.confirmProject(p.configRepo);
    if (r.approval) this.gh.approve(r.approval.user_code, asUserId);
    await drive(this.clock, Promise.resolve(r.done), { maxMs: 1000 * 1000 });
  }

  async isRunning(p: Project): Promise<boolean> {
    const all = await this.engine!.projects();
    return all.some((x) => samePath(x.path, p.configRepo) && x.state === "running");
  }

  async stop() {
    if (this.engine) {
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

  engineJsonPath(p: Project = this.projects[0]) {
    return join(p.clone, ".factory", "engine.json");
  }

  engineJson(p: Project = this.projects[0]): { version: string; path: string; pid: number } {
    return JSON.parse(readFileSync(this.engineJsonPath(p), "utf8"));
  }

  socket(p: Project = this.projects[0]): string {
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
      throw new Error(`${method} failed: ${JSON.stringify(r.error ?? r)}`);
    }
    return r.result;
  }

  async startFeature(request = "Let people export their data as CSV"): Promise<string> {
    const r = await this.ok("feature.start", { request });
    return r.feature;
  }

  /** Opens a session and approves it on the fake phone. */
  async approvedSession(feature: string, asUserId?: number): Promise<string> {
    const open = await this.ok("interview.open", { feature });
    this.sessionTokens.push(open.session);
    const p = this.projectOf(feature) ?? this.projects[0];
    this.gh.approve(open.approval.user_code, asUserId ?? p.ownerId);
    const r = await drive(this.clock, this.rpc("interview.awaitApproval", { session: open.session, wait_s: 900 }, 120_000));
    if (!r.result?.approved) throw new Error(`approval failed: ${JSON.stringify(r)}`);
    return open.session;
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
    const out = new Map<string, { where: string; id: string; text: string }>();
    const consider = (where: string, id: string, text: string) => {
      if (/^category:\s*Security\s*$/m.test(text)) out.set(`${where}:${id}`, { where, id, text });
    };
    const repos = [...this.projects.flatMap((p) => [p.clone, p.bare, p.configRepo])];
    for (const r of repos) {
      const dir = join(r, ".factory", "inbox", "decision");
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) consider(r, f, readFileSync(join(dir, f), "utf8"));
      }
      const names = tryGit(r, "ls-tree", "-r", "--name-only", "refs/heads/factory/state", "--", "inbox/decision");
      for (const n of names?.split("\n").filter(Boolean) ?? []) {
        const text = tryGit(r, "show", `refs/heads/factory/state:${n}`);
        if (text) consider(r, n.split("/").pop()!, text);
      }
    }
    // The same item seen in the worktree and on the branch counts once.
    const byId = new Map<string, { where: string; id: string; text: string }>();
    for (const v of out.values()) byId.set(`${v.where.replace(/\.git$/, "")}:${v.id}`, v);
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
    try {
      await this.stop();
    } catch {
      // A failing engine must not hide the test's own failure.
    }
    await this.gh.stop().catch(() => undefined);
    rmSync(this.root, { recursive: true, force: true });
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
