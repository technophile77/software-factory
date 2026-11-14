import { execFileSync } from "node:child_process";
import YAML from "yaml";

export interface StoredItem {
  id: string;
  record: Record<string, any>;
  /** The record and the latest rendered issue body, for text checks. */
  text: string;
}

function show(repo: string, ref: string, file: string): string | null {
  try {
    return execFileSync("git", ["-C", repo, "show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** F-011 inbox records on a repo's factory/state (inbox/<id>.yaml plus inbox/<id>.rev<n>.md), oldest id first. */
export function inboxItems(repo: string, ref = "refs/heads/factory/state"): StoredItem[] {
  let names: string[];
  try {
    names = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", ref, "--", "inbox"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  } catch {
    return [];
  }
  const out: StoredItem[] = [];
  for (const n of names.sort()) {
    const m = /^inbox\/([A-Z]-\d{4,})\.json$/.exec(n);
    if (!m) continue;
    const raw = show(repo, ref, n);
    if (!raw) continue;
    const record = JSON.parse(raw) as Record<string, any>;
    const rev = Array.isArray(record.revisions) ? record.revisions.length : 0;
    const body = rev ? show(repo, ref, `inbox/${m[1]}.rev${rev}.md`) ?? "" : "";
    out.push({ id: m[1]!, record, text: `${raw}\n${body}` });
  }
  return out;
}

export function securityItemsIn(repo: string, ref?: string): StoredItem[] {
  return inboxItems(repo, ref).filter((i) => i.record.category === "Security");
}
