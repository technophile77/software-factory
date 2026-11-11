import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionRefused, runAnalystSession } from "./agent/analyst";
import { AgentRuntime, TurnQueue, populateWorktree, prepareWorktree, sweepLeftovers } from "./agent/runtime";
import { SessionGroup, runVolume } from "./agent/sandbox";
import type { SessionOutcome } from "./agent/session";
import { commitWorktree } from "./agent/worktree-commit";
import { DockerError } from "./docker/cli";
import { baseImageId, ensureAgentImage, skillsPluginDir } from "./docker/image";
import { frameRequest } from "./interview/frame";
import { Conn, notification, serve } from "./channel/framing";
import { EngineControl, ProjectChannel, methods } from "./channel/methods";
import { SessionManager } from "./channel/sessions";
import { Listener, listenUnix } from "./channel/unix";
import { listenPipe } from "./channel/windows";
import { Clock, iso, systemClock } from "./clock";
import { AuthorizationError, authorizeProject, billingMismatch, modelCredentialFor } from "./config/authorize";
import { AgentSources, Instructions, MASTER_SOURCE_PATHS, resolveAgentSources } from "./config/agent-sources";
import { TreeSnapshot, resolveFactoryVersion } from "./config/factory-source";
import { Limits, LimitsError, agentLimits, containerLimits, manifestLimits, maxPageBytes, mergeLimits, readDefaultLimits, roleContainerLimits, worktreeLimits } from "./config/limits";
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
import { InterviewTools, ResearchConfig, createInterviewTools } from "./interview/tools";
import { FileLogger, Logger } from "./log";
import { OsApi, realOsApi } from "./os/ffi";
import { Children, osParent } from "./proc";
import { CredentialStore, MODEL_CREDENTIAL, OsCredentialStore, SecretError, factoryTokenName } from "./secrets";
import { SecurityAlert, fileSecurityItem } from "./state/inbox";
import { EngineRecord, RunRecord } from "./state/record";
import { ResumePlan, RunBook, RunFacts, RunUsage, agentReport } from "./state/runs";
import { Change, SecretFound, StateRepo } from "./state/state-repo";
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
  /**
   * Docker and the Agent SDK. With it, feature.start and every resume run the
   * analyst in its container (FR-8), and leftovers of an earlier engine are
   * swept at start. Without it no agent starts (and resumeAnalyst is called).
   */
  agents?: AgentRuntime;
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
  /** Known for every running project (phase 1); see EngineHandle.limits and agentSources. */
  limits: Limits | null;
  sources: AgentSources | null;
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
  /**
   * The analyst's tools for one feature, reading the spec from `worktree` (the
   * analyst's checkout). `research` is the web reader for research_web.
   */
  interviewTools(feature: string, worktree: string, facts?: RunFacts, research?: ResearchConfig): InterviewTools;
  /**
   * H-0087: a running project's effective limits, the defaults at its
   * `factory.version` commit lowered by its manifest's `limits:`. A project
   * runs only once these are known; any other name throws.
   */
  limits(project: string): Limits;
  /** Spec v30: a running project's resolved agent instructions and skills, master defaults with its overrides on top. */
  agentSources(project: string): AgentSources;
  /** A role's `AGENT.md` for a running project; throws when the role has none, so it can't run. */
  instructions(project: string, role: string): Instructions;
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
  const children = new Children(o.parentOf ?? osParent(osApi));
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
    path: p, name: null, state: "stopped", warnings: [], real: null, manifest: null, limits: null, sources: null, state_repo: null,
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

  const running = (name: string): Project => {
    const p = projects.find((x) => x.manifest?.name === name && x.state === "running");
    if (!p || !p.limits || !p.sources) throw new LimitsError(`No running project is named ${name}.`);
    return p;
  };

  /**
   * Spec v30 and Project manifest v1.4 (H-0087): the master commit that
   * `factory.version` names gives the limit defaults, `AGENT.md` and skills;
   * the project's own overrides, from its config repo's `main`, win over
   * them, and its `limits:` may only lower the defaults. Anything that can't
   * be resolved, or a value above a default, stops the project and files a
   * Security item.
   */
  async function checkSources(p: Project): Promise<boolean> {
    const m = p.manifest!;
    let reason: string;
    let above: string[] = [];
    try {
      const masterCommit = await resolveFactoryVersion(git, o.masterRepo, m.factoryVersion);
      // One listing serves the limits and the agent sources: this runs on every start, and each git process counts.
      const masterTree = await TreeSnapshot.read(git, o.masterRepo, masterCommit, MASTER_SOURCE_PATHS);
      const merged = mergeLimits(await readDefaultLimits(git, o.masterRepo, masterCommit, masterTree), manifestLimits(m.raw));
      if (!merged.above.length) {
        p.sources = await resolveAgentSources({ git, masterRepo: o.masterRepo, masterCommit, configRepo: p.real!, configCommit: m.commit, manifest: m.raw, masterTree });
        p.limits = merged.limits;
        return true;
      }
      above = merged.above;
      reason = `the manifest's limits set ${above.join(", ")} above the master default`;
    } catch (e) {
      reason = e instanceof ConfigError ? e.message : "the factory version's files couldn't be read";
    }
    stop(p, reason);
    await alert(p, `sources:${m.commit}:${reason}`, {
      title: above.length ? "Project manifest raises a limit above the master default" : "Project's factory sources were refused",
      context: above.length
        ? `The manifest on main (${m.commit.slice(0, 12)}) sets ${above.join(", ")} above the master defaults in engine/config/limits.yaml. A project may only lower them (H-0087, F-007 SR-18).`
        : `The engine reads limits, agent instructions and skills from the master commit that factory.version names, and the project's overrides from its config repo's main (spec v30). It refused this project: ${reason}`,
      impact: "The project is stopped. No agent runs and no interview opens until this is fixed on main.",
      confirm: above.length ? "Lower or remove those keys on main and restart the engine" : "Fix it on main (or tag the master clone) and restart the engine",
      hold: "Keep the project stopped and find out who changed it",
      recommendation: above.length ? "B" : "A",
    });
    return false;
  }

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
    if (!(await checkSources(p))) continue;
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
   * it is adopted, a Security item is filed, and the feature's readiness
   * checks fail. The interview itself goes on, since the engine's own local
   * transcript is intact. Other changes (an answered inbox item) are adopted
   * when they fast-forward.
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
      if (f) f.remoteRefused = true;
      await alert(p, `fetch:${dir}:${remote}`, {
        title: `Remote factory/state holds interview files the engine didn't write${fid ? ` (${fid})` : ""}`, ...(fid ? { feature: fid } : {}),
        context: `The remote factory/state at ${remote!.slice(0, 12)} adds or changes files under interviews/${fid ?? "<unknown>"}/ that this engine has no record of writing (F-007 SR-17). None of it was adopted.`,
        impact: `${f ? `The readiness checks of ${fid} fail until this is resolved. ` : ""}The engine's pushes of factory/state fail while the remote holds these commits.`,
        confirm: "Investigate and restore factory/state on the remote", hold: "Leave it as it is", recommendation: "A",
      });
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
      secretRefused: async (where, found, fid) => {
        const rules = [...new Set(found.rules)].filter((r) => /^[A-Za-z0-9_.-]{1,80}$/.test(r));
        // Each refusal is its own event, so the alert key never repeats.
        await alert(p, `secret:${crypto.randomBytes(8).toString("hex")}`, {
          title: "Owner text refused: the secrets scan found a secret", ...(fid ? { feature: fid } : {}),
          context: `The engine refused a ${where} call because gitleaks flagged its text (rules: ${rules.join(", ") || "unnamed"}). Nothing was recorded or pushed; the text itself is not kept here (F-007 AC-11, H-0084).`,
          impact: "Nothing changed. If the text was meant to be sent, send it again without the secret.",
          confirm: "It was a real secret: rotate it", hold: "It was a false positive: no action", recommendation: "A",
        });
      },
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
          launchAnalyst(p, f);
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
        summary: `Run ${r.id} was interrupted (${(r.reason ?? "the engine stopped").slice(0, 300)}). It resumes ${r.session_id ? "from its session" : "from its last commit with a summary of the transcript"}; no retry is counted (FR-14).`,
        body: { spec_path: null, spec_version: null, open_assumptions: f.state.list("assumption").filter((a) => a.status === "open").map((a) => a.id) },
        facts: {},
      })], `${f.id}: run ${r.id} interrupted`);
      await pushState(p);
    } catch (e) {
      log.warn(`${p.name}: the report for interrupted run ${r.id} wasn't committed (${(e as Error).message}).`);
    }
  }

  // -- Analyst runs (FR-8 to FR-11, FR-14, SR-18) --------------------------------

  interface Job {
    turns: TurnQueue | null;
    done: Promise<void>;
  }
  const jobs = new Map<string, Job>();
  /** Each run's image and skills, for its reports (proposal 0013). */
  const runArtifacts = new Map<string, Array<{ kind: string; ref: string }>>();
  const images = new Map<string, Promise<{ id: string; tag: string }>>();
  let proxyImage: Promise<string> | null = null;
  let shuttingDown = false;
  const worktreeDir = (p: Project, fid: string) => path.join(home, "worktrees", sha256Hex(p.real!).slice(0, 16), fid);
  const engineWords = (e: unknown) => (e instanceof ConfigError || e instanceof DockerError || e instanceof SessionRefused ? (e as Error).message.slice(0, 300) : "an internal error");

  /** Tells the owner, in the transcript, why the analyst isn't working (AC-13). Engine words only. */
  async function noteAnalyst(f: FeatureInterview, status: "stopped" | "waiting", reason: string): Promise<void> {
    if (dead || !f.chainIntact) return;
    await f.exclusive(() => f.append([{ type: "analyst_session", status, reason }], `analyst ${status}`)).catch(() => undefined);
  }

  function launchAnalyst(p: Project, f: FeatureInterview, plan?: ResumePlan): void {
    const rt = o.agents;
    if (!rt || dead || shuttingDown || jobs.has(f.id) || !f.chainIntact) return;
    const job: Job = { turns: null, done: Promise.resolve() };
    jobs.set(f.id, job);
    job.done = runAnalyst(rt, p, f, job, plan)
      .catch((e) => log.warn(`${f.id}: the analyst run stopped: ${engineWords(e)}`))
      .finally(() => jobs.delete(f.id));
  }

  async function shared<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
    let v = cache.get(key);
    if (!v) {
      v = make();
      cache.set(key, v);
      v.catch(() => cache.delete(key));
    }
    return v;
  }

  /**
   * One analyst session for a feature, start to end: the worktree, the
   * project's image for its factory.version commit and overrides, the run's
   * containers, the SDK session under the project's limits with owner
   * replies fed in as turns, then the commit and its checks. A session that
   * can't start leaves the run interrupted, to resume at the next engine
   * start; one that stops at a cap or on a breach fails the run and reports
   * why. On shutdown the run stays open, so the next start resumes it.
   */
  async function runAnalyst(rt: AgentRuntime, p: Project, f: FeatureInterview, job: Job, plan?: ResumePlan): Promise<void> {
    const m = p.manifest!;
    const sources = p.sources!;
    const limits = p.limits!;
    const branch = f.state.branch;
    const known = plan?.run ?? (analystRuns.get(f.id) ? record.run(analystRuns.get(f.id)!) : undefined);
    const wt = await prepareWorktree(git, p.real!, known?.worktree ?? worktreeDir(p, f.id), branch, known?.git_dir);
    const runId = analystRun(p, f.id, wt.path);
    runs.update(runId, { git_dir: wt.gitDir });
    let resumeId = plan?.mode === "session" ? plan.sessionId : undefined;
    try {
      const credential = modelCredentialFor(env, modelCredential);
      if (!credential) throw new SessionRefused("no model credential is stored or set");
      const analystMd = sources.instructions.get("requirements-analyst");
      if (!analystMd) throw new SessionRefused("the requirements-analyst role has no AGENT.md at factory.version or in the project's overrides");
      const readerMd = sources.instructions.get("web-reader");
      const sdk = await rt.sdk();
      const ident = { project: m.name, masterCommit: sources.masterCommit, skillsDigest: sources.skillsDigest };
      const image = await shared(images, `${ident.project}\0${ident.masterCommit}\0${ident.skillsDigest}`, () => ensureAgentImage(rt.docker, rt.dockerDir, path.join(home, "images"), ident, sources));
      proxyImage ??= baseImageId(rt.docker);
      proxyImage.catch(() => (proxyImage = null));
      const proxyImageId = await proxyImage;
      runArtifacts.set(runId, [
        { kind: "image", ref: image.tag },
        ...(sources.skills.get("requirements-analyst") ?? []).map((s) => ({ kind: "skill", ref: `${s.name} (${s.from}: ${s.path})` })),
      ]);
      if (resumeId) {
        // The SDK session lives on the run's volume; without it the run starts again from its commit.
        const v = await rt.docker.run(["volume", "inspect", runVolume(runId)], { okCodes: [1] });
        if (v.code !== 0) resumeId = undefined;
      }
      const slugName = branch.replace(/^feature\//, "");
      const intro = `You are working on ${f.id} on branch ${branch}, in /workspace. Write its spec at docs/features/${slugName}.md. Reach the owner only through your factory tools.`;
      const first = resumeId
        ? "The engine restarted. Continue where you left off; owner replies, if any, follow as further turns."
        : [intro, frameRequest(f.id, f.state.request), ...(plan?.mode === "from_commit" && plan.summary ? [plan.summary] : [])].join("\n\n");
      const turns = new TurnQueue(f, first);
      job.turns = turns;
      if (shuttingDown || dead) turns.close();
      const base = await git.revParse(p.real!, `refs/heads/${branch}`);
      if (!base) throw new SessionRefused(`the branch ${branch} is gone`);
      const group = new SessionGroup({
        docker: rt.docker, runId, project: m.name, agentImageId: image.id, proxyImageId, proxyScript: rt.proxyScript,
        agentLimits: roleContainerLimits(limits), proxyLimits: containerLimits(limits.proxy), maxPageBytes: maxPageBytes(limits),
        credential, log, ...(rt.platform ? { platform: rt.platform } : {}), ...(rt.sleep ? { sleep: rt.sleep } : {}),
      });
      const facts: RunFacts = rt.model ? { model: rt.model } : {};
      let r: Awaited<ReturnType<typeof runAnalystSession>>;
      try {
        r = await runAnalystSession({
          sdk, docker: rt.docker, group, manifest: m.raw, worktree: wt.path,
          instructions: { analyst: analystMd.text, ...(readerMd ? { reader: readerMd.text } : {}) },
          limits: agentLimits(limits, m.billingMode), skillsPluginDir: skillsPluginDir("requirements-analyst"),
          ...(rt.model ? { model: rt.model } : {}), ...(resumeId ? { resume: resumeId } : {}), sessionVolume: "run",
          billingCheck: () => billingMismatch(m.billingMode, m.name, env, modelCredential),
          tools: (research) => handle.interviewTools(f.id, wt.path, facts, research),
          turns,
          commit: async (policy) => (dead ? { status: "unchanged" } : commitWorktree({
            git, gitDir: wt.gitDir, worktree: wt.path, branch, base, policy, scanner, tmpDir,
            message: `${f.id}: analyst session (run ${runId})`, limits: worktreeLimits(limits),
          })),
          onSessionId: (id) => void (dead || runs.update(runId, { session_id: id })),
          onBreach: async (breaches) => {
            await alert(p, `breach:${runId}:${crypto.randomBytes(4).toString("hex")}`, {
              title: "Analyst wrote outside its rules", feature: f.id,
              context: `The engine rejected run ${runId}'s changes: ${breaches.slice(0, 20).map((b) => `${b.path || "(history)"} (${b.reason})`).join(", ")} (F-007 FR-9, AC-9). Nothing was committed.`,
              impact: "The analyst's run is stopped and its worktree reset to the branch.",
              confirm: "Look at the agent's instructions and restart the feature", hold: "Keep the feature stopped", recommendation: "B",
            });
          },
          log,
        });
      } catch (e) {
        if (e instanceof SecretFound) {
          await populateWorktree(git, p.real!, base, wt.path, wt.gitDir);
          await alert(p, `secret:${crypto.randomBytes(8).toString("hex")}`, {
            title: "Analyst change refused: the secrets scan found a secret", feature: f.id,
            context: `The engine didn't commit run ${runId}'s changes because gitleaks flagged them (F-007 FR-11). The worktree was reset to the branch.`,
            impact: "The analyst's run is stopped.", confirm: "Rotate the secret if it was real", hold: "It was a false positive: no action", recommendation: "A",
          });
          await endRun(p, f, runId, "failed", "the secrets scan found a secret in its change", facts);
          return;
        }
        throw e;
      }
      if (dead) return;
      const { outcome, commit } = r;
      if (commit.status === "committed") runs.update(runId, { last_commit: commit.commit });
      if (commit.status === "rejected" || commit.status === "over_limit") await populateWorktree(git, p.real!, base, wt.path, wt.gitDir);
      let failure: string | null = null;
      if (commit.status === "rejected") failure = "it wrote outside the role's rules (Security item filed)";
      else if (commit.status === "over_limit") failure = `its change went over the worktree ${commit.cap} cap`;
      else if (outcome.status === "cap") failure = `it reached the ${outcome.reason} cap`;
      else if (shuttingDown) return;
      else if (outcome.status === "error") failure = `the session failed (${String(outcome.reason).slice(0, 200)})`;
      else if (record.run(runId)?.status === "running") failure = "the session ended before the spec was ready";
      if (failure) await endRun(p, f, runId, "failed", failure, { ...facts, usage: usage(outcome) });
      else await endRun(p, f, runId, "complete", null, facts);
    } catch (e) {
      if (dead) return;
      // No session ran: the run waits for the next engine start (AC-13).
      const why = engineWords(e);
      if (record.run(runId)?.status === "running") runs.interrupt(runId, why);
      log.warn(`${f.id}: no analyst session started: ${why}`);
      await noteAnalyst(f, "waiting", `No analyst session started: ${why}. The run resumes at the next engine start.`);
    }
  }

  const usage = (o: SessionOutcome): RunUsage => ({ input_tokens: o.inputTokens, output_tokens: o.outputTokens, cost_usd: o.costUsd, duration_s: Math.round(o.durationMs / 1000) });

  /** A run's end: its status, its session volume removed, and for a failure a report and a transcript note (SR-18). */
  async function endRun(p: Project, f: FeatureInterview, runId: string, status: "complete" | "failed", why: string | null, facts: RunFacts): Promise<void> {
    if (status === "failed" || record.run(runId)?.status === "running") runs.finish(runId, status, why ?? undefined);
    await o.agents?.docker.run(["volume", "rm", "--force", runVolume(runId)], { okCodes: [1] }).catch(() => log.warn(`volume ${runVolume(runId)} wasn't removed`));
    if (status !== "failed" || !why) return;
    try {
      await p.state_repo!.commit([agentReport({
        feature: f.id, stage: INTERVIEW_STAGE, role: "requirements-analyst", n: await nextReport(p, f.id), commit: record.run(runId)?.last_commit ?? "unknown",
        outcome: "partial", summary: `Run ${runId} stopped: ${why}.`,
        body: { spec_path: null, spec_version: null, open_assumptions: f.state.list("assumption").filter((a) => a.status === "open").map((a) => a.id) },
        facts, artifacts: runArtifacts.get(runId) ?? [],
      })], `${f.id}: run ${runId} stopped`);
      await pushState(p);
    } catch (e) {
      log.warn(`${p.name}: the report for run ${runId} wasn't committed (${(e as Error).message}).`);
    }
    await noteAnalyst(f, "stopped", `The analyst's run stopped: ${why}.`);
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
      for (const f of fs_) {
        f.paused = false;
        f.changed.emit("resumed");
      }
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
    interviewTools(fid, worktree, facts = {}, research) {
      const f = handle.feature(fid);
      const p = projects.find((x) => x.features.get(fid) === f);
      if (!f || !p) throw new Error(`unknown feature ${fid}`);
      const runId = analystRun(p, fid, worktree);
      return createInterviewTools({
        feature: f,
        worktree,
        log,
        ...(research ? { research } : {}),
        onSpecReady: (passed) => {
          if (passed && !dead && record.run(runId)?.status === "running") runs.finish(runId, "complete");
          // The analyst's session ends with its turn; its changes are then committed and checked.
          if (passed) jobs.get(fid)?.turns?.close();
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
            artifacts: runArtifacts.get(runId) ?? [],
          })];
        },
      });
    },
    async crash() {
      dead = true;
      for (const j of jobs.values()) j.turns?.close();
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
    limits(project) {
      return structuredClone(running(project).limits!);
    },
    agentSources(project) {
      return running(project).sources!;
    },
    instructions(project, role) {
      const i = running(project).sources!.instructions.get(role);
      if (!i) throw new ConfigError(`The ${role} role has no AGENT.md in factory.version's master commit or in the project's overrides, so it may not run.`);
      return i;
    },
    confirmProject: (projectPath, io) =>
      runConfirm({ masterRepo: o.masterRepo, projectPath, git, github, pins, os: osApi, clock, log, io }),
    stop() {
      stopping ??= (async () => {
        // Sessions end with their turn streams; their work is committed and the runs stay open to resume (FR-14).
        shuttingDown = true;
        for (const j of jobs.values()) j.turns?.close();
        await Promise.all([...jobs.values()].map((j) => j.done));
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

  if (o.agents) {
    // What a killed engine left behind goes, except the session volumes of runs that can still resume.
    const keep = new Set(runs.interrupted().map((r) => runVolume(r.id)));
    await sweepLeftovers(o.agents.docker, keep, log).catch((e) => log.warn(`Leftover containers couldn't be swept: ${engineWords(e)}`));
  }

  // FR-14: an interrupted analyst run gets a report saying so, then resumes
  // from its session or its last commit, with no retry counted.
  for (const r of runs.interrupted()) {
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
    if (o.agents) launchAnalyst(p, f, plan);
    else if (o.resumeAnalyst && r.worktree) {
      o.resumeAnalyst({ feature: f.id, worktree: r.worktree, tools: handle.interviewTools(f.id, r.worktree), plan });
    }
  }
  return handle;
}
