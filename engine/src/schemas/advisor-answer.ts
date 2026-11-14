import { z } from "zod";
import { sha256Hex } from "../fsutil";
import type { Part } from "../inbox/model";
import { parseJsonFile } from "./json-file";

/**
 * Advisor answer v1.0 (F-020 FR-6, H-0243): what the advisor returns for one
 * hard question. Every string is the advisor's and untrusted (F-011 SR-10).
 * Its options are numbered 1 to 4 and only ever shown as "Advisor option N",
 * so they can't be read as the item's own options (SR-8).
 */

const text = (max: number) => z.string().max(max);
const optionId = z.number().int().min(1).max(4);

export const ADVISOR_ANSWER_SCHEMA = "advisor-answer/1.0";

export const advisorAnswer = z.strictObject({
  schema: z.literal(ADVISOR_ANSWER_SCHEMA),
  findings: z.array(z.strictObject({ text: text(4000), source: text(2000) })).max(50),
  options: z.array(z.strictObject({ id: optionId, label: text(200), trade_offs: text(2000) })).min(2).max(4),
  recommendation: z.strictObject({ option: optionId, reasoning: text(4000), confidence: z.enum(["low", "medium", "high"]) }),
  risks: z.array(z.strictObject({ text: text(2000) })).max(50),
  /** The advisor's own claim (SR-10): true shows a warning; false relaxes no check. */
  source_contains_instructions: z.boolean(),
  /** Where the instructions were, when the claim is true; untrusted text. */
  where: text(2000).optional(),
}).superRefine((a, ctx) => {
  const ids = a.options.map((o) => o.id);
  if (ids.some((id, i) => id !== i + 1)) ctx.addIssue({ code: "custom", path: ["options"], message: "options are numbered 1, 2, ... in order" });
  if (!ids.includes(a.recommendation.option)) ctx.addIssue({ code: "custom", path: ["recommendation", "option"], message: "not one of the options" });
  if (a.source_contains_instructions !== (a.where !== undefined)) ctx.addIssue({ code: "custom", path: ["where"], message: "set exactly when source_contains_instructions is true" });
});

export type AdvisorAnswer = z.infer<typeof advisorAnswer>;

/** SR-9: reads `.factory/advice/<call>.json`, keeping the SHA-256 of its exact bytes for the record. */
export function readAdvice(file: string, raw: Buffer): { answer: AdvisorAnswer; sha256: string } {
  return { answer: parseJsonFile(file, raw, advisorAnswer), sha256: sha256Hex(raw) };
}

/**
 * The inbox issue's Advisor section (FR-6): the engine's labels as engine
 * text, every advisor string as outside text, which the issue renders
 * escaped and never as Markdown or HTML (F-011 SR-10).
 */
export function adviceParts(a: AdvisorAnswer): Part[] {
  const out: Part[] = [];
  const said = (s: string) => out.push({ outside: s, author: "advisor" });
  const engine = (s: string) => out.push({ engine: s });
  if (a.source_contains_instructions) {
    engine("The advisor says a source it read contained instructions; it names where:");
    said(a.where ?? "");
  }
  engine("Findings:");
  for (const f of a.findings) {
    said(f.text);
    engine("Source:");
    said(f.source);
  }
  for (const o of a.options) {
    engine(`Advisor option ${o.id}:`);
    said(o.label);
    engine("Trade-offs:");
    said(o.trade_offs);
  }
  engine(`The advisor recommends Advisor option ${a.recommendation.option}, with ${a.recommendation.confidence} confidence:`);
  said(a.recommendation.reasoning);
  if (a.risks.length) {
    engine("Risks:");
    for (const r of a.risks) said(r.text);
  }
  return out;
}
