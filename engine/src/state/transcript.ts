import { sha256Hex } from "../fsutil";
import type { ChainHead } from "./record";

/**
 * The interview transcript: JSON Lines, one entry per line, every text field
 * a JSON string, so nothing the analyst or owner wrote is ever live Markdown
 * (SR-22). Each entry carries the hash of the one before it and its own
 * hash; the engine keeps the last hash in its own record (SR-17).
 */
export interface Entry {
  seq: number;
  at: string;
  type: string;
  prev: string | null;
  hash: string;
  [key: string]: unknown;
}

export type EntryBody = { type: string } & Record<string, unknown>;

export class ChainError extends Error {
  override name = "ChainError";
}

export function transcriptPath(feature: string): string {
  return `interviews/${feature}/transcript.jsonl`;
}

/** JSON with keys sorted at every level, so the hash doesn't depend on insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function entryHash(e: Omit<Entry, "hash">): string {
  const { hash: _drop, ...rest } = e as Entry;
  void _drop;
  return sha256Hex(canonical(rest));
}

export function makeEntry(prev: Entry | null, body: EntryBody, at: string): Entry {
  const reserved = ["seq", "at", "prev", "hash"];
  for (const k of reserved) if (k in body) throw new ChainError(`entry body may not set ${k}`);
  const base = { ...body, seq: (prev?.seq ?? 0) + 1, at, prev: prev?.hash ?? null };
  return { ...base, hash: entryHash(base as Omit<Entry, "hash">) } as Entry;
}

export function serialize(entries: Entry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}

/** Parses and checks the whole chain from its first entry. */
export function parseTranscript(text: string): Entry[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const out: Entry[] = [];
  let prev: Entry | null = null;
  for (const line of lines) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      throw new ChainError(`entry ${out.length + 1} is not JSON`);
    }
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new ChainError(`entry ${out.length + 1} is not an object`);
    const entry = e as Entry;
    if (entry.seq !== out.length + 1 || entry.prev !== (prev?.hash ?? null) || typeof entry.type !== "string" || typeof entry.at !== "string") {
      throw new ChainError(`entry ${out.length + 1} doesn't follow the one before`);
    }
    if (typeof entry.hash !== "string" || entryHash(entry) !== entry.hash) throw new ChainError(`entry ${out.length + 1} has a wrong hash`);
    out.push(entry);
    prev = entry;
  }
  return out;
}

/**
 * Checks a transcript read from factory/state against the head in the
 * engine's record. Only what this engine wrote is accepted: the record moves
 * with every entry the engine appends, so an entry past the recorded head,
 * or any change before it, was written by someone else (SR-17).
 */
export function checkAgainstHead(entries: Entry[], head: ChainHead | null): void {
  if (!head) {
    if (entries.length) throw new ChainError("the transcript has entries this engine has no record of");
    return;
  }
  if (entries.length < head.seq) throw new ChainError("the transcript is shorter than the engine's record");
  if (entries[head.seq - 1]?.hash !== head.head) throw new ChainError("the transcript doesn't match the engine's record");
  if (entries.length > head.seq) throw new ChainError("the transcript has entries the engine didn't write");
}
