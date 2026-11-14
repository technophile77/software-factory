import { z } from "zod";

/**
 * Inbox item v4.0 (F-020 FR-4, H-0241): the record of one inbox item, as
 * JSON on the config repo's factory/state. Strict at every level (F-020
 * SR-6): an unknown key is refused, never stripped, and every list and
 * string has a cap so a forged record can't make the engine read without
 * bound.
 */

const text = (max: number) => z.string().max(max);
const id = z.string().regex(/^[DTHSMN]-\d{4,}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const ghId = z.number().int().nonnegative();
const at = z.string().max(40);
const kind = z.enum(["decision", "testing", "hygiene", "spec", "maturity", "notice"]);
const category = z.enum(["Product", "Architecture", "Interfaces", "Assumptions", "Security"]);
const priority = z.enum(["critical", "high", "medium", "low"]);
const status = z.enum(["open", "approved", "chosen", "rejected", "changes_requested", "research_requested", "deferred", "dismissed", "closed"]);
const historyAction = z.enum([
  "filed", "revised", "confirm_requested", "closed", "migrated", "reopened", "effect_done",
  "chosen", "approved", "rejected", "changes_requested", "research_requested", "deferred", "restored", "dismissed", "step_chosen",
]);
const source = z.enum(["reaction", "command"]);
/** F-021 (H-0246): owner answers may also come from the console, proven by a file in the engine folder. */
const answerSource = z.enum(["reaction", "command", "console"]);

const option = z.strictObject({ id: text(3), label: text(500) });
const link = z.strictObject({ kind: text(40), ref: text(2000) });

const history = z.strictObject({
  at,
  by: z.enum(["engine", "owner"]),
  action: historyAction,
  option: text(3).optional(),
  step: z.number().int().min(1).max(99).optional(),
  rev: z.number().int().min(1).optional(),
  source: answerSource.optional(),
  /** Console answers only: whether the console session signed in to GitHub (F-021 FR-13). */
  signed_in: z.boolean().optional(),
  /** Console answers only: sha256 of the entry without this field, as the local answer file holds it (F-021 FR-10). */
  console_answer: sha.optional(),
  actor_id: ghId.optional(),
  comment_id: ghId.optional(),
  reaction_id: ghId.optional(),
  ref: text(2000).optional(),
  note: text(4000).optional(),
  confirmed_by: z.union([z.strictObject({ source, comment_id: ghId, reaction_id: ghId.optional() }), z.strictObject({ source: z.literal("console") })]).optional(),
  pending: text(200).optional(),
  /** confirm_requested only: the owner's action waiting for its confirmation. */
  chosen: z.strictObject({ action: text(200), source, comment_id: ghId, reaction_id: ghId.optional(), url: text(2000), note: text(4000).optional() }).optional(),
  code: text(8).optional(),
  effect: text(100).optional(),
  stage: text(100).optional(),
  from: text(500).optional(),
});

const revision = z.strictObject({
  rev: z.number().int().min(1),
  body_sha256: sha,
  issue_body_sha256: sha.optional(),
  action_comments: z.array(z.strictObject({ id: ghId, action: text(200), sha256: sha })).max(50),
  dispatched: z.boolean().optional(),
});

/** Engine-written values only (F-016 SR-4); open keys, but each value a bounded string, a number or null. */
const effect = z.object({ type: text(100) }).catchall(z.union([text(500), z.number(), z.null()]));

export const INBOX_RECORD_SCHEMA = "inbox-record/4.0";

export const inboxRecord = z.strictObject({
  schema: z.literal(INBOX_RECORD_SCHEMA),
  id,
  kind,
  title: text(500),
  category: category.optional(),
  priority,
  effective_priority: priority,
  blocking: z.boolean(),
  status,
  repo: text(200),
  feature: text(40).optional(),
  created_by: text(100),
  created_at: at,
  issue: ghId.optional(),
  options: z.array(option).max(4).optional(),
  recommendation: text(3).optional(),
  steps: z.array(text(2000)).max(20).optional(),
  links: z.array(link).max(50),
  effect: effect.optional(),
  key: text(500).optional(),
  revisions: z.array(revision).min(1).max(200),
  engine_comments: z.array(ghId).max(2000),
  refused: z.array(z.strictObject({ comment_id: ghId.optional(), reaction_id: ghId.optional(), reason: text(500) })).max(2000).optional(),
  history: z.array(history).max(5000),
});

export type InboxRecordData = z.infer<typeof inboxRecord>;
