import YAML from "yaml";
import type { TreeSnapshot } from "./factory-source";
import { ConfigError } from "./paths-file";

/** Spec v32: the model for each agent role until F-002 wires rungs, a master default like the limits. */
export const MODELS_FILE = "engine/config/models.yaml";

/** The roles the engine runs in F-007; each needs a model. */
export const MODEL_ROLES = ["requirements-analyst", "web-reader"] as const;
/** F-008: a factory version from before it has no entry, and then Gate 1 doesn't run (AC-10). */
export const OPTIONAL_MODEL_ROLES = ["security-reviewer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export type Models = Record<ModelRole, string> & Partial<Record<(typeof OPTIONAL_MODEL_ROLES)[number], string>>;

const MAX_FILE = 16 * 1024;
// A model id goes into the SDK options as is, so nothing that could read as more than one token.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
/** F-013 FR-2: endpoint names, shared by the endpoints file, the manifest list and rung ids. */
export const ENDPOINT_NAME_RE = /^[a-z0-9-]{1,32}$/;

export class ModelsError extends ConfigError {
  override name = "ModelsError";
}

/**
 * Splits a rung id into its endpoint and model (F-013 FR-1). Only a prefix that
 * is a valid endpoint name and not `anthropic` counts as an endpoint, so plain
 * Claude ids (which never contain such a prefix before a `/`) are unchanged.
 * The caller checks the endpoint exists; this function does not.
 *
 * @example
 * parseRungModel("lan/qwen3.8-27b"); // { endpoint: "lan", model: "qwen3.8-27b" }
 * parseRungModel("claude-sonnet-4-5"); // { endpoint: null, model: "claude-sonnet-4-5" }
 */
export function parseRungModel(id: string): { endpoint: string | null; model: string } {
  const slash = id.indexOf("/");
  if (slash > 0) {
    const prefix = id.slice(0, slash);
    const rest = id.slice(slash + 1);
    if (prefix !== "anthropic" && ENDPOINT_NAME_RE.test(prefix) && rest) return { endpoint: prefix, model: rest };
  }
  return { endpoint: null, model: id };
}

/**
 * Reads the models from the master commit `factory.version` names, never a
 * working tree. Missing, unreadable, an unknown role, a missing required role
 * or an empty model id refuses the project. There is no per-project override yet.
 */
export async function readDefaultModels(tree: TreeSnapshot): Promise<Models> {
  const e = tree.entry(MODELS_FILE);
  if (!e) throw new ModelsError(`${MODELS_FILE} is missing from master commit ${tree.commit.slice(0, 12)}.`);
  if (!e.regular) throw new ModelsError(`${MODELS_FILE} in the master repo is not a regular file.`);
  if (e.size > MAX_FILE) throw new ModelsError(`${MODELS_FILE} is over 16 KiB.`);
  const raw = (await tree.blobs([e.sha])).get(e.sha)!;
  let doc: unknown;
  try {
    doc = YAML.parse(raw.toString("utf8"), { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    throw new ModelsError(`${MODELS_FILE} is not valid YAML.`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ModelsError(`${MODELS_FILE} must map each role to a model id.`);
  const map = doc as Record<string, unknown>;
  for (const k of Object.keys(map)) {
    if (!(MODEL_ROLES as readonly string[]).includes(k) && !(OPTIONAL_MODEL_ROLES as readonly string[]).includes(k)) throw new ModelsError(`${MODELS_FILE}: '${k.slice(0, 64)}' is not a role the engine runs.`);
  }
  const out = {} as Models;
  for (const role of MODEL_ROLES) {
    const v = map[role];
    if (typeof v !== "string" || !MODEL_RE.test(v)) throw new ModelsError(`${MODELS_FILE}: '${role}' needs a model id.`);
    out[role] = v;
  }
  for (const role of OPTIONAL_MODEL_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(map, role)) continue;
    const v = map[role];
    if (typeof v !== "string" || !MODEL_RE.test(v)) throw new ModelsError(`${MODELS_FILE}: '${role}' needs a model id.`);
    out[role] = v;
  }
  return out;
}
