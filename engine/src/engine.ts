import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Conn, notification, serve } from "./channel/framing";
import { EngineControl, ProjectChannel, methods } from "./channel/methods";
import { SessionManager } from "./channel/sessions";
import { Listener, listenUnix } from "./channel/unix";
import { listenPipe } from "./channel/windows";
import { Clock, iso, systemClock } from "./clock";
import { AuthorizationError, authorizeProject, billingMismatch } from "./config/authorize";
import { Manifest, readManifest } from "./config/manifest";
import { ConfigError, checkProjectPath, readPathsFile } from "./config/paths-file";
import { PinStore, comparePin } from "./config/pins";
import { ConfirmIo, confirmProject as runConfirm } from "./config/confirm";
import { ENGINE_JSON, FEATURE_ID_RE, GITHUB_WEB_BASE, INTERVIEW_STAGE, SERVED_CHANNEL_VERSION } from "./constants";
import { ensureOwnerDir, findOnPath, sha256Hex, writeFileAtomic } from "./fsutil";
import { Git } from "./git";
import { GitHubClient, HttpGitHub, checkBase } from "./github";
import { Gitleaks, SecretsScanner } from "./gitleaks";
import { FeatureInterview } from "./interview/feature";
import { InterviewTools, createInterviewTools } from "./interview/tools";
import { FileLogger, Logger } from "./log";
import { OsApi, realOsApi } from "./os/ffi";
import { Children, linuxParent } from "./proc";
import { CredentialStore, MODEL_CREDENTIAL, OsCredentialStore, SecretError, factoryTokenName } from "./secrets";
import { SecurityAlert, fileSecurityItem } from "./state/inbox";
import { EngineRecord, RunRecord } from "./state/record";
import { ResumePlan, RunBook, RunFacts, agentReport } from "./state/runs";
import { Change, StateRepo } from "./state/state-repo";
import { ChainError, Entry, checkAgainstHead, parseTranscript, transcriptPath } from "./state/transcript";

export class StartError extends Error {
  override name = "StartError";
}

export interface EngineOptions {
  /** The owner's clone of the master factory repo, holding factory-projects.local.yaml. */
  masterRepo: string;
  /** Engine-owned folder outside every repo. Default: ~/.software-factory/engine (or %LOCALAPPDATA%). */
  engineHome?: string;
  /** Where channel sockets go. Default: <engineHome>/run. Keep it short: socket paths are limited to ~100 bytes. */
  runtimeDir?: string;
  gitleaks: { path: string; timeoutS?: number; expectSha256?: string };
  /** A pre-built scanner, instead of gitleaks (tests only). */
  scanner?: SecretsScanner;
  gitPath?: string;
  credentials?: CredentialStore;
  /** A GitHub client, or the base URLs of a fake GitHub. */
  github?: GitHubClient | { webBase?: string; apiBase?: string };
  clock?: Clock;
  os?: OsApi;
  /** Environment for the billing-mode check. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** How the channel finds a peer's parent process. Default: /proc on Linux. */
  parentOf?: (pid: number) => number | null;
  /**
   * Talk to each project's remote: fetch factory/state at start and on
   * sync(), push it after each commit. Default false; the CLI turns it on.
   */
  push?: boolean;
  /**
   * Starts the analyst again for a run the engine found interrupted (FR-14).
   * Milestone 2 starts an Agent SDK session here. Without it, the resumed run
   * waits for the next interviewTools call for its feature.
   */
  resumeAnalyst?: (r: { feature: string; worktree: string; tools: InterviewTools; plan: ResumePlan }) => void;
}

export type ProjectState = "running" | "stopped" | "disabled";

export interface ProjectStatus {
  path: string;
  name: string | null;
  state: ProjectState;
  reason?: string;
  channel?: string;
  warnings: string[];
}

