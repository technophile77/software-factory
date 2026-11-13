import type { RolePolicy } from "../policy/role-policy";
import { ROLE_RE } from "../policy/role-policy";
import { MODEL_RE, parseRungModel } from "./models";
import { ConfigError } from "./paths-file";

/*
 * PROVISIONAL (pending the owner's OQ-11 decision on how a role is assigned an endpoint).
 * Everything that reads `settings.agents.<role>.{model,fallback,advisory}` lives in this file,
 * so replacing the design means replacing this module and its callers' one-line uses.
 */

/** Roles whose Claude model F-002 A-3 fixes; an endpoint may only advise them (F-013 FR-10). */
export const GATE_ROLES: readonly string[] = ["security-reviewer", "validation-judge"];

/** An endpoint rung, `<endpoint>/<model>`. */
export interface RungRef {
  endpoint: string;
  model: string;
}

/** What the project manifest says about one role's endpoint use. */
export interface RoleAssignment {
  role: string;
  /** The role runs on this endpoint rung; always paired with `fallback`. */
  model?: RungRef;
  /** The Claude model id the role runs on when the endpoint can't serve it. */
  fallback?: string;
  /** Gate roles only: an endpoint that gives the Claude reviewer unverified hints first. */
  advisory?: RungRef;
}

/** The manifest's endpoint assignment is wrong, or refused by the rules of F-013; the message is plain words for the owner. */
export class RoleAssignmentError extends ConfigError {
  override name = "RoleAssignmentError";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function rung(v: unknown, where: string): RungRef {
  const r = typeof v === "string" && MODEL_RE.test(v) ? parseRungModel(v) : null;
  if (!r || r.endpoint === null) throw new RoleAssignmentError(`${where} must name an endpoint rung as <endpoint>/<model>.`);
  return { endpoint: r.endpoint, model: r.model };
}

/**
 * Reads the endpoint keys of `settings.agents` in the project manifest (F-013
 * FR-1, SR-9, F-002 A-3). Other keys of a role (such as `rung`) are not this
 * module's and are ignored. A role with none of the three keys has no entry.
 *
 * @param settingsAgents the manifest's `settings.agents`, or undefined when absent.
 * @example
 * parseRoleAssignments({ "log-reader": { model: "lan/qwen3", fallback: "claude-haiku-4-5" } })
 *   .get("log-reader"); // { role: "log-reader", model: { endpoint: "lan", model: "qwen3" }, fallback: "claude-haiku-4-5" }
 * @throws RoleAssignmentError when `model` has no `fallback` (or the reverse), `fallback` is not a Claude model id, or a gate role is given `model` (it may only have `advisory`).
 */
export function parseRoleAssignments(settingsAgents: unknown): Map<string, RoleAssignment> {
  const out = new Map<string, RoleAssignment>();
  if (settingsAgents === undefined) return out;
  if (!isObj(settingsAgents)) throw new RoleAssignmentError("settings.agents must map each role to its settings.");
  for (const [role, v] of Object.entries(settingsAgents)) {
    if (!ROLE_RE.test(role)) throw new RoleAssignmentError("settings.agents holds a role name that isn't one.");
    if (!isObj(v)) throw new RoleAssignmentError(`settings.agents.${role} must be a mapping.`);
    if (v.model === undefined && v.fallback === undefined && v.advisory === undefined) continue;
    const where = `settings.agents.${role}`;
    const a: RoleAssignment = { role };
    if (v.model !== undefined) a.model = rung(v.model, `${where}.model`);
    if (v.advisory !== undefined) a.advisory = rung(v.advisory, `${where}.advisory`);
    if (v.fallback !== undefined) {
      if (typeof v.fallback !== "string" || !MODEL_RE.test(v.fallback) || parseRungModel(v.fallback).endpoint !== null) {
        throw new RoleAssignmentError(`${where}.fallback must be a Claude model id.`);
      }
      a.fallback = v.fallback;
    }
    if (a.model && !a.fallback) throw new RoleAssignmentError(`${where}.model uses an endpoint, so ${where}.fallback (a Claude model id) is required.`);
    if (a.fallback && !a.model) throw new RoleAssignmentError(`${where}.fallback only goes with ${where}.model.`);
    if (a.model && GATE_ROLES.includes(role)) {
      throw new RoleAssignmentError(`${where}.model: the ${role} role stays on its Claude model (F-002 A-3); use ${where}.advisory for a first pass instead.`);
    }
    if (a.advisory && !GATE_ROLES.includes(role)) throw new RoleAssignmentError(`${where}.advisory: only the gate roles (${GATE_ROLES.join(", ")}) take an advisory endpoint.`);
    out.set(role, a);
  }
  return out;
}

/**
 * The assignments in a parsed project manifest (`raw` as kept on `Manifest`).
 *
 * @throws RoleAssignmentError as `parseRoleAssignments`; `validateManifest` has already checked, so this does not happen for a loaded project.
 */
export function manifestAssignments(raw: unknown): Map<string, RoleAssignment> {
  return parseRoleAssignments(isObj(raw) && isObj(raw.settings) ? raw.settings.agents : undefined);
}

/**
 * SR-9: whether a role may run on an endpoint. It must write only under
 * `.factory/` (the worktree is then mounted read-only) and reach no network
 * host beyond the gateway.
 *
 * @example
 * isReadOnlyRole({ write: { allow: [".factory/runs/**"], deny: [] }, network: [] }); // true
 * isReadOnlyRole({ write: { allow: ["docs/**"], deny: [] }, network: [] }); // false
 */
export function isReadOnlyRole(p: Pick<RolePolicy, "write" | "network">): boolean {
  return p.write.allow.every((g) => g.startsWith(".factory/")) && p.network.length === 0;
}

/** Why a role that was meant for an endpoint runs on Claude (AC-13, FR-7); `endpoint` is a name, never an address. */
export interface ClaudeReason {
  endpoint: string;
  reason: string;
}

/** What a role runs on this time. */
export type RolePlan =
  | { kind: "claude"; model: string; because?: ClaudeReason }
  | { kind: "endpoint"; rung: RungRef; fallback: string };

/** What the caller knows about the project and this PC when a role starts. */
export interface PlanInput {
  role: string;
  assignment: RoleAssignment | undefined;
  /** The role's Claude model from `engine/config/models.yaml`, used when nothing else applies. */
  claudeDefault: string;
  /** The project's `settings.endpoints` (SR-8). */
  allowed: readonly string[];
  /** Null when the rung can be used on this PC, else a plain reason. */
  unavailable(rung: RungRef): string | null;
}

function whyNot(i: PlanInput, r: RungRef): string | null {
  if (!i.allowed.includes(r.endpoint)) return "the project's manifest doesn't list this endpoint (settings.endpoints)";
  return i.unavailable(r);
}

/**
 * Decides which model a role runs on at its start (F-013 FR-1, FR-7, SR-8,
 * SR-9; AC-13). A role with an endpoint rung that its project may not use, or
 * that this PC lacks, runs on its fallback Claude model with the reason, not
 * an error.
 *
 * @param policy the role's effective policy, checked against SR-9.
 * @example
 * planRole({ role: "log-reader", assignment, claudeDefault: "claude-sonnet-5-5", allowed: [], unavailable: () => null }, policy);
 * // { kind: "claude", model: "claude-haiku-4-5", because: { endpoint: "lan", reason: "the project's manifest doesn't list this endpoint (settings.endpoints)" } }
 * @throws RoleAssignmentError when the role has an endpoint rung but its policy isn't read-only (SR-9).
 */
export function planRole(i: PlanInput, policy: Pick<RolePolicy, "write" | "network">): RolePlan {
  const a = i.assignment;
  if (!a?.model) return { kind: "claude", model: i.claudeDefault };
  if (!isReadOnlyRole(policy)) {
    throw new RoleAssignmentError(`The ${i.role} role can't use an endpoint: it writes outside .factory/ or reaches the network, and only read-only roles may (F-013 SR-9).`);
  }
  const reason = whyNot(i, a.model);
  if (reason) return { kind: "claude", model: a.fallback!, because: { endpoint: a.model.endpoint, reason } };
  return { kind: "endpoint", rung: a.model, fallback: a.fallback! };
}

/** The advisory pass of a gate role: an endpoint rung to use, a reason to skip, or nothing configured. */
export type AdvisoryPlan = { kind: "none" } | { kind: "skip"; because: ClaudeReason } | { kind: "run"; rung: RungRef };

/**
 * Decides whether a gate role gets an advisory first pass (FR-10); the same
 * manifest and availability checks as `planRole`, and a skip never blocks the gate (FR-11).
 *
 * @example
 * planAdvisory({ role: "security-reviewer", assignment: { role: "security-reviewer", advisory: { endpoint: "lan", model: "qwen3" } },
 *   claudeDefault: "m", allowed: ["lan"], unavailable: () => null }); // { kind: "run", rung: { endpoint: "lan", model: "qwen3" } }
 */
export function planAdvisory(i: PlanInput): AdvisoryPlan {
  const r = i.assignment?.advisory;
  if (!r) return { kind: "none" };
  const reason = whyNot(i, r);
  return reason ? { kind: "skip", because: { endpoint: r.endpoint, reason } } : { kind: "run", rung: r };
}
