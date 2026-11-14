import { afterEach, describe, expect, it } from "vitest";
import { EngineHandle } from "../src/engine";
import type { ResearchConfig } from "../src/interview/tools";
import { parseTranscript } from "../src/state/transcript";
import { RpcClient, engineJson, git, makeWorld, start } from "./helpers";

let engines: EngineHandle[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const e of engines) await e.stop();
  engines = [];
  clients = [];
});

async function setup() {
  const w = makeWorld();
  const e = await start(w);
  engines.push(e);
  const c = await RpcClient.connect(engineJson(w).path);
  clients.push(c);
  const { feature } = (await c.ok("feature.start", { request: "Export as CSV" })) as { feature: string };
  return { w, e, feature };
}

// Interview tools v1.2 (F-020 FR-7): the reader's facts, its sources and its claim about instructions on a page.
const ANSWER = { facts: [{ text: "Use a streaming writer.", source: "https://example.org/csv" }], sources: ["https://example.org/csv"], page_contains_instructions: true, where: "https://example.org/csv" };
const EMPTY = { facts: [], sources: [], page_contains_instructions: false };

describe("research_web with the web reader (H-0082 caps)", () => {
  it("logs the query against the open question and returns the reader's answer", async () => {
    const { w, e, feature } = await setup();
    const queries: string[] = [];
    const research: ResearchConfig = { perQuestion: 1, perSession: 5, run: async (q) => (queries.push(q), ANSWER) };
    const t = e.interviewTools(feature, w.worktree, {}, research);
    await t.interview_ask({ text: "Which CSV dialect?", why: "w" });
    expect(await t.research_web({ query: "csv dialects" })).toEqual({ ok: true, result: ANSWER });
    expect(queries).toEqual(["csv dialects"]);
    const second = await t.research_web({ query: "again" });
    expect(second).toMatchObject({ ok: false, error: { code: "limit" } });
    expect(queries).toHaveLength(1);
    const entries = parseTranscript(git(w.config, "show", `factory/state:interviews/${feature}/transcript.jsonl`) + "\n");
    expect(entries.filter((x) => x.type === "research_requested")).toMatchObject([{ query: "csv dialects", item: "Q-001" }]);
    expect(entries.filter((x) => x.type === "cap_reached")).toMatchObject([{ cap: "research per question", item: "Q-001" }]);
  });

  it("caps research per session, and a reader failure is `unavailable`", async () => {
    const { w, e, feature } = await setup();
    let fail = false;
    const research: ResearchConfig = { perQuestion: 9, perSession: 2, run: async () => {
      if (fail) throw new Error("container failed its check");
      return EMPTY;
    } };
    const t = e.interviewTools(feature, w.worktree, {}, research);
    expect((await t.research_web({ query: "a" })).ok).toBe(true);
    fail = true;
    expect(await t.research_web({ query: "b" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await t.research_web({ query: "c" })).toMatchObject({ ok: false, error: { code: "limit" } });
  });

  it("doesn't hold the feature while the reader works", async () => {
    const { w, e, feature } = await setup();
    let release!: () => void;
    const research: ResearchConfig = { perQuestion: 9, perSession: 9, run: () => new Promise((r) => (release = () => r(EMPTY))) };
    const t = e.interviewTools(feature, w.worktree, {}, research);
    const pending = t.research_web({ query: "slow" });
    await new Promise((r) => setTimeout(r, 50));
    expect((await t.interview_propose_assumption({ text: "A.", why: "w" })).ok).toBe(true);
    release();
    expect((await pending).ok).toBe(true);
  });
});
