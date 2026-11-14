import { z } from "zod";

/** Run review v1.0, Tuning metrics v1.1 and Calibration result v1.0 (F-002 A-8; F-020 FR-1). */

const text = (max: number) => z.string().max(max);
const role = text(60);
const rung = z.number().int().min(1).max(20);
const usage = z.strictObject({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0), cost_usd: z.number().min(0), duration_s: z.number().min(0) });
const spread = z.strictObject({ median: z.number().min(0), p90: z.number().min(0) });
const hygieneId = z.string().regex(/^H-\d{4,}$/);

export const runReview = z.strictObject({
  schema: z.literal("run-review/1.0"),
  feature: z.string().regex(/^F-\d{3,6}$/),
  outcome: z.enum(["pr_opened", "stopped"]),
  derived_complexity: z.enum(["simple", "moderate", "complex"]),
  evaluator: z.strictObject({ predicted: z.record(role, rung), correct: z.boolean() }),
  transcripts_proposed: z.array(z.strictObject({ role, ref: text(2000), action: z.enum(["add", "remove"]) })).max(50),
  roles: z.array(z.strictObject({
    role, rung, runs: z.number().int().min(0), first_try_pass: z.boolean(), fix_cycles: z.number().int().min(0), reruns: z.number().int().min(0),
    attributed_failures: z.array(z.strictObject({ cause: text(100), stage: text(60), report: text(500) })).max(200),
    usage,
    suggestions_filed: z.array(hygieneId).max(50),
  })).max(20),
});

export const tuningMetrics = z.strictObject({
  schema: z.literal("tuning-metrics/1.0"),
  updated_at: text(40),
  cost_unit: z.enum(["usd", "plan_usage"]),
  prices: z.strictObject({ source: text(2000), as_of: text(40) }),
  roles: z.record(role, z.strictObject({
    ladder_order: z.array(rung).max(20),
    rungs: z.record(z.string().regex(/^\d{1,2}$/), z.strictObject({
      samples: z.number().int().min(0), passes: z.number().int().min(0),
      tokens: spread, cost_usd: spread, duration_s: spread,
      by_repo: z.record(text(200), z.strictObject({ samples: z.number().int().min(0), passes: z.number().int().min(0) })),
    })),
  })),
});

export const calibrationResult = z.strictObject({
  schema: z.literal("calibration-result/1.0"),
  reason: z.enum(["initial", "owner_request", "step_down_check"]),
  source: text(100),
  ladder_version: text(100),
  estimated_cost_usd: z.number().min(0),
  actual_cost_usd: z.number().min(0),
  stopped_at_cap: z.boolean(),
  roles: z.array(z.strictObject({
    role,
    tried: z.array(z.strictObject({ rung, trials: z.number().int().min(0), passes: z.number().int().min(0), tokens: z.number().int().min(0), cost_usd: z.number().min(0), passed: z.boolean() })).max(20),
    proposed_rung: rung,
  })).max(20),
});
