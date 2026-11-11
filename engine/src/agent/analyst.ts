import type { DockerCli } from "../docker/cli";
import type { InterviewTools, ResearchConfig } from "../interview/tools";
import type { Logger } from "../log";
import { PolicyError, RolePolicy, effectiveRole } from "../policy/role-policy";
import { PageCaps, analystTools } from "./factory-tools";
import type { SessionGroup } from "./sandbox";
import type { AgentSdk, UserTurn } from "./sdk";
import { SessionCaps, SessionOutcome, containerSpawn, runSession, sessionOptions } from "./session";
import { research } from "./web-reader";
import type { Breach } from "./write-check";
import type { WorktreeCommitResult } from "./worktree-commit";

/** SR-18 and H-0082 values, from change-controlled config. The engine has no defaults for any of them. */
export interface AgentLimitsConfig {
  analyst: SessionCaps;
  reader: SessionCaps;
  research: { perQuestion: number; perSession: number };
  page: PageCaps;
  summaryMaxChars: number;
  maxSources: number;
}

export interface AnalystRunInput {
  sdk: AgentSdk;
  docker: DockerCli;
  group: SessionGroup;
  /** The manifest as read from the config repo's main commit; its `policy` gives the roles. */
  manifest: unknown;
  repoName?: string;
  worktree: string;
  instructions: { analyst: string; reader?: string };
  limits: AgentLimitsConfig;
  skillsPluginDir?: string;
  model?: string;
  resume?: string;
  /** FR-3: the billing-mode check, run before each session (SR-18). Returns why not, or null. */
  billingCheck(): string | null;
  /** The analyst's tools for the feature, given the web reader to research with. */
  tools(research: ResearchConfig | undefined): InterviewTools;
  turns: AsyncIterable<UserTurn>;
  /** FR-11 with FR-9's check: called once the container is gone. */
  commit(policy: RolePolicy): Promise<WorktreeCommitResult>;
  onSessionId(id: string): void;
  /** AC-9: a breach rejects the session's changes and files a Security item. */
  onBreach(breaches: Breach[]): Promise<void>;
  log: Logger;
}

export class SessionRefused extends Error {
  override name = "SessionRefused";
}

/**
 * One analyst session, start to end (FR-8 to FR-11): billing check, the
 * run's network and proxy, the analyst's container, the `factory` tools, the
 * SDK session under its caps, then the container stops before the engine
 * commits and checks what it wrote. Every failure before the session starts
 * means no session (SR-2).
 */
export async function runAnalystSession(i: AnalystRunInput): Promise<{ outcome: SessionOutcome; commit: WorktreeCommitResult }> {
  const why = i.billingCheck();
  if (why) throw new SessionRefused(why);
  let analyst: RolePolicy;
  let reader: RolePolicy | null = null;
  try {
    analyst = effectiveRole(i.manifest, "requirements-analyst", i.repoName);
    const roles = (i.manifest as { policy?: { roles?: Record<string, unknown> } }).policy?.roles ?? {};
    if (Object.prototype.hasOwnProperty.call(roles, "web-reader")) reader = effectiveRole(i.manifest, "web-reader", i.repoName);
  } catch (e) {
    throw new SessionRefused(e instanceof PolicyError ? `Role policy: ${e.message}` : "the Role policy couldn't be read");
  }
  await i.group.open();
  try {
    const agent = await i.group.startAgent(analyst, i.worktree, { sessionVolume: true });
    let outcome: SessionOutcome;
    try {
      const researchCfg: ResearchConfig | undefined = reader && i.instructions.reader
        ? {
            perQuestion: i.limits.research.perQuestion,
            perSession: i.limits.research.perSession,
            run: (q) => research({
              group: i.group, docker: i.docker, sdk: i.sdk, policy: reader!, instructions: i.instructions.reader!, caps: i.limits.reader,
              page: i.limits.page, summaryMaxChars: i.limits.summaryMaxChars, maxSources: i.limits.maxSources, log: i.log, ...(i.model ? { model: i.model } : {}),
            }, q),
          }
        : undefined;
      const tools = analystTools(i.tools(researchCfg));
      const abort = new AbortController();
      const opts = sessionOptions({
        policy: analyst,
        worktree: i.worktree,
        instructions: i.instructions.analyst,
        factoryServer: i.sdk.createFactoryServer(tools),
        factoryTools: tools.map((t) => t.name),
        caps: i.limits.analyst,
        ...(i.skillsPluginDir ? { skillsPluginDir: i.skillsPluginDir } : {}),
        ...(i.model ? { model: i.model } : {}),
        ...(i.resume ? { resume: i.resume } : {}),
        spawn: containerSpawn(i.docker, agent.name),
        log: i.log,
      }, abort);
      outcome = await runSession(i.sdk, opts, i.turns, i.limits.analyst, {
        onSessionId: i.onSessionId,
        onWebSearch: (q) => i.log.info(`analyst ${agent.name}: WebSearch ${JSON.stringify(q).slice(0, 500)}`),
      });
    } finally {
      // The container must be gone before the worktree is read, so nothing changes under the check.
      await i.group.stopAgent(agent);
    }
    const commit = await i.commit(analyst);
    if (commit.status === "rejected") await i.onBreach(commit.breaches);
    return { outcome, commit };
  } finally {
    await i.group.close();
  }
}
