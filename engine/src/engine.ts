import * as crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionRefused, runAnalystSession } from "./agent/analyst";
import { type EndpointProbe, httpProbe } from "./agent/endpoint-check";
import { EndpointService, type EndpointStatus, estimateTokens } from "./agent/endpoint-service";
import { AgentRuntime, TurnQueue, populateWorktree, prepareWorktree, sweepLeftovers } from "./agent/runtime";
import { orchestratorPolicy, runReviewerSessions, reviewerPolicy } from "./agent/reviewer";
import type { RouterConfig } from "./agent/sandbox";
import { type GroupConfig, SessionGroup, runVolume } from "./agent/sandbox";
import { WORKSPACE, type SessionOutcome } from "./agent/session";
import { commitWorktree } from "./agent/worktree-commit";
import { DockerError } from "./docker/cli";
import { baseImageId, ensureAgentImage, skillsPluginDir } from "./docker/image";
import { makeCosignVerifier, parseCosignPins } from "./docker/cosign";
import { type LitellmImage, type LitellmPin, litellmImageId } from "./docker/litellm-image";
import { DocumentRefused, SourceDocument, documentMeta, lineOfByte, sha256 as sha256Of, sourcePath } from "./interview/document";
import { frameDocument, frameRequest } from "./interview/frame";
import { Conn, notification, serve } from "./channel/framing";
import { EngineControl, ProjectChannel, methods } from "./channel/methods";
import { SessionManager } from "./channel/sessions";
import { Listener, listenUnix } from "./channel/unix";
import { listenPipe } from "./channel/windows";
import { Clock, iso, systemClock } from "./clock";
import { AuthorizationError, authorizeProject, billingMismatch, modelCredentialFor } from "./config/authorize";
import { AgentSources, Instructions, MASTER_SOURCE_PATHS, resolveAgentSources } from "./config/agent-sources";
import { TreeSnapshot, readFileAt, resolveFactoryVersion } from "./config/factory-source";
import { type EndpointLookup } from "./config/endpoint-address";
import { RoleAssignmentError, manifestAssignments, planAdvisory, planRole } from "./config/endpoint-roles";
import { type Endpoint, EndpointsError, readEndpointsFile } from "./config/endpoints";
import { Models, MODELS_FILE, readDefaultModels } from "./config/models";
import { LIMITS_FILE, Limits, LimitsError, agentLimits, gate1Limits, containerLimits, manifestLimits, maxPageBytes, mergeLimits, readDefaultLimits, readinessLimits, roleContainerLimits, worktreeLimits } from "./config/limits";
import { Manifest, interviewSignIn, readManifest } from "./config/manifest";
import { ConfigError, checkProjectPath, readPathsFile } from "./config/paths-file";
import { PinStore, comparePin, pinnedKeys } from "./config/pins";
import { ConfirmIo, confirmProject as runConfirm } from "./config/confirm";
import { CAPABILITIES, ENGINE_JSON, FEATURE_ID_RE, GITHUB_API_BASE, BUILD_STAGE, GITHUB_WEB_BASE, INTERVIEW_STAGE, MAX_RESUMES, SERVED_CHANNEL_VERSION } from "./constants";
import { ensureOwnerDir, findOnPath, sha256Hex, writeFileAtomic } from "./fsutil";
import { Git } from "./git";
import { GitHubClient, GitHubError, GitHubUnreachable, HttpGitHub, checkBase } from "./github";
import { HttpIssues, IssuesApi } from "./inbox/github-issues";
import { ConsoleResult, Inbox, Recorded } from "./inbox/store";
import { InboxLocal } from "./inbox/local";
import type { ItemInput } from "./inbox/model";
import { osNotifier } from "./os/notify";
import { Gitleaks, SecretsScanner } from "./gitleaks";
import { activityOf } from "./interview/activity";
import { FeatureInterview } from "./interview/feature";
import { InterviewTools, ResearchConfig, createInterviewTools } from "./interview/tools";
import { FileLogger, Logger } from "./log";
import { OsApi, realOsApi } from "./os/ffi";
import { Children, osParent, osStartOrder } from "./proc";
import { CredentialStore, MODEL_CREDENTIAL, OsCredentialStore, SecretError, factoryTokenName } from "./secrets";
import { SecurityAlert, fileDecisionItem, fileSecurityItem } from "./state/inbox";
import { READINESS_STAGE, analystGate1Turn, analystReturnTurn, correctionTurn, gate1Resolution, recordedOnly, records, reviewerTurn } from "./gate1/flow";
import { findingRef, plain, renderReport } from "./gate1/render";
import { ADVISORY_WALL_MS, type AdvisoryHints, advisoryBlock, matchRate, runAdvisory } from "./gate1/advisory";
import { runAdvisorySession } from "./gate1/advisory-session";
import { GATE1_STAGE, Gate1Report, REVIEWER_ROLE, validateReport } from "./gate1/report";
import { modelReport, reportOutputSchema } from "./schemas/agent-report";
import { schemaErrors } from "./schemas/json-file";
import { StandardsError, loadStandards } from "./gate1/standards";
import { type Check, readinessChecks, specPathPattern } from "./interview/readiness";
import { structuralChecks } from "./readiness/checks";
import { structureText } from "./interview/structure";
import { READINESS_ROLE, type ReadinessReport, orchestratorTurn, readinessCorrection, validateReadinessReport } from "./readiness/report";
import { PolicyError, type RolePolicy, effectiveRole } from "./policy/role-policy";
import { EngineRecord, RunRecord } from "./state/record";
import { ResumePlan, RunBook, RunFacts, RunUsage, agentReport, transcriptSummary } from "./state/runs";
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
   * Tests replace the real resume through this; without it, the resumed run
   * waits for the next interviewTools call for its feature.
   */
  /**
   * F-011: the GitHub issues API for a project's factory token. Absent, the
   * engine uses GitHub's own API when `push` is set, and otherwise records
   * inbox items without filing them (tests).
   */
  issues?: (token: string) => IssuesApi;
  /** How often each project's inbox is read; F-011 calls it "one poll". */
  inboxPollMs?: number;
  resumeAnalyst?: (r: { feature: string; worktree: string; tools: InterviewTools; plan: ResumePlan }) => void;
  /**
   * Docker and the Agent SDK. With it, feature.start and every resume run the
   * analyst in its container (FR-8), and leftovers of an earlier engine are
   * swept at start. Without it no agent starts (and resumeAnalyst is called).
   */
  agents?: AgentRuntime;
  /**
   * F-013: replacements for the network and the LiteLLM image check (tests only; the defaults are the real ones).
   * `litellm.verify` replaces the cosign check, `pin` the pinned release, `cosignPath` where the bundled cosign is looked for.
   */
  endpoints?: { lookup?: EndpointLookup; probe?: EndpointProbe; litellm?: { verify?: (imageRef: string) => Promise<void>; pin?: LitellmPin | null; cosignPath?: string }; slotWaitMs?: number };
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
  models: Models | null;
  state_repo: StateRepo | null;
  features: Map<string, FeatureInterview>;
  sessions: SessionManager | null;
  listener: Listener | null;
  conns: Set<Conn>;
  token: string | null;
  inbox: Inbox | null;
  /** Stopped only because pinned keys changed: the inbox still runs, so the owner can approve the change there (F-016 OQ-3). */
  pinsWaiting: boolean;
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
  /** Spec v32: a running project's model per role, from `engine/config/models.yaml` at its `factory.version` commit. */
  models(project: string): Models;
  /** A role's `AGENT.md` for a running project; throws when the role has none, so it can't run. */
  instructions(project: string, role: string): Instructions;
  /** F-013 FR-6: each configured model endpoint with whether this PC can use it and, if not, why. */
  endpoints(): EndpointStatus[];
  /** F-013 FR-2: why the whole endpoints file was refused (AC-2), or null. */
  endpointsProblem(): string | null;
}

