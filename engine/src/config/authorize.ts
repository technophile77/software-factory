import { GitHubClient, GitHubError } from "../github";
import { Logger } from "../log";
import type { Manifest } from "./manifest";
import type { ProjectTokens } from "./tokens";

export type CredentialKind = "api_key" | "subscription";

export class AuthorizationError extends Error {
  override name = "AuthorizationError";
}

/**
 * What kind of model credential the engine would use. An ANTHROPIC_API_KEY
 * in the environment overrides a subscription login (ADR 0012), so it wins.
 */
export function credentialKind(env: NodeJS.ProcessEnv, stored: string | null): CredentialKind | null {
  if (env.ANTHROPIC_API_KEY) return "api_key";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "subscription";
  if (!stored) return null;
  if (stored.startsWith("sk-ant-oat")) return "subscription";
  if (stored.startsWith("sk-ant-api")) return "api_key";
  return null;
}

/** The credential the proxy's gateway uses, chosen in the same order as credentialKind. */
export function modelCredentialFor(env: NodeJS.ProcessEnv, stored: string | null): { kind: CredentialKind; value: string } | null {
  if (env.ANTHROPIC_API_KEY) return { kind: "api_key", value: env.ANTHROPIC_API_KEY };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: "subscription", value: env.CLAUDE_CODE_OAUTH_TOKEN };
  const kind = credentialKind({}, stored);
  return kind && stored ? { kind, value: stored } : null;
}

/** FR-3: refuse when the credentials don't match the project's billing mode. Returns the reason, or null. */
export function billingMismatch(mode: Manifest["billingMode"], project: string, env: NodeJS.ProcessEnv, stored: string | null): string | null {
  const kind = credentialKind(env, stored);
  if (kind === null) {
    return "No usable model credential: store one with `factory-engine secret set model-credential`.";
  }
  if (mode === "subscription" && kind === "api_key") {
    return env.ANTHROPIC_API_KEY
      ? `Project ${project} is in subscription mode, but ANTHROPIC_API_KEY is set and would bill the API instead. Unset it, or switch the project to tokens mode.`
      : `Project ${project} is in subscription mode, but the stored model credential is an API key.`;
  }
  if (mode === "tokens" && kind === "subscription") {
    return `Project ${project} is in tokens mode, but the model credential is a subscription login.`;
  }
  return null;
}

/**
 * FR-2 / ADR 0012: every repo of the project must be reachable with the
 * factory token and owned by an allowed account, judged by the numeric owner
 * id GitHub reports for the repo, not by the URL text. Any failure refuses.
 * Resolves to warnings for the owner (public repos: factory/state is pushed).
 */
/**
 * `config` is the config repo, where factory/state (transcripts, reports) is
 * pushed; only its visibility exposes them. A public code repo only matters
 * for stage 9, which pushes code there when onboarding recorded the owner's
 * confirmation (F-015 SR-6).
 */
export async function authorizeProject(m: Manifest, github: GitHubClient, tokens: ProjectTokens, log: Logger, config?: { owner: string; repo: string }): Promise<string[]> {
  // F-015 FR-19: each repo is checked with the token chosen for its owner.
  const tokenOf = (owner: string): string => {
    const t = tokens.for(owner);
    if (!t) throw new AuthorizationError(`No factory token stored for ${m.name}: run \`factory-engine secret set ${tokens.nameFor(owner)}\`.`);
    return t;
  };
  // A token without access to a repo gets 404, so the hint names the store name that would fix it.
  const hint = (owner: string) => (tokens.hasOwn(owner) ? "" : ` If ${owner}'s repos need their own token, store it with \`factory-engine secret set factory-token/${m.name}/${owner.toLowerCase()}\` (F-015 FR-19).`);
  // A fine-grained token reaches one owner's repos (classic tokens are refused, SR-2), and public repos
  // read fine with any token, so two owners left on the default token can only fail later, at a push.
  const shared = [...new Set([...m.repos.map((r) => r.owner), ...(config ? [config.owner] : [])].map((o) => o.toLowerCase()))].filter((o) => !tokens.hasOwn(o));
  if (shared.length > 1) {
    throw new AuthorizationError(`${m.name}'s repos belong to ${shared.length} GitHub owners without their own token, and one fine-grained token reaches only one owner. Store a token for all but one of them: ${shared.map((o) => `\`factory-engine secret set factory-token/${m.name}/${o}\``).join(", ")} (F-015 FR-19).`);
  }
  const allowed = new Set(m.allowed_repo_owners.map((a) => a.id));
  const warnings: string[] = [];
  for (const r of m.repos) {
    let info;
    try {
      info = await github.repo(r.owner, r.repo, tokenOf(r.owner));
    } catch (e) {
      if (e instanceof AuthorizationError) throw e;
      throw new AuthorizationError(`${r.owner}/${r.repo}: ${e instanceof GitHubError ? e.message : "GitHub is unreachable"}.`);
    }
    if (info.status !== 200 || info.ownerId === undefined) {
      throw new AuthorizationError(`${r.owner}/${r.repo} isn't reachable with ${tokens.nameFor(r.owner)} (HTTP ${info.status}).${hint(r.owner)}`);
    }
    if (!allowed.has(info.ownerId)) {
      throw new AuthorizationError(`${r.owner}/${r.repo} is owned by account id ${info.ownerId}, which isn't on allowed_repo_owners.`);
    }
    if (info.private === false && r.visibility !== "public") warnings.push(`${r.owner}/${r.repo} is public, and publishing to it wasn't confirmed at onboarding, so the engine won't push code to it (F-015 SR-6).`);
  }
  if (config) {
    const info = await github.repo(config.owner, config.repo, tokenOf(config.owner)).catch(() => null);
    if (info?.status === 200 && info.private === false) warnings.push(`The config repo ${config.owner}/${config.repo} is public, so interview transcripts pushed on factory/state are public too.`);
  }
  log.info(`${m.name}: ${m.repos.length} repo(s) authorized`);
  return warnings;
}
