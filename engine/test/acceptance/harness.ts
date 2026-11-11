// The one place that knows how the developer's engine is started and driven
// in-process. Everything else in this suite talks to the engine only through
// the control channel, files, the fake GitHub server and the fake gitleaks.
// When the real API differs, adapt this file and nothing else
// (docs/features/F-007-test-plan.md, "Harness assumptions").

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Injected clock. The engine must take all time from it: now(), timers,
 * device-flow polling, the 30-minute idle and 2-hour session limits, and
 * `wait_s`. Tests advance it by hand. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number): Promise<void>;
}

/** Injected OS credential store (SR-20). The real one goes through koffi. */
export interface CredentialStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The interview tools (Interview tools v1.0) as engine functions, one object
 * per session with its project and feature fixed. Milestone 2 serves the same
 * functions to the analyst through the in-process MCP server `factory`. */
export interface InterviewTools {
  call(tool: string, args: unknown): Promise<unknown>;
}

/** Where the engine hands work to the requirements analyst. Milestone 2
 * replaces the test's fake with an Agent SDK session in a container. */
export interface AnalystSeam {
  start(ctx: AnalystStart): void | Promise<void>;
  /** One turn's message: the owner's reply wrapped in the engine's frame. */
  turn(ctx: { feature: string; message: string }): void | Promise<void>;
}
export interface AnalystStart {
  project?: string;
  feature: string;
  /** The analyst's worktree on the host (its branch of the feature). */
  worktree: string;
  tools: InterviewTools;
  resume?: boolean;
}

export interface EngineOptions {
  clock: Clock;
  /** The engine's whole environment; it must not read process.env. */
  env: Record<string, string>;
  github: {
    /** Stands for https://github.com (device flow and git over HTTPS). */
    webBaseUrl: string;
    /** Stands for https://api.github.com (`GET /user`, `GET /repos/...`). */
    apiBaseUrl: string;
  };
  credentialStore: CredentialStore;
  /** Absolute path of the gitleaks binary and the SHA-256 it must have (the
   * test pin replaces the release pin). */
  gitleaks: { path: string; sha256: string };
  /** Absolute path of `git`. */
  gitPath: string;
  paths: {
    /** The owner's clone of the master factory repo. */
    masterRepo: string;
    /** `factory-projects.local.yaml` in that clone (H-0081). */
    projectsFile: string;
    /** Engine-only state outside every repo: pinned keys, chain heads. */
    stateDir: string;
    /** Owner-only log folder. */
    logDir: string;
    /** Where the engine makes its owner-only socket directory. */
    runtimeDir: string;
    /** Local clone of each managed repo, by its `repos[].url`. */
    repoClones: Record<string, string>;
  };
  analyst: AnalystSeam;
}

export interface ProjectState {
  /** Config repo path as listed in the projects file. */
  path: string;
  name?: string;
  /** "running" when the project runs; anything else means it doesn't. */
  state: string;
}

export interface ConfirmResult {
  /** Device sign-in the owner must approve, when the engine asks for one. */
  approval?: { user_code: string; verification_uri: string; expires_at: string };
  /** Settles when the confirmation succeeds (resolves) or fails (rejects). */
  done: Promise<unknown>;
}

export interface EngineHandle {
  /** Graceful stop, as `engine.shutdown`. */
  stop(): Promise<void>;
  /** Stop as if the process were killed: no shutdown bookkeeping. */
  crash(): Promise<void>;
  /** Each listed project and whether it runs. */
  projects(): Promise<ProjectState[]>;
  /** The engine command where the owner confirms new or changed pinned keys
   * (SR-5). */
  confirmProject(configRepoPath: string): Promise<ConfirmResult>;
  /** Optional: fetch `factory/state` now. Without it the suite restarts the
   * engine, which must fetch at start. */
  sync?(): Promise<void>;
  /** Optional: resolve once queued commits and pushes are done. */
  flush?(): Promise<void>;
}

/** Credential store names the fixtures seed. */
export const CREDENTIAL_NAMES = {
  model: "software-factory/model-credential",
  factoryToken: "software-factory/factory-token",
};

const ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

export const ENGINE_NOT_AVAILABLE = "engine not available";

type StartEngine = (o: EngineOptions) => Promise<EngineHandle>;

export async function loadStartEngine(): Promise<StartEngine> {
  if (!existsSync(ENTRY)) {
    throw new Error(`${ENGINE_NOT_AVAILABLE}: ${ENTRY} does not exist (F-007 milestone 1 not on this branch)`);
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ ENTRY)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${ENGINE_NOT_AVAILABLE}: loading ${ENTRY} failed: ${(e as Error).message}`);
  }
  if (typeof mod.startEngine !== "function") {
    throw new Error(`${ENGINE_NOT_AVAILABLE}: ${ENTRY} has no startEngine export`);
  }
  return mod.startEngine as StartEngine;
}

export async function startEngine(options: EngineOptions): Promise<EngineHandle> {
  const start = await loadStartEngine();
  return start(options);
}

/** Normalized result of an interview tool call: the contract's error names
 * are `one_at_a_time`, `invalid`, `limit`, `unknown_item`, `wrong_status`. */
export type ToolOutcome = { ok: true; value: any } | { ok: false; code: string; message: string };

export async function callTool(tools: InterviewTools, tool: string, args: unknown): Promise<ToolOutcome> {
  try {
    const v: any = await tools.call(tool, args);
    if (v && typeof v === "object" && v.error && typeof v.error.code === "string") {
      return { ok: false, code: v.error.code, message: String(v.error.message ?? "") };
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
