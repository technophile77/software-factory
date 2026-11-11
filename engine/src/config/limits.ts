import YAML from "yaml";
import type { AgentLimitsConfig } from "../agent/analyst";
import type { SessionCaps } from "../agent/session";
import type { WorktreeLimits } from "../agent/worktree-commit";
import type { ContainerLimits } from "../docker/plan";
import type { Git } from "../git";
import type { Manifest } from "./manifest";
import { ConfigError } from "./paths-file";

/** H-0087: the master defaults, shipped with the engine in the master repo. */
export const LIMITS_FILE = "engine/config/limits.yaml";

const MiB = 1024 * 1024;
const MAX_FILE = 64 * 1024;

type Kind = "int" | "num";
const CONTAINER = { cpus: "num", memory_mib: "num", pids: "int", tmp_mib: "num" } as const;
const SESSION = { turns: "int", output_tokens: "int", dollars: "num", wall_time_minutes: "int", ...CONTAINER } as const;

/** Every key the file and a manifest's `limits:` may hold. `num` keys take fractions; `int` keys don't. */
export const LIMIT_KEYS = {
  analyst: SESSION,
  web_reader: SESSION,
  proxy: CONTAINER,
  research_web: { per_question: "int", per_session: "int" },
  fetch_page: { max_download_mib: "num", max_chars: "int" },
  research_result: { summary_chars: "int", max_sources: "int" },
  worktree_commit: { max_files: "int", max_total_mib: "num", max_file_mib: "num" },
} as const satisfies Record<string, Record<string, Kind>>;

type Keys = typeof LIMIT_KEYS;
export type Limits = { [S in keyof Keys]: { [K in keyof Keys[S]]: number } };
export type PartialLimits = { [S in keyof Keys]?: { [K in keyof Keys[S]]?: number } };
type Section = keyof Keys;

export class LimitsError extends ConfigError {
  override name = "LimitsError";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Checks a limits document: known sections and keys only, each a positive
 * finite number, whole where the key needs it. `full` requires every key (the
 * master file); a manifest block may name any subset.
 */
export function parseLimits(doc: unknown, where: string, full: true): Limits;
export function parseLimits(doc: unknown, where: string, full: false): PartialLimits;
export function parseLimits(doc: unknown, where: string, full: boolean): Limits | PartialLimits {
  const bad = (m: string): never => {
    throw new LimitsError(`${where}: ${m}`);
  };
  if (!isObj(doc)) return bad("must be a mapping");
  const out: Record<string, Record<string, number>> = {};
  for (const s of Object.keys(doc)) if (!own(LIMIT_KEYS, s)) bad(`unknown section '${s}'`);
  for (const [s, keys] of Object.entries(LIMIT_KEYS) as Array<[string, Record<string, Kind>]>) {
    if (!own(doc, s)) {
      if (full) bad(`'${s}' is missing`);
      continue;
    }
    const sec = doc[s];
    if (!isObj(sec)) return bad(`'${s}' must be a mapping`);
    for (const k of Object.keys(sec)) if (!own(keys, k)) bad(`unknown key '${s}.${k}'`);
    out[s] = {};
    for (const [k, kind] of Object.entries(keys)) {
      if (!own(sec, k)) {
        if (full) bad(`'${s}.${k}' is missing`);
        continue;
      }
      const v = sec[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`'${s}.${k}' must be a positive number`);
      if (kind === "int" && !Number.isSafeInteger(v)) bad(`'${s}.${k}' must be a whole number`);
      out[s]![k] = v as number;
    }
  }
  return out as Limits | PartialLimits;
}

/**
 * Reads the master defaults from `commit`, the master clone commit the
 * project's `factory.version` names (spec v30), never a working tree.
 * Missing or invalid means no defaults, and the project doesn't run.
 */
export async function readDefaultLimits(git: Git, masterRepo: string, commit: string): Promise<Limits> {
  let raw: Buffer | null;
  try {
    raw = await git.readBlob(masterRepo, commit, LIMITS_FILE);
  } catch {
    throw new LimitsError(`${LIMITS_FILE} in the master repo is not a regular file.`);
  }
  if (!raw) throw new LimitsError(`${LIMITS_FILE} is missing from master commit ${commit.slice(0, 12)}.`);
  if (raw.length > MAX_FILE) throw new LimitsError(`${LIMITS_FILE} is over 64 KiB.`);
  let doc: unknown;
  try {
    doc = YAML.parse(raw.toString("utf8"), { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    throw new LimitsError(`${LIMITS_FILE} is not valid YAML.`);
  }
  return parseLimits(doc, LIMITS_FILE, true);
}

/** The manifest's optional `limits:` block (Project manifest v1.4), or null when it has none. */
export function manifestLimits(raw: unknown): PartialLimits | null {
  if (!isObj(raw) || !own(raw, "limits")) return null;
  return parseLimits(raw.limits, "factory-project.yaml limits", false);
}

/**
 * Project manifest v1.4: the lower of the two values for each key. `above`
 * lists every key the project set higher than the default; the caller refuses
 * such a project, so the lower value is never quietly used in its place.
 */
export function mergeLimits(defaults: Limits, project: PartialLimits | null): { limits: Limits; above: string[] } {
  const limits = structuredClone(defaults);
  const above: string[] = [];
  for (const [s, sec] of Object.entries(project ?? {}) as Array<[Section, Record<string, number>]>) {
    const target = limits[s] as Record<string, number>;
    for (const [k, v] of Object.entries(sec)) {
      if (v > target[k]!) above.push(`${s}.${k}`);
      else target[k] = v;
    }
  }
  return { limits, above };
}

const bytes = (mib: number) => Math.max(1, Math.floor(mib * MiB));

/** SR-18 session caps. Dollars apply in API key (tokens) mode only (H-0087). */
export function sessionCaps(l: Limits["analyst"], billing: Manifest["billingMode"]): SessionCaps {
  return {
    maxTurns: l.turns,
    maxOutputTokens: l.output_tokens,
    ...(billing === "tokens" ? { maxBudgetUsd: l.dollars } : {}),
    wallTimeMs: l.wall_time_minutes * 60_000,
  };
}

export function containerLimits(l: Limits["proxy"]): ContainerLimits {
  return { cpus: l.cpus, memoryBytes: bytes(l.memory_mib), pids: l.pids, tmpBytes: bytes(l.tmp_mib) };
}

export function agentLimits(l: Limits, billing: Manifest["billingMode"]): AgentLimitsConfig {
  return {
    analyst: sessionCaps(l.analyst, billing),
    reader: sessionCaps(l.web_reader, billing),
    research: { perQuestion: l.research_web.per_question, perSession: l.research_web.per_session },
    page: { maxChars: l.fetch_page.max_chars },
    summaryMaxChars: l.research_result.summary_chars,
    maxSources: l.research_result.max_sources,
  };
}

/** The container limits for each agent role, keyed as the sandbox looks them up. */
export function roleContainerLimits(l: Limits): Record<string, ContainerLimits> {
  return { "requirements-analyst": containerLimits(l.analyst), "web-reader": containerLimits(l.web_reader) };
}

export function maxPageBytes(l: Limits): number {
  return bytes(l.fetch_page.max_download_mib);
}

export function worktreeLimits(l: Limits): WorktreeLimits {
  return { maxFiles: l.worktree_commit.max_files, maxTotalBytes: bytes(l.worktree_commit.max_total_mib), maxFileBytes: bytes(l.worktree_commit.max_file_mib) };
}
