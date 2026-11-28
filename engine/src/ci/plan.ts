import * as crypto from "node:crypto";
import YAML from "yaml";
import catalog from "./catalog.json";
import { prWorkflowProblems } from "../build/stage9";
import { type CiJobRequest, parseRequest } from "./request";
import { WORKFLOW_DIR, checkName, commandsOf, readHeader, renderWorkflow, scheduleOf, workflowPath } from "./render";

/**
 * F-026 FR-3 to FR-7, SR-6, SR-8, SR-10: from the test engineer's requests
 * and what is on `main`, the exact files one hygiene item proposes. Code
 * decides everything here; the agent's text is only ever data in it.
 */

export interface MainView {
  /** Every workflow file on main, by path, with its text. */
  workflows: ReadonlyArray<{ path: string; text: string }>;
  /** Check names reported on main's head by any app. */
  checks: readonly string[];
  /** main's required checks (rulesets and classic protection, F-015 FR-31). */
  required: readonly string[];
}

export interface PlannedFile {
  path: string;
  /** null removes the file. */
  content: string | null;
  /** The file on main before, for the item's "current content". */
  before: string | null;
}

export interface PlannedJob {
  request: CiJobRequest;
  file: PlannedFile;
  flags: string[];
  scheduled: boolean;
  timeout: number | null;
}

export type Planned = { jobs: PlannedJob[]; refused: Array<{ job: string; why: string }> };

/** SR-6: arguments the catalog's flag table matches; code reads the table, the item recommends Reject on any. */
export function commandFlags(argvs: readonly string[][]): string[] {
  const programs = new Set(catalog.flags.programs.map((x) => x.toLowerCase()));
  const patterns = catalog.flags.patterns.map((x) => new RegExp(x, "i"));
  const out = new Set<string>();
  for (const argv of argvs) {
    for (const arg of argv) {
      for (const word of [arg, ...arg.split(/\s+/)]) {
        const base = word.split("/").pop()!.toLowerCase();
        if (programs.has(base) || patterns.some((p) => p.test(word))) out.add(word.slice(0, 200));
      }
    }
  }
  return [...out];
}

/** Job names a workflow file defines, as GitHub names their checks: the job's `name`, else its key. */
export function jobNames(text: string): string[] {
  try {
    const doc = YAML.parse(text, { maxAliasCount: 50 }) as { jobs?: Record<string, { name?: unknown }> } | null;
    return Object.entries(doc?.jobs ?? {}).map(([key, j]) => (typeof j?.name === "string" ? j.name : key));
  } catch {
    return [];
  }
}

/**
 * FR-4 as a check on the output too: whatever the renderer did, a file that
 * breaks a rule is never proposed. Code, not review, holds the line.
 */
export function renderedProblems(path: string, text: string): string[] {
  const out = prWorkflowProblems([{ path, text }]);
  let doc: Record<string, unknown>;
  try {
    doc = YAML.parse(text, { maxAliasCount: 0 }) as Record<string, unknown>;
  } catch (e) {
    return [...out, `${path} isn't valid YAML (${(e as Error).message.slice(0, 200)})`];
  }
  const allowed = new Set(["pull_request", "push", "workflow_dispatch", "schedule"]);
  for (const t of Object.keys((doc.on ?? {}) as object)) if (!allowed.has(t)) out.push(`${path} triggers on ${t}`);
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read" })) out.push(`${path} asks for more than contents: read`);
  if (/\bsecrets\./.test(text)) out.push(`${path} reads a secret`);
  for (const [key, job] of Object.entries((doc.jobs ?? {}) as Record<string, Record<string, unknown>>)) {
    if (job.permissions !== undefined) out.push(`${path} job ${key} sets its own permissions`);
    if (typeof job["timeout-minutes"] !== "number") out.push(`${path} job ${key} has no timeout`);
    for (const s of (job.steps ?? []) as Array<Record<string, unknown>>) {
      const uses = typeof s.uses === "string" ? s.uses : null;
      if (uses && !/^[a-z0-9-]+\/[a-z0-9._-]+@[0-9a-f]{40}$/i.test(uses)) out.push(`${path} uses ${uses}, which isn't pinned to a commit`);
      if (uses?.startsWith("actions/checkout@") && (s.with as Record<string, unknown> | undefined)?.["persist-credentials"] !== false) out.push(`${path} checks out with credentials kept`);
      if (uses && /cache/i.test(uses)) out.push(`${path} uses a cache action`);
      if (s.with && typeof s.with === "object" && "cache" in (s.with as object)) out.push(`${path} turns on a cache`);
    }
  }
  return out;
}

