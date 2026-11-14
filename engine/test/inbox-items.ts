import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface StoredItem {
  id: string;
  record: Record<string, any>;
  /** The record and the latest rendered issue body, for text checks. */
  text: string;
}

const git = (repo: string, args: string[], input?: string): Buffer =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["pipe", "pipe", "ignore"], ...(input !== undefined ? { input } : {}) });

/**
 * The commit `ref` names, read from the ref files where possible. Tests poll
 * this every few milliseconds while the engine runs in the same process, and
 * a synchronous git process per check blocks the engine's event loop; on a
 * hosted Windows runner, where a process start is slow, that starved the
 * engine of time to do the work the test was waiting for.
 */
function resolve(repo: string, ref: string): string | null {
  const gitDir = path.join(repo, ".git");
  try {
    return fs.readFileSync(path.join(gitDir, ...ref.split("/")), "utf8").trim();
  } catch {
    // Not a loose ref: packed, or a layout this shortcut doesn't read.
  }
  try {
    const line = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8").split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
    if (line) return line.split(" ")[0]!;
  } catch {
    // No packed-refs file.
  }
  try {
    return git(repo, ["rev-parse", "--verify", "-q", ref]).toString("utf8").trim();
  } catch {
    return null;
  }
}

/** Blob contents by path at `commit`, in one git process; a missing path is left out. */
function readBlobs(repo: string, commit: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!files.length) return out;
  const buf = git(repo, ["cat-file", "--batch"], files.map((f) => `${commit}:${f}\n`).join(""));
  let at = 0;
  for (const f of files) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString("utf8");
    at = nl + 1;
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) continue;
    const size = Number(m[1]);
    out.set(f, buf.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return out;
}

const cache = new Map<string, { commit: string; items: StoredItem[] }>();

/** F-011 inbox records on a repo's factory/state (inbox/<id>.json plus inbox/<id>.rev<n>.md), oldest id first. */
export function inboxItems(repo: string, ref = "refs/heads/factory/state"): StoredItem[] {
  const commit = resolve(repo, ref);
  if (!commit) return [];
  const key = `${repo}\0${ref}`;
  const hit = cache.get(key);
  if (hit?.commit === commit) return structuredClone(hit.items);
  let names: string[];
  try {
    names = git(repo, ["ls-tree", "-r", "--name-only", commit, "--", "inbox"]).toString("utf8").split("\n");
  } catch {
    return [];
  }
  const ids = names.sort().map((n) => /^inbox\/([A-Z]-\d{4,})\.json$/.exec(n)?.[1]).filter((x): x is string => !!x);
  const records = readBlobs(repo, commit, ids.map((id) => `inbox/${id}.json`));
  const parsed = ids.flatMap((id) => {
    const raw = records.get(`inbox/${id}.json`);
    if (!raw) return [];
    const record = JSON.parse(raw) as Record<string, any>;
    const rev = Array.isArray(record.revisions) ? record.revisions.length : 0;
    return [{ id, raw, record, body: rev ? `inbox/${id}.rev${rev}.md` : null }];
  });
  const bodies = readBlobs(repo, commit, parsed.flatMap((p) => (p.body ? [p.body] : [])));
  const items = parsed.map((p) => ({ id: p.id, record: p.record, text: `${p.raw}\n${p.body ? bodies.get(p.body) ?? "" : ""}` }));
  cache.set(key, { commit, items });
  return structuredClone(items);
}

export function securityItemsIn(repo: string, ref?: string): StoredItem[] {
  return inboxItems(repo, ref).filter((i) => i.record.category === "Security");
}
