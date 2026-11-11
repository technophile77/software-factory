// Read-only views of what the engine left behind: git history, objects,
// transcripts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_PATH, listFiles, REAL_GIT, tryGit, type Project } from "./world";

/** Every object in a repo, decompressed, as text. */
export function allObjects(repo: string): string {
  try {
    return execFileSync(REAL_GIT, ["cat-file", "--batch-all-objects", "--batch"], {
      cwd: repo,
      encoding: "latin1",
      maxBuffer: 512 * 1024 * 1024,
      env: { PATH: BASE_PATH },
    });
  } catch {
    return "";
  }
}

/** Text of every commit reachable from any ref. */
export function reachable(repo: string): string {
  return tryGit(repo, "log", "--all", "-p", "--text", "--format=commit %H%n%B") ?? "";
}

export const STATE = "refs/heads/factory/state";

/** factory/state commits (newest first) that touch the feature's transcript. */
export function transcriptCommits(p: Project, feature: string): Array<{ sha: string; subject: string }> {
  const out = tryGit(p.clone, "log", "--format=%H %s", STATE, "--", `interviews/${feature}`) ?? "";
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
}

/** The committed transcript of a feature on factory/state, all files joined. */
export function committedTranscript(p: Project, feature: string, rev = STATE): string {
  const names = tryGit(p.clone, "ls-tree", "-r", "--name-only", rev, "--", `interviews/${feature}`) ?? "";
  return names
    .split("\n")
    .filter(Boolean)
    .map((n) => tryGit(p.clone, "show", `${rev}:${n}`) ?? "")
    .join("\n");
}

export function transcriptFiles(p: Project, feature: string): string[] {
  return listFiles(join(p.clone, ".factory", "interviews", feature));
}

/** Every string value in a JSON document (or JSON Lines file). */
export function jsonStrings(text: string, file: string): string[] {
  const docs = file.endsWith(".jsonl") ? text.split("\n").filter((l) => l.trim()) : [text];
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const d of docs) walk(JSON.parse(d));
  return out;
}

export function readIfExists(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
