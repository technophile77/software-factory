// The one place that knows how the developer's engine is started and driven
// in-process (engine/src/index.ts, engine README "In-process API"). Everything
// else in this suite talks to the engine only through the control channel,
// files, the fake GitHub server and the fake gitleaks.
// See docs/features/F-007-test-plan.md, "Harness assumptions", and the
// F-007 test report for the seams the API doesn't offer yet.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The clock the suite drives. The engine's Clock is `{ now, sleep(ms, signal?) }`. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The engine's CredentialStore. */
export interface CredentialStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** The interview tools of one feature, called by name. */
export interface InterviewTools {
  call(tool: string, args: unknown): Promise<unknown>;
}

export interface EngineOptions {
  clock: Clock;
  env: Record<string, string>;
  github: { webBaseUrl: string; apiBaseUrl: string };
  credentialStore: CredentialStore;
  gitleaks: { path: string; sha256: string };
  gitPath: string;
  paths: {
    /** The owner's clone of the master repo; holds factory-projects.local.yaml. */
    masterRepo: string;
    /** Engine home: pinned keys, engine record, logs (`<stateDir>/logs`). */
    stateDir: string;
    runtimeDir: string;
  };
  /** Called at start for each interrupted analyst run the engine resumes (FR-14). */
  resumeAnalyst?: (r: ResumedRun) => void;
}

/** A run in the engine record (FR-14 bookkeeping). */
export interface RunInfo {
  id: string;
  feature: string;
  role: string;
  status: string;
  resumes: number;
  reason?: string;
  [k: string]: unknown;
}

export interface ResumedRun {
  feature: string;
  worktree: string;
  tools: InterviewTools;
  plan: { mode: string; run: RunInfo };
}

export interface ProjectState {
  path: string;
  name?: string | null;
  state: string;
  reason?: string;
}

export interface ConfirmResult {
  approval?: { user_code: string; verification_uri: string; expires_at: string };
  done: Promise<unknown>;
}

/** What the suite needs from a running engine. */
export interface EngineHandle {
  stop(): Promise<void>;
  /** Stop as if the process were killed. */
  crash(): Promise<void>;
  projects(): Promise<ProjectState[]>;
  /** Every run in the engine record. */
  runs(): Promise<RunInfo[]>;
  /** The SR-5 confirmation command, run in-process against the fake GitHub. */
  confirmProject(configRepoPath: string): Promise<ConfirmResult>;
  /** The analyst's tools for a feature, reading the spec from `worktree`. */
  interviewTools(feature: string, worktree: string): InterviewTools;
  /** The analyst's next turn message (owner replies, framed), or null. */
  takeTurn(feature: string): Promise<string | null>;
  sync?(): Promise<void>;
  flush?(): Promise<void>;
}

/** Credential names the engine reads (README, "secret set"). */
export const CREDENTIAL_NAMES = {
  model: "model-credential",
  factoryToken: (project: string) => `factory-token/${project}`,
};

const ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

export const ENGINE_NOT_AVAILABLE = "engine not available";

/** A seam the suite needs and the engine's API doesn't offer. Tests that hit
 * it fail with this message, never pass. */
export class MissingSeam extends Error {
  constructor(what: string) {
    super(`missing seam: ${what}`);
  }
}

async function load(): Promise<Record<string, any>> {
  if (!existsSync(ENTRY)) {
    throw new Error(`${ENGINE_NOT_AVAILABLE}: ${ENTRY} does not exist (F-007 milestone 1 not on this branch)`);
  }
  try {
    return (await import(/* @vite-ignore */ ENTRY)) as Record<string, any>;
  } catch (e) {
    throw new Error(`${ENGINE_NOT_AVAILABLE}: loading ${ENTRY} failed: ${(e as Error).message}`);
  }
}

export async function startEngine(o: EngineOptions): Promise<EngineHandle> {
  const mod = await load();
  if (typeof mod.startEngine !== "function") throw new Error(`${ENGINE_NOT_AVAILABLE}: no startEngine export`);
  const real = await mod.startEngine({
    masterRepo: o.paths.masterRepo,
    engineHome: o.paths.stateDir,
    runtimeDir: o.paths.runtimeDir,
    gitleaks: { path: o.gitleaks.path, expectSha256: o.gitleaks.sha256 },
    gitPath: o.gitPath,
    credentials: o.credentialStore,
    github: { webBase: o.github.webBaseUrl, apiBase: o.github.apiBaseUrl },
    clock: o.clock,
    env: o.env,
    push: true,
    resumeAnalyst: o.resumeAnalyst
      ? (r: { feature: string; worktree: string; tools: Record<string, any>; plan: ResumedRun["plan"] }) =>
          o.resumeAnalyst!({ ...r, tools: toolsByName(r.tools) })
      : undefined,
  });
  return {
    stop: () => real.stop(),
    crash: () => real.crash(),
    projects: async () => real.projects as ProjectState[],
    runs: async () => {
      const { EngineRecord } = await import(/* @vite-ignore */ srcModule("state/record"));
      return new EngineRecord(o.paths.stateDir).runs() as RunInfo[];
    },
    confirmProject: (projectPath) => confirmCommand(o, projectPath),
    interviewTools: (feature, worktree) => toolsByName(real.interviewTools(feature, worktree)),
    takeTurn: async (feature) => {
      const f = real.feature(feature);
      if (!f) return null;
      const turn = await f.takeTurn();
      return turn ? turn.message : null;
    },
  };
}

