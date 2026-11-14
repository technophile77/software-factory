import type { BuildEvent } from "../interview/model";
import type { RunReport } from "./test-run";

/**
 * Stage 6's failure table (testing-strategy.md § Failure handling) as code:
 * the orchestrator names causes, and this decides what happens next from the
 * counts in the build's own record (owner rule: code, not AI, makes policy).
 * The numbers come from `limits.yaml` `stage6` (H-0197).
 */

export const CAUSES = ["environment", "product_code", "test_code", "dependency", "unclear"] as const;
export type Cause = (typeof CAUSES)[number];

export interface Stage6Limits {
  environment_reruns: number;
  incomplete_reruns: number;
  product_fix_cycles: number;
  test_fix_cycles: number;
  unclear_investigations: number;
  flaky_per_test: number;
  disagreements: number;
  agent_hours: number;
}

export interface Stage6Counts {
  environmentReruns: number;
  incompleteReruns: number;
  productCycles: number;
  testCycles: number;
  agentMs: number;
  /** Times each test was found flaky: failed, classified environment, then passed on a rerun. */
  flaky: Map<string, number>;
  /** Each test's causes, in order, from the classifications. */
  causes: Map<string, Cause[]>;
  /** Tests classified environment in the last classification, still waiting on their rerun. */
  pendingEnvironment: string[];
}

/** The counts since the owner last sent the build on: an owner's answer starts the table again. */
export function stage6Counts(events: readonly BuildEvent[]): Stage6Counts {
  let from = 0;
  events.forEach((e, i) => {
    if (typeof e.item === "string" && e.action !== "escalate") from = i + 1;
  });
  const c: Stage6Counts = { environmentReruns: 0, incompleteReruns: 0, productCycles: 0, testCycles: 0, agentMs: 0, flaky: new Map(), causes: new Map(), pendingEnvironment: [] };
  for (const e of events.slice(from)) {
    if (typeof e.ms === "number" && e.stage6 === true) c.agentMs += e.ms;
    if (e.action === "rerun" && e.why === "incomplete") c.incompleteReruns++;
    if (e.action === "rerun" && e.why === "environment") c.environmentReruns++;
    if (e.action === "product_code") c.productCycles++;
    if (e.action === "test_code") c.testCycles++;
    const causes = e.causes && typeof e.causes === "object" ? (e.causes as Record<string, Cause>) : null;
    if (causes) {
      for (const [t, cause] of Object.entries(causes)) c.causes.set(t, [...(c.causes.get(t) ?? []), cause]);
      c.pendingEnvironment = Object.entries(causes).filter(([, cause]) => cause === "environment").map(([t]) => t);
    }
    if (Array.isArray(e.flaky)) for (const t of e.flaky as string[]) c.flaky.set(t, (c.flaky.get(t) ?? 0) + 1);
  }
  return c;
}

export type AfterRun =
  | { action: "passed"; flaky: string[] }
  | { action: "tests_failed" }
  | { action: "rerun"; why: "incomplete" }
  | { action: "escalate"; why: string; kind: "testing" | "decision" };

export function afterRun(report: RunReport, c: Stage6Counts, l: Stage6Limits): AfterRun {
  if (c.agentMs >= l.agent_hours * 3_600_000) return { action: "escalate", why: `stage 6 has used ${l.agent_hours} hours of agent time`, kind: "testing" };
  if (!report.complete) {
    if (c.incompleteReruns < l.incomplete_reruns) return { action: "rerun", why: "incomplete" };
    return { action: "escalate", why: `the run is incomplete (${report.incomplete}) after ${c.incompleteReruns} rerun${c.incompleteReruns === 1 ? "" : "s"}`, kind: "testing" };
  }
  if (report.failed > 0) return { action: "tests_failed" };
  const failing = new Set(report.failures.map((f) => f.test));
  const flaky = c.pendingEnvironment.filter((t) => !failing.has(t));
  const over = flaky.filter((t) => (c.flaky.get(t) ?? 0) + 1 >= l.flaky_per_test);
  if (over.length) return { action: "escalate", why: `${over.slice(0, 5).join(", ")} ${over.length === 1 ? "has" : "have"} been flaky ${l.flaky_per_test} times in this feature`, kind: "testing" };
  return { action: "passed", flaky };
}

