import { z } from "zod";

/**
 * Agent report v1.6 (F-020 FR-1, FR-8, H-0242). Two shapes:
 * - `modelReport(role)`: what the agent itself returns. It leaves out every
 *   field the engine fills (F-020 SR-7), so a report that sets one is refused.
 * - `storedReport`: the file on factory/state, the agent's part plus the
 *   engine's facts.
 * Gate 1 and readiness add context rules on top (the criteria and checklist
 * the reviewer was given, the feature and commit), in their own validators.
 */

const text = (max: number) => z.string().max(max);
const list = <T extends z.ZodType>(t: T, max = 200) => z.array(t).max(max);
const itemId = z.string().regex(/^[DTHSMN]-\d{4,}$/);

export const AGENT_REPORT_SCHEMA = "agent-report/1.0";

const outcome = z.enum(["complete", "blocked", "failed", "partial"]);

/** Role-specific bodies, as the contract's table lists them. */
export const ROLE_BODIES = {
  "requirements-analyst": z.strictObject({
    spec_path: text(300), spec_version: z.number().int().min(1), open_assumptions: list(itemId),
  }),
  "software-developer": z.strictObject({
    files_changed: list(text(300), 2000), spec_deviations: list(text(2000)), not_done: list(text(2000)),
    /** v1.6: the documentation the change updated, which the judge checks. */
    docs_updated: list(text(300)),
  }),
  "test-engineer": z.strictObject({
    tests_run: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0),
    criteria_map: z.record(z.string().regex(/^AC-\d{1,3}$/), list(text(300))),
    failures: list(z.strictObject({ test: text(300), expected: text(2000), actual: text(2000), log_ref: text(500) }), 1000),
    not_run: list(z.strictObject({ test: text(300), reason: text(1000) }), 1000),
    /** v1.6: the tool for each required test type, and why (testing-strategy.md § Test tools). */
    tool_choices: list(z.strictObject({ test_type: text(100), tool: text(200), reason: text(1000), approval_ref: text(500).nullable() }), 50),
  }),
  "security-reviewer": z.strictObject({
    gate: z.union([z.literal(1), z.literal(2)]),
    findings: list(z.strictObject({
      criterion: z.string().regex(/^[SP]\d{1,2}(\.\d{1,2})?$/), severity: text(20), location: text(500), explanation: text(4000), fix: text(4000),
      needs_owner: z.boolean().optional(),
      options: z.array(z.strictObject({ id: z.enum(["A", "B", "C", "D"]), label: text(200) })).min(2).max(4).optional(),
      recommendation: z.enum(["A", "B", "C", "D"]).optional(),
    })),
    checklist: list(z.strictObject({ question: text(500), answer: text(4000) }), 50).optional(),
    permissions_added: list(text(1000)).optional(),
    abuse_cases: list(text(1000)).optional(),
    not_applicable: list(z.strictObject({ criterion: z.string().regex(/^[SP]\d{1,2}(\.\d{1,2})?$/), reason: text(1000) })).optional(),
  }),
  "validation-judge": z.strictObject({
    verdict: z.enum(["PASS", "FAIL", "NEEDS_HUMAN_REVIEW"]),
    checklist: list(z.strictObject({ area: text(100), status: text(40), evidence: text(4000) })),
    findings: list(z.strictObject({ grade: text(40), location: text(500), explanation: text(4000) })),
  }),
  orchestrator: z.strictObject({
    gate: text(40),
    checks: list(z.strictObject({ name: text(100), passed: z.boolean(), evidence: text(2000) })),
    failures: list(z.strictObject({ test: text(300), cause: text(100), evidence: text(4000) }), 1000).optional(),
  }),
  "project-evaluator": z.strictObject({
    scope: z.enum(["project", "feature"]),
    complexity: z.enum(["simple", "moderate", "complex"]),
    predictions: z.record(text(60), z.strictObject({ rung: z.number().int().min(1).max(20), reason: text(1000) })),
    proposed_items: list(z.record(z.string(), z.unknown()), 50).optional(),
  }),
  "context-hygiene": z.strictObject({
    sizes: list(z.strictObject({ file: text(300), tokens: z.number().int().min(0), budget: z.number().int().min(0), change_since_last_review: z.number().int() })),
    duplicates: list(z.strictObject({ instruction: text(2000), locations: list(text(300), 50) })),
    skill_misses: list(z.strictObject({ run: text(100), skill: text(100), kind: z.enum(["not_loaded", "not_applicable"]) })),
    conflicts: list(z.strictObject({ location: text(300), explanation: text(2000) })),
    proposed_items: list(z.record(z.string(), z.unknown()), 50),
  }),
} as const;

export type ReportRole = keyof typeof ROLE_BODIES;

/** The report an agent returns: no engine-filled field is allowed (SR-7). */
export function modelReport<R extends ReportRole>(role: R) {
  return z.strictObject({
    schema: z.literal(AGENT_REPORT_SCHEMA),
    role: z.literal(role),
    feature: z.string().regex(/^F-\d{3,6}$/),
    stage: text(60),
    commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    outcome,
    summary: text(4000),
    body: ROLE_BODIES[role],
  });
}

const usage = z.strictObject({
  input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0), cost_usd: z.number().min(0), duration_s: z.number().min(0),
  plan_share: z.number().min(0).max(1).optional(),
});
const fallback = z.strictObject({ endpoint: text(60), reason: text(200), waited_s: z.number().min(0), prompt_tokens: z.number().int().min(0) });

/** The engine's facts (v1.1, v1.4) next to the agent's part. */
const facts = {
  items_filed: list(z.string().regex(/^[DTHSMN]-\d{4,}$/)),
  artifacts: list(z.strictObject({ kind: text(40), ref: text(2000) })),
  model: text(200).optional(),
  effort: text(20).optional(),
  rung: z.number().int().min(1).max(20).optional(),
  usage: usage.optional(),
  transcript_ref: text(2000).optional(),
  fallback: fallback.optional(),
  advisory: z.record(z.string(), z.unknown()).optional(),
  endpoint_rates: list(z.record(z.string(), z.unknown()), 50).optional(),
};

/** The stored report: any role's body, plus the engine's facts. */
export const storedReport = z.strictObject({
  schema: z.literal(AGENT_REPORT_SCHEMA),
  role: text(60),
  feature: z.string().regex(/^F-\d{3,6}$/),
  stage: text(60),
  commit: text(64),
  outcome,
  summary: text(4000),
  body: z.record(z.string(), z.unknown()),
  ...facts,
});
