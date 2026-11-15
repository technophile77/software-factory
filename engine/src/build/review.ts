import { globMatch } from "../policy/glob";
import { blocksAt } from "../st-review/flow";
import type { Standards } from "../st-review/standards";
import allowance from "./judge-allowance.json";

/**
 * Stages 7 and 8 as code (F-015 FR-8, FR-9): the reviewer and the judge
 * report facts, and these decide what blocks and where the feature goes.
 */

export interface CodeReviewFinding {
  criterion: string;
  severity: string;
  location: string;
  explanation: string;
  fix: string;
  /** From the severity and the repo's maturity (security-blocking.json), never the reviewer's say. */
  blocks: boolean;
}

/** A Code Review report body (already shape-checked) against the standards it was given; a string says why it is refused. */
export function checkCodeReview(body: unknown, standards: Pick<Standards, "criteria" | "severities">, maturity: string): CodeReviewFinding[] | string {
  const b = body as { gate?: unknown; findings?: Array<Record<string, unknown>> };
  if (b?.gate !== 2) return "body.gate must be 2 for Code Review";
  if (!Array.isArray(b.findings)) return "body.findings must be a list (empty if there are none)";
  const out: CodeReviewFinding[] = [];
  for (const [i, f] of b.findings.entries()) {
    if (typeof f.criterion !== "string" || !standards.criteria.has(f.criterion)) return `body.findings[${i}].criterion must be a criterion id from the standards you were given`;
    if (typeof f.severity !== "string" || !standards.severities.includes(f.severity)) return `body.findings[${i}].severity must be one of ${standards.severities.join(", ")}`;
    if (f.needs_owner !== undefined || f.options !== undefined) return `body.findings[${i}] can't ask the owner at Code Review: grade it and the engine decides`;
    out.push({ criterion: f.criterion, severity: f.severity, location: String(f.location), explanation: String(f.explanation), fix: String(f.fix), blocks: blocksAt(f.severity, maturity) });
  }
  return out;
}

export type JudgeAction = "pass" | "fail_product" | "fail_tests" | "needs_human";

export interface JudgeOutcome {
  action: JudgeAction;
  /** The engine's verdict; the judge's own is kept beside it when they differ. */
  verdict: "PASS" | "FAIL" | "NEEDS_HUMAN_REVIEW";
  /** What decided it, in engine words with the judge's text quoted as data. */
  reasons: string[];
}

const STATUSES = { met: "met", "not met": "not_met", "needs owner": "needs_owner" } as const;
const GRADES = ["blocking", "major", "minor"] as const;
const MAJORS = allowance as { levels: Record<string, number | null> };

/**
 * The validation verdict from the judge's checklist and graded findings
 * (validation-judge AGENT.md § Verdict, open decision 8). A failure goes to
 * the test engineer only when everything that failed is theirs: findings
 * located in the test engineer's write paths, or checklist lines about
 * acceptance-criterion evidence or test tools. Otherwise it is the developer's.
 */
export function judgeOutcome(body: unknown, maturity: string, testGlobs: readonly string[]): JudgeOutcome | string {
  const b = body as { checklist?: Array<Record<string, unknown>>; findings?: Array<Record<string, unknown>> };
  if (!Array.isArray(b?.checklist) || !b.checklist.length) return "body.checklist must mark every area of the evidence checklist";
  if (!Array.isArray(b.findings)) return "body.findings must be a list (empty if there are none)";
  const lines: Array<{ area: string; status: (typeof STATUSES)[keyof typeof STATUSES] }> = [];
  for (const [i, c] of b.checklist.entries()) {
    const status = STATUSES[String(c.status).trim().toLowerCase() as keyof typeof STATUSES];
    if (!status) return `body.checklist[${i}].status must be Met, Not met or Needs owner`;
    lines.push({ area: String(c.area), status });
  }
  const findings: Array<{ grade: (typeof GRADES)[number]; location: string }> = [];
  for (const [i, f] of b.findings.entries()) {
    const grade = String(f.grade).trim().toLowerCase() as (typeof GRADES)[number];
    if (!GRADES.includes(grade)) return `body.findings[${i}].grade must be Blocking, Major or Minor`;
    findings.push({ grade, location: String(f.location) });
  }
  const owner = lines.filter((l) => l.status === "needs_owner");
  if (owner.length) return { action: "needs_human", verdict: "NEEDS_HUMAN_REVIEW", reasons: owner.map((l) => `needs the owner: ${JSON.stringify(l.area)}`) };

  const allowed = maturity in MAJORS.levels ? MAJORS.levels[maturity]! : 0;
  const majors = findings.filter((f) => f.grade === "major");
  const failing = [
    ...lines.filter((l) => l.status === "not_met").map((l) => ({ test: /acceptance criterion|test tool/i.test(l.area), why: `not met: ${JSON.stringify(l.area)}` })),
    ...findings.filter((f) => f.grade === "blocking").map((f) => ({ test: inTests(f.location, testGlobs), why: `blocking finding at ${JSON.stringify(f.location)}` })),
    ...(allowed !== null && majors.length > allowed ? majors.map((f) => ({ test: inTests(f.location, testGlobs), why: `major finding at ${JSON.stringify(f.location)}, over the ${allowed} allowed at ${maturity || "an unknown level"}` })) : []),
  ];
  if (!failing.length) return { action: "pass", verdict: "PASS", reasons: [] };
  return { action: failing.every((x) => x.test) ? "fail_tests" : "fail_product", verdict: "FAIL", reasons: failing.map((x) => x.why) };
}

/** A finding's file, from a `path:line` location, is under the test engineer's write paths. */
function inTests(location: string, globs: readonly string[]): boolean {
  const file = location.trim().replace(/\\/g, "/").replace(/:\d+(:\d+)?$/, "").replace(/^\.\//, "");
  return !!file && globs.some((g) => globMatch(g, file, false));
}

/**
 * What the owner reads to decide a NEEDS HUMAN REVIEW item: the judge's
 * Needs owner lines with their evidence, then its findings, as the judge
 * wrote them. Without it the item named only a file on factory/state.
 */
export function judgeQuestions(body: unknown, max = 12_000): string {
  const b = body as { checklist?: Array<Record<string, unknown>>; findings?: Array<Record<string, unknown>> };
  const owner = (Array.isArray(b?.checklist) ? b.checklist : []).filter((c) => STATUSES[String(c.status).trim().toLowerCase() as keyof typeof STATUSES] === "needs_owner");
  const findings = Array.isArray(b?.findings) ? b.findings : [];
  const parts = [
    ...owner.map((c) => `Needs your call: ${String(c.area)}\n${String(c.evidence ?? "")}`),
    ...findings.map((f) => `${String(f.grade)} finding at ${String(f.location)}\n${String(f.explanation ?? "")}`),
  ];
  const text = parts.join("\n\n");
  return text.length > max ? `${text.slice(0, max)}\n\n(cut; the full report is on factory/state)` : text;
}

