import { z } from "zod";

/**
 * Web reader answer v1.0 (F-020 FR-7, H-0243): the facts the reader found
 * for one query, each with the address it came from. All of it is the
 * reader's and untrusted; the engine keeps only facts from pages it fetched.
 */

const text = (max: number) => z.string().max(max);

export const WEB_READER_ANSWER_SCHEMA = "web-reader-answer/1.0";

export const webReaderAnswer = z.strictObject({
  schema: z.literal(WEB_READER_ANSWER_SCHEMA),
  facts: z.array(z.strictObject({ text: text(2000), source: text(2000) })).max(50),
  /** The reader's own claim (SR-10): true shows a warning; false relaxes no check. */
  page_contains_instructions: z.boolean(),
  /** The address of the page with instructions, when the claim is true; untrusted text. */
  where: text(2000).optional(),
}).superRefine((a, ctx) => {
  if (a.page_contains_instructions !== (a.where !== undefined)) ctx.addIssue({ code: "custom", path: ["where"], message: "set exactly when page_contains_instructions is true" });
});

export type WebReaderAnswer = z.infer<typeof webReaderAnswer>;
