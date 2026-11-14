import { z } from "zod";

/**
 * PR record v1.0 (Inbox item v4.0, F-020 FR-5): `prs/<owner>/<repo>/<n>.json`
 * on the config repo's factory/state. Defined before F-015 writes it, so it
 * is JSON from the first record.
 */

const text = (max: number) => z.string().max(max);
const ghId = z.number().int().nonnegative();
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export const PR_RECORD_SCHEMA = "pr-record/1.0";

export const prRecord = z.strictObject({
  schema: z.literal(PR_RECORD_SCHEMA),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  number: z.number().int().min(1),
  feature: z.string().regex(/^F-\d{3,6}$/),
  evidence_comment_id: ghId.optional(),
  head: sha.optional(),
  history: z.array(z.discriminatedUnion("action", [
    z.strictObject({ at: text(40), action: z.literal("evidence_posted"), comment_id: ghId, head: sha }),
    z.strictObject({ at: text(40), action: z.literal("changes_requested"), comment_id: ghId, actor_id: ghId }),
    z.strictObject({ at: text(40), action: z.literal("merged_on_github"), merge_commit: sha, merged_by: text(100) }),
    z.strictObject({ at: text(40), action: z.literal("closed_on_github") }),
  ])).max(1000),
});

export type PrRecord = z.infer<typeof prRecord>;
