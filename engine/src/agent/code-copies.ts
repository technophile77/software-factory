import * as fs from "node:fs";
import * as path from "node:path";
import type { Git } from "../git";
import { badSegment, caseInsensitiveAt, checkTree, writeNew } from "./worktree-populate";

/** F-007 FR-15: where the analyst finds the code repos, inside its worktree. */
export const CODE_DIR = "code-repos";

/** What the engine wrote under CODE_DIR: worktree-relative path to blob id. */
export type CodeFiles = Map<string, string>;

export interface CodeSource {
  name: string;
  /** Fetches the repo's `main` into a clone with no credential and returns where it is. */
  load: () => Promise<{ dir: string; commit: string }>;
}

export interface PlacedCopies {
  files: CodeFiles;
  placed: Array<{ name: string; commit: string }>;
  missing: Array<{ name: string; error: unknown }>;
}

const REGULAR = new Set(["100644", "100755"]);

/**
 * F-007 FR-15, SR-24: a plain-file copy of each code repo's `main` under
 * CODE_DIR, made fresh each time. Only regular files are written; links and
 * submodules are left out, so nothing in the copy can point outside it, and
 * there is no `.git`, so it carries no remote or credential. A repo that
 * can't be fetched or written is left out whole and reported, so the
 * interview still runs.
 */
export async function placeCodeCopies(git: Git, worktree: string, sources: CodeSource[], platform: NodeJS.Platform = process.platform): Promise<PlacedCopies> {
  const root = path.join(worktree, CODE_DIR);
  fs.rmSync(root, { recursive: true, force: true });
  const out: PlacedCopies = { files: new Map(), placed: [], missing: [] };
  if (!sources.length) return out;
  fs.mkdirSync(root, { mode: 0o755 });
  for (const s of sources) {
    const target = path.join(root, s.name);
    const prefix = `${CODE_DIR}/${s.name}/`;
    try {
      const why = badSegment(s.name, platform);
      if (why) throw new Error(`its name can't be a folder here (${why})`);
      const { dir, commit } = await s.load();
      const entries = (await git.lsTree(dir, commit)).filter((e) => REGULAR.has(e.mode));
      checkTree(entries, caseInsensitiveAt(root), platform);
      fs.mkdirSync(target, { mode: 0o755 });
      // Blobs in batches, as populateWorktree reads them.
      for (let i = 0; i < entries.length; i += 256) {
        const batch = entries.slice(i, i + 256);
        const blobs = await git.catBlobs(dir, batch.map((e) => e.sha));
        for (const e of batch) {
          writeNew(target, e.path, blobs.get(e.sha)!, e.mode === "100755");
          out.files.set(prefix + e.path, e.sha);
        }
      }
      out.placed.push({ name: s.name, commit });
    } catch (e) {
      fs.rmSync(target, { recursive: true, force: true });
      for (const k of [...out.files.keys()]) if (k.startsWith(prefix)) out.files.delete(k);
      out.missing.push({ name: s.name, error: e });
    }
  }
  return out;
}

/** Removes the copies once the analyst's session is over, so no later check of the worktree sees them. */
export function removeCodeCopies(worktree: string): void {
  fs.rmSync(path.join(worktree, CODE_DIR), { recursive: true, force: true });
}

/** True for CODE_DIR itself or anything under it. */
export function underCodeDir(rel: string): boolean {
  return rel === CODE_DIR || rel.startsWith(`${CODE_DIR}/`);
}
