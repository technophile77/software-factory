import { z } from "zod";

/**
 * F-026 FR-1, FR-2, FR-3 (H-0282, H-0283): a CI job request, as the test
 * engineer reports it in `ci_jobs`. Templates only (OQ-2): the agent picks a
 * template and fills its params; it never writes YAML. Every string that
 * reaches the rendered workflow is checked here, so a value can't add a
 * GitHub expression, a new line or a path outside the repo.
 */

export const CI_JOB_REQUEST_SCHEMA = "ci-job-request/1.0";
export const TEMPLATES = ["test-command", "coverage", "gitleaks", "semgrep", "osv-scanner"] as const;
export type Template = (typeof TEMPLATES)[number];

export const JOB_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Text the workflow carries: no `${{` (Actions would evaluate it before the shell sees it), no control characters. */
const safe = (max: number) =>
  z.string().min(1).max(max).refine((s) => !s.includes("${{") && !/[\u0000-\u001f\u007f]/.test(s), "may not hold ${{ or a control character");

/** A path inside the repo: relative, `/`-separated, no `..`, no glob or shell characters. */
export const repoPath = z.string().min(1).max(300).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/, "must be a relative path inside the repo");

const argv = z.array(safe(500)).min(1).max(40);

const runtime = z.discriminatedUnion("language", [
  z.strictObject({ language: z.literal("python"), version: z.string().regex(/^3\.\d{1,2}(\.\d{1,2})?$/) }),
  z.strictObject({ language: z.literal("node"), version: z.string().regex(/^\d{2}(\.\d{1,2}){0,2}$/) }),
]);

const testCommand = z.strictObject({
  runtime,
  /** Install steps, each an argument list, run in order before `run`. */
  setup: z.array(argv).max(5).default([]),
  run: argv,
  /** Also run weekly on main (fuzz and other long suites). */
  schedule: z.boolean().default(false),
  timeout_minutes: z.number().int().min(1).max(120).default(30),
});

const coverage = testCommand.extend({
  /** The Cobertura XML report `run` writes (coverage.py `coverage xml`, Jest/Vitest `cobertura`). */
  report: repoPath,
  min_percent: z.number().min(0).max(100),
});

const gitleaks = z.strictObject({ timeout_minutes: z.number().int().min(1).max(60).default(15) });

const semgrep = z.strictObject({
  /** Registry rule sets (`p/<name>`) or rule files in the repo. */
  configs: z.array(z.union([z.string().regex(/^p\/[a-z0-9][a-z0-9-]{0,63}$/), repoPath])).min(1).max(10),
  timeout_minutes: z.number().int().min(1).max(60).default(20),
});

const osv = z.strictObject({
  /** Lockfiles to scan; none scans the repo recursively. */
  lockfiles: z.array(repoPath).max(20).default([]),
  schedule: z.boolean().default(true),
  timeout_minutes: z.number().int().min(1).max(60).default(15),
});

export const PARAMS = { "test-command": testCommand, coverage, gitleaks, semgrep, "osv-scanner": osv } as const;
export type Params<T extends Template> = z.output<(typeof PARAMS)[T]>;

const ids = z.array(z.string().min(1).max(300)).max(200);

/** What the agent reports: `params` is checked against its template in `parseRequest`. */
export const ciJobRequest = z.strictObject({
  repo: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
  job: z.string().regex(JOB_RE),
  action: z.enum(["add", "update", "remove"]),
  template: z.enum(TEMPLATES).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** Test ids and AC ids the job runs (SR-10 joins these with `ci_only`). */
  covers: ids.default([]),
  reason: z.string().min(1).max(1000),
});

export type CiJobRequestInput = z.input<typeof ciJobRequest>;

export type CiJobRequest =
  | { repo: string; job: string; action: "remove"; covers: string[]; reason: string }
  | { [T in Template]: { repo: string; job: string; action: "add" | "update"; template: T; params: Params<T>; covers: string[]; reason: string } }[Template];

/** A request checked against its template; the error names what is wrong, for the test engineer. */
export function parseRequest(raw: unknown): { ok: true; request: CiJobRequest } | { ok: false; error: string } {
  const base = ciJobRequest.safeParse(raw);
  if (!base.success) return { ok: false, error: issues(base.error) };
  const r = base.data;
  if (r.action === "remove") {
    if (r.template !== undefined || r.params !== undefined) return { ok: false, error: "a remove request takes no template or params" };
    return { ok: true, request: { repo: r.repo, job: r.job, action: "remove", covers: r.covers, reason: r.reason } };
  }
  if (!r.template) return { ok: false, error: `an ${r.action} request needs a template (one of ${TEMPLATES.join(", ")})` };
  const params = PARAMS[r.template].safeParse(r.params ?? {});
  if (!params.success) return { ok: false, error: `params for ${r.template}: ${issues(params.error)}` };
  return { ok: true, request: { repo: r.repo, job: r.job, action: r.action, template: r.template, params: params.data, covers: r.covers, reason: r.reason } as CiJobRequest };
}

function issues(e: z.ZodError): string {
  return e.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(request)"}: ${i.message}`).join("; ").slice(0, 1000);
}
