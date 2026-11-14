import { z } from "zod";

/** F-020 SR-6: the largest JSON file the engine parses; checked on the bytes before parsing. */
export const MAX_JSON_BYTES = 1024 * 1024;

export class SchemaError extends Error {
  override name = "SchemaError";
}

/** The path of the first failing field, as `a.b[2].c`. Never the value (SR-6). */
function where(issue: z.core.$ZodIssue): string {
  const p = issue.path.map((k) => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("");
  return p ? p.replace(/^\./, "") : "(top level)";
}

function issueText(issue: z.core.$ZodIssue): string {
  const what = issue.code === "unrecognized_keys" ? `unknown key ${(issue as { keys: string[] }).keys.map((k) => JSON.stringify(k.slice(0, 64))).join(", ")}` : issue.code;
  return `${where(issue)} is invalid (${what})`;
}

function failure(file: string, error: z.ZodError): SchemaError {
  return new SchemaError(`${file}: ${issueText(error.issues[0]!)}`);
}

/** Each failing field of a value, as engine words that name the path and the rule, never the value (SR-6); for a correction turn. */
export function schemaErrors(value: unknown, schema: z.ZodType, max = 20): string[] {
  const r = schema.safeParse(value);
  return r.success ? [] : r.error.issues.slice(0, max).map(issueText);
}

/** F-020 FR-3: parses and validates a JSON file, or throws naming the file and the first failing field. */
export function parseJsonFile<T>(file: string, raw: Buffer | string, schema: z.ZodType<T>): T {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (bytes > MAX_JSON_BYTES) throw new SchemaError(`${file}: larger than ${MAX_JSON_BYTES} bytes`);
  let data: unknown;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    throw new SchemaError(`${file}: not valid JSON`);
  }
  const r = schema.safeParse(data);
  if (!r.success) throw failure(file, r.error);
  return r.data;
}

/** F-020 FR-3: validates before writing, so an invalid file is never committed. */
export function jsonFileContent(file: string, value: unknown, schema: z.ZodType): string {
  const r = schema.safeParse(value);
  if (!r.success) throw failure(file, r.error);
  return JSON.stringify(r.data, null, 2) + "\n";
}

/** F-020 FR-9: the JSON Schema a session is given for its answer, from the same schema the engine checks it with. */
export function outputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...out } = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
  return out;
}
