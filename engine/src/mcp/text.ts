/**
 * How the MCP mode shows engine text to the owner (F-005 SR-2, SR-10): every
 * escape and invisible character removed, so the owner and the model read the
 * same text, and every engine-written field fenced so it reads as data.
 */

// CSI and OSC sequences go whole: dropping only ESC would leave "[31m" behind.
const ANSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[@-_]/g;

// Invisible characters in visible categories. Variation selectors can encode
// arbitrary bytes the owner never sees but the model reads (F-005 Gate 2 #1).
const INVISIBLE = /[͏ᅟᅠ឴឵᠋-᠍᠏⠀ㅤﾠ︀-️\u{16fe4}\u{e0100}-\u{e01ef}]/gu;

// Whole categories, not a list of known characters: controls, format (bidi,
// zero-width, tags), private use, unassigned, surrogates, line separators.
const DROP = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

export function clean(text: string, singleLine = false): string {
  const stripped = text.replace(ANSI, "").replace(INVISIBLE, "");
  let out = "";
  for (const ch of stripped) {
    if (ch === "\n" || ch === "\t") out += singleLine ? " " : ch;
    else if (!DROP.test(ch)) out += ch;
  }
  return out;
}

/** The first `n` characters, never splitting a surrogate pair. */
export function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

/** Wraps engine text in a code fence it can't close. */
export function fence(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const bar = "`".repeat(Math.max(3, longest + 1));
  return `${bar}text\n${text}\n${bar}`;
}

function squash(text: string): string {
  return clean(text, true).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * True if an engine message repeats any `run`-character stretch of the
 * owner's reply, so a partial or reflowed quote is caught too (F-005 SR-16).
 * A false match only replaces an engine message with a fixed one.
 */
export function quotesReply(message: string, text: string, run = 8): boolean {
  const msg = squash(message);
  const txt = Array.from(squash(text));
  if (txt.length < run) return txt.length >= 4 && msg.includes(txt.join(""));
  for (let i = 0; i + run <= txt.length; i++) {
    if (msg.includes(txt.slice(i, i + run).join(""))) return true;
  }
  return false;
}

export function seconds(limit: number): string {
  const n = Math.max(1, Math.round(limit));
  return n === 1 ? "1 second" : `${n} seconds`;
}

/** False for a string holding half a surrogate pair, which can't be encoded as UTF-8. */
export function isWellFormed(s: string): boolean {
  return !/\p{Cs}/u.test(s);
}
