import type { Git } from "../git";
import { checkRepoPath, readFileAt } from "../config/factory-source";
import { ConfigError } from "../config/paths-file";

export const STANDARDS_FILE = "docs/security-standards.md";
const MAX_STANDARDS_BYTES = 256 * 1024;

export class StandardsError extends ConfigError {
  override name = "StandardsError";
}

/** What the reviewer is given and what its report is checked against (F-008 FR-3, FR-5). */
export interface Standards {
  /** The factory's text, then the project's additions when they are valid (SR-10). */
  factoryText: string;
  additionsText: string | null;
  /** The additions file's path in the config repo, for the reviewer's input. */
  additionsPath: string | null;
  criteria: Set<string>;
  checklist: string[];
  severities: string[];
}

const CRITERION_LINE = /^- ([SP]\d{1,2}\.\d{1,2}) /gm;

function lines(text: string, heading: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) inside = heading.test(line);
    else if (inside) out.push(line);
  }
  return out;
}

/** The factory standards: criterion ids, the Gate 1 checklist and the severity names, all from the file itself. */
export function parseStandards(text: string): Omit<Standards, "additionsText" | "additionsPath"> {
  const criteria = new Set<string>();
  for (const m of text.matchAll(CRITERION_LINE)) if (m[1]!.startsWith("S")) criteria.add(m[1]!);
  const checklist = lines(text, /^##\s+Gate 1\b.*checklist\s*$/i).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  const severities = lines(text, /^##\s+Severity\s*$/)
    .map((l) => /^\|\s*([A-Z][a-z]+)\s*\|/.exec(l)?.[1])
    .filter((s): s is string => !!s && s !== "Severity");
  if (!criteria.size || !checklist.length || !severities.length) {
    throw new StandardsError(`${STANDARDS_FILE} has no criteria, Gate 1 checklist or severity table that the engine can read.`);
  }
  return { factoryText: text, criteria, checklist, severities };
}

/**
 * SR-10: additions may only add criteria, each with a `P` id. A line that
 * defines an `S` id would redefine a factory criterion, so the whole file is
 * refused and the gate runs on the factory standards alone.
 */
export function parseAdditions(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(CRITERION_LINE)) {
    if (m[1]!.startsWith("S")) throw new StandardsError(`the project's security additions define ${m[1]}, a factory criterion id; additions must use P ids.`);
    ids.add(m[1]!);
  }
  return ids;
}

/** The manifest's `standards.security` path, or null when it names none. */
export function additionsPath(manifest: unknown): string | null {
  const st = (manifest as { standards?: unknown } | null)?.standards;
  if (!st || typeof st !== "object" || Array.isArray(st)) return null;
  const p = (st as Record<string, unknown>).security;
  if (p === undefined) return null;
  return checkRepoPath(p, "standards.security");
}

export interface LoadedStandards {
  standards: Standards;
  /** Why the project's additions weren't used, in engine words, for a Security item (SR-10). */
  additionsRefused: string | null;
}

/**
 * FR-3 and OQ-4: the standards from the master commit `factory.version`
 * names, and the project's additions from its config repo's `main` commit,
 * both read from git as regular files, never through a link or a working
 * tree. A bad factory file stops the gate; bad additions only drop them.
 */
export async function loadStandards(o: {
  git: Git;
  masterRepo: string;
  masterCommit: string;
  configRepo: string;
  configCommit: string;
  manifest: unknown;
  additionsBytes: number;
}): Promise<LoadedStandards> {
  const raw = await readFileAt(o.git, o.masterRepo, o.masterCommit, STANDARDS_FILE, MAX_STANDARDS_BYTES, "The security standards");
  const base = parseStandards(raw.toString("utf8"));
  let file: string | null;
  try {
    file = additionsPath(o.manifest);
  } catch (e) {
    return { standards: { ...base, additionsText: null, additionsPath: null }, additionsRefused: (e as Error).message };
  }
  if (!file) return { standards: { ...base, additionsText: null, additionsPath: null }, additionsRefused: null };
  try {
    const text = (await readFileAt(o.git, o.configRepo, o.configCommit, file, o.additionsBytes, "The project's security additions")).toString("utf8");
    const extra = parseAdditions(text);
    return {
      standards: { ...base, criteria: new Set([...base.criteria, ...extra]), additionsText: text, additionsPath: file },
      additionsRefused: null,
    };
  } catch (e) {
    return { standards: { ...base, additionsText: null, additionsPath: null }, additionsRefused: (e as Error).message.slice(0, 300) };
  }
}
