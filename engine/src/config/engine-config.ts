import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { checkConfig, engineFile } from "../schemas/config";

/** `engine.yaml` in the engine folder: the owner's per-PC settings. */
export function readEngineConfig(home: string): { gitleaks?: string; master?: string } {
  const file = path.join(home, "engine.yaml");
  if (!fs.existsSync(file)) return {};
  const doc = YAML.parse(fs.readFileSync(file, "utf8"), { uniqueKeys: true, maxAliasCount: 0 }) as unknown;
  if (doc === null) return {};
  checkConfig("engine.yaml", doc, engineFile);
  const { gitleaks, master } = doc as { gitleaks?: string; master?: string };
  return { ...(gitleaks ? { gitleaks } : {}), ...(master ? { master } : {}) };
}

/** F-023 FR-16: --master wins, then engine.yaml's `master:`, then the current folder. */
export function masterClone(flag: string | undefined, configured: string | undefined, cwd: string): string {
  if (flag !== undefined) return path.resolve(flag);
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) throw new Error("engine.yaml's master: must be an absolute path.");
    return path.resolve(configured);
  }
  return path.resolve(cwd);
}