function toolsByName(t: Record<string, any>): InterviewTools {
  return {
    call: async (tool: string, args: unknown) => {
      if (typeof t[tool] !== "function") throw Object.assign(new Error(`no tool ${tool}`), { code: "no_such_tool" });
      return t[tool](args);
    },
  };
}

const srcModule = (p: string) => fileURLToPath(new URL(`../../src/${p}.ts`, import.meta.url));

/**
 * The SR-5 `factory-engine confirm` command. The in-process API doesn't offer
 * it and the CLI can't be pointed at a fake GitHub or clock, so this builds
 * it exactly as engine/src/cli.ts does, swapping only the GitHub base URLs
 * and the clock. The owner's answer to "type the project name" is the name
 * the prompt shows; the device code is the one the command tells the owner.
 */
async function confirmCommand(o: EngineOptions, projectPath: string): Promise<ConfirmResult> {
  const [{ confirmProject }, { PinStore }, { Git }, { HttpGitHub }, { FileLogger }, { realOsApi }, { Children }] = await Promise.all(
    ["config/confirm", "config/pins", "git", "github", "log", "os/ffi", "proc"].map((m) => import(/* @vite-ignore */ srcModule(m))),
  );
  const log = new FileLogger(join(o.paths.stateDir, "logs"), o.clock, () => undefined);
  const said: string[] = [];
  let codeSeen: (c: string) => void = () => undefined;
  const code = new Promise<string>((r) => (codeSeen = r));
  const done: Promise<unknown> = confirmProject({
    masterRepo: o.paths.masterRepo,
    projectPath,
    git: new Git({ gitPath: o.gitPath, homeDir: join(o.paths.stateDir, "git"), children: new Children() }),
    github: new HttpGitHub({ webBase: o.github.webBaseUrl, apiBase: o.github.apiBaseUrl, log }),
    pins: new PinStore(o.paths.stateDir),
    os: realOsApi(),
    clock: o.clock,
    log,
    io: {
      say: (line: string) => {
        said.push(line);
        const m = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(line);
        if (m) codeSeen(m[1]!);
      },
      ask: async (q: string) => /\(([^)]+)\) to confirm/.exec(q)?.[1] ?? "",
    },
  }).then((ok: boolean) => {
    if (!ok) throw new Error(`not confirmed: ${said.join(" | ")}`);
    return ok;
  });
  done.catch(() => undefined);
  const first = await Promise.race([code.then((c) => ({ c })), done.then(() => ({ c: undefined }), () => ({ c: undefined }))]);
  return {
    approval: first.c ? { user_code: first.c, verification_uri: "https://github.com/login/device", expires_at: "" } : undefined,
    done,
  };
}

export function logDir(stateDir: string) {
  return join(stateDir, "logs");
}

/** Normalized result of an interview tool call: the contract's error names
 * are `one_at_a_time`, `invalid`, `limit`, `unknown_item`, `wrong_status`. */
export type ToolOutcome = { ok: true; value: any } | { ok: false; code: string; message: string };

export async function callTool(tools: InterviewTools, tool: string, args: unknown): Promise<ToolOutcome> {
  try {
    const v: any = await tools.call(tool, args);
    if (v && typeof v === "object" && v.ok === true && "result" in v) return { ok: true, value: v.result };
    if (v && typeof v === "object" && v.ok === false && v.error) {
      return { ok: false, code: String(v.error.code), message: String(v.error.message ?? "") };
    }
    return { ok: true, value: v };
  } catch (e: any) {
    const code = e?.code ?? e?.error?.code;
    if (typeof code !== "string") throw e;
    return { ok: false, code, message: String(e?.message ?? "") };
  }
}

/** Readiness checks 5 and 6 by name. The contract names no check strings,
 * so this matches on the number or the subject. */
export function readinessCheck(
  checks: Array<{ name: string; passed: boolean; evidence: unknown }>,
  n: 5 | 6,
): { name: string; passed: boolean; evidence: unknown } {
  const pattern = n === 5 ? /\b5\b|assumption/i : /\b6\b|decision|deferred|question/i;
  const found = checks.find((c) => pattern.test(c.name));
  if (!found) throw new Error(`readiness check ${n} not found in ${JSON.stringify(checks.map((c) => c.name))}`);
  return found;
}
