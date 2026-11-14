import { z } from "zod";
import { ROLE_BODIES, modelReport, storedReport } from "./agent-report";
import { inboxRecord } from "./inbox-record";
import { prRecord } from "./pr-record";
import { calibrationResult, runReview, tuningMetrics } from "./tuning";

/**
 * Every JSON format the engine owns, by the name and major version its
 * `schema` field carries (F-020 FR-1, FR-2). `scripts/write-schemas.ts`
 * writes each to `docs/schemas/<name>.schema.json`; a test fails when a
 * committed file differs.
 */
export const SCHEMAS: Record<string, z.ZodType> = {
  "inbox-record-4": inboxRecord,
  "pr-record-1": prRecord,
  "agent-report-1": storedReport,
  ...Object.fromEntries(Object.keys(ROLE_BODIES).map((r) => [`agent-report-1.${r}`, modelReport(r as keyof typeof ROLE_BODIES)])),
  "run-review-1": runReview,
  "tuning-metrics-1": tuningMetrics,
  "calibration-result-1": calibrationResult,
};

/** The JSON Schema text for one format, as committed under docs/schemas/. */
export function jsonSchemaText(name: string): string {
  return JSON.stringify(z.toJSONSchema(SCHEMAS[name]!, { target: "draft-2020-12" }), null, 2) + "\n";
}
