import type { Logger } from "../log";
import { outputSchemaOf, schemaErrors } from "../schemas/json-file";
import { type WebReaderAnswer, webReaderAnswer } from "../schemas/web-reader-answer";
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
  /** Most characters of facts handed back to the analyst, all facts together. */
  summaryMaxChars: number;
  /** Most sources returned. */
  maxSources: number;
  log: Logger;
  model?: string;
}

/** What research_web hands the analyst (Interview tools v1.2): the reader's answer, cut to the pages the engine fetched. */
export interface ResearchResult {
  facts: WebReaderAnswer["facts"];
  sources: string[];
  page_contains_instructions: boolean;
  where?: string;
}

/**
 * research_web's other half: one web reader session per query, in its own
 * container with no worktree, reaching pages only through fetch_page. The
 * reader gets only the query and returns its answer as structured output
 * (F-020 FR-7, FR-9). Its sources are the pages the engine fetched for it,
 * not addresses it claims: a fact from any other address is dropped. The
 * answer goes back labelled untrusted (F-005 SR-6, SR-17; F-020 SR-10).
 */
export async function research(c: WebReaderConfig, query: string): Promise<ResearchResult> {
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
      outputSchema: outputSchemaOf(webReaderAnswer),
      ...(c.model ? { model: c.model } : {}),
      spawn: containerSpawn(c.docker, agent.name, agent.cwd),
      log: c.log,
    }, abort);
    async function* turns(): AsyncIterable<UserTurn> {
      yield { type: "user", message: { role: "user", content: query }, parent_tool_use_id: null, session_id: "" };
    }
    const out = await runSession(c.sdk, opts, turns(), c.caps, { onWebSearch: (q) => c.log.info(`web-reader ${agent.name}: WebSearch ${JSON.stringify(q).slice(0, 500)}`) });
    if (out.status !== "complete") throw new Error(out.status === "cap" ? `the reader reached its ${out.reason} cap` : "the reader didn't finish");
    if (out.structured === undefined) throw new Error("the reader returned no answer");
    const bad = schemaErrors(out.structured, webReaderAnswer, 3);
    if (bad.length) throw new Error(`the reader's answer was refused: ${bad.join("; ")}`);
    const answer = webReaderAnswer.parse(out.structured);
    const kept = sources.slice(0, c.maxSources);
    const facts: ResearchResult["facts"] = [];
    let room = c.summaryMaxChars;
    for (const f of answer.facts) {
      if (!kept.includes(f.source) || f.text.length > room) continue;
      facts.push(f);
      room -= f.text.length;
    }
    return { facts, sources: kept, page_contains_instructions: answer.page_contains_instructions, ...(answer.where !== undefined ? { where: answer.where } : {}) };
  } finally {
    await c.group.stopAgent(agent);
  }
}
