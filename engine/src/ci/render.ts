import * as crypto from "node:crypto";
import YAML from "yaml";
import catalog from "./catalog.json";
import type { CiJobRequest, Params, Template } from "./request";

/**
 * F-026 FR-2 to FR-5: engine code builds every CI workflow from a request.
 * The workflow is built as an object and written by the YAML library, so a
 * parameter can only ever be a value, never structure. Command arguments
 * reach the shell single-quoted; request.ts has already refused `${{` and
 * control characters in them.
 */

export const CATALOG_VERSION = catalog.version;
export const WORKFLOW_DIR = ".github/workflows";
/** The engine owns only these files (FR-5). */
export const workflowPath = (job: string) => `${WORKFLOW_DIR}/factory-${job}.yml`;
/** The check a job reports, which GitHub names after the job's `name` (FR-6). */
export const checkName = (job: string) => `factory-${job}`;

const HEADER_RE = /^# Rendered by the software factory engine \(F-026\)\. template=([a-z-]+) catalog=(\d+) job=([a-z][a-z0-9-]{0,31})\n/;

/** The header that marks a file as the engine's (FR-5). */
export function header(template: Template, job: string): string {
  return `# Rendered by the software factory engine (F-026). template=${template} catalog=${CATALOG_VERSION} job=${job}\n` +
    "# Changes go through a factory CI job request and the owner's approval, not by hand.\n";
}

/** The template and job a file's header names, or null when the engine didn't render it. */
export function readHeader(text: string): { template: string; catalog: number; job: string } | null {
  const m = HEADER_RE.exec(text);
  return m ? { template: m[1]!, catalog: Number(m[2]), job: m[3]! } : null;
}

/** POSIX shell single quotes: the only character to handle is `'` itself. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'"'"'`)}'`;
}

const line = (argv: readonly string[]) => argv.map(shellQuote).join(" ");

/** A weekly time spread by job name, so a project's scheduled jobs don't all start at once. */
export function weeklyCron(job: string): string {
  const h = crypto.createHash("sha256").update(job).digest();
  return `${h[0]! % 60} ${h[1]! % 24} * * ${1 + (h[2]! % 5)}`;
}

type Step = Record<string, unknown>;

const checkout = (fullHistory = false): Step => ({
  name: "Check out",
  uses: catalog.actions.checkout.uses,
  with: { "persist-credentials": false, ...(fullHistory ? { "fetch-depth": 0 } : {}) },
});

function runtimeStep(r: Params<"test-command">["runtime"]): Step {
  // SR-7: no Actions cache (neither setup action caches unless asked), so a pull request run can't plant what main restores.
  return r.language === "python"
    ? { name: `Set up Python ${r.version}`, uses: catalog.actions["setup-python"].uses, with: { "python-version": r.version } }
    : { name: `Set up Node ${r.version}`, uses: catalog.actions["setup-node"].uses, with: { "node-version": r.version } };
}

function commandSteps(p: Params<"test-command">): Step[] {
  return [
    checkout(),
    runtimeStep(p.runtime),
    ...p.setup.map((a, i) => ({ name: `Install (${i + 1})`, run: line(a) })),
    { name: "Run", run: line(p.run) },
  ];
}

/** Coverage from a Cobertura report, checked by fixed code; the path and minimum arrive as environment values. */
const COVERAGE_CHECK = [
  "import os, sys, xml.etree.ElementTree as ET",
  "root = ET.parse(os.environ['REPORT']).getroot()",
  "rate = float(root.get('line-rate', '0')) * 100",
  "need = float(os.environ['MIN_PERCENT'])",
  "print(f'Line coverage {rate:.2f}% (minimum {need:g}%)')",
  "sys.exit(0 if rate >= need else 1)",
].join("\n");

