import { z } from "zod";
import { LIMIT_KEYS, OPTIONAL_SECTIONS } from "../config/limits";
import { MODEL_ROLES, OPTIONAL_MODEL_ROLES } from "../config/models";
import { ConfigError } from "../config/paths-file";

/**
 * Schemas for the YAML files the owner edits by hand (F-020 FR-11, FR-12,
 * H-0244). The files stay YAML (proposal 0034 decision 2). The engine checks
 * each against its schema when it reads it, before the file's own
 * validator, and the schema files under docs/schemas/ come from these.
 * Where a part already has a detailed validator (the Role policy, rungs,
 * endpoint rules) the schema checks its outline and leaves the rules there.
 */

const text = (max: number) => z.string().max(max);
const posInt = z.number().int().positive();
const open = z.record(z.string(), z.unknown());

const limitSection = (keys: Record<string, "int" | "num">, full: boolean) =>
  z.strictObject(Object.fromEntries(Object.entries(keys).map(([k, kind]) => {
    const n = kind === "int" ? z.number().int().positive() : z.number().positive();
    return [k, full ? n : n.optional()];
  })));

const limits = (full: boolean) =>
  z.strictObject(Object.fromEntries(Object.entries(LIMIT_KEYS).map(([s, keys]) => {
    const sec = limitSection(keys, full);
    return [s, full && !(OPTIONAL_SECTIONS as readonly string[]).includes(s) ? sec : sec.optional()];
  })));

/** `engine/config/limits.yaml` in the master repo. */
export const limitsFile = limits(true);

/** `engine/config/models.yaml` in the master repo. */
export const modelsFile = z.strictObject({
  ...Object.fromEntries(MODEL_ROLES.map((r) => [r, text(200)])),
  ...Object.fromEntries(OPTIONAL_MODEL_ROLES.map((r) => [r, text(200).optional()])),
});

/** `factory-projects.local.yaml` next to the master clone. */
export const projectsFile = z.strictObject({ projects: z.array(z.strictObject({ path: text(4096) })).max(200) });

/** `~/.software-factory/engine.yaml` (the engine home). */
export const engineFile = z.strictObject({ gitleaks: text(4096).optional() });

const endpoint = z.strictObject({
  base_url: text(2000),
  model: text(200),
  api: z.enum(["anthropic", "openai"]),
  api_key_ref: text(100).optional(),
  max_sessions: z.number().int().min(1).max(16).optional(),
  billing: z.enum(["local", "per_token", "subscription"]),
  deadline: z.strictObject({ margin_s: z.number().int().min(10).max(3600) }).optional(),
  allow_loopback: z.boolean().optional(),
  prices: z.strictObject({ input_per_mtok: z.number().min(0), output_per_mtok: z.number().min(0) }).optional(),
  plan: z.strictObject({
    limits: z.array(z.strictObject({ kind: z.enum(["requests", "input_tokens", "output_tokens"]), count: posInt, window: z.enum(["5h", "day", "week", "month"]) })).max(10),
    reserve_pct: z.number().min(0).max(90).optional(),
  }).optional(),
});

/** `factory-endpoints.local.yaml` (Model endpoints file v1.0). */
export const endpointsFile = z.strictObject({ endpoints: z.record(z.string().regex(/^[a-z0-9-]{1,32}$/), endpoint) });

const repo = z.strictObject({
  name: text(100),
  url: text(300),
  maturity: text(40).optional(),
  policy: open.optional(),
  commands: z.strictObject({
    test: z.array(text(500)).min(1).max(50).optional(),
    test_results: text(500).optional(),
    build: z.array(text(500)).min(1).max(50).optional(),
  }).optional(),
});

/** `factory-project.yaml` (Project manifest v1.7) in the project's config repo. */
export const manifestFile = z.strictObject({
  schema: z.literal("factory-project/1.0"),
  name: text(100),
  description: text(1000).optional(),
  factory: z.strictObject({ version: text(200) }),
  enabled: z.boolean().optional(),
  target_maturity: text(40).optional(),
  owner: z.strictObject({ github_id: posInt, oauth_client_id: text(100), commit_name: text(100).optional() }).optional(),
  allowed_repo_owners: z.array(z.strictObject({ login: text(100), id: posInt })).max(50).optional(),
  repos: z.array(repo).min(1).max(100),
  maturity: text(40),
  complexity: z.enum(["simple", "moderate", "complex"]).optional(),
  skills: open.optional(),
  agents: open.optional(),
  standards: open.optional(),
  settings: z.strictObject({
    budget: open.optional(),
    endpoints: z.array(text(32)).max(32).optional(),
    agents: open.optional(),
    concurrency: z.union([text(20), posInt]).optional(),
    retries: open.optional(),
    ci: open.optional(),
    github: open.optional(),
    providers: open.optional(),
  }).optional(),
  notes: text(20000).optional(),
  policy: open.optional(),
  limits: limits(false).optional(),
  github: open.optional(),
});

/** F-020 FR-12: checks a hand-edited file's outline, naming the file and the field path, never the value. */
export function checkConfig(file: string, doc: unknown, schema: z.ZodType): void {
  const r = schema.safeParse(doc);
  if (r.success) return;
  const first = r.error.issues[0]!;
  const at = first.path.map((k) => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("").replace(/^\./, "") || "(top level)";
  const what = first.code === "unrecognized_keys" ? `unknown key ${(first as { keys: string[] }).keys.map((k) => `'${k.slice(0, 64)}'`).join(", ")}` : first.code;
  throw new ConfigError(`${file}: ${at} is invalid (${what})`);
}
