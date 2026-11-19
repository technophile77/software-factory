import { z } from "zod";

/**
 * Filed alerts v1.0 (F-023 FR-8): `alerts/filed.json` on the config repo's
 * factory/state. The Security items the engine has filed, by a hash of the
 * project name and the alert's key, so a project moved to another factory
 * doesn't file the same alert twice. Only hashes and item ids: the keys can
 * name local detail, and factory/state may be pushed to GitHub.
 */
export const FILED_ALERTS_SCHEMA = "filed-alerts/1.0";
export const FILED_ALERTS_PATH = "alerts/filed.json";

export const filedAlerts = z.strictObject({
  schema: z.literal(FILED_ALERTS_SCHEMA),
  alerts: z.record(z.string().regex(/^[0-9a-f]{64}$/), z.string().regex(/^[A-Z]-\d{4,8}$/)),
});

export type FiledAlerts = z.infer<typeof filedAlerts>;
