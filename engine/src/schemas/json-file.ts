import type { z } from "zod";

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

function failure(file: string, error: z.ZodError): SchemaError {
  const first = error.issues[0]!;
  const what = first.code === "unrecognized_keys" ? `unknown key ${(first as { keys: string[] }).keys.map((k) => JSON.stringify(k)).join(", ")}` : first.code;
  return new SchemaError(`${file}: ${where(first)} is invalid (${what})`);
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
