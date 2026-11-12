import * as fs from "node:fs";
import * as path from "node:path";
import { realPath } from "../fsutil";

/**
 * The Role policy glob dialect (H-0046): literal segments separated by `/`,
 * `*` within one segment (dot files included), `**` for zero or more whole
 * segments. Everything other glob libraries read differently is refused.
 */
export function globError(glob: string): string | null {
  if (typeof glob !== "string" || glob.length === 0 || glob.length > 1000) return "must be a non-empty string";
  if (glob.normalize("NFC") !== glob) return "must be NFC";
  if (glob.startsWith("/") || /^[A-Za-z]:/.test(glob)) return "must be relative";
  if (glob.includes("\\")) return "must not hold \\";
  if (/[?[\]{}]/.test(glob)) return "must not hold ?, [ ], { }";
  if (/[@!+](?=\()/.test(glob)) return "must not hold extglobs";
  if (/[\0-\x1f]/.test(glob)) return "must not hold control characters";
  for (const seg of glob.split("/")) {
    if (seg === "" || seg === ".") return "must not have empty or '.' segments";
    if (seg.includes("..")) return "must not have a segment that can match '..'";
    if (seg.includes("**") && seg !== "**") return "'**' must be a whole segment";
  }
  return null;
}

type Seg = { kind: "any" } | { kind: "one"; re: RegExp };

const compiled = new Map<string, Seg[]>();

function compile(glob: string, fold: boolean): Seg[] {
  const key = `${fold ? "i" : "s"}:${glob}`;
  const have = compiled.get(key);
  if (have) return have;
  const segs = glob.split("/").map((s): Seg => {
    if (s === "**") return { kind: "any" };
    const body = s.split("*").map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    return { kind: "one", re: new RegExp(`^${body}$`, fold ? "iu" : "u") };
  });
  compiled.set(key, segs);
  return segs;
}

/**
 * Matches one relative `/` path. Segment by segment with a memo, so a glob
 * of many `**` stays linear in the path rather than backtracking.
 */
export function globMatch(glob: string, rel: string, caseInsensitive: boolean): boolean {
  const g = compile(glob, caseInsensitive);
  const p = rel === "" ? [] : rel.split("/");
  const memo = new Map<number, boolean>();
  const go = (gi: number, pi: number): boolean => {
    const k = gi * (p.length + 1) + pi;
    const m = memo.get(k);
    if (m !== undefined) return m;
    let r: boolean;
    if (gi === g.length) r = pi === p.length;
    else {
      const s = g[gi]!;
      if (s.kind === "any") r = go(gi + 1, pi) || (pi < p.length && go(gi, pi + 1));
      else r = pi < p.length && s.re.test(p[pi]!) && go(gi + 1, pi + 1);
    }
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

export interface Rules {
  allow: string[];
  deny: string[];
}

/** Allowed only if an allow glob matches (case-sensitive) and no deny glob does (case-insensitive). */
export function allowedBy(rules: Rules, rel: string): boolean {
  const n = rel.normalize("NFC");
  return rules.allow.some((g) => globMatch(g, n, false)) && !rules.deny.some((g) => globMatch(g, n, true));
}

export class OutsideWorktree extends Error {
  override name = "OutsideWorktree";
}

/**
 * The ADR 0015 path rule: follow every link to the real path (a path that
 * doesn't exist yet resolves through its nearest existing parent), refuse it
 * outside the worktree, and return it relative with `/` separators.
 */
export function worktreeRelative(worktree: string, p: string): string {
  const root = realPath(worktree);
  let cur = path.resolve(root, p);
  const tail: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(cur);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) throw new OutsideWorktree("no existing parent");
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const real = path.join(realPath(cur), ...tail);
  const rel = path.relative(root, real);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new OutsideWorktree("outside the worktree");
  const out = rel.split(path.sep).join("/");
  if (out.split("/").some((s) => s === ".." || s === ".")) throw new OutsideWorktree("outside the worktree");
  return out.normalize("NFC");
}
