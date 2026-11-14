import { AFTER_INTERVIEW_STAGE, ID_RE, TOOL_LIMITS as L } from "../constants";
import type { ResearchResult } from "../agent/web-reader";
import { Logger } from "../log";
import type { Change } from "../state/state-repo";
import { SecretFound } from "../state/state-repo";
import { FeatureInterview, InterviewError } from "./feature";
import * as fs from "node:fs";
import * as path from "node:path";
import { DocumentMeta, SourceRow, sha256, sourcesTable, specLine, tableHash, tableProblems } from "./document";
import { Finding, ItemContent, QUESTION_TYPES, QuestionType, WireItem } from "./model";
import { Check, SpecPathRefused, readSpec, readinessChecks } from "./readiness";

export type ToolErrorCode = "one_at_a_time" | "invalid" | "limit" | "unknown_item" | "wrong_status" | "unavailable";
export type ToolResult<T = unknown> = { ok: true; result: T } | { ok: false; error: { code: ToolErrorCode; message: string } };

class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
  }
}

const fail = (code: ToolErrorCode, message: string): never => {
  throw new ToolError(code, message);
};

const chars = (s: string) => [...s].length;

function obj(args: unknown, allowed: string[]): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("invalid", "Arguments must be an object.");
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) if (!allowed.includes(k)) fail("invalid", `Unknown key ${JSON.stringify(k).slice(0, 80)}.`);
  return a;
}

function str(v: unknown, name: string, max: number, required = true): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || (required && v.length === 0)) return fail("invalid", `${name} must be a non-empty string.`);
  if (chars(v) > max) fail("invalid", `${name} is over ${max} characters.`);
  return v;
}

/** A worktree path a conflict may cite (Interview tools v1.1): relative, `/`-separated, no `..`. */
const WORKTREE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function source(v: unknown, allowPath: boolean): string {
  if (allowPath && typeof v === "string" && WORKTREE_PATH_RE.test(v) && chars(v) <= L.findingSource) return v;
  return httpsUrl(v, allowPath);
}

function httpsUrl(v: unknown, allowPath = false): string {
  const what = allowPath ? "an https URL or a worktree path" : "an https URL";
  const s = str(v, "findings[].source", L.findingSource)!;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return fail("invalid", `findings[].source must be ${what}.`);
  }
  if (u.protocol !== "https:" || /\s/.test(s)) fail("invalid", `findings[].source must be ${what}.`);
  return s;
}

/** Text fields are stored and shown exactly as written: checked, never rewritten (SR-3). */
function itemContent(a: Record<string, unknown>, full: boolean, fromDocument = false): ItemContent {
  const c: ItemContent = { text: str(a.text, "text", L.text)!, why: str(a.why, "why", L.why)! };
  if (!full) return c;
  // `suggested` has no limit of its own in the contract; it is a text field, so text's applies.
  const suggested = str(a.suggested, "suggested", L.text, false);
  if (suggested !== undefined) c.suggested = suggested;
  if (a.options !== undefined) {
    if (!Array.isArray(a.options) || a.options.length > L.options) fail("invalid", `options must be a list of at most ${L.options}.`);
    c.options = (a.options as unknown[]).map((o) => str(o, "options[]", L.option)!);
  }
  if (a.findings !== undefined) {
    if (!Array.isArray(a.findings) || a.findings.length > L.findings) fail("invalid", `findings must be a list of at most ${L.findings}.`);
    c.findings = (a.findings as unknown[]).map((f): Finding => {
      const fo = obj(f, ["text", "source"]);
      return { text: str(fo.text, "findings[].text", L.findingText)!, source: source(fo.source, fromDocument) };
    });
  }
  if (a.type !== undefined) {
    if (!fromDocument) fail("invalid", "type is only for a feature started from a document.");
    if (typeof a.type !== "string" || !QUESTION_TYPES.includes(a.type)) fail("invalid", "type must be gap, conflict or ambiguity.");
    c.type = a.type as QuestionType;
  }
  return c;
}

