/**
 * The owner renamed "Security Gate 1" to the Security and Testability Review
 * and "Security Gate 2" to the Code Review (2026-11-14). Transcripts, inbox
 * records and run records written before that are hash-chained or already on
 * GitHub, so they keep their old ids; the engine maps them to the new ids
 * wherever it reads them. Nothing new is ever written with an old id.
 */

export const LEGACY_ST_REVIEW_STAGE = "security_gate_1";

const STAGES: Record<string, string> = {
  [LEGACY_ST_REVIEW_STAGE]: "security_testability_review",
  security_gate_2: "code_review",
};

/** Old effect and alert types; transcript entry types and return reasons follow the `gate1_` rule. */
const TYPES: Record<string, string> = {
  gate1cap: "streviewcap",
  gate1unresolved: "streviewunresolved",
};

export function currentStage(stage: string): string {
  return STAGES[stage] ?? stage;
}

export function currentType(type: string): string {
  if (type.startsWith("gate1_")) return `st_review_${type.slice(6)}`;
  return TYPES[type] ?? type;
}

/** The pre-rename form of an alert key, so an alert filed under its old key isn't filed again. */
export function legacyAlertKey(key: string): string | null {
  for (const [old, now] of Object.entries(TYPES)) if (key.startsWith(`${now}:`)) return old + key.slice(now.length);
  return null;
}

/** Finding references: "Security and Testability Review #3", or "Gate 1 #3" in specs written before the rename. */
export const FINDING_TAG_SOURCE = "(?:Security and Testability Review|Gate 1)";

/** Spec section 9's source column, current and pre-rename (specs already signed off keep the old header). */
export const SECTION9_SOURCE_HEADERS = ["Source (analyst / Security and Testability Review)", "Source (analyst / Gate 1)"];