export type AfterClassify =
  | { action: "product_code" | "test_code" }
  | { action: "rerun"; why: "environment" }
  | { action: "escalate"; why: string; kind: "testing" | "decision" };

export function afterClassify(causes: Record<string, Cause>, c: Stage6Counts, l: Stage6Limits): AfterClassify {
  const all = Object.values(causes);
  const tests = (cause: Cause) => Object.entries(causes).filter(([, x]) => x === cause).map(([t]) => t);
  if (c.agentMs >= l.agent_hours * 3_600_000) return { action: "escalate", why: `stage 6 has used ${l.agent_hours} hours of agent time`, kind: "testing" };
  if (all.includes("dependency")) return { action: "escalate", why: `a dependency fails ${tests("dependency").slice(0, 5).join(", ")}`, kind: "testing" };
  if (all.includes("unclear")) return { action: "escalate", why: `the cause of ${tests("unclear").slice(0, 5).join(", ")} is still unclear after the orchestrator investigated`, kind: "testing" };
  // Developer and test engineer going back and forth on one test is the owner's call (Assumptions or Product).
  for (const [t, cause] of Object.entries(causes)) {
    if (cause !== "product_code" && cause !== "test_code") continue;
    const seq = [...(c.causes.get(t) ?? []), cause].filter((x) => x === "product_code" || x === "test_code");
    let switches = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
    if (switches >= l.disagreements) return { action: "escalate", why: `the developer and test engineer have gone back and forth on ${t} ${switches} times`, kind: "decision" };
  }
  if (all.includes("product_code")) {
    if (c.productCycles >= l.product_fix_cycles) return { action: "escalate", why: `product code still fails after ${c.productCycles} fix cycles`, kind: "testing" };
    return { action: "product_code" };
  }
  if (all.includes("test_code")) {
    if (c.testCycles >= l.test_fix_cycles) return { action: "escalate", why: `test code still fails after ${c.testCycles} fix cycles`, kind: "testing" };
    return { action: "test_code" };
  }
  if (c.environmentReruns >= l.environment_reruns) return { action: "escalate", why: `the environment still fails after ${c.environmentReruns} reruns`, kind: "testing" };
  return { action: "rerun", why: "environment" };
}

/**
 * SR-10: the classifier's failures must be exactly the run's failures, each
 * with a known cause and at most 2 KiB of evidence. Null when valid.
 */
export function checkClassification(failures: unknown, failed: readonly string[]): { causes: Record<string, Cause>; evidence: Record<string, string> } | string {
  if (!Array.isArray(failures)) return "the report has no failures list";
  const causes: Record<string, Cause> = {};
  const evidence: Record<string, string> = {};
  for (const f of failures as Array<{ test?: unknown; cause?: unknown; evidence?: unknown }>) {
    if (typeof f?.test !== "string" || !failed.includes(f.test)) return `${JSON.stringify(String(f?.test ?? "")).slice(0, 80)} isn't one of the run's failures`;
    if (typeof f.cause !== "string" || !(CAUSES as readonly string[]).includes(f.cause)) return `the cause for ${f.test} isn't one of ${CAUSES.join(", ")}`;
    if (typeof f.evidence !== "string" || Buffer.byteLength(f.evidence) > 2048) return `the evidence for ${f.test} is missing or over 2 KiB`;
    if (causes[f.test]) return `${f.test} is classified twice`;
    causes[f.test] = f.cause as Cause;
    evidence[f.test] = f.evidence;
  }
  const missing = failed.filter((t) => !causes[t]);
  if (missing.length) return `no cause for ${missing.slice(0, 5).join(", ")}`;
  return { causes, evidence };
}
