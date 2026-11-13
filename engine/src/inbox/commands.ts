import type { ActionId } from "./model";

export const MAX_NOTE_CHARS = 4_000;

export type Command =
  | { kind: "action"; action: ActionId; note?: string }
  | { kind: "confirm"; code: string };

/**
 * F-011 SR-18: a command is the comment's first line, matching one fixed
 * pattern exactly and case-sensitively. `/changes` and `/research` carry a
 * note: the rest of the first line, then any further lines. Returns null for
 * anything else, including a first line that merely starts with a command.
 */
export function parseCommand(body: string): Command | null {
  const text = body.replace(/\r\n?/g, "\n");
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  const rest = nl < 0 ? "" : text.slice(nl + 1);
  let m: RegExpExecArray | null;
  if ((m = /^\/choose ([A-D])$/.exec(first))) return { kind: "action", action: `choose:${m[1]}` };
  if ((m = /^\/step ([1-9]\d?)$/.exec(first))) return { kind: "action", action: `step:${m[1]}` };
  if ((m = /^\/confirm ([A-Z0-9]{4})$/.exec(first))) return { kind: "confirm", code: m[1]! };
  if ((m = /^\/(approve|reject|defer|restore|dismiss)$/.exec(first))) return { kind: "action", action: m[1]! };
  if ((m = /^\/(changes|research) (\S.*)$/.exec(first))) {
    const note = [m[2]!, rest].join("\n").trim();
    if (note.length > MAX_NOTE_CHARS) return null;
    return { kind: "action", action: m[1]!, note };
  }
  return null;
}

/** Comments whose first line looks like a command attempt get a reply when they don't parse; others are conversation. */
export const looksLikeCommand = (body: string) => body.trimStart().startsWith("/");

/** A 4-character confirm code from an alphabet without look-alikes. */
export function confirmCode(random: (n: number) => Buffer): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...random(4)].map((b) => alphabet[b % alphabet.length]).join("");
}
