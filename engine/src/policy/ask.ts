import { PolicyError } from "./role-policy";

/**
 * Role policy v2.7 (H-0201): programs the owner is asked about before any
 * role runs them, because they act with the owner's own credentials.
 */
export const ASK_PROGRAMS: readonly string[] = [
  "gh", "aws", "az", "gcloud", "gsutil", "bq", "railway", "vercel", "netlify", "fly", "flyctl", "heroku",
  "doppler", "op", "vault", "kubectl", "helm", "terraform", "pulumi", "docker", "ssh",
];

/**
 * F-015 SR-7: subcommands that publish or reach a remote with the owner's
 * credentials. The program alone is too common to ask about every time.
 */
export const ASK_SUBCOMMANDS: readonly (readonly [string, string])[] = [
  ["git", "push"], ["git", "remote"], ["git", "credential"], ["npm", "publish"], ["npm", "login"], ["twine", "upload"], ["cargo", "publish"],
];

const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** `policy.ask` in the manifest: programs a project adds; the listed ones can't be removed. */
export function projectAsk(manifestDoc: unknown): string[] {
  const policy = manifestDoc && typeof manifestDoc === "object" ? (manifestDoc as { policy?: unknown }).policy : undefined;
  const ask = policy && typeof policy === "object" ? (policy as { ask?: unknown }).ask : undefined;
  if (ask === undefined) return [];
  if (!Array.isArray(ask) || ask.some((a) => typeof a !== "string" || !PROGRAM_RE.test(a))) throw new PolicyError("policy.ask must be a list of program names");
  return ask as string[];
}

/** A word as the ask rule compares it: no folder, no `.exe`, `.cmd` or `.bat`, lower case. */
export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * The command's words, or null when it can't be split: an unclosed quote,
 * or a command substitution whose output could name any program. A
 * backslash stays in its word: it is a Windows folder separator as often as
 * an escape, and `programName` strips folders at either.
 */
export function splitWords(command: string): string[] | null {
  if (/`|\$\(|\$\{|<\(|>\(/.test(command)) return null;
  const words: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  const end = () => {
    if (has) words.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      // Inside quotes a space still ends a word for this check: `sh -c "gh pr list"` must show `gh`.
      else if (/\s/.test(c)) end();
      else {
        cur += c;
        has = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/[\s;&|()<>]/.test(c)) {
      end();
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) return null;
  end();
  return words;
}

/**
 * What on the ask list the command names, or null. Every word counts, not
 * only the first, so a program behind `env`, `xargs`, `sh -c` or a pipe is
 * still found; a command that can't be split counts as a match.
 */
export function askMatch(command: string, extra: readonly string[] = []): string | null {
  const words = splitWords(command);
  if (words === null) return "a command the engine can't split into words";
  // `g\h` runs `gh` in a POSIX shell, so each word is also read with its backslashes taken out.
  const names = words.flatMap((w) => (w.includes("\\") ? [programName(w), programName(w.replace(/\\/g, ""))] : [programName(w)]));
  const programs = new Set([...ASK_PROGRAMS, ...extra.map((e) => e.toLowerCase())]);
  for (const n of names) if (programs.has(n)) return n;
  for (let i = 0; i < names.length; i++) {
    for (const [prog, sub] of ASK_SUBCOMMANDS) {
      // `git -C dir push`: options can come first, so look a few words on. Matching too much only asks the owner.
      if (names[i] !== prog) continue;
      for (let j = i + 1; j < names.length && j < i + 8; j++) {
        if (names[j] === sub) return `${prog} ${sub}`;
      }
    }
  }
  return null;
}
