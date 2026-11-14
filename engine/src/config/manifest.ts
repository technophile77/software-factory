import YAML from "yaml";
import { MANIFEST_FILE, RAPID_PROTOTYPE } from "../constants";
import { Git } from "../git";
import { RoleAssignmentError, parseRoleAssignments } from "./endpoint-roles";
import { ENDPOINT_NAME_RE } from "./models";
import { ConfigError } from "./paths-file";
import { checkConfig, manifestFile } from "../schemas/config";

/**
 * How often the owner signs in to GitHub to open interview sessions
 * (F-018 FR-15): `never`, once per `engine_start`, every `session`, or once
 * per `hours` hours.
 */
export type SignInEvery = "never" | "engine_start" | "session" | "hours";
export interface InterviewSignIn {
  every: SignInEvery;
  hours?: number;
}
const SIGN_IN_EVERY: readonly SignInEvery[] = ["never", "engine_start", "session", "hours"];
export const MAX_SIGN_IN_HOURS = 168;

/** The setting in force: the manifest's, or the level's default when it has none. */
export function interviewSignIn(m: Pick<Manifest, "maturity" | "interviewSignIn">): InterviewSignIn {
  return m.interviewSignIn ?? { every: m.maturity === RAPID_PROTOTYPE ? "never" : "session" };
}

export interface RepoOwner {
  login: string;
  id: number;
}

export interface Manifest {
  name: string;
  /** The `main` commit the manifest was read from. */
  commit: string;
  enabled: boolean;
  owner: { github_id: number; oauth_client_id: string };
  allowed_repo_owners: RepoOwner[];
  repos: Array<{ name: string; url: string; owner: string; repo: string }>;
  billingMode: "subscription" | "tokens";
  /** SR-8: the model endpoints (by name) this project's code may be sent to; whether each exists is checked at run time. */
  endpoints: string[];
  /** The master factory tag the project uses (spec v30: skills, AGENT.md and limit defaults come from its commit). */
  factoryVersion: string;
  /** The project's maturity level (H-0008); `rapid-prototype` relaxes interview approval (F-018 FR-13). */
  maturity: string;
  /** `settings.interview_sign_in` as written; null when absent (F-018 FR-15). */
  interviewSignIn: InterviewSignIn | null;
  /** The parsed document, from which a session's Role policy is resolved when it starts. */
  raw?: unknown;
}

const MAX_MANIFEST = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const REPO_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * Reads `factory-project.yaml` from the config repo's `main` commit, never the
 * working tree, which can hold an unmerged edit (SR-5).
 */
export async function readManifest(git: Git, repo: string): Promise<Manifest> {
  const commit = await git.revParse(repo, "refs/heads/main");
  if (!commit) throw new ConfigError("The config repo has no main branch.");
  let raw: Buffer | null;
  try {
    raw = await git.readBlob(repo, commit, MANIFEST_FILE);
  } catch {
    throw new ConfigError(`${MANIFEST_FILE} on main is not a regular file.`);
  }
  if (!raw) throw new ConfigError(`main has no ${MANIFEST_FILE}.`);
  if (raw.length > MAX_MANIFEST) throw new ConfigError(`${MANIFEST_FILE} is over 1 MiB.`);
  let doc: unknown;
  try {
    doc = YAML.parse(raw.toString("utf8"), { uniqueKeys: true, maxAliasCount: 100 });
  } catch {
    throw new ConfigError(`${MANIFEST_FILE} is not valid YAML.`);
  }
  const m = validateManifest(doc, commit);
  // F-020 FR-12: after the detailed rules, the outline: an unknown or misplaced key is refused with its path.
  checkConfig(MANIFEST_FILE, doc, manifestFile);
  return m;
}

/**
 * Project manifest v1.3 as far as this increment uses it: the required keys,
 * and the H-0080 owner and authorization keys checked exactly. The engine
 * refuses to run a project without `enabled` or `owner` (FR-2).
 */