/** F-011 "one poll": often enough to feel prompt, few enough calls for GitHub's 5,000 an hour. */
export const INBOX_POLL_MS = 60_000;

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
  const children = o.parentOf ? new Children(o.parentOf) : new Children(osParent(osApi), osStartOrder(osApi));
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

  let endpointConfig: { endpoints: Endpoint[] } | { problem: string };
  try {
    endpointConfig = readEndpointsFile(o.masterRepo, osApi);
  } catch (e) {
    endpointConfig = { problem: e instanceof EndpointsError ? e.message : "the endpoints file couldn't be read" };
  }
  let litellm: Promise<LitellmImage> | null = null;
  const endpointSvc = await EndpointService.start({
    config: endpointConfig, credentials, clock, log,
    lookup: o.endpoints?.lookup ?? ((host) => dnsLookup(host, { all: true })),
    probe: o.endpoints?.probe ?? httpProbe,
    planFile: path.join(home, "endpoint-plans.json"), identityFile: path.join(home, "endpoint-models.json"), workDir: path.join(home, "router"),
    ...(o.endpoints?.slotWaitMs !== undefined ? { slotWaitMs: o.endpoints.slotWaitMs } : {}),
    ...(o.agents ? {
      image: () => {
        const cosignPath = path.join(home, "bin", process.platform === "win32" ? "cosign.exe" : "cosign");
        // Read at each attempt, so installing cosign (a hygiene step) takes effect without a code change.
        const verify = o.endpoints?.litellm?.verify ?? makeCosignVerifier({
          path: o.endpoints?.litellm?.cosignPath ?? cosignPath,
          pins: parseCosignPins(fs.readFileSync(path.join(o.agents!.dockerDir, "cosign-sha256.json"), "utf8")),
          keyFile: path.join(o.agents!.dockerDir, "litellm-cosign.pub"),
        });
        litellm ??= litellmImageId(o.agents!.docker, { verify, now: () => clock.now(), ...(o.endpoints?.litellm?.pin !== undefined ? { pin: o.endpoints.litellm.pin } : {}) });
        litellm.catch(() => (litellm = null));
        return litellm;
      },
    } : {}),
  });

  const projects: Project[] = listed.map((p) => ({
    path: p, name: null, state: "stopped", warnings: [], real: null, manifest: null, limits: null, sources: null, models: null, state_repo: null,
    features: new Map(), sessions: null, listener: null, conns: new Set(), token: null, inbox: null, pinsWaiting: false,
  }));

  const notify = osNotifier({ platform: osApi.platform, children, log, cwd: home });
  /**
   * F-021 SR-5: private detail goes through the secrets scan before it is
   * stored; each flagged line is replaced, and if the scan still flags the
   * result, all of it is.
   */
  const REMOVED = "[secret removed by the engine]";
  const scrubPrivate = async (text: string): Promise<string> => {
    const scan = (t: string) => scanner.scan([{ sha: sha256Hex(t), content: Buffer.from(t, "utf8") }]);
    const r = await scan(text);
    if (r.clean) return text;
    const lines = text.split("\n");
    for (const h of r.hits ?? []) if (h.line >= 1 && h.line <= lines.length) lines[h.line - 1] = REMOVED;
    const out = lines.join("\n");
    return (await scan(out)).clean ? out : REMOVED;
  };

  /**
   * F-021 FR-4 (b): the engine's own log lines that name `match`, newest
   * last, at most `max`, from today's and yesterday's log. Only for private
   * detail, which never leaves the PC.
   */
  const logLines = (match: string, max = 200): string => {
    const dir = path.join(home, "logs");
    const out: string[] = [];
    try {
      const files = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort().slice(-2);
      for (const f of files) {
        for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as { at?: string; level?: string; message?: string };
            if (typeof rec.message === "string" && rec.message.includes(match)) out.push(`${rec.at ?? ""} ${rec.level ?? ""} ${rec.message}`);
          } catch {
            // A damaged line is skipped; the log is the engine's own.
          }
        }
      }
    } catch {
      return "";
    }
    return out.slice(-max).join("\n");
  };

  const alert = async (p: Project, key: string, a: SecurityAlert) => {
    if (!p.inbox || dead) return;
    const k = sha256Hex(`${p.real}\0${key}`);
    if (record.alert(k)) return;
    try {
      const id = await fileSecurityItem(p.inbox, key.split(":", 1)[0]!, a);
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
    if (!p || !p.limits || !p.sources || !p.models) throw new LimitsError(`No running project is named ${name}.`);
    return p;
  };

  /**
   * F-013 SR-9: refuses a run whose manifest puts a role on an endpoint when that role can't use one.
   * No engine session of the roles that call this runs on an endpoint, so a plan that would is refused too.
   */
  function checkRoleEndpoint(p: Project, role: string, claudeDefault: string): void {
    const assignment = manifestAssignments(p.manifest!.raw).get(role);
    if (!assignment?.model) return;
    try {
      const plan = planRole({ role, assignment, claudeDefault, allowed: p.manifest!.endpoints, unavailable: (r) => endpointSvc.unavailable(r) }, effectiveRole(p.manifest!.raw, role));
      if (plan.kind === "endpoint") throw new RoleAssignmentError(`The ${role} role can't run on an endpoint yet.`);
    } catch (e) {
      if (e instanceof RoleAssignmentError || e instanceof PolicyError) throw new SessionRefused(e.message);
      throw e;
    }
  }

  /**
   * Spec v30 and Project manifest v1.4 (H-0087): the master commit that
   * `factory.version` names gives the limit defaults, `AGENT.md` and skills;
   * the project's own overrides, from its config repo's `main`, win over
   * them, and its `limits:` may only lower the defaults. Anything that can't
   * be resolved, or a value above a default, stops the project and files a
   * Security item.
   */
  /** F-011: the inbox reads GitHub with the project's factory token, as the pinned owner (SR-2). */
  async function connectInbox(p: Project): Promise<void> {
    if (!p.inbox || !p.token || !p.state_repo || !(o.issues || o.push)) return;
    const pin = pins.get(p.real!);
    if (!pin) return;
    try {
      const url = await p.state_repo.remoteUrl(gitBase, await p.state_repo.refuseRedirectingConfig());
      const repo = url.slice(gitBase.length + 1).replace(/\.git$/, "");
      const api = o.issues ? o.issues(p.token) : new HttpIssues(p.token, log, GITHUB_API_BASE);
      // SR-9: a token without Issues read and write on the config repo is reported, not polled with every minute.
      try {
        await api.openIssues(repo);
      } catch (e) {
        if (e instanceof GitHubError && !(e instanceof GitHubUnreachable)) {
          log.warn(`${p.name ?? p.path}: the factory token can't read issues on ${repo}, so the inbox is off: it needs Issues read and write on the config repo (F-016 SR-9).`);
          notify("Factory inbox off", `${p.name ?? "A project"}: the factory token needs Issues read and write on the config repo.`);
          return;
        }
      }
      p.inbox.connect({ api, repo, ownerId: pin.owner.github_id });
    } catch (e) {
      log.warn(`${p.name ?? p.path}: the inbox can't reach GitHub, so items are recorded but not filed (${e instanceof ConfigError ? e.message.slice(0, 300) : "its address couldn't be read"}).`);
    }
  }

  async function checkSources(p: Project): Promise<boolean> {
    const m = p.manifest!;
    let reason: string;
    let above: string[] = [];
    try {
      const masterCommit = await resolveFactoryVersion(git, o.masterRepo, m.factoryVersion);
      // One listing and one read serve the limits, the models and the agent sources: this runs on every start, and each git process counts.
      const masterTree = await TreeSnapshot.read(git, o.masterRepo, masterCommit, MASTER_SOURCE_PATHS);
      await masterTree.prefetch([LIMITS_FILE, MODELS_FILE], 64 * 1024);
      const merged = mergeLimits(await readDefaultLimits(git, o.masterRepo, masterCommit, masterTree), manifestLimits(m.raw));
      const models = await readDefaultModels(masterTree);
      if (!merged.above.length) {
        p.sources = await resolveAgentSources({ git, masterRepo: o.masterRepo, masterCommit, configRepo: p.real!, configCommit: m.commit, manifest: m.raw, masterTree });
        p.limits = merged.limits;
        p.models = models;
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
    // F-021: private detail and console answer proofs stay in the engine folder, keyed by the project's path (H-0246).
    p.inbox = new Inbox({ state: p.state_repo, clock, log, notify, local: new InboxLocal(home, sha256Hex(p.real!).slice(0, 16)), scrub: scrubPrivate });
    const legacy = await p.inbox.legacyRecords();
    if (legacy.length) {
      // F-020 SR-4: filing an item here would hide the open ones in the unread files, so the owner is told on the PC only.
      const why = `the inbox has ${legacy.length} record(s) in the old YAML form (${legacy.slice(0, 3).join(", ")}${legacy.length > 3 ? ", ..." : ""}); run \`npm run migrate-inbox-json -- --project ${p.real} --gitleaks <path>\` in engine/ and restart the engine`;
      stop(p, why);
      notify("Factory project stopped", why);
      continue;
    }
    await p.inbox.records().catch(() => []);
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
      stop(p, `${what}; run \`factory-engine confirm --project ${p.real}\` or approve the inbox item`);
      p.pinsWaiting = cmp.status === "changed";
      await alert(p, `pins:${p.manifest.commit}:${cmp.status}`, {
        title: cmp.status === "new_path" ? "New project path needs confirmation" : "Pinned owner keys changed",
        context: `The engine found ${what} (manifest on main at ${p.manifest.commit.slice(0, 12)}). Owner ids, the OAuth client id, the allow list, enabled and the interview sign-in setting are pinned until you confirm a change (F-007 SR-5, F-018 FR-15).`,
        impact: `The project is stopped. It runs again after you confirm this change here, or with \`factory-engine confirm\` and a GitHub device sign-in as the previously pinned owner, and restart the engine. A confirm here pins the manifest at ${p.manifest.commit.slice(0, 12)} only.`,
        confirm: "Confirm the change if you made it", hold: "Keep the project stopped and find out who changed it", recommendation: "B",
        ...(cmp.status === "changed" ? { effectData: { commit: p.manifest.commit } } : {}),
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
    await connectInbox(p);
    await loadFeatures(p);
    await checkRemote(p);
  }

  // OQ-3: the token is looked up under the pinned name, never the changed manifest's.
  for (const p of projects) {
    if (!p.pinsWaiting || !p.real) continue;
    const pin = pins.get(p.real);
    if (!pin) continue;
    p.token = await credentials.get(factoryTokenName(pin.name)).catch(() => null);
    await connectInbox(p);
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
   * transcript is intact. Inbox records are refused the same way (F-016
   * Gate 2 M1, owner decision 2026-11-14): only the engine records answers,
   * from GitHub. Other changes are adopted when they fast-forward.
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
    const changed = await p.state_repo.changedPaths(local, remote);
    for (const c of changed) {
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
    const inboxChanged = (await p.state_repo.remoteChanges(local, remote)).some((c) => c.startsWith("inbox/"));
    if (inboxChanged) {
      await alert(p, `fetch:inbox:${remote}`, {
        title: "Remote factory/state holds inbox records the engine didn't write",
        context: `The remote factory/state at ${remote.slice(0, 12)} adds or changes files under inbox/ that this engine has no record of writing (F-016, Gate 2 M1). None of it was adopted, so no answer in it has any effect.`,
        impact: "The engine's pushes of factory/state fail while the remote holds these commits. Answers you give on GitHub are still read there.",
        confirm: "Investigate and restore factory/state on the remote", hold: "Leave it as it is", recommendation: "A",
      });
    }
    if (touched.size || inboxChanged) return;
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

  /** F-009 FR-3, SR-11: gitleaks on the exact bytes; a hit names lines and rule ids only. */
  async function scanDocument(doc: SourceDocument): Promise<void> {
    const content = Buffer.from(doc.text, "utf8");
    const res = await scanner.scan([{ sha: sha256Of(content), content }]);
    if (res.clean) return;
    const lines = [...new Set((res.hits ?? []).map((h) => h.line))].sort((a, b) => a - b);
    throw new DocumentRefused("secret", "The secrets scan found a secret in the document; nothing was stored. Remove it and try again.", lines, res.rules[0]);
  }

  /**
   * Commits the document byte for byte to a new commit on top of main, at the
   * engine's own path for the feature (F-009 FR-4, SR-10), through a private
   * index so the project's checkout and index are never touched.
   */
  async function storeDocument(p: Project, fid: string, main: string, doc: SourceDocument): Promise<{ commit: string; blob: string }> {
    const content = Buffer.from(doc.text, "utf8");
    const blob = (await git.out(p.real!, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content })).trim();
    const back = await git.catBlob(p.real!, blob);
    if (!back.equals(content)) throw new Error("git stored a different blob than the document");
    ensureOwnerDir(tmpDir);
    const index = path.join(tmpDir, `doc-index-${crypto.randomBytes(8).toString("hex")}`);
    try {
      await git.run(p.real!, ["read-tree", main], { indexFile: index });
      await git.run(p.real!, ["update-index", "--add", "--cacheinfo", `100644,${blob},${sourcePath(fid, doc.media_type)}`], { indexFile: index });
      const tree = (await git.out(p.real!, ["write-tree"], { indexFile: index })).trim();
      const commit = (await git.out(p.real!, ["commit-tree", tree, "-p", main, "-F", "-"], { input: `${fid}: source document from the owner\n` })).trim();
      return { commit, blob };
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  function channelFor(p: Project): ProjectChannel {
    return {
      name: p.name!,
      sessions: p.sessions!,
      features: () => [...p.features.values()].filter((f) => !ambiguous.has(f.id)),
      feature: (fid) => (ambiguous.has(fid) ? null : p.features.get(fid) ?? null),
      inbox: () => {
        const ib = p.inbox;
        if (!ib) return null;
        return {
          list: () => ib.consoleList(),
          show: (id) => ib.consoleShow(id),
          answer: async (a) => answeredInConsole(p, await ib.consoleAnswer(a)),
          confirm: async (a) => answeredInConsole(p, await ib.consoleConfirm(a)),
        };
      },
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
      startFeature: (request, doc) => {
        // One at a time across projects, so two requests can't take the same id.
        const run = startLock.then(async () => {
          // The document is scanned before anything else happens: a refusal leaves no id, branch, commit or transcript (F-009 AC-3).
          if (doc) await scanDocument(doc);
          const n = (await knownFeatureIds()) + 1;
          const fid = `F-${String(n).padStart(3, "0")}`;
          const branch = `feature/${fid}-${slug(request)}`;
          const main = await git.revParse(p.real!, "refs/heads/main");
          if (!main) throw new Error("the config repo has no main branch");
          const stored = doc ? await storeDocument(p, fid, main, doc) : null;
          record.assignFeature(fid, p.real!);
          await git.run(p.real!, ["update-ref", `refs/heads/${branch}`, stored?.commit ?? main, "0".repeat(40)]);
          const f = newFeature(p, fid);
          const document = stored && doc ? documentMeta(fid, doc, stored.blob) : null;
          await f.exclusive(() => f.append([{ type: "feature_started", feature: fid, title: title(request), branch, request, ...(document ? { document } : {}) }], "feature requested"));
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

  /** The stored source document, by the blob id in the transcript, only if it still matches its SHA-256 (F-009 FR-4). */
  async function documentText(p: Project, f: FeatureInterview): Promise<string | null> {
    const d = f.state.document;
    if (!d || !/^[0-9a-f]{40,64}$/.test(d.blob)) return null;
    const buf = await git.catBlob(p.real!, d.blob).catch(() => null);
    if (!buf || sha256Of(buf) !== d.sha256) return null;
    return buf.toString("utf8");
  }

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
      .finally(() => {
        jobs.delete(f.id);
        // F-008 FR-1: a spec that passed the interview checks goes on to Gate 1 once the analyst's work is committed.
        if (f.stage() === GATE1_STAGE) afterInterview(p, f);
      });
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
    const models = p.models!;
    const branch = f.state.branch;
    const known = plan?.run ?? (analystRuns.get(f.id) ? record.run(analystRuns.get(f.id)!) : undefined);
    const wt = await prepareWorktree(git, p.real!, known?.worktree ?? worktreeDir(p, f.id), branch, known?.git_dir);
    const runId = analystRun(p, f.id, wt.path);
    runs.update(runId, { git_dir: wt.gitDir });
    let resumeId = plan?.mode === "session" ? plan.sessionId : undefined;
    try {
      const credential = modelCredentialFor(env, modelCredential);
      if (!credential) throw new SessionRefused("no model credential is stored or set");
      checkRoleEndpoint(p, "requirements-analyst", models["requirements-analyst"]);
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
        { kind: "model", ref: `requirements-analyst: ${models["requirements-analyst"]}` },
        ...(readerMd ? [{ kind: "model", ref: `web-reader: ${models["web-reader"]}` }] : []),
      ]);
      if (resumeId) {
        // The SDK session lives on the run's volume; without it the run starts again from its commit.
        const v = await rt.docker.run(["volume", "inspect", runVolume(runId)], { okCodes: [1] });
        if (v.code !== 0) resumeId = undefined;
      }
      const slugName = branch.replace(/^feature\//, "");
      const intro = `You are working on ${f.id} on branch ${branch}, in /workspace. Write its spec at docs/features/${slugName}.md. Reach the owner only through your factory tools.\n\n${structureText()}`;
      let summary = plan?.mode === "from_commit" ? plan.summary : "";
      if (plan?.mode === "session" && !resumeId) summary = transcriptSummary(f.state);
      // A new run after one that ended (an analyststop or breach restart) would otherwise start from the request alone (F-016 FR-13).
      if (!plan && record.runs().some((x) => x.id !== runId && x.feature === f.id && x.project === p.real && x.role === "requirements-analyst")) summary = transcriptSummary(f.state);
      const facts: RunFacts = { model: models["requirements-analyst"] };
      const docText = f.state.document ? await documentText(p, f) : null;
      if (f.state.document && docText === null) throw new SessionRefused("the feature's source document is missing or doesn't match its recorded hash");
      const sourceDoc = f.state.document && docText !== null ? frameDocument(f.id, f.state.document, docText) : null;
      let r: Awaited<ReturnType<typeof runAnalystSession>>;
      for (;;) {
        const gate1 = f.state.gate1.pending && f.stage() === INTERVIEW_STAGE && f.state.lastSpecReady
          ? analystGate1Turn(f.id, f.state.lastSpecReady.spec_path, f.state.gate1.findings, maturityOf(p.manifest!))
          : null;
        // F-016 FR-3, FR-8: what the owner's inbox answers or the readiness gate sent back.
        const returned = f.state.returns.length && f.stage() === INTERVIEW_STAGE && f.state.lastSpecReady
          ? analystReturnTurn(f.id, f.state.lastSpecReady.spec_path, f.state.returns)
          : null;
        const first = resumeId
          ? "The engine restarted. Continue where you left off; owner replies, if any, follow as further turns."
          : gate1 || returned
            ? [intro, ...(sourceDoc ? [sourceDoc] : []), transcriptSummary(f.state), ...(gate1 ? [gate1] : []), ...(returned ? [returned] : [])].join("\n\n")
            : [intro, frameRequest(f.id, f.state.request), ...(sourceDoc ? [sourceDoc] : []), ...(summary ? [summary] : [])].join("\n\n");
        if (gate1 || returned) {
          // F-008 SR-9: the findings were scanned when recorded; the input built from them is scanned again before it leaves the engine.
          const content = Buffer.from(first, "utf8");
          const scan = await scanner.scan([{ sha: sha256Hex(content), content }]);
          if (!scan.clean) {
            await alert(p, `secret:${crypto.randomBytes(8).toString("hex")}`, {
              title: "Gate 1 findings not sent: the secrets scan found a secret", feature: f.id,
              context: `The engine didn't start the analyst with ${f.id}'s Gate 1 findings because gitleaks flagged them (F-008 SR-9).`,
              impact: "The analyst's run is stopped.", confirm: "Rotate the secret if it was real", hold: "It was a false positive: no action", recommendation: "A",
            });
            await endRun(p, f, runId, "failed", "the secrets scan found a secret in its Gate 1 input", facts);
            return;
          }
        }
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
        try {
          r = await runAnalystSession({
            sdk, docker: rt.docker, group, manifest: m.raw, worktree: wt.path,
            instructions: { analyst: analystMd.text, ...(readerMd ? { reader: readerMd.text } : {}) },
            limits: agentLimits(limits, m.billingMode), skillsPluginDir: skillsPluginDir("requirements-analyst"),
            models: { analyst: models["requirements-analyst"], reader: models["web-reader"] }, ...(resumeId ? { resume: resumeId } : {}), sessionVolume: "run",
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
        } finally {
          // A session that ended can still hold a pending read of its turns, which would take an owner reply meant for the next session.
          turns.close();
        }
        if (dead) return;
        if (r.outcome.status === "error") log.warn(`${f.id}: run ${runId}'s session failed (${r.outcome.reason})${r.outcome.detail ? `; Claude Code said: ${JSON.stringify(r.outcome.detail)}` : ""}`);
        if (r.commit.status === "committed") runs.update(runId, { last_commit: r.commit.commit });
        if (r.commit.status === "rejected" || r.commit.status === "over_limit") await populateWorktree(git, p.real!, base, wt.path, wt.gitDir);
        // ADR 0012: a session that can't be resumed (it fails before the model produced anything, as when the
        // engine stopped mid tool call) gives way to a new session from the last commit, in the same resume.
        if (resumeId && !shuttingDown && r.outcome.status === "error" && r.outcome.outputTokens === 0 && r.commit.status !== "rejected" && r.commit.status !== "over_limit") {
          log.warn(`${f.id}: run ${runId} couldn't resume its session; it starts a new one from its last commit with a summary of the transcript.`);
          runs.update(runId, { session_id: undefined });
          resumeId = undefined;
          summary = transcriptSummary(f.state);
          continue;
        }
        break;
      }
      const { outcome, commit } = r;
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
      // The log keeps docker's whole stderr tail (4 KiB at most); the owner's note keeps the short form.
      log.warn(`${f.id}: no analyst session started: ${e instanceof DockerError ? e.message : why}`);
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
    await offerRerun(p, f, runId, why);
  }

  // A breach or a secret already filed its own item, with its own effect (SR-8).
  const rerunnable = (why: string) => !/outside the role's rules|secrets scan/.test(why);

  /** F-016 FR-13: with no analyst running, only the owner can start another, so ask once per stopped run. */
  async function offerRerun(p: Project, f: FeatureInterview, runId: string, why: string): Promise<void> {
    if (!rerunnable(why)) return;
    await alert(p, `analyststop:${f.id}:${runId}`, {
      title: `The analyst for ${f.id} stopped`, feature: f.id,
      context: `Analyst run ${runId} for ${f.id} stopped: ${why}. No analyst works on ${f.id} until this is decided; interview replies wait for the next run.`,
      impact: `${f.id} stays in the requirements interview with no analyst.`,
      confirm: "Run the analyst again (a new run with the full limits)", hold: "Keep the feature stopped", recommendation: "A",
    });
  }

  // -- Security Gate 1 (F-008) ---------------------------------------------------

  /** One Gate 1 job per feature at a time (FR-1); it shares the analyst's job slot, so the two never overlap. */
  const gate1Words = (e: unknown) => (e instanceof ConfigError || e instanceof DockerError || e instanceof SessionRefused || e instanceof StandardsError ? (e as Error).message.slice(0, 300) : "an internal error");

  async function noteGate1(f: FeatureInterview, status: "stopped" | "waiting" | "blocked", reason: string): Promise<void> {
    if (dead || !f.chainIntact) return;
    await f.exclusive(() => f.append([{ type: "gate1_session", status, reason }], `gate 1 ${status}`)).catch(() => undefined);
  }

  async function nextGate1Report(p: Project, fid: string): Promise<number> {
    const existing = await p.state_repo!.list(`runs/${fid}/${GATE1_STAGE}`).catch(() => []);
    return existing.filter((e) => /\/security-reviewer-\d+\.json$/.test(e.path)).length + 1;
  }

  /**
   * What a feature at `security_gate_1` needs next (FR-1, FR-9): the FR-9
   * check when it comes back from the findings interview, nothing while it
   * waits on the owner, else a reviewer run.
   */
  function afterInterview(p: Project, f: FeatureInterview, resume?: ResumePlan): void {
    const rt = o.agents;
    if (!rt || dead || shuttingDown || jobs.has(f.id) || !f.chainIntact || p.state !== "running" || ambiguous.has(f.id)) return;
    if (f.stage() !== GATE1_STAGE) return;
    const g = f.state.gate1;
    // F-016 FR-16: a blocked feature is checked again, in case the spec already answers what its items ask.
    if (g.blocked && !resume && !g.pending) return;
    const job: Job = { turns: null, done: Promise.resolve() };
    jobs.set(f.id, job);
    job.done = (g.pending && !resume ? resolveGate1(p, f) : runGate1(rt, p, f, resume))
      .catch((e) => log.warn(`${f.id}: Gate 1 stopped: ${gate1Words(e)}`))
      .finally(() => {
        jobs.delete(f.id);
        // A report that sent findings back starts the analyst once this job's slot is free.
        if (!dead && !shuttingDown && f.stage() === INTERVIEW_STAGE && f.state.gate1.pending) launchAnalyst(p, f);
        // F-016 FR-7: a Gate 1 pass goes straight on to the readiness gate.
        else if (!dead && !shuttingDown && f.stage() === READINESS_STAGE) startReadiness(p, f);
      });
  }

  /** The spec as the branch holds it, read from git as a regular file (SR-3, F-007 SR-12's path rule). */
  async function branchSpec(p: Project, f: FeatureInterview): Promise<{ spec: string; path: string; version: number | null; commit: string }> {
    const ready = f.state.lastSpecReady;
    if (!ready || !specPathPattern(f.id).test(ready.spec_path)) throw new SessionRefused("the feature has no spec that passed the interview checks");
    const commit = await git.revParse(p.real!, `refs/heads/${f.state.branch}`);
    if (!commit) throw new SessionRefused(`the branch ${f.state.branch} is gone`);
    const buf = await readFileAt(git, p.real!, commit, ready.spec_path, 1024 * 1024, "The spec");
    const spec = buf.toString("utf8");
    // The analyst can still edit the spec after interview_spec_ready in the same session, so the committed spec must pass the checks too.
    const failed = readinessChecks({ spec, specVersion: ready.spec_version, state: f.state, chainIntact: f.chainIntact && !f.remoteRefused }).filter((c) => !c.passed);
    if (failed.length) throw new SessionRefused(`the spec committed on ${f.state.branch} no longer passes the interview checks (${failed.map((c) => c.name).join(", ")})`);
    return { spec, path: ready.spec_path, version: ready.spec_version, commit };
  }

  /** FR-9 and FR-13 after the findings interview: readiness, or the owner's call, or the gap named. */
  async function resolveGate1(p: Project, f: FeatureInterview): Promise<void> {
    const { spec, path: specPath } = await branchSpec(p, f);
    const r = gate1Resolution(spec, f.state, maturityOf(p.manifest!));
    if (r.check.passed) {
      await f.exclusive(() => f.append([{ type: "gate1_resolved", passed: true, evidence: r.check.evidence }, { type: "stage", stage: READINESS_STAGE }], "gate 1: findings resolved"));
      log.info(`${f.id}: Gate 1 findings resolved; the feature is at ${READINESS_STAGE}.`);
      // FR-16: a risk item filed before the spec was read right asks about a finding the spec now takes up.
      for (const rec of p.inbox ? await p.inbox.records() : []) {
        if (rec.status === "open" && rec.effect?.type === "gate1_risk" && rec.effect.feature === f.id) {
          await p.inbox!.withdraw(rec.id, `${f.id}'s spec takes up this Gate 1 finding, so Security Gate 1 passed.`);
        }
      }
      return;
    }
    // FR-16: already waiting on the owner; the items stand until answered or the spec takes them up.
    if (f.state.gate1.blocked) return;
    const filed: Array<{ n: number; item: string }> = [];
    for (const n of r.rejected.filter((x) => !f.state.gate1.riskFiled.includes(x))) {
      const finding = f.state.gate1.findings.find((x) => x.n === n)!;
      const item = await fileDecisionItem(p.inbox!, {
        title: `${findingRef(n)} for ${f.id}: accept the risk or send it back`, feature: f.id,
        effect: { type: "gate1_risk", feature: f.id, finding: n },
        context: [
          { engine: `Security Gate 1 found a gap in ${f.id}'s spec (${specPath}) and suggested a requirement. After the interview, no requirement in the spec takes it up, which usually means you said no (F-008 FR-13).` },
          { outside: `${finding.criterion}, ${finding.severity}: ${finding.explanation}\nSuggested requirement: ${finding.fix}`, author: "the security reviewer" },
        ],
        impact: `${f.id} stays at Security Gate 1 until this is decided.`,
        options: [
          { id: "A", label: "Accept the risk and leave it out of the spec", detail: "The finding is recorded as an accepted risk." },
          { id: "B", label: "Send it back to the interview", detail: "The analyst asks about it again." },
        ],
        recommendation: "B",
        costOfDelay: `${f.id} can't reach the readiness gate.`,
      });
      filed.push({ n, item });
    }
    const blocked = filed.length || r.waiting.length;
    if (!blocked) {
      // F-016 FR-15: nothing waits on the owner and nothing was refused, so the interview missed a step; the analyst gets one more go per report.
      const back = { type: "returned", return: { why: "gate1_unresolved", evidence: r.check.evidence } };
      if (f.state.gate1.unresolvedSent === 0) {
        await f.exclusive(() => f.append([{ type: "gate1_resolved", passed: false, evidence: r.check.evidence }, back, { type: "stage", stage: INTERVIEW_STAGE }], "gate 1: findings not resolved, back to the interview"));
        log.warn(`${f.id}: Gate 1 findings not resolved: ${r.check.evidence} Back to the interview.`);
        return;
      }
      await f.exclusive(() => f.append([{ type: "gate1_resolved", passed: false, evidence: r.check.evidence }], "gate 1: findings not resolved"));
      log.warn(`${f.id}: Gate 1 findings not resolved again: ${r.check.evidence}`);
      await alert(p, `gate1unresolved:${f.id}:${f.state.gate1.reportAt}:${f.state.gate1.unresolvedSent}`, {
        title: `Gate 1 findings for ${f.id} still not taken up`, feature: f.id,
        context: `The interview went back to the analyst once already, and Security Gate 1's check still finds: ${r.check.evidence.slice(0, 1500)}`,
        impact: `${f.id} stays at Security Gate 1 with no analyst.`,
        confirm: "Send it back to the analyst again", hold: "Keep the feature where it is", recommendation: "A",
      });
      return;
    }
    await f.exclusive(() => f.append([
      blocked
        ? { type: "gate1_blocked", reason: `Waiting on the owner's Security items: ${[...filed.map((x) => x.item), ...r.waiting.map((n) => f.state.gate1.findings.find((x) => x.n === n)?.item ?? findingRef(n))].join(", ")}.`, risk: filed.map((x) => x.n) }
        : { type: "gate1_resolved", passed: false, evidence: r.check.evidence },
    ], blocked ? "gate 1: waiting on the owner" : "gate 1: findings not resolved"));
    log.warn(`${f.id}: Gate 1 findings not resolved: ${r.check.evidence}`);
  }

  /**
   * One Gate 1 run, start to end (FR-1 to FR-8, FR-10, FR-11, SR-11): the
   * checks before any session, the reviewer's sessions, the report's check,
   * then the rendering on the feature branch and the report, items, findings
   * and stage on factory/state in one transcript commit.
   */
  async function runGate1(rt: AgentRuntime, p: Project, f: FeatureInterview, resume?: ResumePlan): Promise<void> {
    const m = p.manifest!;
    const sources = p.sources!;
    const limits = p.limits!;
    const g1 = gate1Limits(limits, m.billingMode);
    const model = p.models!["security-reviewer"];
    const instructions = sources.instructions.get("security-reviewer");
    const notReady = !g1 || !model
      ? `this factory version (${m.factoryVersion}) has no security-reviewer entry in ${!model ? MODELS_FILE : LIMITS_FILE}`
      : !instructions ? "the security-reviewer role has no AGENT.md at factory.version or in the project's overrides" : null;
    if (notReady) {
      // AC-10: no session, and the owner is told why.
      log.warn(`${f.id}: no Gate 1 session started: ${notReady}.`);
      // Not a block: a later factory version or override fixes it, and the next engine start tries again.
      await noteGate1(f, "waiting", `No Gate 1 session started: ${notReady}.`);
      return;
    }
    if (!resume && f.state.gate1.runs >= g1!.runsPerFeature + f.state.gate1.extraRuns) {
      // SR-11: a fourth run needs the owner.
      const why = `${f.id} has had ${f.state.gate1.runs} Gate 1 runs, the most allowed (F-008 SR-11)`;
      // The transcript records the block before the owner is told, so the item never names a state the record lacks.
      if (!f.state.gate1.blocked) await f.exclusive(() => f.append([{ type: "gate1_blocked", reason: why }], "gate 1 run limit"));
      await alert(p, `gate1cap:${f.id}:${f.state.gate1.runs}`, {
        title: `Gate 1 for ${f.id} reached its run limit`, feature: f.id,
        private: [{ name: "Engine log", text: logLines(`${f.id}`) || "The engine log has no lines for this feature from today or yesterday." }],
        context: `${why}. Another run would cost another reviewer session. The Gate 1 reports and the engine log say why the earlier runs didn't pass.`,
        impact: `${f.id} stays at Security Gate 1 until you allow another run.`,
        confirm: "Allow one more Gate 1 run: the security reviewer checks the current spec again", hold: "Keep the feature where it is, with no more runs", recommendation: "A",
      });
      return;
    }
    const { spec, path: specPath, version: specVersion, commit } = await branchSpec(p, f);
    const n = await nextGate1Report(p, f.id);
    const reportName = `security-reviewer-${n}.json`;
    const reportRel = `.factory/runs/${f.id}/${GATE1_STAGE}/${reportName}`;
    const wtDir = path.join(path.dirname(worktreeDir(p, f.id)), `${f.id}-gate1`);
    const known = resume?.run;
    const wt = await prepareWorktree(git, p.real!, known?.worktree ?? wtDir, f.state.branch, known?.git_dir, commit);
    await populateWorktree(git, p.real!, commit, wt.path, wt.gitDir);
    const run = known ?? runs.start({ project: p.real!, feature: f.id, role: REVIEWER_ROLE, stage: GATE1_STAGE, worktree: wt.path });
    const runId = run.id;
    runs.update(runId, { git_dir: wt.gitDir, last_commit: commit });
    if (!known) await f.exclusive(() => f.append([{ type: "gate1_run", run: runId, commit }], "gate 1 started"));
    const reportDir = path.join(home, "gate1", sha256Hex(p.real!).slice(0, 16), runId);
    let resumeId = resume?.mode === "session" ? resume.sessionId : undefined;
    const facts: RunFacts = { model };
    try {
      const credential = modelCredentialFor(env, modelCredential);
      if (!credential) throw new SessionRefused("no model credential is stored or set");
      const loaded = await loadStandards({
        git, masterRepo: o.masterRepo, masterCommit: sources.masterCommit, configRepo: p.real!, configCommit: m.commit, manifest: m.raw, additionsBytes: g1!.additionsBytes,
      });
      if (loaded.additionsRefused) {
        await alert(p, `additions:${m.commit}:${loaded.additionsRefused}`, {
          title: "Project security additions were not used at Gate 1", feature: f.id,
          context: `The project's standards.security file was refused: ${loaded.additionsRefused}. Gate 1 runs on the factory's security standards alone (F-008 SR-10).`,
          impact: "Gate 1 checks only the factory's criteria until the additions file is fixed on main.",
          confirm: "Fix the additions file on main", hold: "Find out who changed it", recommendation: "A",
        });
      }
      // F-020 FR-10: the Claude reviewer returns its report as structured output and writes nothing; only the endpoint's advisory pass writes a file (A-2, SR-11).
      const policy = reviewerPolicy(m.raw, undefined);
      const filePolicy = reviewerPolicy(m.raw, undefined, reportRel);
      const sdk = await rt.sdk();
      const ident = { project: m.name, masterCommit: sources.masterCommit, skillsDigest: sources.skillsDigest };
      const image = await shared(images, `${ident.project}\0${ident.masterCommit}\0${ident.skillsDigest}`, () => ensureAgentImage(rt.docker, rt.dockerDir, path.join(home, "images"), ident, sources));
      proxyImage ??= baseImageId(rt.docker);
      proxyImage.catch(() => (proxyImage = null));
      const proxyImageId = await proxyImage;
      runArtifacts.set(runId, [
        { kind: "image", ref: image.tag },
        ...(sources.skills.get(REVIEWER_ROLE) ?? []).map((s) => ({ kind: "skill", ref: `${s.name} (${s.from}: ${s.path})` })),
        { kind: "model", ref: `${REVIEWER_ROLE}: ${model}` },
      ]);
      if (resumeId) {
        const v = await rt.docker.run(["volume", "inspect", runVolume(runId)], { okCodes: [1] });
        if (v.code !== 0) resumeId = undefined;
      }
      // The report folder is engine-owned and starts empty, so nothing in it predates this run (SR-8).
      fs.rmSync(reportDir, { recursive: true, force: true });
      ensureOwnerDir(reportDir);
      // The mount point inside the read-only worktree; an empty folder is no change to the branch.
      fs.mkdirSync(path.join(wt.path, ...path.posix.dirname(reportRel).split("/")), { recursive: true });
      const groupFor = (id: string, router?: RouterConfig): GroupConfig => ({
        docker: rt.docker, runId: id, project: m.name, agentImageId: image.id, proxyImageId, proxyScript: rt.proxyScript,
        agentLimits: roleContainerLimits(limits), proxyLimits: containerLimits(limits.proxy), maxPageBytes: maxPageBytes(limits),
        credential, log, ...(rt.platform ? { platform: rt.platform } : {}), ...(rt.sleep ? { sleep: rt.sleep } : {}), ...(router ? { router } : {}),
      });
      const group = new SessionGroup(groupFor(runId));
      let valid: Gate1Report | null = null;
      const turnFor = (reportPath?: string) => reviewerTurn({ feature: f.id, specPath, specVersion, commit, ...(reportPath ? { reportPath } : {}), standards: loaded.standards, transcript: transcriptSummary(f.state) });
      const first = resumeId ? "The engine restarted. Finish your Gate 1 report and return it as your structured output." : turnFor();
      const reportTarget = `${WORKSPACE}/${path.posix.dirname(reportRel)}`;
      // The worktree and the report folder are checked after every reviewer session, whether it ran on Claude or on an endpoint (SR-12, AC-4).
      const verifyIn = (dir: string) => async (pol: RolePolicy) => {
        const extra = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x !== reportName) : [];
        if (extra.length) return { status: "rejected" as const, breaches: extra.slice(0, 20).map((x) => ({ path: `${path.posix.dirname(reportRel)}/${x}`, reason: "not_allowed" as const })) };
        return commitWorktree({
          git, gitDir: wt.gitDir, worktree: wt.path, branch: f.state.branch, base: commit, policy: { ...pol, write: { allow: [], deny: [] } }, scanner, tmpDir,
          message: `${f.id}: Gate 1 reviewer session (run ${runId})`, limits: worktreeLimits(limits),
        });
      };
      const onBreachOf = (id: string, who: string) => async (breaches: Array<{ path: string; reason: string }>) => {
        await alert(p, `breach:${id}:${crypto.randomBytes(4).toString("hex")}`, {
          title: `Security reviewer${who} changed files outside its report`, feature: f.id,
          context: `The engine rejected run ${id}: ${breaches.slice(0, 20).map((b) => `${b.path || "(history)"} (${b.reason})`).join(", ")} (F-008 AC-4). Nothing was committed.`,
          impact: "The Gate 1 run is stopped.", confirm: "Look at the reviewer's instructions and run Gate 1 again", hold: "Keep the feature stopped", recommendation: "B",
        });
      };
      // F-013 FR-10: an endpoint may give the Claude reviewer unverified hints first; the gate result is only the Claude report.
      let hints: AdvisoryHints | null = null;
      let reviewerFirst = first;
      if (!resumeId) {
        const advId = `${runId}-adv`;
        const advDir = path.join(path.dirname(reportDir), advId);
        let advUsage: RunUsage | null = null;
        const adv = await runAdvisory({
          plan: planAdvisory({ role: REVIEWER_ROLE, assignment: manifestAssignments(m.raw).get(REVIEWER_ROLE), claudeDefault: model!, allowed: m.endpoints, unavailable: (r) => endpointSvc.unavailable(r) }),
          role: REVIEWER_ROLE, standards: loaded.standards, allowed: m.endpoints, promptTokens: estimateTokens(first),
          route: (req) => endpointSvc.route(req),
          session: async (route) => {
            fs.rmSync(advDir, { recursive: true, force: true });
            ensureOwnerDir(advDir);
            try {
              return await runAdvisorySession({
                route, group: new SessionGroup(groupFor(advId, route.router)), reportDir: advDir, reportName, maxBytes: g1!.reportBytes,
                run: {
                  sdk, docker: rt.docker, policy: filePolicy, worktree: wt.path, reportDir: { source: advDir, target: reportTarget }, instructions: instructions!.text,
                  caps: { ...g1!.caps, wallTimeMs: Math.min(g1!.caps.wallTimeMs, ADVISORY_WALL_MS) }, skillsPluginDir: skillsPluginDir(REVIEWER_ROLE), first: turnFor(reportRel),
                  billingCheck: () => billingMismatch(m.billingMode, m.name, env, modelCredential),
                  verify: verifyIn(advDir), onBreach: onBreachOf(advId, "'s advisory pass"), log,
                },
              });
            } finally {
              fs.rmSync(advDir, { recursive: true, force: true });
              await rt.docker.run(["volume", "rm", "--force", runVolume(advId)], { okCodes: [1] }).catch(() => undefined);
            }
          },
          onCost: (c, u) => {
            advUsage = { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cost_usd: c.costUsd, duration_s: 0, ...(c.planShare > 0 ? { plan_share: c.planShare } : {}) };
          },
          log,
        });
        const rates = endpointSvc.bandReports();
        if (rates.length) facts.endpoint_rates = rates;
        if (adv.status !== "none") {
          facts.advisory = {
            endpoint: adv.endpoint, status: adv.status, ...(adv.status !== "ok" ? { reason: adv.reason } : {}), ...(adv.status !== "skipped" ? { report_via: "file" as const } : {}),
            ...(adv.status === "ok" ? { model: adv.model, hints: adv.hints.findings.length, dropped: adv.hints.dropped } : {}), ...(advUsage ? { usage: advUsage } : {}),
            ...(adv.status !== "ok" && adv.fallback ? { fallback: adv.fallback } : {}),
          };
        }
        if (adv.status === "ok" && adv.hints.findings.length) {
          const block = advisoryBlock(adv.hints);
          // The endpoint's words go to Claude as data only after the same secrets scan as the other inputs (F-008 SR-9).
          const content = Buffer.from(block, "utf8");
          if ((await scanner.scan([{ sha: sha256Hex(content), content }])).clean) {
            hints = adv.hints;
            reviewerFirst = `${first}\n\n${block}`;
          } else {
            facts.advisory!.status = "failed";
            facts.advisory!.reason = "its hints were not passed on: the secrets scan found a secret in them";
          }
        } else if (adv.status === "ok") hints = adv.hints;
      }
      facts.report_via = "structured_output";
      const result = await runReviewerSessions({
        sdk, docker: rt.docker, group, policy, worktree: wt.path, outputSchema: reportOutputSchema(REVIEWER_ROLE),
        instructions: instructions!.text, caps: g1!.caps, skillsPluginDir: skillsPluginDir(REVIEWER_ROLE), model: model!, first: reviewerFirst,
        ...(resumeId ? { resume: resumeId } : {}),
        ...(known?.used ? { used: known.used } : {}),
        onUsed: (u) => void (dead || runs.update(runId, { used: u })),
        billingCheck: () => billingMismatch(m.billingMode, m.name, env, modelCredential),
        check: async (structured) => {
          // SR-7: the model's schema first, so a report that sets an engine-filled field is refused; then the Gate 1 rules.
          const shape = schemaErrors(structured, modelReport(REVIEWER_ROLE));
          const errors = shape.length ? shape : (() => {
            const v = validateReport(JSON.stringify(structured), { feature: f.id, commit, standards: loaded.standards, spec, maxBytes: g1!.reportBytes, maturity: maturityOf(p.manifest!) });
            if (v.ok) valid = v.report;
            return v.ok ? [] : v.errors;
          })();
          if (!errors.length) return null;
          log.warn(`${f.id}: Gate 1 report refused: ${errors.slice(0, 5).join("; ")}`);
          return correctionTurn(undefined, errors);
        },
        // SR-12: the report folder may hold the named report and nothing else.
        verify: verifyIn(reportDir),
        onBreach: onBreachOf(runId, ""),
        onSessionId: (id) => void (dead || runs.update(runId, { session_id: id })),
        log,
      });
      if (dead) return;
      facts.usage = usage(result.outcome);
      if (shuttingDown && result.invalid) return;
      if (result.invalid || !valid) {
        await populateWorktree(git, p.real!, commit, wt.path, wt.gitDir).catch(() => undefined);
        await endGate1(p, f, runId, n, "failed", result.invalid ?? "its report couldn't be read", facts, commit);
        return;
      }
      if (hints && facts.advisory) facts.advisory.match = matchRate((valid as Gate1Report).findings, hints);
      await acceptGate1(p, f, { runId, n, commit, wt, report: valid, specPath, specVersion, facts, limits });
    } catch (e) {
      if (dead) return;
      if (e instanceof SecretFound) {
        // SR-9: reviewer text with a secret in it goes nowhere.
        await alert(p, `secret:${crypto.randomBytes(8).toString("hex")}`, {
          title: "Gate 1 report refused: the secrets scan found a secret", feature: f.id,
          private: [{ name: "Where the scan found it", text: `Files: ${e.paths.join(", ") || "not named"}\nRules: ${e.rules.join(", ") || "not named"}` }],
          context: `The engine didn't record run ${runId}'s Gate 1 report, its rendering or its items because gitleaks flagged them (F-008 SR-9).`,
          impact: `${f.id} stays at Security Gate 1.`, confirm: "Rotate the secret if it was real, then run Gate 1 again", hold: "It was a false positive: no action", recommendation: "A",
        });
        await endGate1(p, f, runId, n, "failed", "the secrets scan found a secret in its report", facts, commit);
        return;
      }
      const why = gate1Words(e);
      if (record.run(runId)?.status === "running") runs.interrupt(runId, why);
      log.warn(`${f.id}: no Gate 1 session started: ${e instanceof DockerError ? e.message : why}`);
      await noteGate1(f, "waiting", `No Gate 1 session started: ${why}. The run resumes at the next engine start.`);
    } finally {
      fs.rmSync(reportDir, { recursive: true, force: true });
    }
  }

  const maturityOf = (m: Manifest): string => {
    const raw = m.raw as { maturity?: unknown } | undefined;
    return typeof raw?.maturity === "string" ? raw.maturity : "";
  };

  /** A valid report: rendering on the branch, then report, items, findings and stage in one factory/state commit. */
  async function acceptGate1(p: Project, f: FeatureInterview, a: {
    runId: string; n: number; commit: string; wt: { path: string; gitDir: string }; report: Gate1Report;
    specPath: string; specVersion: number | null; facts: RunFacts; limits: Limits;
  }): Promise<void> {
    // SR-9: the reviewer's own text is scanned raw, before anything built from it is written. Escaped or
    // quoted copies can hide a token from the scanner's patterns.
    const strings: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    collect(a.report);
    const raw = Buffer.from(strings.join("\n"), "utf8");
    const scan = await scanner.scan([{ sha: sha256Hex(raw), content: raw }]);
    if (!scan.clean) throw new SecretFound([], []);
    const rendered = `docs/features/${f.id}-security-gate1.md`;
    fs.writeFileSync(path.join(a.wt.path, ...rendered.split("/")), renderReport({
      feature: f.id, title: f.state.title, specVersion: a.specVersion, date: iso(clock.now()).slice(0, 10), runId: a.runId, report: a.report,
      maturity: maturityOf(p.manifest!),
    }) + "\n");
    const enginePolicy: RolePolicy = { role: "engine", tools: [], read: { allow: [], deny: [] }, write: { allow: [rendered], deny: [] }, commands: [], network: [], mayRequest: [] };
    const c = await commitWorktree({
      git, gitDir: a.wt.gitDir, worktree: a.wt.path, branch: f.state.branch, base: a.commit, policy: enginePolicy, scanner, tmpDir,
      message: `${f.id}: Security Gate 1 report (run ${a.runId})`, limits: worktreeLimits(a.limits),
    });
    if (c.status !== "committed") throw new Error(`the Gate 1 rendering wasn't committed (${c.status})`);
    runs.update(a.runId, { last_commit: c.commit });
    const items = new Map<number, string>();
    const findings = a.report.findings;
    for (const [i, fd] of findings.entries()) {
      if (!fd.needs_owner || recordedOnly(fd, maturityOf(p.manifest!))) continue;
      items.set(i + 1, await fileDecisionItem(p.inbox!, {
        title: `${findingRef(i + 1)} for ${f.id}: the owner's choice`, feature: f.id,
        effect: { type: "gate1_choice", feature: f.id, finding: i + 1 },
        context: [
          { engine: `Security Gate 1 on ${f.id} (${a.specPath}) found a choice only you can make.` },
          { outside: `${fd.criterion}, ${fd.severity}, at ${fd.location}: ${fd.explanation}\nWhat the options decide: ${fd.fix}`, author: "the security reviewer" },
        ],
        impact: `${f.id} waits at Security Gate 1 until this is decided.`,
        options: fd.options!.map((op) => ({ id: op.id, label: op.label })), optionsBy: "the security reviewer",
        recommendation: fd.recommendation!,
        costOfDelay: `${f.id} can't reach the readiness gate.`,
      }));
    }
    const recs = records(findings, items, maturityOf(p.manifest!));
    const toAnalyst = recs.some((r) => !r.needs_owner && !r.recorded);
    const choices = [...items.values()];
    const report = agentReport({
      feature: f.id, stage: GATE1_STAGE, role: REVIEWER_ROLE, n: a.n, commit: a.commit, outcome: choices.length ? "blocked" : "complete",
      summary: a.report.summary, itemsFiled: choices,
      body: { gate: 1, findings: a.report.findings, checklist: a.report.checklist, permissions_added: a.report.permissions_added, abuse_cases: a.report.abuse_cases, not_applicable: a.report.not_applicable },
      facts: a.facts, artifacts: [...(runArtifacts.get(a.runId) ?? []), { kind: "report", ref: rendered }],
    });
    const next = recs.every((r) => r.recorded) ? READINESS_STAGE : toAnalyst ? INTERVIEW_STAGE : GATE1_STAGE;
    await f.exclusive(() => f.append([
      { type: "gate1_report", run: a.runId, report: a.n, commit: a.commit, rendered: c.commit, findings: recs },
      ...(choices.length && !toAnalyst ? [{ type: "gate1_blocked", reason: `Waiting on the owner's Security items: ${choices.join(", ")}.` }] : []),
      ...(next !== GATE1_STAGE ? [{ type: "stage", stage: next }] : []),
    ], `gate 1: ${findings.length} finding${findings.length === 1 ? "" : "s"}`, [report]));
    runs.finish(a.runId, "complete");
    await o.agents?.docker.run(["volume", "rm", "--force", runVolume(a.runId)], { okCodes: [1] }).catch(() => undefined);
    log.info(`${f.id}: Gate 1 run ${a.runId} filed ${findings.length} finding(s); the feature is at ${next}.`);
  }

  async function endGate1(p: Project, f: FeatureInterview, runId: string, n: number, status: "failed", why: string, facts: RunFacts, commit: string): Promise<void> {
    await o.agents?.docker.run(["volume", "rm", "--force", runVolume(runId)], { okCodes: [1] }).catch(() => log.warn(`volume ${runVolume(runId)} wasn't removed`));
    try {
      await p.state_repo!.commit([agentReport({
        feature: f.id, stage: GATE1_STAGE, role: REVIEWER_ROLE, n, commit, outcome: "failed", summary: `Run ${runId} stopped: ${why}.`,
        body: { gate: 1, findings: [] }, facts, artifacts: runArtifacts.get(runId) ?? [],
      })], `${f.id}: Gate 1 run ${runId} stopped`);
      await pushState(p);
    } catch (e) {
      log.warn(`${p.name}: the report for Gate 1 run ${runId} wasn't committed (${(e as Error).message}).`);
    }
    await noteGate1(f, "stopped", `The Gate 1 run stopped: ${why}.`);
    // Last, so a run shown as ended already has its report and its transcript note (FR-10).
    runs.finish(runId, status, why);
  }

  let done!: () => void;
  const stopped = new Promise<void>((r) => (done = r));
  let stopping: Promise<void> | null = null;
  const allFeatures = () => projects.filter((p) => p.state === "running").flatMap((p) => [...p.features.values()]);

  const control: EngineControl = {
    status: () => ({
      version: SERVED_CHANNEL_VERSION,
      capabilities: [...CAPABILITIES],
      uptime_s: Math.floor((clock.now() - startedAt) / 1000),
      features: projects.filter((p) => p.state === "running").flatMap((p) => [...p.features.values()].filter((f) => !ambiguous.has(f.id)).map((f) => {
        const waiting = p.inbox?.waitingOn(f.id) ?? [];
        // H-0183 (channel v1.5): the items the feature waits on, only when there are any.
        const stage = f.stage() || INTERVIEW_STAGE;
        const activity = activityOf({ stage, paused: f.paused, running: jobs.has(f.id), statuses: f.state.list().map((it) => it.status), decisions: waiting });
        return { id: f.id, stage, active_agents: jobs.has(f.id) ? 1 : 0, activity, ...(waiting.length ? { waiting_on: waiting } : {}) };
      })),
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
    shutdown: () => void handle.stop().catch((e) => log.warn(`The engine didn't stop cleanly: ${engineWords(e)}`)),
  };

  // Phase 3: channels and engine.json (FR-4).
  try {
    for (const p of projects) {
      if (p.state !== "running" || !p.manifest || !p.state_repo) continue;
      const pin = pins.get(p.real!)!;
      const signInSetting = interviewSignIn(p.manifest);
      p.sessions = new SessionManager(p.manifest.name, { githubId: pin.owner.github_id, oauthClientId: pin.owner.oauth_client_id }, github, clock, log, async (fid, no, signIn) => {
        const f = p.features.get(fid);
        if (f?.chainIntact) {
          // Without sign-in nothing proves who is answering, so the record doesn't claim the owner approved.
          const entry = signIn
            ? { type: "session_approved", session: no, owner_id: pin.owner.github_id }
            : { type: "session_opened_without_sign_in", session: no, sign_in: signInSetting };
          await f.exclusive(() => f.append([entry], "session approved"));
        }
      }, signInSetting);
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
      writeFileAtomic(path.join(p.state_repo.factoryDir, ENGINE_JSON), JSON.stringify({ version: SERVED_CHANNEL_VERSION, capabilities: CAPABILITIES, path: p.listener.path, pid: process.pid }) + "\n");
      log.info(`${p.manifest.name}: serving channel v${SERVED_CHANNEL_VERSION}`);
    }
  } catch (e) {
    for (const p of projects) await p.listener?.close();
    throw new StartError(`The control channel couldn't be served: ${(e as Error).message}`);
  }

  // -- Owner answers and the readiness gate (F-016) -----------------------------

  /** The project's open features waiting on Gate 1 items: choices undecided, or risks neither accepted nor sent back. */
  /** Findings still waiting on a Security item, other than `except`; risk items aren't on the finding, so the name falls back to its ref. */
  function gate1Waiting(f: FeatureInterview, except?: number): string[] {
    const g = f.state.gate1;
    return g.findings
      .filter((x) => x.n !== except && ((x.needs_owner && !g.decided.has(x.n)) || (g.riskFiled.includes(x.n) && !g.accepted.has(x.n))))
      .map((x) => x.item ?? findingRef(x.n));
  }

  /**
   * F-016 FR-2 to FR-9: carries out one recorded owner action. The effect is
   * picked by the item's effect type, fixed by the engine when it filed the
   * item (SR-4), never by its text. The feature's entries and the record's
   * `effect_done` land in one commit (SR-7); an effect that throws leaves
   * both unchanged and runs again at the next poll, and the record keeps it
   * from running twice (SR-5).
   */
  async function onAnswer(p: Project, rec: Recorded): Promise<void> {
    const r = rec.record;
    const e = rec.entry;
    const type = String(r.effect?.type ?? "");
    const fid = typeof r.effect?.feature === "string" ? r.effect.feature : null;
    const f = fid ? p.features.get(fid) : undefined;
    const chosen = e.action === "chosen" ? e.option : undefined;
    const keepsWaiting = e.action === "deferred" || e.action === "restored";
    const done = async (effect: string, entries: Array<Record<string, unknown>> = [], stage?: string) => {
      const change = await p.inbox!.effectChange(r.id, effect, stage);
      if (f && entries.length) {
        await f.exclusive(() => f.append([...entries, ...(stage ? [{ type: "stage", stage }] : [])] as never, `${r.id}: ${effect}`, [change]));
      } else {
        await p.state_repo!.commit([change], `${r.id}: effect ${effect}`);
      }
      log.info(`${r.id}: ${effect}${stage ? `; ${fid} is at ${stage}` : ""}.`);
    };
    if (keepsWaiting) return done("none");
    if ((type.startsWith("gate1_") || type === "spec_signoff") && (!f || !f.chainIntact)) return done("feature_unavailable");

    if (type === "gate1_choice" || type === "gate1_risk") {
      const n = Number(r.effect!.finding);
      const finding = f!.state.gate1.findings.find((x) => x.n === n);
      if (!finding) return done("finding_gone");
      // Gate 2 L1: a choice counts only from the item the engine filed for that finding.
      if (type === "gate1_choice" && finding.item !== r.id) return done("not_the_findings_item");
      const note = e.note !== undefined ? { note: e.note } : {};
      let entries: Array<Record<string, unknown>>;
      let effect: string;
      if (type === "gate1_choice" && chosen) {
        const label = r.options?.find((o) => o.id === chosen)?.label ?? chosen;
        entries = [
          { type: "gate1_decided", finding: n, item: r.id, option: chosen, label },
          { type: "returned", return: { why: "gate1_choice", item: r.id, finding: n, option: chosen, label } },
        ];
        effect = "gate1_decided";
      } else if (type === "gate1_risk" && chosen === "A") {
        entries = [
          { type: "gate1_risk_accepted", finding: n, item: r.id },
          { type: "returned", return: { why: "gate1_risk_accepted", item: r.id, finding: n } },
        ];
        effect = "gate1_risk_accepted";
      } else {
        // Send it back, Reject, Request changes, Ask for more research: the analyst asks the owner again (FR-4, FR-5).
        entries = [
          { type: "gate1_reask", finding: n, item: r.id },
          { type: "returned", return: { why: "gate1_reask", item: r.id, finding: n, ...note } },
        ];
        effect = "gate1_reask";
      }
      // The feature goes back to the interview once nothing else of its Gate 1 waits on the owner.
      const after = gate1Waiting(f!, n);
      if (after.length) {
        await done(effect, [...entries, { type: "gate1_blocked", reason: `Waiting on the owner's Security items: ${after.join(", ")}.` }]);
        return;
      }
      await done(effect, [...entries, { type: "gate1_unblocked" }], INTERVIEW_STAGE);
      launchAnalyst(p, f!);
      return;
    }

    if (type === "spec_signoff") {
      const so = f!.state.readiness.signoff;
      if (!so || so.item !== r.id) return done("signoff_superseded");
      if (e.action === "approved") {
        // SR-3: the sign-off counts only for the commit it named.
        const head = await git.revParse(p.real!, `refs/heads/${f!.state.branch}`).catch(() => null);
        if (head !== so.commit) {
          await done("signoff_stale", [{ type: "signoff_withdrawn", item: r.id, reason: "the feature branch moved after the item was filed" }]);
          // FR-9: the same item is revised to the new commit once the gate passes again.
          await p.inbox!.reopen(r.id);
          startReadiness(p, f!);
          return;
        }
        await done("spec_signed_off", [{ type: "spec_signed_off", item: r.id, commit: so.commit, version: so.version }], BUILD_STAGE);
        notify(`Factory: ${f!.id} is ready for development`, `Spec v${so.version ?? "?"} is signed off.`);
        return;
      }
      await done("signoff_changes", [
        { type: "signoff_withdrawn", item: r.id, reason: e.action },
        { type: "returned", return: { why: "signoff_changes", item: r.id, ...(e.note !== undefined ? { note: e.note } : {}) } },
      ], INTERVIEW_STAGE);
      launchAnalyst(p, f!);
      return;
    }

    // Engine Security items (H-0182). Option B, and anything but A, only records.
    if (chosen !== "A") return done("record_only");
    if (type === "pins") {
      // OQ-3: the inbox proves the previously pinned owner (the inbox reads only that id), so the change is pinned as `factory-engine confirm` pins it.
      const m = p.manifest;
      const pin = p.real ? pins.get(p.real) : null;
      if (!m || !pin || e.actor_id !== pin.owner.github_id) return done("record_only");
      // Gate 2 M2: the approval covers the manifest commit the item named, never a later change on main.
      if (r.effect?.commit !== m.commit) {
        notify(`Factory: ${m.name} not confirmed`, `${r.id} named another manifest commit. Restart the engine for a new item.`);
        return done("pins_stale");
      }
      pins.set(p.real!, { ...pinnedKeys(m), pinned_at: iso(clock.now()), commit: m.commit });
      log.action({ agent: "owner", action: "pins.confirm", target: m.name, approval_id: `inbox:${r.id}`, outcome: "pinned" });
      notify(`Factory: ${m.name} confirmed`, "Restart the engine to run the project.");
      return done("pinned");
    }
    if (type === "chain" && f) {
      const fresh = newFeature(p, f.id);
      const t = await readTranscript(p, fresh);
      if (!t.intact) {
        await done("chain_still_broken");
        await tampered(p, fresh, t.why!, `again:${sha256Hex(t.raw ?? "")}`);
        return;
      }
      fresh.load(t.entries, true);
      p.features.set(f.id, fresh);
      await done("chain_reopened");
      resumeFeature(p, fresh);
      return;
    }
    if (type === "breach" && f) {
      // SR-8: restarts after a breach count against MAX_RESUMES per feature; at the cap the owner gets a Notice instead.
      const restarts = (await p.inbox!.records()).filter((x) => x.effect?.type === "breach" && x.effect.feature === f.id && x.history.some((h) => h.action === "effect_done" && h.effect === "restarted")).length;
      if (restarts >= MAX_RESUMES) {
        await done("restart_capped");
        await p.inbox!.file({
          kind: "notice", title: `${f.id} not restarted: ${restarts} restarts after a rules breach`, priority: "high", blocking: false, created_by: "engine", feature: f.id,
          sections: { Details: [{ engine: `${r.id} asked to restart ${f.id}, but it has already restarted ${restarts} times after the analyst wrote outside its rules, the most allowed (F-016 SR-8). Nothing was restarted. Look at the agent's instructions before starting the feature again.` }] },
        });
        return;
      }
      await done("restarted");
      resumeFeature(p, f);
      return;
    }
    if (type === "gate1unresolved" && f) {
      await jobs.get(f.id)?.done;
      if (f.stage() !== GATE1_STAGE || jobs.has(f.id)) return done("record_only");
      await done("restarted", [{ type: "returned", return: { why: "gate1_unresolved", item: r.id } }], INTERVIEW_STAGE);
      launchAnalyst(p, f);
      return;
    }
    if (type === "analyststop" && f) {
      // The item is filed as the stopped run ends, so a quick answer can arrive before its job slot is free.
      await jobs.get(f.id)?.done;
      // SR-13: one run per approval; a feature that moved on, or already has a job, needs none.
      if (f.stage() !== INTERVIEW_STAGE || jobs.has(f.id)) return done("record_only");
      await done("restarted");
      launchAnalyst(p, f);
      return;
    }
    if (type === "gate1cap" && f) {
      await done("gate1_extra_run", [{ type: "gate1_extra_run", item: r.id }]);
      afterInterview(p, f);
      return;
    }
    return done("record_only");
  }

  /** Starts whatever a feature's stage needs, as at engine start (F-016 H-0182 resume effects). */
  function resumeFeature(p: Project, f: FeatureInterview): void {
    if (f.stage() === INTERVIEW_STAGE) launchAnalyst(p, f);
    else if (f.stage() === GATE1_STAGE) afterInterview(p, f);
    else if (f.stage() === READINESS_STAGE) startReadiness(p, f);
  }

  async function nextReadinessReport(p: Project, fid: string): Promise<number> {
    const existing = await p.state_repo!.list(`runs/${fid}/${READINESS_STAGE}`).catch(() => []);
    return existing.filter((e) => /\/orchestrator-\d+\.json$/.test(e.path)).length + 1;
  }

  /** F-016 FR-7: a feature at the readiness gate with no sign-off pending gets the gate, once at a time. */
  function startReadiness(p: Project, f: FeatureInterview): void {
    if (dead || shuttingDown || jobs.has(f.id) || !f.chainIntact || p.state !== "running" || ambiguous.has(f.id)) return;
    if (f.stage() !== READINESS_STAGE || f.state.readiness.signoff) return;
    const job: Job = { turns: null, done: Promise.resolve() };
    jobs.set(f.id, job);
    job.done = runReadiness(p, f)
      .catch((e) => log.warn(`${f.id}: the readiness gate stopped: ${engineWords(e)}`))
      .finally(() => {
        jobs.delete(f.id);
        if (!dead && !shuttingDown && f.stage() === INTERVIEW_STAGE) launchAnalyst(p, f);
      });
  }

  /** The gate failed: back to the interview with each failed check's evidence as data (FR-8). */
  async function readinessFailed(f: FeatureInterview, commit: string, checks: Check[], extra: Change[] = []): Promise<void> {
    const failed = checks.filter((c) => !c.passed).map((c) => ({ name: c.name, evidence: c.evidence }));
    await f.exclusive(() => f.append([
      { type: "readiness_result", passed: false, commit, checks },
      { type: "returned", return: { why: "readiness_failed", checks: failed } },
      { type: "stage", stage: INTERVIEW_STAGE },
    ], "readiness gate failed", extra));
    log.warn(`${f.id}: readiness gate failed (${failed.map((c) => c.name).join(", ")}); back to the interview.`);
  }

  /**
   * F-016 FR-7, FR-8, OQ-1 (c): code checks first; only if every one passes,
   * one orchestrator session judges checks 1 to 4, read-only, writing only
   * its report (SR-11). A pass files the Spec sign-off item.
   */
  async function runReadiness(p: Project, f: FeatureInterview): Promise<void> {
    let spec: string, specPath: string, version: number | null, commit: string;
    try {
      ({ spec, path: specPath, version, commit } = await branchSpec(p, f));
    } catch (e) {
      if (!(e instanceof SessionRefused)) throw e;
      const head = (await git.revParse(p.real!, `refs/heads/${f.state.branch}`).catch(() => null)) ?? "unknown";
      await readinessFailed(f, head, [{ name: "interview_checks", passed: false, evidence: `${e.message}.` }]);
      return;
    }
    const code: Check[] = [
      ...readinessChecks({ spec, specVersion: version ?? 0, state: f.state, chainIntact: f.chainIntact && !f.remoteRefused }),
      gate1Resolution(spec, f.state, maturityOf(p.manifest!)).check,
      ...structuralChecks(spec),
    ];
    if (code.some((c) => !c.passed)) {
      await readinessFailed(f, commit, code);
      return;
    }
    const m = p.manifest!;
    const rl = readinessLimits(p.limits!, m.billingMode);
    const model = p.models!.orchestrator;
    const instructions = p.sources!.instructions.get(READINESS_ROLE);
    const rt = o.agents;
    const notReady = !rt ? "no agent runtime is configured"
      : !rl || !model ? `this factory version (${m.factoryVersion}) has no orchestrator entry in ${!model ? MODELS_FILE : LIMITS_FILE}`
      : !instructions ? "the orchestrator role has no AGENT.md at factory.version or in the project's overrides" : null;
    if (notReady) {
      log.warn(`${f.id}: no readiness session started: ${notReady}.`);
      await f.exclusive(() => f.append([{ type: "readiness_session", status: "waiting", reason: `No readiness session started: ${notReady}.` }], "readiness waiting")).catch(() => undefined);
      return;
    }
    if (f.state.readiness.runs >= rl!.runsPerFeature) {
      await alert(p, `readinesscap:${f.id}:${f.state.readiness.runs}`, {
        title: `The readiness gate for ${f.id} reached its run limit`, feature: f.id,
        context: `${f.id} has had ${f.state.readiness.runs} readiness sessions, the most allowed (F-016 H-0184).`,
        impact: `${f.id} stays at the readiness gate.`, confirm: "Look at the readiness reports and the engine log", hold: "Keep the feature where it is", recommendation: "A",
      });
      return;
    }
    const n = await nextReadinessReport(p, f.id);
    const wt = await prepareWorktree(git, p.real!, path.join(path.dirname(worktreeDir(p, f.id)), `${f.id}-ready`), f.state.branch, undefined, commit);
    await populateWorktree(git, p.real!, commit, wt.path, wt.gitDir);
    const run = runs.start({ project: p.real!, feature: f.id, role: READINESS_ROLE, stage: READINESS_STAGE, worktree: wt.path });
    runs.update(run.id, { git_dir: wt.gitDir, last_commit: commit });
    await f.exclusive(() => f.append([{ type: "readiness_run", run: run.id, commit }], "readiness gate started"));
    const facts: RunFacts = { model: model! };
    try {
      const credential = modelCredentialFor(env, modelCredential);
      if (!credential) throw new SessionRefused("no model credential is stored or set");
      const policy = orchestratorPolicy(m.raw);
      const sdk = await rt!.sdk();
      const sources = p.sources!;
      const ident = { project: m.name, masterCommit: sources.masterCommit, skillsDigest: sources.skillsDigest };
      const image = await shared(images, `${ident.project}\0${ident.masterCommit}\0${ident.skillsDigest}`, () => ensureAgentImage(rt!.docker, rt!.dockerDir, path.join(home, "images"), ident, sources));
      proxyImage ??= baseImageId(rt!.docker);
      proxyImage.catch(() => (proxyImage = null));
      const proxyImageId = await proxyImage;
      const group = new SessionGroup({
        docker: rt!.docker, runId: run.id, project: m.name, agentImageId: image.id, proxyImageId, proxyScript: rt!.proxyScript,
        agentLimits: roleContainerLimits(p.limits!), proxyLimits: containerLimits(p.limits!.proxy), maxPageBytes: maxPageBytes(p.limits!),
        credential, log, ...(rt!.platform ? { platform: rt!.platform } : {}), ...(rt!.sleep ? { sleep: rt!.sleep } : {}),
      });
      let valid: ReadinessReport | null = null;
      facts.report_via = "structured_output";
      const result = await runReviewerSessions({
        sdk, docker: rt!.docker, group, policy, worktree: wt.path, outputSchema: reportOutputSchema(READINESS_ROLE),
        instructions: instructions!.text, caps: rl!.caps, model: model!,
        first: orchestratorTurn({ feature: f.id, specPath, specVersion: version, commit }),
        onUsed: (u) => void (dead || runs.update(run.id, { used: u })),
        billingCheck: () => billingMismatch(m.billingMode, m.name, env, modelCredential),
        check: async (structured) => {
          const shape = schemaErrors(structured, modelReport(READINESS_ROLE));
          const errors = shape.length ? shape : (() => {
            const v = validateReadinessReport(JSON.stringify(structured), { feature: f.id, commit, maxBytes: rl!.reportBytes });
            if (v.ok) valid = v.report;
            return v.ok ? [] : v.errors;
          })();
          return errors.length ? readinessCorrection(undefined, errors) : null;
        },
        verify: async (pol: RolePolicy) => {
          return commitWorktree({
            git, gitDir: wt.gitDir, worktree: wt.path, branch: f.state.branch, base: commit, policy: { ...pol, write: { allow: [], deny: [] } }, scanner, tmpDir,
            message: `${f.id}: readiness session (run ${run.id})`, limits: worktreeLimits(p.limits!),
          });
        },
        onBreach: async (breaches) => {
          await alert(p, `breach:${run.id}:${crypto.randomBytes(4).toString("hex")}`, {
            title: "Orchestrator changed files outside its report", feature: f.id,
            context: `The engine rejected readiness run ${run.id}: ${breaches.slice(0, 20).map((b) => `${b.path || "(history)"} (${b.reason})`).join(", ")} (F-016 SR-11). Nothing was committed.`,
            impact: "The readiness run is stopped.", confirm: "Look at the orchestrator's instructions and run the gate again", hold: "Keep the feature stopped", recommendation: "B",
          });
        },
        onSessionId: (id) => void (dead || runs.update(run.id, { session_id: id })),
        log,
      });
      if (dead) return;
      facts.usage = usage(result.outcome);
      const got = valid as ReadinessReport | null;
      if (result.invalid || !got) {
        // Fails closed (AC-14): nothing from the run is used; the gate runs again at the next engine start.
        runs.finish(run.id, "failed", result.invalid ?? "its report couldn't be read");
        log.warn(`${f.id}: the readiness report was refused (${result.invalid ?? "its report couldn't be read"}); nothing from the run is used and the gate runs again at the next start.`);
        await f.exclusive(() => f.append([{ type: "readiness_session", status: "stopped", reason: `The readiness session failed: ${result.invalid ?? "its report couldn't be read"}.` }], "readiness failed",
          [agentReport({ feature: f.id, stage: READINESS_STAGE, role: READINESS_ROLE, n, commit, outcome: "failed", summary: `The readiness session failed: ${result.invalid ?? "no report"}.`, body: { gate: "readiness", checks: code }, facts })]));
        return;
      }
      const judged: Check[] = got.checks.map((c) => ({ name: c.name, passed: c.passed, evidence: c.evidence }));
      const all = [...code, ...judged];
      const report = agentReport({
        feature: f.id, stage: READINESS_STAGE, role: READINESS_ROLE, n, commit, outcome: judged.every((c) => c.passed) ? "complete" : "partial",
        summary: got.summary, body: { gate: "readiness", checks: all }, facts,
      });
      runs.finish(run.id, "complete");
      if (!judged.every((c) => c.passed)) {
        await readinessFailed(f, commit, all, [report]);
        return;
      }
      const item = await fileSignoff(p, f, { specPath, version, commit, checks: judged });
      await f.exclusive(() => f.append([
        { type: "readiness_result", passed: true, commit, checks: all },
        { type: "signoff_filed", item, commit, version },
      ], "readiness gate passed", [report]));
      log.info(`${f.id}: readiness gate passed; Spec sign-off item ${item} filed.`);
    } catch (e) {
      if (dead) return;
      if (e instanceof SecretFound) {
        await alert(p, `secret:${crypto.randomBytes(8).toString("hex")}`, {
          title: "Readiness report refused: the secrets scan found a secret", feature: f.id,
          context: `The engine didn't record readiness run ${run.id}'s report because gitleaks flagged it.`,
          impact: `${f.id} stays at the readiness gate.`, confirm: "Rotate the secret if it was real", hold: "It was a false positive: no action", recommendation: "A",
        });
      }
      runs.finish(run.id, "failed", engineWords(e));
      throw e;
    } finally {
      await o.agents?.docker.run(["volume", "rm", "--force", runVolume(run.id)], { okCodes: [1] }).catch(() => undefined);
    }
  }

  /** F-016 FR-8: the Spec sign-off item; the orchestrator's evidence is outside text (F-011 SR-10). */
  async function fileSignoff(p: Project, f: FeatureInterview, a: { specPath: string; version: number | null; commit: string; checks: Check[] }): Promise<string> {
    const accepted = [...f.state.gate1.accepted.entries()].map(([n, item]) => `${findingRef(n)} accepted as a risk in ${item}`);
    const item: ItemInput = {
      kind: "spec", key: `signoff:${f.id}`, title: `${f.id} ${f.state.title}, spec v${a.version ?? "?"}`, priority: "high", blocking: true, created_by: "engine", feature: f.id,
      links: [{ kind: "file", ref: a.specPath }],
      effect: { type: "spec_signoff", feature: f.id, commit: a.commit, version: a.version },
      sections: {
        Summary: [{ engine: `${f.id} spec version ${a.version ?? "?"} (\`${a.specPath}\` at commit \`${a.commit.slice(0, 12)}\` on \`${f.state.branch}\`) passed the readiness gate. Approve starts development on exactly this commit; any later change to the branch needs a new sign-off.` }],
        Readiness: [
          { engine: "Every code check passed: interview checks, Gate 1 findings resolved, sections, requirements and criteria. The orchestrator's judgment of checks 1 to 4:" },
          { outside: a.checks.map((c) => `${c.name}: ${c.passed ? "passed" : "failed"}. ${c.evidence}`).join("\n"), author: "the orchestrator" },
        ],
        "Open items": [{ engine: accepted.length ? accepted.join("; ") + "." : "None." }],
      },
    };
    // FR-9: a sign-off item reopened because the branch moved is revised, not filed again.
    const open = await p.inbox!.openByKey(item.key!);
    if (open) {
      await p.inbox!.revise(open.id, item);
      return open.id;
    }
    return p.inbox!.file(item);
  }

  // F-011 FR-5: each project's inbox is read every poll while the engine runs.
  const polling = new AbortController();
  const pollers: Promise<void>[] = [];
  /** F-016 SR-7: failed effects, by item id; after 3 a Notice is filed and the item is left alone until the engine restarts. */
  const effectTries = new Map<string, number>();
  /** Gate 2 M1: answers this run recorded itself, by project, item and entry; any other pending answer is checked on GitHub first. */
  const recordedHere = new Set<string>();
  // The whole entry, not its time, so a forged entry beside a real one is never taken for it (Gate 2 re-review R1).
  const answerKey = (p: Project, r: Recorded): string => `${p.name}/${r.id}/${sha256Hex(JSON.stringify(r.entry))}`;

  /**
   * F-021 FR-9: an answer given in the console is carried out at once, by the
   * same code as one from GitHub. The poll and the console take turns, so no
   * answer's effect runs twice.
   */
  const applying = new Map<Project, Promise<void>>();
  function applyAnswers(p: Project): Promise<void> {
    const run = (applying.get(p) ?? Promise.resolve()).then(() => applyAnswersNow(p));
    applying.set(p, run.catch(() => undefined));
    return run;
  }

  async function answeredInConsole(p: Project, r: ConsoleResult): Promise<ConsoleResult> {
    if ("recorded" in r) {
      recordedHere.add(answerKey(p, r.recorded));
      await applyAnswers(p).catch((e) => log.warn(`${p.name}: a console answer's effect wasn't applied now (${engineWords(e)}); the next poll tries again.`));
    }
    return r;
  }

  /** Carries out every recorded answer without an effect yet: new ones, ones a crash left, and ones that failed before (FR-2, SR-7). */
  async function applyAnswersNow(p: Project): Promise<void> {
    for (const r of await p.inbox!.pendingEffects()) {
      if (dead || polling.signal.aborted) return;
      // A stopped project applies only the pins approval; other answers wait for its next start.
      if (p.state !== "running" && r.record.effect?.type !== "pins") continue;
      const id = r.record.id;
      const tries = effectTries.get(id) ?? 0;
      if (tries >= 3) continue;
      try {
        if (!recordedHere.has(answerKey(p, r))) {
          // Not connected yet: the answer waits, since it can't be checked.
          if (!p.inbox!.connected) continue;
          if (!(await p.inbox!.verify(r))) {
            log.warn(`${id}: the recorded answer doesn't match GitHub, so it was not carried out (Gate 2 M1).`);
            await alert(p, `unverified:${id}@${r.entry.at}`, {
              title: `An answer on ${id} in factory/state isn't on GitHub`, ...(r.record.feature ? { feature: r.record.feature } : {}),
              context: `factory/state records an owner answer on ${id} at ${r.entry.at} that the engine didn't read itself in this run, and the issue on GitHub doesn't show it: the owner's reaction or command, or its confirmation, isn't there (F-016 Gate 2 M1). It was not carried out.`,
              impact: `Nothing changed. If you did answer ${id}, answer it again on its issue.`,
              confirm: "Investigate who wrote factory/state", hold: "Leave it as it is", recommendation: "A",
            });
            await p.inbox!.effectDone(id, "unverified");
            continue;
          }
          recordedHere.add(answerKey(p, r));
        }
        await onAnswer(p, r);
        effectTries.delete(id);
      } catch (e) {
        // An unreachable GitHub during the check isn't a failed effect: the answer waits for the next poll.
        if (e instanceof GitHubUnreachable) continue;
        effectTries.set(id, tries + 1);
        log.warn(`${id}: its effect wasn't applied (${engineWords(e)}); try ${tries + 1} of 3.`);
        if (tries + 1 === 3) {
          await p.inbox!.file({
            kind: "notice", title: `${id}: your answer couldn't be carried out`, priority: "high", blocking: false, created_by: "engine",
            ...(r.record.feature ? { feature: r.record.feature } : {}),
            sections: { Details: [{ engine: `The engine recorded your answer on ${id} but failed 3 times to carry it out (F-016 SR-7). Nothing changed: ${r.record.feature ?? "the project"} stays where it is. The engine tries once more when it restarts; the engine log has the reason.` }] },
            private: [{ name: "Engine log", text: logLines(id) || "The engine log has no lines for this item from today or yesterday." }],
          }).catch(() => undefined);
        }
      }
    }
  }

  async function pollInbox(p: Project): Promise<void> {
    while (!polling.signal.aborted && !dead && (p.state === "running" || p.pinsWaiting)) {
      try {
        for (const r of await p.inbox!.poll()) recordedHere.add(answerKey(p, r));
        await applyAnswers(p);
      } catch (e) {
        log.warn(`${p.name}: the inbox couldn't be read this poll (${engineWords(e)}); it is read again at the next.`);
      }
      await clock.sleep(o.inboxPollMs ?? INBOX_POLL_MS, polling.signal);
    }
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
        documentText: () => documentText(p, f),
        maturity: maturityOf(p.manifest!),
        ...(research ? { research } : {}),
        onSpecReady: (passed) => {
          if (passed && !dead && record.run(runId)?.status === "running") runs.finish(runId, "complete");
          // The analyst's session ends with its turn; its changes are then committed and checked.
          if (passed) jobs.get(fid)?.turns?.close();
        },
        reportFor: async (r): Promise<Change[]> => {
          const n = await nextReport(p, fid);
          // Never the worktree's own .git link, which the agent can rewrite (Gate 2, L2): the git dir
          // recorded when the worktree was made, else the feature branch in the project repo.
          const gitDir = record.run(runId)?.git_dir;
          const commit = (gitDir
            ? await git.out(worktree, ["--git-dir", gitDir, "--work-tree", worktree, "rev-parse", "--verify", "HEAD^{commit}"]).catch(() => null)
            : await git.revParse(p.real!, `refs/heads/${f.state.branch}`).catch(() => null)) ?? "unknown";
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
      polling.abort();
      for (const j of jobs.values()) j.turns?.close();
      for (const p of projects) {
        p.sessions?.closeAll();
        await p.listener?.close().catch(() => undefined);
      }
      await git.closeReaders();
      done();
    },
    async sync() {
      for (const p of projects) {
        if (p.state !== "running" || dead) continue;
        p.state_repo?.forgetHead();
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
    models(project) {
      return { ...running(project).models! };
    },
    endpoints: () => endpointSvc.statuses(),
    endpointsProblem: () => endpointSvc.fileProblem(),
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
        polling.abort();
        await Promise.all(pollers);
        for (const j of jobs.values()) j.turns?.close();
        await Promise.all([...jobs.values()].map((j) => j.done));
        for (const p of projects) {
          p.sessions?.closeAll();
          await p.listener?.close().catch(() => undefined);
          if (p.state_repo) fs.rmSync(path.join(p.state_repo.factoryDir, ENGINE_JSON), { force: true });
        }
        await git.closeReaders();
        // A notification still showing runs in the engine folder; Windows can't remove a folder a process works in.
        await notify.settled();
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
    if (!p || !f || ambiguous.has(f.id)) continue;
    if (r.role === REVIEWER_ROLE) {
      // F-008 FR-10: a Gate 1 run resumes as an analyst run does.
      const plan = runs.resume(r.id);
      if (plan.mode === "failed") {
        log.warn(`Run ${r.id} (${f.id}, Gate 1) failed: ${plan.run.reason}.`);
        // FR-10: the failure is also recorded in the agent report and the transcript.
        if (f.stage() === GATE1_STAGE) {
          await endGate1(p, f, r.id, await nextGate1Report(p, f.id), "failed", plan.run.reason ?? "it was interrupted too often", { model: p.models?.["security-reviewer"] ?? "" }, r.last_commit ?? "")
            .catch((e) => log.warn(`${f.id}: Gate 1 run ${r.id}'s failure wasn't recorded (${engineWords(e)}).`));
        }
      } else if (f.stage() === GATE1_STAGE) afterInterview(p, f, plan);
      else runs.finish(r.id, "failed", "the feature left Security Gate 1");
      continue;
    }
    if (r.role !== "requirements-analyst") continue;
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
  // F-008 FR-1: features parked at Gate 1 start it; one sent back with findings gets its analyst, once.
  for (const p of projects) {
    if (p.state !== "running") continue;
    for (const f of p.features.values()) {
      if (ambiguous.has(f.id) || jobs.has(f.id)) continue;
      if (f.stage() === GATE1_STAGE) afterInterview(p, f);
      // F-016 FR-7: a gate that failed closed, or was cut off by a stop, runs again at start.
      else if (f.stage() === READINESS_STAGE) startReadiness(p, f);
      else if (f.stage() === INTERVIEW_STAGE && f.state.gate1.pending && f.state.gate1.reportAt) {
        const since = f.state.gate1.reportAt;
        const tried = record.runs().some((r) => r.feature === f.id && r.project === p.real && r.role === "requirements-analyst" && r.started_at >= since);
        if (!tried) launchAnalyst(p, f);
      }
      if (f.stage() === INTERVIEW_STAGE && !jobs.has(f.id)) {
        // FR-13: a feature whose analyst stopped before this engine (or before this rule) would wait forever.
        const last = record.runs().filter((r) => r.feature === f.id && r.project === p.real && r.role === "requirements-analyst").sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
        if (last?.status === "failed") void offerRerun(p, f, last.id, last.reason ?? "the run failed");
      }
    }
  }
  for (const p of projects) if ((p.state === "running" || p.pinsWaiting) && p.inbox?.connected) pollers.push(pollInbox(p));
  return handle;
}
