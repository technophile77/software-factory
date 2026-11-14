import * as path from "node:path";

/**
 * Finds git on PATH without ever picking a copy inside an open workspace
 * folder: a planted git binary there would run with the owner's rights
 * (Code Review finding 1). PATH entries that aren't absolute are skipped for the
 * same reason, since they resolve against the current directory.
 */
export function findGitOnPath(
  pathEnv: string,
  workspaceDirs: string[],
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  const norm = (d: string) => (platform === "win32" ? p.resolve(d).toLowerCase() : p.resolve(d));
  const blocked = workspaceDirs.map(norm);
  const exe = platform === "win32" ? "git.exe" : "git";
  for (const dir of pathEnv.split(platform === "win32" ? ";" : ":")) {
    if (!dir || !p.isAbsolute(dir)) continue;
    const d = norm(dir);
    if (blocked.some((w) => d === w || d.startsWith(w + p.sep))) continue;
    const candidate = p.join(p.resolve(dir), exe);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** True when `target` is `root` itself or somewhere below it. */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
