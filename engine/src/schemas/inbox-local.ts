import { z } from "zod";

/**
 * F-021 (H-0246): what the inbox keeps only in the engine folder on the PC,
 * never on factory/state: an item's private detail (FR-4) and the proof of
 * each console answer (FR-10).
 */

const id = z.string().regex(/^[DTHSMN]-\d{4,}$/);
export const MAX_PRIVATE_SECTION_CHARS = 40_000;

export const inboxPrivate = z.strictObject({
  schema: z.literal("inbox-private/1.0"),
  id,
  rev: z.number().int().min(1),
  sections: z.array(z.strictObject({ name: z.string().min(1).max(80), text: z.string().max(MAX_PRIVATE_SECTION_CHARS) })).max(10),
});

export const consoleAnswer = z.strictObject({
  schema: z.literal("console-answer/1.0"),
  id,
  /** The entry's index in the record's history. */
  n: z.number().int().min(0),
  rev: z.number().int().min(1),
  action: z.string().max(40),
  note: z.string().max(4_000).optional(),
  at: z.string().max(40),
  session: z.number().int().min(0),
  entry_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
