/**
 * F-020 FR-2: writes one JSON Schema file per format in `src/schemas/index.ts`
 * to `docs/schemas/`, and removes any file there the list no longer has.
 *
 *   npm run write-schemas
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SCHEMAS, jsonSchemaText } from "../src/schemas";

export const SCHEMA_DIR = path.join(__dirname, "..", "..", "docs", "schemas");

export function writeSchemas(dir = SCHEMA_DIR): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const want = new Set(Object.keys(SCHEMAS).map((n) => `${n}.schema.json`));
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".schema.json") && !want.has(f)) fs.rmSync(path.join(dir, f));
  for (const n of Object.keys(SCHEMAS)) fs.writeFileSync(path.join(dir, `${n}.schema.json`), jsonSchemaText(n));
  return [...want].sort();
}

if (require.main === module) for (const f of writeSchemas()) process.stdout.write(`docs/schemas/${f}\n`);