export function validateManifest(doc: unknown, commit: string): Manifest {
  const bad = (m: string): never => {
    throw new ConfigError(`${MANIFEST_FILE}: ${m}`);
  };
  if (!isObj(doc)) return bad("not a mapping");
  if (doc.schema !== "factory-project/1.0") bad("schema must be factory-project/1.0");
  if (typeof doc.name !== "string" || !NAME_RE.test(doc.name)) bad("name must be letters, digits, '.', '_' or '-'");
  if (!isObj(doc.factory) || typeof doc.factory.version !== "string" || !doc.factory.version) bad("factory.version is required");
  if (typeof doc.maturity !== "string" || !doc.maturity) bad("maturity is required");
  if (!Array.isArray(doc.repos) || doc.repos.length === 0) bad("repos must list at least one repo");

  if (doc.enabled === undefined) bad("enabled is required to run (onboarding writes false)");
  if (typeof doc.enabled !== "boolean") bad("enabled must be true or false");
  if (!isObj(doc.owner)) return bad("owner is required to run");
  const ownerKeys = Object.keys(doc.owner).sort().join();
  if (ownerKeys !== "github_id,oauth_client_id") bad("owner must have exactly github_id and oauth_client_id");
  if (!isPosInt(doc.owner.github_id)) bad("owner.github_id must be a positive integer");
  if (typeof doc.owner.oauth_client_id !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(doc.owner.oauth_client_id)) {
    bad("owner.oauth_client_id must be a non-empty client id");
  }
  const allowed: RepoOwner[] = [];
  if (doc.allowed_repo_owners !== undefined) {
    if (!Array.isArray(doc.allowed_repo_owners)) bad("allowed_repo_owners must be a list");
    for (const [i, a] of (doc.allowed_repo_owners as unknown[]).entries()) {
      if (!isObj(a) || Object.keys(a).sort().join() !== "id,login" || typeof a.login !== "string" || !a.login || !isPosInt(a.id)) {
        bad(`allowed_repo_owners[${i}] must be { login, id } with a positive integer id`);
      }
      allowed.push({ login: (a as { login: string }).login, id: (a as { id: number }).id });
    }
  }
  const repos = (doc.repos as unknown[]).map((r, i) => {
    if (!isObj(r) || typeof r.name !== "string" || typeof r.url !== "string") return bad(`repos[${i}] needs name and url`);
    const m = REPO_URL_RE.exec(r.url);
    if (!m) return bad(`repos[${i}].url must be https://github.com/<owner>/<repo>`);
    return { name: r.name, url: r.url, owner: m[1]!, repo: m[2]! };
  });
  const budget = isObj(doc.settings) && isObj(doc.settings.budget) ? doc.settings.budget : undefined;
  const mode = budget?.mode;
  if (mode !== "subscription" && mode !== "tokens") bad("settings.budget.mode must be subscription or tokens (ADR 0012)");
  const endpoints: string[] = [];
  const listed = isObj(doc.settings) ? doc.settings.endpoints : undefined;
  if (listed !== undefined) {
    if (!Array.isArray(listed)) bad("settings.endpoints must be a list of endpoint names");
    for (const [i, n] of (listed as unknown[]).entries()) {
      if (typeof n !== "string" || !ENDPOINT_NAME_RE.test(n) || n === "anthropic") bad(`settings.endpoints[${i}] must be an endpoint name (lower-case letters, digits, '-')`);
      if (endpoints.includes(n as string)) bad(`settings.endpoints lists '${n as string}' twice`);
      endpoints.push(n as string);
    }
  }
  const signIn = isObj(doc.settings) ? parseSignIn(doc.settings.interview_sign_in, doc.maturity as string, bad) : null;
  try {
    parseRoleAssignments(isObj(doc.settings) ? doc.settings.agents : undefined);
  } catch (e) {
    if (e instanceof RoleAssignmentError) bad(e.message);
    throw e;
  }
  return {
    name: doc.name as string,
    commit,
    enabled: doc.enabled as boolean,
    owner: { github_id: doc.owner.github_id as number, oauth_client_id: doc.owner.oauth_client_id as string },
    allowed_repo_owners: allowed,
    repos,
    billingMode: mode as "subscription" | "tokens",
    endpoints,
    factoryVersion: (doc.factory as { version: string }).version,
    maturity: doc.maturity as string,
    interviewSignIn: signIn,
    raw: doc,
  };
}

function parseSignIn(v: unknown, maturity: string, bad: (m: string) => never): InterviewSignIn | null {
  if (v === undefined) return null;
  const k = "settings.interview_sign_in";
  if (!isObj(v)) return bad(`${k} must be a mapping with 'every'`);
  const every = v.every;
  if (typeof every !== "string" || !SIGN_IN_EVERY.includes(every as SignInEvery)) bad(`${k}.every must be one of ${SIGN_IN_EVERY.join(", ")}`);
  const extra = Object.keys(v).filter((x) => x !== "every" && x !== "hours");
  if (extra.length) bad(`${k} has unknown key '${extra[0]}'`);
  if (every === "hours") {
    if (!isPosInt(v.hours) || v.hours > MAX_SIGN_IN_HOURS) bad(`${k}.hours must be a whole number from 1 to ${MAX_SIGN_IN_HOURS}`);
    return { every, hours: v.hours as number };
  }
  if (v.hours !== undefined) bad(`${k}.hours is only allowed with every: hours`);
  // No sign-in at all is an accepted risk only until Alpha (F-018 SR-8).
  if (every === "never" && maturity !== RAPID_PROTOTYPE) bad(`${k}.every: never is allowed only at ${RAPID_PROTOTYPE}`);
  return { every: every as SignInEvery };
}