function steps(r: Extract<CiJobRequest, { action: "add" | "update" }>): Step[] {
  switch (r.template) {
    case "test-command":
      return commandSteps(r.params);
    case "coverage":
      return [
        ...commandSteps(r.params),
        { name: "Check coverage", run: `python3 -c "$CHECK"`, env: { CHECK: COVERAGE_CHECK, REPORT: r.params.report, MIN_PERCENT: String(r.params.min_percent) } },
      ];
    case "gitleaks": {
      const t = catalog.tools.gitleaks;
      return [
        checkout(true),
        {
          name: `Install gitleaks ${t.version}`,
          run: [
            `curl -fsSL -o "$RUNNER_TEMP/gitleaks.tgz" ${t.url}`,
            `echo "${t.sha256}  $RUNNER_TEMP/gitleaks.tgz" | sha256sum --check --strict`,
            `tar -xzf "$RUNNER_TEMP/gitleaks.tgz" -C "$RUNNER_TEMP" gitleaks`,
          ].join("\n"),
        },
        { name: "Scan history", run: `"$RUNNER_TEMP/gitleaks" git --redact --no-banner --exit-code 1 .` },
      ];
    }
    case "semgrep":
      return [
        checkout(),
        { name: "Semgrep", run: `semgrep scan ${r.params.configs.map((c) => `--config ${shellQuote(c)}`).join(" ")} --metrics=off --disable-nosem --error` },
      ];
    case "osv-scanner": {
      const t = catalog.tools["osv-scanner"];
      const target = r.params.lockfiles.length ? r.params.lockfiles.map((l) => `-L ${shellQuote(l)}`).join(" ") : "--recursive --no-resolve .";
      return [
        checkout(),
        {
          name: `Install OSV-Scanner ${t.version}`,
          run: [
            `curl -fsSL -o "$RUNNER_TEMP/osv-scanner" ${t.url}`,
            `echo "${t.sha256}  $RUNNER_TEMP/osv-scanner" | sha256sum --check --strict`,
            `chmod 0755 "$RUNNER_TEMP/osv-scanner"`,
          ].join("\n"),
        },
        { name: "Scan", run: `"$RUNNER_TEMP/osv-scanner" scan source ${target}` },
      ];
    }
  }
}

const scheduled = (r: Extract<CiJobRequest, { action: "add" | "update" }>): boolean =>
  (r.template === "test-command" || r.template === "coverage" || r.template === "osv-scanner") && r.params.schedule;

/** FR-2 to FR-4: the workflow file for an add or update request. */
export function renderWorkflow(r: Extract<CiJobRequest, { action: "add" | "update" }>, base = "main"): { path: string; content: string } {
  const name = checkName(r.job);
  const on: Record<string, unknown> = {
    pull_request: { branches: [base] },
    push: { branches: [base] },
    workflow_dispatch: {},
    ...(scheduled(r) ? { schedule: [{ cron: weeklyCron(r.job) }] } : {}),
  };
  const job: Record<string, unknown> = {
    name,
    "runs-on": catalog.runner,
    "timeout-minutes": r.params.timeout_minutes,
    ...(r.template === "semgrep" ? { container: { image: catalog.tools.semgrep.image } } : {}),
    steps: steps(r),
  };
  const doc = {
    name,
    on,
    permissions: { contents: "read" },
    concurrency: { group: `${name}-\${{ github.ref }}`, "cancel-in-progress": true },
    jobs: { [name]: job },
  };
  const body = YAML.stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
  return { path: workflowPath(r.job), content: header(r.template, r.job) + body };
}

/** Whether a rendered workflow runs on a schedule, and its timeout, for the item (SR-12). */
export function scheduleOf(r: CiJobRequest): { scheduled: boolean; timeout: number | null } {
  if (r.action === "remove") return { scheduled: false, timeout: null };
  return { scheduled: scheduled(r), timeout: r.params.timeout_minutes };
}

/** Each command argument list a request runs, for the item and the flag check (SR-6). */
export function commandsOf(r: CiJobRequest): string[][] {
  if (r.action === "remove") return [];
  if (r.template === "test-command" || r.template === "coverage") return [...r.params.setup, r.params.run];
  return [];
}
