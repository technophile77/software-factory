import type { Logger } from "../log";
import type { RolePolicy } from "../policy/role-policy";
import { PageCaps, fetchPageTool } from "./factory-tools";
import type { SessionGroup } from "./sandbox";
import type { AgentSdk, UserTurn } from "./sdk";
import { SessionCaps, containerSpawn, runSession, sessionOptions } from "./session";

export interface WebReaderConfig {
  group: SessionGroup;
  docker: Parameters<typeof containerSpawn>[0];
  sdk: AgentSdk;
  /** The web-reader role, whose policy is fixed (Role policy v2.5). */
  policy: RolePolicy;
  instructions: string;
  caps: SessionCaps;
  page: PageCaps;
  /** Longest summary handed back to the analyst, in characters. */
  summaryMaxChars: number;
  /** Most sources returned. */
  maxSources: number;
  log: Logger;
  model?: string;
}

/**
 * research_web's other half: one web reader session per query, in its own
 * container with no worktree, reaching pages only through fetch_page. The
 * reader gets only the query. Its sources are the pages the engine fetched
 * for it, not addresses it claims, and its summary goes back labelled
 * untrusted (F-005 SR-6, SR-17).
 */
export async function research(c: WebReaderConfig, query: string): Promise<{ summary: string; sources: string[] }> {
  if (c.policy.role !== "web-reader") throw new Error("research runs as the web-reader role");
  const agent = await c.group.startAgent(c.policy, null);
  const sources: string[] = [];
  try {
    const tool = fetchPageTool((url) => c.group.fetch(agent, url), c.page, (url) => {
      if (!sources.includes(url)) sources.push(url);
    });
    const abort = new AbortController();
    const opts = sessionOptions({
      policy: c.policy,
      cwd: agent.cwd,
      worktree: null,
      instructions: c.instructions,
      factoryServer: c.sdk.createFactoryServer([tool]),
      factoryTools: ["fetch_page"],
      caps: c.caps,
      ...(c.model ? { model: c.model } : {}),
      spawn: containerSpawn(c.docker, agent.name, agent.cwd),
      log: c.log,
    }, abort);
    async function* turns(): AsyncIterable<UserTurn> {
      yield { type: "user", message: { role: "user", content: query }, parent_tool_use_id: null, session_id: "" };
    }
    const out = await runSession(c.sdk, opts, turns(), c.caps, { onWebSearch: (q) => c.log.info(`web-reader ${agent.name}: WebSearch ${JSON.stringify(q).slice(0, 500)}`) });
    if (out.status !== "complete" || !out.result) throw new Error(out.status === "cap" ? `the reader reached its ${out.reason} cap` : "the reader didn't finish");
    const summary = [...out.result].slice(0, c.summaryMaxChars).join("");
    return { summary, sources: sources.slice(0, c.maxSources) };
  } finally {
    await c.group.stopAgent(agent);
  }
}
