import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// F-011 FR-14, AC-10: the engine merges only under FR-10 and never creates a reaction.

const SRC = path.join(__dirname, "..", "src");
/** The FR-10 hygiene auto-merge module, once F-015 adds it; no other file may merge. */
const MERGE_ALLOWED = new Set<string>(["inbox/auto-merge.ts"]);

const MERGE = [/\/pulls\/[^\s"'`]*\/merge\b/, /\bmergePullRequest\b/, /\benablePullRequestAutoMerge\b/];
const REACT = [/\baddReaction\b/, /\bcreateReaction\b/, /["'`]POST["'`][^\n]*\/reactions\b/, /\/reactions\b[^\n]*["'`]POST["'`]/];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
}

/** `file:line` for each line of engine source that matches one of `res`. */
function offending(res: RegExp[], allowed: Set<string> = new Set(), root = SRC): string[] {
  const out: string[] = [];
  for (const f of files(root)) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    if (allowed.has(rel)) continue;
    fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      if (res.some((re) => re.test(l))) out.push(`src/${rel}:${i + 1}`);
    });
  }
  return out;
}

describe("GitHub calls the engine never makes (F-011 FR-14)", () => {
  it("AC-10: no merge call outside the FR-10 module", () => {
    expect(offending(MERGE, MERGE_ALLOWED), "merge API calls outside FR-10").toEqual([]);
  });

  it("AC-10: no create-reaction call anywhere", () => {
    expect(offending(REACT), "create-reaction API calls").toEqual([]);
  });

  it("names the file and line of a call it finds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr14-"));
    fs.mkdirSync(path.join(dir, "x"));
    fs.writeFileSync(path.join(dir, "x", "bad.ts"), 'const a = 1;\nawait call("PUT", `/repos/o/r/pulls/${n}/merge`);\nawait call("POST", `/repos/o/r/issues/comments/1/reactions`);\n');
    expect(offending(MERGE, new Set(), dir)).toEqual(["src/x/bad.ts:2"]);
    expect(offending(REACT, new Set(), dir)).toEqual(["src/x/bad.ts:3"]);
  });
});