interface Project extends ProjectStatus {
  real: string | null;
  manifest: Manifest | null;
  state_repo: StateRepo | null;
  features: Map<string, FeatureInterview>;
  sessions: SessionManager | null;
  listener: Listener | null;
  conns: Set<Conn>;
  token: string | null;
}

export interface EngineHandle {
  projects: ProjectStatus[];
  runs: RunBook;
  /** Resolves when the engine has stopped (engine.shutdown or stop()). */
  stopped: Promise<void>;
  stop(): Promise<void>;
  /**
   * Stops as a kill would: no shutdown work, and nothing more is committed or
   * written. The sockets are freed, so a new startEngine can run in this
   * process and find its runs interrupted (AC-12).
   */
  crash(): Promise<void>;
  /** Fetches factory/state for each running project and checks every transcript against the engine's chain (SR-17). */
  sync(): Promise<void>;
  /** The SR-5 confirm command, with this engine's GitHub, clock and logger. A confirmed project runs after a restart. */
  confirmProject(projectPath: string, io: ConfirmIo): Promise<boolean>;
  feature(id: string): FeatureInterview | null;
  /** The analyst's tools for one feature, reading the spec from `worktree` (the analyst's checkout). */
  interviewTools(feature: string, worktree: string, facts?: RunFacts): InterviewTools;
}

export function defaultEngineHome(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "software-factory", "engine");
  }
  return path.join(os.homedir(), ".software-factory", "engine");
}

function slug(request: string): string {
  const words = request.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  const s = words.slice(0, 5).join("-").slice(0, 40).replace(/-+$/, "");
  return s || "feature";
}

function title(request: string): string {
  const first = request.trim().split(/\r?\n/)[0]!.trim();
  return [...first].slice(0, 80).join("");
}

