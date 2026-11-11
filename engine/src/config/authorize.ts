import { GitHubClient, GitHubError } from "../github";
import { Logger } from "../log";
import type { Manifest } from "./manifest";

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
export async function authorizeProject(m: Manifest, github: GitHubClient, token: string | null, log: Logger): Promise<string[]> {
  if (!token) throw new AuthorizationError(`No factory token stored for ${m.name}: run \`factory-engine secret set factory-token/${m.name}\`.`);
  const allowed = new Set(m.allowed_repo_owners.map((a) => a.id));
  const warnings: string[] = [];
  for (const r of m.repos) {
    let info;
    try {
      info = await github.repo(r.owner, r.repo, token);
    } catch (e) {
      throw new AuthorizationError(`${r.owner}/${r.repo}: ${e instanceof GitHubError ? e.message : "GitHub is unreachable"}.`);
    }
    if (info.status !== 200 || info.ownerId === undefined) {
      throw new AuthorizationError(`${r.owner}/${r.repo} isn't reachable with the factory token (HTTP ${info.status}).`);
    }
    if (!allowed.has(info.ownerId)) {
      throw new AuthorizationError(`${r.owner}/${r.repo} is owned by account id ${info.ownerId}, which isn't on allowed_repo_owners.`);
    }
    if (info.private === false) warnings.push(`${r.owner}/${r.repo} is public, so interview transcripts pushed on factory/state are public too.`);
  }
  log.info(`${m.name}: ${m.repos.length} repo(s) authorized`);
  return warnings;
}