/** The engine's own job behind a factory check, or null when a factory file doesn't define it. */
function factoryOwner(main: MainView, job: string): { path: string; text: string } | null {
  return main.workflows.find((w) => w.path === workflowPath(job) && readHeader(w.text)?.job === job) ?? null;
}

/**
 * The files for one repo's requests. A request that breaks a rule is
 * refused with a reason the test engineer gets; the rest are planned.
 */
export function planJobs(raw: readonly unknown[], repo: string, main: MainView): Planned {
  const jobs: PlannedJob[] = [];
  const refused: Array<{ job: string; why: string }> = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const parsed = parseRequest(r);
    const job = typeof (r as { job?: unknown })?.job === "string" ? String((r as { job: string }).job).slice(0, 40) : "(unnamed)";
    if (!parsed.ok) {
      refused.push({ job, why: parsed.error });
      continue;
    }
    const q = parsed.request;
    if (q.repo !== repo) {
      refused.push({ job: q.job, why: `the feature builds in repo ${repo}, not ${q.repo}` });
      continue;
    }
    if (seen.has(q.job)) {
      refused.push({ job: q.job, why: "the same job is requested twice in one report" });
      continue;
    }
    seen.add(q.job);
    const path = workflowPath(q.job);
    const existing = main.workflows.find((w) => w.path === path) ?? null;
    const mine = factoryOwner(main, q.job);
    // FR-5: the engine touches only its own files.
    if (existing && !mine) {
      refused.push({ job: q.job, why: `${path} on main wasn't rendered by the engine, so it can't be changed through a request` });
      continue;
    }
    if (q.action === "add" && mine) {
      refused.push({ job: q.job, why: `${path} is already on main; ask for update instead` });
      continue;
    }
    if (q.action !== "add" && !mine) {
      refused.push({ job: q.job, why: `${path} isn't on main, so there is nothing to ${q.action}` });
      continue;
    }
    // FR-6, SR-8: the check name may not stand in for a check another workflow or app reports, or one main requires.
    const name = checkName(q.job);
    if (q.action === "add") {
      const others = main.workflows.filter((w) => w.path !== path).flatMap((w) => jobNames(w.text));
      if (others.includes(name) || main.checks.includes(name) || main.required.includes(name)) {
        refused.push({ job: q.job, why: `a check named ${name} already exists on main` });
        continue;
      }
    }
    if (q.action === "remove") {
      jobs.push({ request: q, file: { path, content: null, before: mine!.text }, flags: [], scheduled: false, timeout: null });
      continue;
    }
    const out = renderWorkflow(q);
    if (mine && mine.text === out.content) {
      refused.push({ job: q.job, why: `${path} on main is already what this update asks for` });
      continue;
    }
    const problems = renderedProblems(out.path, out.content);
    if (problems.length) {
      refused.push({ job: q.job, why: problems.slice(0, 3).join("; ") });
      continue;
    }
    const s = scheduleOf(q);
    jobs.push({ request: q, file: { path: out.path, content: out.content, before: mine?.text ?? null }, flags: commandFlags(commandsOf(q)), scheduled: s.scheduled, timeout: s.timeout });
  }
  return { jobs, refused };
}

/**
 * SR-8: `factory-*` check names that a workflow the engine didn't render
 * reports on main. Such a check could stand in for a factory job, so stage 9
 * won't count factory checks while one exists.
 */
export function impostorChecks(main: Pick<MainView, "workflows">): string[] {
  const own = (w: { path: string; text: string }) => { const h = readHeader(w.text); return !!h && w.path === workflowPath(h.job); };
  return [...new Set(main.workflows.filter((w) => !own(w)).flatMap((w) => jobNames(w.text)).filter((n) => n.startsWith("factory-")))];
}

/** Git's blob id of `content`, which GitHub reports for each file of a pull request. */
export function blobSha(content: string): string {
  const b = Buffer.from(content, "utf8");
  return crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
}

/** The changed files as GitHub lists them on the PR (`autoMergeHygiene`'s `diffHash` input). */
export function prFiles(files: readonly PlannedFile[]): Array<{ filename: string; status: string; sha: string }> {
  return files.map((f) => ({
    filename: f.path,
    status: f.content === null ? "removed" : f.before === null ? "added" : "modified",
    sha: f.content === null ? (f.before === null ? "" : blobSha(f.before)) : blobSha(f.content),
  }));
}

/** SR-10: the `ci_only` tests a job runs, by the request's `covers`. */
export function coveredCiOnly(covers: readonly string[], ciOnly: ReadonlyArray<{ test: string }>): string[] {
  const set = new Set(covers);
  return ciOnly.map((t) => t.test).filter((t) => set.has(t));
}

export { WORKFLOW_DIR };