export async function startEngine(o: EngineOptions): Promise<EngineHandle> {
  const clock = o.clock ?? systemClock;
  const home = o.engineHome ?? defaultEngineHome();
  ensureOwnerDir(home);
  const log = o.logger ?? new FileLogger(path.join(home, "logs"), clock);
  const osApi = o.os ?? realOsApi();
  const env = o.env ?? process.env;
  const children = new Children(o.parentOf ?? linuxParent);
  const gitPath = o.gitPath ?? findOnPath("git");
  if (!gitPath) throw new StartError("git isn't on PATH.");
  const git = new Git({ gitPath, homeDir: path.join(home, "git"), children, env });
  const scanner = o.scanner ?? new Gitleaks({ binary: o.gitleaks.path, workDir: path.join(home, "gitleaks"), children, timeoutS: o.gitleaks.timeoutS, expectSha256: o.gitleaks.expectSha256 });
  if (scanner instanceof Gitleaks) {
    // Without a working scanner nothing may be committed, so the engine doesn't start (SR-2).
    try {
      await scanner.verify();
    } catch (e) {
      throw new StartError((e as Error).message);
    }
  }
  const record = new EngineRecord(home);
  const pins = new PinStore(home);
  const runs = new RunBook(record, clock);
  const interruptedAtStart = runs.markInterrupted();
  for (const r of interruptedAtStart) log.warn(`Run ${r.id} (${r.role}, ${r.feature}) was interrupted; it will resume without counting a retry.`);
  const credentials = o.credentials ?? new OsCredentialStore(() => osApi.credentials());
  const github: GitHubClient = o.github && "requestDeviceCode" in o.github ? o.github : new HttpGitHub({ ...(o.github ?? {}), log });
  // Pushes and fetches go only to the GitHub the engine was given (SR-1). A
  // loopback http base can come only from these in-process options.
  let gitBase: string;
  try {
    gitBase = checkBase(github.webBase ?? GITHUB_WEB_BASE);
  } catch (e) {
    throw new StartError((e as Error).message);
  }
  // Set by crash(): from then on the engine acts as if its process were gone.
  let dead = false;
  const runtimeDir = o.runtimeDir ?? path.join(home, "run");
  const tmpDir = path.join(home, "tmp");
  const startedAt = clock.now();

  let modelCredential: string | null;
  try {
    modelCredential = await credentials.get(MODEL_CREDENTIAL);
  } catch (e) {
    throw new StartError(e instanceof SecretError ? e.message : "The credential store couldn't be read.");
  }

  let listed: string[];
  try {
    listed = readPathsFile(o.masterRepo, osApi);
  } catch (e) {
    throw new StartError(e instanceof ConfigError ? e.message : "The project paths file couldn't be read.");
  }

  const projects: Project[] = listed.map((p) => ({
    path: p, name: null, state: "stopped", warnings: [], real: null, manifest: null, state_repo: null,
    features: new Map(), sessions: null, listener: null, conns: new Set(), token: null,
  }));

  const alert = async (p: Project, key: string, a: SecurityAlert) => {
    if (!p.state_repo || dead) return;
    const k = sha256Hex(`${p.real}\0${key}`);
    if (record.alert(k)) return;
    try {
      const id = await fileSecurityItem(p.state_repo, clock, a);
      record.setAlert(k, id);
      log.warn(`${p.name ?? p.path}: filed Security item ${id}: ${a.title}`);
    } catch (e) {
      log.warn(`${p.name ?? p.path}: couldn't file a Security item (${(e as Error).message}).`);
    }
  };

  const stop = (p: Project, reason: string, state: ProjectState = "stopped") => {
    p.state = state;
    p.reason = reason;
    log.warn(`${p.name ?? p.path}: ${state === "disabled" ? "not running" : "stopped"}: ${reason}`);
  };

  // Phase 1: paths, manifests from main, pinned keys (FR-2, SR-5, SR-13).
  for (const p of projects) {
    try {
      p.real = await checkProjectPath(p.path, o.masterRepo, git);
    } catch (e) {
      // Not a repo the engine can trust, so nothing is written into it.
      stop(p, e instanceof ConfigError ? e.message : "the path couldn't be checked");
      continue;
    }
    p.state_repo = new StateRepo(git, scanner, p.real, log, tmpDir);
    try {
      await p.state_repo.ensureWorktree();
    } catch (e) {
      p.state_repo = null;
      stop(p, `factory/state couldn't be checked out at .factory (${(e as Error).message})`);
      continue;
    }
    try {
      p.manifest = await readManifest(git, p.real);
      p.name = p.manifest.name;
    } catch (e) {
      stop(p, (e as Error).message);
      await alert(p, `manifest:${(e as Error).message}`, {
        title: "Project manifest failed validation", context: `The engine refused to run this project: ${(e as Error).message}`,
        impact: "No agent runs and no interview opens in this project until main holds a valid manifest.",
        confirm: "Fix the manifest on main and restart the engine", hold: "Keep the project stopped", recommendation: "A",
      });
      continue;
    }
    const pin = pins.get(p.real);
    const cmp = comparePin(pin, p.manifest);
    if (cmp.status !== "match") {
      const what = cmp.status === "new_path" ? "a project path the engine hasn't confirmed before" : `a change to ${cmp.keys.join(", ")}`;
      stop(p, `${what}; run \`factory-engine confirm --project ${p.real}\``);
      await alert(p, `pins:${p.manifest.commit}:${cmp.status}`, {
        title: cmp.status === "new_path" ? "New project path needs confirmation" : "Pinned owner keys changed",
        context: `The engine found ${what} (manifest on main at ${p.manifest.commit.slice(0, 12)}). Owner ids, the OAuth client id, the allow list and enabled are pinned until you confirm a change (F-007 SR-5).`,
        impact: "The project is stopped. It runs again only after you confirm at the engine command and approve a GitHub device sign-in as the previously pinned owner.",
        confirm: "Confirm with `factory-engine confirm` if you made this change", hold: "Keep the project stopped and find out who changed it", recommendation: "B",
      });
      continue;
    }
    if (!p.manifest.enabled) {
      stop(p, "enabled is false in the manifest", "disabled");
      continue;
    }
    p.state = "running";
  }

  // FR-3: credentials must match every runnable project's billing mode, or the engine doesn't start.
  for (const p of projects) {
    if (p.state !== "running" || !p.manifest) continue;
    const why = billingMismatch(p.manifest.billingMode, p.manifest.name, env, modelCredential);
    if (why) throw new StartError(why);
  }

  // Phase 2: authorization (FR-2), transcripts (SR-17), feature id uniqueness (SR-16).
  for (const p of projects) {
    if (p.state !== "running" || !p.manifest || !p.state_repo) continue;
    try {
      p.token = await credentials.get(factoryTokenName(p.manifest.name));
      p.warnings.push(...(await authorizeProject(p.manifest, github, p.token, log)));
      for (const w of p.warnings) log.warn(`${p.manifest.name}: ${w}`);
    } catch (e) {
      const msg = e instanceof AuthorizationError || e instanceof SecretError ? e.message : "authorization failed";
      stop(p, msg);
      await alert(p, `auth:${msg}`, {
        title: "Project failed the authorization check", context: `Before running, the engine checks each repo with the factory token and GitHub's owner id (ADR 0012). It failed: ${msg}`,
        impact: "The project is stopped; other projects are not affected.",
        confirm: "Fix the token, repo or allow list, then restart the engine", hold: "Keep the project stopped", recommendation: "A",
      });
      continue;
    }
    await loadFeatures(p);
    await checkRemote(p);
  }

  async function loadFeatures(p: Project): Promise<void> {
    const entries = await p.state_repo!.list("interviews").catch(() => []);
    const ids = new Set<string>();
    for (const e of entries) {
      const m = /^interviews\/(F-\d{3,6})\/transcript\.jsonl$/.exec(e.path);
      if (m) ids.add(m[1]!);
    }
    for (const fid of ids) {
      const f = newFeature(p, fid);
      const t = await readTranscript(p, f);
      if (t.intact) {
        f.load(t.entries, true);
        continue;
      }
      let shown: Entry[] = [];
      try {
        shown = parseTranscript(t.raw?.toString("utf8") ?? "");
      } catch {
        // Unparseable: the feature opens empty and closed.
      }
      f.load(shown, false);
      await tampered(p, f, t.why!, `local:${sha256Hex(t.raw ?? "")}`);
    }
  }

  /** Reads a feature's transcript from local factory/state and checks it against the engine's chain head (SR-17). */
  async function readTranscript(p: Project, f: FeatureInterview): Promise<{ entries: Entry[]; intact: boolean; raw: Buffer | null; why?: string }> {
    const raw = await p.state_repo!.read(transcriptPath(f.id));
    try {
      const entries = parseTranscript(raw?.toString("utf8") ?? "");
      if (checkAgainstHead(entries, record.chain(f.chainKey)) === "pending") {
        // The engine was killed after committing its own append and before recording it.
        const last = entries[entries.length - 1]!;
        record.setChain(f.chainKey, { seq: last.seq, head: last.hash });
      }
      return { entries, intact: true, raw };
    } catch (e) {
      if (!(e instanceof ChainError)) throw e;
      return { entries: [], intact: false, raw, why: e.message };
    }
  }

  async function tampered(p: Project, f: FeatureInterview, why: string, key: string): Promise<void> {
    f.chainIntact = false;
    await alert(p, `chain:${f.id}:${key}`, {
      title: `Transcript of ${f.id} changed outside the engine`, feature: f.id,
      context: `The interview transcript on factory/state doesn't match the engine's own hash chain (${why}). Someone or something other than the engine wrote to it (F-007 SR-17).`,
      impact: `The interview of ${f.id} is closed and its readiness checks fail until this is resolved.`,
      confirm: "Investigate and restore the transcript the engine wrote", hold: "Keep the feature closed", recommendation: "B",
    });
  }

  /**
   * Fetches factory/state and refuses what the engine didn't write (SR-17,
   * "on fetch"). Only the engine writes under interviews/, so any change
   * there that the local branch doesn't already hold is refused: nothing of
   * it is adopted, the feature is closed and a Security item is filed. Other
   * changes (an answered inbox item) are adopted when they fast-forward.
   */
  async function checkRemote(p: Project): Promise<void> {
    if (!o.push || !p.token || !p.state_repo || dead) return;
    let remote: string | null;
    try {
      remote = await p.state_repo.fetch(p.token, gitBase);
    } catch (e) {
      log.warn(`${p.name}: factory/state couldn't be fetched (${(e as Error).message}); transcripts were checked against the local branch only.`);
      return;
    }
    const local = await p.state_repo.head();
    if (!remote || remote === local || (await p.state_repo.isAncestor(remote, local))) return;
    const touched = new Set<string>();
    for (const c of await p.state_repo.changedPaths(local, remote)) {
      const m = /^interviews\/([^/]+)\//.exec(c);
      if (m) touched.add(m[1]!);
    }
    for (const dir of touched) {
      const fid = FEATURE_ID_RE.test(dir) ? dir : null;
      const f = fid ? p.features.get(fid) : undefined;
      if (f) {
        await f.exclusive(() => tampered(p, f, `the remote factory/state at ${remote!.slice(0, 12)} changes interviews/${f.id}/`, `fetch:${remote}`));
      } else {
        await alert(p, `fetch:${dir}:${remote}`, {
          title: "Remote factory/state holds interview files the engine didn't write", ...(fid ? { feature: fid } : {}),
          context: `The remote factory/state at ${remote!.slice(0, 12)} adds or changes files under interviews/ that this engine has no record of writing (F-007 SR-17).`,
          impact: "The engine didn't adopt the remote branch. Its pushes of factory/state fail until this is resolved.",
          confirm: "Investigate and restore factory/state on the remote", hold: "Leave it as it is", recommendation: "A",
        });
      }
    }
    if (touched.size) return;
    if (await p.state_repo.isAncestor(local, remote)) {
      await p.state_repo.fastForward(local, remote);
      log.info(`${p.name}: factory/state moved forward to the remote ${remote.slice(0, 12)}`);
    } else {
      log.warn(`${p.name}: factory/state on the remote has diverged from the engine's; it was not adopted.`);
    }
  }

  /** Checks every open feature's transcript on the local branch again (SR-17). */
  async function checkLocal(p: Project): Promise<void> {
    for (const f of p.features.values()) {
      if (!f.chainIntact) continue;
      await f.exclusive(async () => {
        const t = await readTranscript(p, f);
        if (!t.intact) await tampered(p, f, t.why!, `local:${sha256Hex(t.raw ?? "")}`);
      });
    }
  }

  function newFeature(p: Project, fid: string): FeatureInterview {
    const f = new FeatureInterview(fid, `${p.real}#${fid}`, {
      record, clock, log,
      persist: async (feature, text, extra, message) => {
        if (dead) throw new Error("the engine has stopped");
        const commit = await p.state_repo!.commit([{ path: transcriptPath(feature), content: text }, ...extra], message);
        await pushState(p);
        return commit;
      },
    });
    f.changed.on("itemReady", (item: string) => {
      for (const c of p.conns) c.write(notification("interview.itemReady", { feature: fid, item }));
    });
    p.features.set(fid, f);
    return f;
  }

  async function pushState(p: Project): Promise<void> {
    if (!o.push || !p.token || !p.state_repo || dead) return;
    try {
      await p.state_repo.push(p.token, gitBase);
      log.action({ agent: "engine", action: "git.push", target: `${p.name}:factory/state` });
    } catch (e) {
      log.warn(`${p.name}: factory/state wasn't pushed (${(e as Error).message}); the next commit tries again.`);
    }
  }

  // A feature id names its project alone (SR-16, OQ-10): an id found in two projects is refused in both.
  const owners = new Map<string, Project[]>();
  for (const p of projects) for (const fid of p.features.keys()) owners.set(fid, [...(owners.get(fid) ?? []), p]);
  const assigned = record.features();
  const ambiguous = new Set(
    [...owners].filter(([fid, ps]) => ps.length > 1 || (assigned[fid] !== undefined && assigned[fid] !== ps[0]!.real)).map(([fid]) => fid),
  );
  for (const fid of ambiguous) {
    for (const p of owners.get(fid)!) {
      await alert(p, `dup:${fid}`, {
        title: `Feature id ${fid} exists in more than one project`, feature: fid,
        context: `Feature ids must be unique across the engine's projects (F-007 SR-16), so the engine refuses ${fid} everywhere rather than guess which project it means.`,
        impact: `No interview of ${fid} opens until the duplicate is resolved.`,
        confirm: "Rename or remove the duplicate, then restart the engine", hold: "Keep the feature closed", recommendation: "A",
      });
    }
  }

  async function knownFeatureIds(): Promise<number> {
    let max = 0;
    const note = (fid: string) => {
      const m = FEATURE_ID_RE.exec(fid);
      if (m) max = Math.max(max, Number(m[1]));
    };
    Object.keys(record.features()).forEach(note);
    for (const p of projects) {
      if (!p.real) continue;
      p.features.forEach((_, fid) => note(fid));
      const refs = await git.out(p.real, ["for-each-ref", "--format=%(refname)", "refs/heads/feature/", "refs/remotes/origin/feature/"]).catch(() => "");
      for (const r of refs.split("\n")) {
        const m = /\/feature\/(F-\d{3,6})(?:-|\/|$)/.exec(r);
        if (m) note(m[1]!);
      }
      const main = await git.revParse(p.real, "refs/heads/main").catch(() => null);
      if (main) {
        for (const e of await git.lsTree(p.real, main, "docs/features").catch(() => [])) {
          const m = /^docs\/features\/(F-\d{3,6})-/.exec(e.path);
          if (m) note(m[1]!);
        }
      }
    }
    return max;
  }

  let startLock: Promise<unknown> = Promise.resolve();

  function channelFor(p: Project): ProjectChannel {
    return {
      name: p.name!,
      sessions: p.sessions!,
      features: () => [...p.features.values()].filter((f) => !ambiguous.has(f.id)),
      feature: (fid) => (ambiguous.has(fid) ? null : p.features.get(fid) ?? null),
      startFeature: (request) => {
        // One at a time across projects, so two requests can't take the same id.
        const run = startLock.then(async () => {
          const n = (await knownFeatureIds()) + 1;
          const fid = `F-${String(n).padStart(3, "0")}`;
          const branch = `feature/${fid}-${slug(request)}`;
          const main = await git.revParse(p.real!, "refs/heads/main");
          if (!main) throw new Error("the config repo has no main branch");
          record.assignFeature(fid, p.real!);
          await git.run(p.real!, ["update-ref", `refs/heads/${branch}`, main, "0".repeat(40)]);
          const f = newFeature(p, fid);
          await f.exclusive(() => f.append([{ type: "feature_started", feature: fid, title: title(request), branch, request }], "feature requested"));
          log.info(`${p.name}: ${fid} started on ${branch}`);
          return fid;
        });
        startLock = run.catch(() => undefined);
        return run;
      },
    };
  }

  const analystRuns = new Map<string, string>();

  /** The feature's analyst run in this engine, started on the first call for its tools. */
  function analystRun(p: Project, fid: string, worktree: string): string {
    const have = analystRuns.get(fid);
    if (have && record.run(have)?.status === "running") return have;
    const run = runs.start({ project: p.real!, feature: fid, role: "requirements-analyst", stage: INTERVIEW_STAGE, worktree });
    analystRuns.set(fid, run.id);
    return run.id;
  }

  async function nextReport(p: Project, fid: string): Promise<number> {
    const existing = await p.state_repo!.list(`runs/${fid}/${INTERVIEW_STAGE}`).catch(() => []);
    return existing.filter((e) => /\/requirements-analyst-\d+\.json$/.test(e.path)).length + 1;
  }

  async function reportInterrupted(p: Project, f: FeatureInterview, r: RunRecord): Promise<void> {
    try {
      await p.state_repo!.commit([agentReport({
        feature: f.id, stage: INTERVIEW_STAGE, role: "requirements-analyst", n: await nextReport(p, f.id), commit: r.last_commit ?? "unknown",
        outcome: "partial",
        summary: `Run ${r.id} was interrupted when the engine stopped. It resumes ${r.session_id ? "from its session" : "from its last commit with a summary of the transcript"}; no retry is counted (FR-14).`,
        body: { spec_path: null, spec_version: null, open_assumptions: f.state.list("assumption").filter((a) => a.status === "open").map((a) => a.id) },
        facts: {},
      })], `${f.id}: run ${r.id} interrupted`);
      await pushState(p);
    } catch (e) {
      log.warn(`${p.name}: the report for interrupted run ${r.id} wasn't committed (${(e as Error).message}).`);
    }
  }

  let done!: () => void;
  const stopped = new Promise<void>((r) => (done = r));
  let stopping: Promise<void> | null = null;
  const allFeatures = () => projects.filter((p) => p.state === "running").flatMap((p) => [...p.features.values()]);

  const control: EngineControl = {
    status: () => ({
      version: SERVED_CHANNEL_VERSION,
      uptime_s: Math.floor((clock.now() - startedAt) / 1000),
      features: allFeatures().filter((f) => !ambiguous.has(f.id)).map((f) => ({ id: f.id, stage: f.stage() || INTERVIEW_STAGE, active_agents: 0 })),
    }),
    pause: (fid) => {
      const fs_ = allFeatures().filter((f) => !fid || f.id === fid);
      for (const f of fs_) f.paused = true;
      return allFeatures().filter((f) => f.paused).map((f) => f.id);
    },
    resume: (fid) => {
      const fs_ = allFeatures().filter((f) => !fid || f.id === fid);
      for (const f of fs_) f.paused = false;
      return fs_.map((f) => f.id);
    },
    shutdown: () => void handle.stop(),
  };

  // Phase 3: channels and engine.json (FR-4).
  try {
    for (const p of projects) {
      if (p.state !== "running" || !p.manifest || !p.state_repo) continue;
      const pin = pins.get(p.real!)!;
      p.sessions = new SessionManager(p.manifest.name, { githubId: pin.owner.github_id, oauthClientId: pin.owner.oauth_client_id }, github, clock, log, async (fid, no) => {
        const f = p.features.get(fid);
        if (f?.chainIntact) {
          await f.exclusive(() => f.append([{ type: "session_approved", session: no, owner_id: pin.owner.github_id }], "session approved"));
        }
      });
      const handler = methods(channelFor(p), control, clock);
      const onConnection = (c: Conn) => {
        p.conns.add(c);
        c.onClose(() => p.conns.delete(c));
        serve(c, handler, (e) => log.warn(`Channel error: ${(e as Error).message}`));
      };
      p.listener = osApi.platform === "win32"
        ? await listenPipe({ os: osApi.windows(), children, log, onConnection })
        : await listenUnix({ dir: runtimeDir, name: `${sha256Hex(p.real!).slice(0, 16)}.sock`, os: osApi.unix(), children, log, onConnection });
      p.channel = p.listener.path;
      writeFileAtomic(path.join(p.state_repo.factoryDir, ENGINE_JSON), JSON.stringify({ version: SERVED_CHANNEL_VERSION, path: p.listener.path, pid: process.pid }) + "\n");
      log.info(`${p.manifest.name}: serving channel v${SERVED_CHANNEL_VERSION}`);
    }
  } catch (e) {
    for (const p of projects) await p.listener?.close();
    throw new StartError(`The control channel couldn't be served: ${(e as Error).message}`);
  }

  const handle: EngineHandle = {
    get projects() {
      return projects.map(({ path: pth, name, state, reason, channel, warnings }) => ({ path: pth, name, state, reason, channel, warnings }));
    },
    runs,
    stopped,
    feature: (fid) => {
      if (ambiguous.has(fid)) return null;
      for (const p of projects) if (p.state === "running" && p.features.has(fid)) return p.features.get(fid)!;
      return null;
    },
    interviewTools(fid, worktree, facts = {}) {
      const f = handle.feature(fid);
      const p = projects.find((x) => x.features.get(fid) === f);
      if (!f || !p) throw new Error(`unknown feature ${fid}`);
      const runId = analystRun(p, fid, worktree);
      return createInterviewTools({
        feature: f,
        worktree,
        log,
        onSpecReady: (passed) => {
          if (passed && !dead && record.run(runId)?.status === "running") runs.finish(runId, "complete");
        },
        reportFor: async (r): Promise<Change[]> => {
          const n = await nextReport(p, fid);
          const commit = await git.out(worktree, ["rev-parse", "HEAD"]).catch(() => "unknown");
          return [agentReport({
            feature: fid, stage: INTERVIEW_STAGE, role: "requirements-analyst", n, commit,
            outcome: r.passed ? "complete" : "partial",
            summary: r.passed
              ? `The spec at version ${r.specVersion} passed the interview checks of the readiness gate.`
              : `The spec at version ${r.specVersion} failed: ${r.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}.`,
            body: {
              spec_path: r.specPath, spec_version: r.specVersion,
              open_assumptions: f.state.list("assumption").filter((a) => a.status === "open").map((a) => a.id),
            },
            facts,
          })];
        },
      });
    },
    async crash() {
      dead = true;
      for (const p of projects) {
        p.sessions?.closeAll();
        await p.listener?.close().catch(() => undefined);
      }
      done();
    },
    async sync() {
      for (const p of projects) {
        if (p.state !== "running" || dead) continue;
        await checkRemote(p);
        await checkLocal(p);
      }
    },
    confirmProject: (projectPath, io) =>
      runConfirm({ masterRepo: o.masterRepo, projectPath, git, github, pins, os: osApi, clock, log, io }),
    stop() {
      stopping ??= (async () => {
        for (const p of projects) {
          p.sessions?.closeAll();
          await p.listener?.close().catch(() => undefined);
          if (p.state_repo) fs.rmSync(path.join(p.state_repo.factoryDir, ENGINE_JSON), { force: true });
        }
        log.info(`engine stopped at ${iso(clock.now())}`);
        done();
      })();
      return stopping;
    },
  };

  // FR-14: an interrupted analyst run gets a report saying so, then resumes
  // from its session or its last commit, with no retry counted.
  for (const r of interruptedAtStart) {
    const p = projects.find((x) => x.real === r.project && x.state === "running");
    const f = p?.features.get(r.feature);
    if (!p || !f || ambiguous.has(f.id) || r.role !== "requirements-analyst") continue;
    await reportInterrupted(p, f, r);
    const plan = runs.resume(r.id, f.state);
    if (plan.mode === "failed") {
      log.warn(`Run ${r.id} (${f.id}) failed: ${plan.run.reason}.`);
      continue;
    }
    analystRuns.set(f.id, r.id);
    if (o.resumeAnalyst && r.worktree) {
      o.resumeAnalyst({ feature: f.id, worktree: r.worktree, tools: handle.interviewTools(f.id, r.worktree), plan });
    }
  }
  return handle;
}
