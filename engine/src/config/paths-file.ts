import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { PATHS_FILE } from "../constants";
import { euid, realPath } from "../fsutil";
import { Git } from "../git";
import type { OsApi } from "../os/ffi";
import { isOwnerWritableOnly } from "../os/sddl";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const MAX_FILE = 64 * 1024;

/**
 * Reads the git-ignored list of config repo clones (H-0081). It decides
 * which owner ids the engine trusts, so it is refused unless only the owner
 * can have written it (SR-13). It holds paths and nothing else.
 */
export function readPathsFile(masterRepo: string, os: OsApi): string[] {
  const file = path.join(masterRepo, PATHS_FILE);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new ConfigError(`${PATHS_FILE} is missing from the master repo clone.`);
  }
  if (st.isSymbolicLink()) throw new ConfigError(`${PATHS_FILE} is a symbolic link.`);
  if (!st.isFile() || st.size > MAX_FILE) throw new ConfigError(`${PATHS_FILE} is not a small regular file.`);
  if (os.platform === "win32") {
    let ok = false;
    try {
      const w = os.windows();
      ok = isOwnerWritableOnly(w.fileSddl(file), w.currentUserSid());
    } catch {
      ok = false;
    }
    if (!ok) throw new ConfigError(`${PATHS_FILE} must be owned by you and writable by nobody else.`);
  } else {
    if (st.uid !== euid()) throw new ConfigError(`${PATHS_FILE} is not owned by you.`);
    if (st.mode & 0o022) throw new ConfigError(`${PATHS_FILE} is group- or world-writable; run chmod go-w on it.`);
  }
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"), { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    throw new ConfigError(`${PATHS_FILE} is not valid YAML.`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ConfigError(`${PATHS_FILE} must be a mapping with 'projects'.`);
  const keys = Object.keys(doc);
  if (keys.length !== 1 || keys[0] !== "projects") throw new ConfigError(`${PATHS_FILE} may hold only 'projects'.`);
  const projects = (doc as { projects: unknown }).projects;
  if (!Array.isArray(projects)) throw new ConfigError(`'projects' must be a list.`);
  return projects.map((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).join() !== "path" || typeof (p as { path: unknown }).path !== "string") {
      throw new ConfigError(`projects[${i}] must be { path: <absolute path> } and nothing else.`);
    }
    return (p as { path: string }).path;
  });
}

/**
 * The master clone's root commits and origin, read once per `Git` (one per
 * engine start) rather than once per project path checked (F-014 FR-4).
 */
const masterFacts = new WeakMap<Git, Map<string, Promise<{ roots: Set<string>; origin: string | null }>>>();

const normUrl = (u: string) => u.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");

/**
 * Checks one listed path (SR-13): absolute, not a link, the top of a Git work
 * tree, and neither the master repo nor a clone of it (by remote URL and root
 * commit), so owner values can't end up in the public master repo.
 * Resolves to the path's real path.
 */
export async function checkProjectPath(p: string, masterRepo: string, git: Git): Promise<string> {
  if (!path.isAbsolute(p)) throw new ConfigError("The path is not absolute.");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    throw new ConfigError("The path doesn't exist.");
  }
  if (st.isSymbolicLink()) throw new ConfigError("The path is a symbolic link.");
  if (!st.isDirectory()) throw new ConfigError("The path is not a folder.");
  const real = realPath(p);
  let top: string;
  try {
    top = realPath(await git.out(real, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new ConfigError("The path is not a Git work tree.");
  }
  if (top !== real) throw new ConfigError("The path is not the top of a Git work tree.");
  const master = realPath(masterRepo);
  if (real === master) throw new ConfigError("The path is the master repo itself.");
  const roots = async (dir: string) => {
    try {
      return new Set((await git.out(dir, ["rev-list", "--max-parents=0", "HEAD"])).split("\n").filter(Boolean));
    } catch {
      return new Set<string>();
    }
  };
  const origin = async (dir: string) => {
    try {
      return normUrl(await git.out(dir, ["remote", "get-url", "origin"]));
    } catch {
      return null;
    }
  };
  // undefined: the read failed; null: the master has no origin. A failed read isn't cached (Gate 2 L5).
  const masterOrigin = async (dir: string) => {
    const r = await git.run(dir, ["remote", "get-url", "origin"], { okCodes: [2] }).catch(() => undefined);
    return r === undefined ? undefined : r.code === 0 ? normUrl(r.stdout.toString("utf8")) : null;
  };
  let byMaster = masterFacts.get(git);
  if (!byMaster) masterFacts.set(git, (byMaster = new Map()));
  let facts = byMaster.get(master);
  if (!facts) {
    facts = (async () => {
      const [r, o] = [await roots(master), await masterOrigin(master)];
      // The master clone always has a root commit, so none, or an origin read that failed, means try again next check.
      if (r.size === 0 || o === undefined) byMaster!.delete(master);
      return { roots: r, origin: o ?? null };
    })();
    byMaster.set(master, facts);
  }
  const { roots: mr, origin: mo } = await facts;
  const pr = await roots(real);
  if ([...pr].some((r) => mr.has(r))) throw new ConfigError("The path is a clone of the master repo (same root commit).");
  const po = await origin(real);
  if (mo && po && mo === po) throw new ConfigError("The path is a clone of the master repo (same remote).");
  return real;
}