/** The branch's copy of the source document, read without following links, against the recorded hash (Gate 2 L1). */
function branchCopyIntact(worktree: string, d: DocumentMeta): boolean {
  let fd: number;
  try {
    fd = fs.openSync(path.join(worktree, ...d.path.split("/")), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return false;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size !== d.bytes) return false;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return sha256(buf) === d.sha256;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function itemId(v: unknown): string {
  if (typeof v !== "string" || !ID_RE.test(v)) fail("invalid", "item must be an id.");
  return v as string;
}

export interface ToolContext {
  feature: FeatureInterview;
  /** The analyst's worktree, where interview_spec_ready reads the spec. */
  worktree: string;
  log: Logger;
  /** Builds the agent report (FR-13) and returns it as a state change, committed with the result. */
  reportFor(result: { specPath: string; specVersion: number; checks: Check[]; passed: boolean }): Promise<Change[]>;
  /** Told once the result is committed; a pass ends the analyst's run. */
  onSpecReady?(passed: boolean): void;
  /** The web reader (milestone 2). Without it, research_web answers `unavailable`. */
  research?: ResearchConfig;
  /**
   * The feature's stored source document, read from git and checked against the
   * SHA-256 in the transcript (F-009 FR-4); null if it is missing or changed.
   */
  documentText?(): Promise<string | null>;
}

export interface ResearchConfig {
  /** Runs one web reader session with only the query (Interview tools v1.2). */
  run(query: string): Promise<ResearchResult>;
  /** Caps from change-controlled config (H-0082); the engine has no defaults. */
  perQuestion: number;
  perSession: number;
}

export interface InterviewTools {
  interview_ask(args: unknown): Promise<ToolResult<{ item: WireItem }>>;
  interview_propose_assumption(args: unknown): Promise<ToolResult<{ item: WireItem }>>;
  interview_revise(args: unknown): Promise<ToolResult<{ revision: number }>>;
  research_web(args: unknown): Promise<ToolResult<ResearchResult>>;
  interview_spec_ready(args: unknown): Promise<ToolResult<{ checks: Check[] }>>;
  interview_confirm_sources(args: unknown): Promise<ToolResult<{ item: WireItem }>>;
}

/**
 * The analyst's tools as plain functions, bound to one feature: no tool takes
 * a feature, and every item must be that feature's (Interview tools v1.0).
 * agent/factory-tools.ts exposes them to an agent session as MCP tools.
 */
export function createInterviewTools(ctx: ToolContext): InterviewTools {
  const f = ctx.feature;
  const fromDocument = () => f.state.document !== null;
  let sessionResearch = 0;

  function specArgs(args: unknown): { specPath: string; specVersion: number; spec: string } {
    const a = obj(args, ["spec_path", "spec_version"]);
    if (typeof a.spec_path !== "string") fail("invalid", "spec_path must be a string.");
    if (typeof a.spec_version !== "number" || !Number.isSafeInteger(a.spec_version) || a.spec_version < 0) {
      fail("invalid", "spec_version must be a non-negative integer.");
    }
    try {
      return { specPath: a.spec_path as string, specVersion: a.spec_version as number, spec: readSpec(ctx.worktree, f.id, a.spec_path as string) };
    } catch (e) {
      if (e instanceof SpecPathRefused) return fail("invalid", e.message);
      throw e;
    }
  }

  async function run<T>(name: string, body: () => Promise<T>): Promise<ToolResult<T>> {
    try {
      return { ok: true, result: await f.exclusive(body) };
    } catch (e) {
      if (e instanceof ToolError) return { ok: false, error: { code: e.code, message: e.message } };
      if (e instanceof SecretFound) return { ok: false, error: { code: "invalid", message: "The secrets scan found a secret in the text; nothing was recorded." } };
      if (e instanceof InterviewError && e.code === "tampered") return { ok: false, error: { code: "invalid", message: e.message } };
      ctx.log.warn(`${f.id}: ${name} failed: ${(e as Error).message}`);
      return { ok: false, error: { code: "invalid", message: "The engine couldn't record that; try again later." } };
    }
  }

  async function capReached(cap: string, item?: string): Promise<never> {
    // The owner is told on the engine console and in the transcript.
    ctx.log.warn(`${f.id}: the analyst reached the ${cap} cap.`);
    await f.append([{ type: "cap_reached", cap, ...(item ? { item } : {}) }], `cap ${cap}`).catch(() => undefined);
    return fail("limit", `The ${cap} cap is reached; the owner has been told.`);
  }

  async function checkItemCap(): Promise<void> {
    if (f.state.items.size >= L.itemsPerFeature) await capReached("items per feature");
  }

  return {
    interview_ask: (args) =>
      run("interview_ask", async () => {
        const c = itemContent(obj(args, ["text", "why", "suggested", "options", "findings", "type"]), true, fromDocument());
        if (f.openQuestion()) fail("one_at_a_time", "An earlier question is still open.");
        await checkItemCap();
        return { item: await f.create("question", c) };
      }),

    interview_propose_assumption: (args) =>
      run("interview_propose_assumption", async () => {
        const c = itemContent(obj(args, ["text", "why"]), false);
        await checkItemCap();
        if (f.state.list("assumption").filter((a) => a.status === "open").length >= L.openAssumptions) {
          await capReached("open assumptions");
        }
        return { item: await f.create("assumption", c) };
      }),

    interview_revise: (args) =>
      run("interview_revise", async () => {
        const a = obj(args, ["item", "text", "why", "suggested", "options", "findings", "type"]);
        const id = itemId(a.item);
        const c = itemContent(a, true, fromDocument());
        const item = f.state.items.get(id);
        if (!item) return fail("unknown_item", "No such item in this feature.");
        if (item.kind !== "question" || item.status !== "researching") {
          fail("wrong_status", "Only a question the owner asked more information on can be revised.");
        }
        return { revision: await f.revise(id, c) };
      }),

    research_web: async (args) => {
      // Recording the request holds the feature; the reader's session doesn't, so replies keep flowing meanwhile.
      const asked = await run("research_web", async () => {
        const a = obj(args, ["query"]);
        const q = str(a.query, "query", L.query)!;
        if (/[\r\n\u2028\u2029]/.test(q)) fail("invalid", "query must be one line.");
        const r = ctx.research;
        if (!r) return fail("unavailable", "Web research isn't available in this engine version.");
        // Logged against the item being researched, else the open question.
        const item = f.researching() ?? f.openQuestion() ?? null;
        if (item && item.research_calls >= r.perQuestion) await capReached("research per question", item.id);
        if (sessionResearch >= r.perSession) await capReached("research per session");
        sessionResearch++;
        await f.append([{ type: "research_requested", query: q, ...(item ? { item: item.id } : {}) }], "research requested");
        return q;
      });
      if (!asked.ok) return asked;
      try {
        const res = await ctx.research!.run(asked.result);
        return { ok: true, result: { facts: res.facts, sources: res.sources, page_contains_instructions: res.page_contains_instructions, ...(res.where !== undefined ? { where: res.where } : {}) } };
      } catch (e) {
        ctx.log.warn(`${f.id}: research failed: ${(e as Error).message.slice(0, 200)}`);
        return { ok: false, error: { code: "unavailable", message: "The web reader couldn't finish; try again later." } };
      }
    },

    interview_spec_ready: (args) =>
      run("interview_spec_ready", async () => {
        const { specPath, specVersion: version, spec } = specArgs(args);
        const a = { spec_path: specPath, spec_version: version };
        const sourceIntact = f.state.document ? branchCopyIntact(ctx.worktree, f.state.document) : undefined;
        const checks = readinessChecks({
          spec, specVersion: version, state: f.state, chainIntact: f.chainIntact && !f.remoteRefused, ...(sourceIntact !== undefined ? { sourceIntact } : {}),
        });
        const passed = checks.every((c) => c.passed);
        // A transcript someone else changed can't take more entries; the failed check is the answer.
        if (!f.chainIntact) return { checks };
        const extra = await ctx.reportFor({ specPath: a.spec_path as string, specVersion: a.spec_version as number, checks, passed });
        const bodies = [{ type: "spec_ready", spec_path: a.spec_path, spec_version: a.spec_version, passed, checks }];
        if (passed) bodies.push({ type: "stage", stage: AFTER_INTERVIEW_STAGE } as never);
        await f.append(bodies, passed ? "spec ready: interview checks pass" : "spec ready: interview checks fail", extra);
        ctx.onSpecReady?.(passed);
        return { checks };
      }),

    interview_confirm_sources: (args) =>
      run("interview_confirm_sources", async () => {
        if (!fromDocument()) fail("invalid", "This feature didn't start from a document.");
        const { specVersion, spec } = specArgs(args);
        const rows: SourceRow[] | null = sourcesTable(spec);
        if (!rows) return fail("invalid", "The spec has no '## Sources' table.");
        const text = ctx.documentText ? await ctx.documentText() : null;
        if (text === null) return fail("unavailable", "The engine couldn't read the stored source document, or it no longer matches its recorded hash.");
        const problems = tableProblems(rows, text, spec);
        if (problems.length) fail("invalid", `The Sources table doesn't match the document: ${problems.slice(0, 20).join("; ")}.`);
        await checkItemCap();
        const sources = rows.map((r) => ({ spec_ref: r.spec_ref, section: r.section, quote: r.quote, spec_line: specLine(spec, r.spec_ref)! }));
        // Engine words only: the list itself is the table, read from the spec (SR-7).
        const c: ItemContent = {
          text: `The spec (version ${specVersion}) takes these ${sources.length} lines from your document. For each, the engine found the quote in one paragraph, list item or table row under the named heading of your stored document, ignoring line breaks and repeated spaces, and copied the spec's own line. Check that each spec line says what its quote says.`,
          why: "Statements from your own document count as your answers. Confirm the list, or name the spec refs you want asked as questions instead.",
        };
        return { item: await f.createSourceConfirmation(c, sources, specVersion, tableHash(rows, spec)) };
      }),
  };
}
