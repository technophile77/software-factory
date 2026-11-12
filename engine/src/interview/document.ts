import * as crypto from "node:crypto";
import { DOCUMENT_LIMITS, TOOL_LIMITS } from "../constants";

/** Channel v1.4 `Document` (H-0105), after the engine's own checks (F-009 SR-9). */
export interface SourceDocument {
  name: string;
  media_type: "text/markdown" | "text/plain";
  text: string;
  provenance: "owner" | "reference";
}

/** What the transcript keeps about the document: never its text, which lives on the feature branch. */
export interface DocumentMeta {
  name: string;
  media_type: SourceDocument["media_type"];
  provenance: SourceDocument["provenance"];
  path: string;
  bytes: number;
  sha256: string;
  /** The git blob the engine stored, read back by id so a later change on the branch can't stand in for it. */
  blob: string;
}

export type RefusalReason = "invalid" | "hidden_content" | "secret" | "budget";

/** Error -32009 `document_refused`: line numbers and rule ids only, never document text. */
export class DocumentRefused extends Error {
  override name = "DocumentRefused";
  constructor(readonly reason: RefusalReason, message: string, readonly lines: number[] = [], readonly rule?: string) {
    super(message);
  }

  data(): { reason: RefusalReason; lines?: number[]; rule?: string } {
    return { reason: this.reason, ...(this.lines.length ? { lines: this.lines.slice(0, 50) } : {}), ...(this.rule ? { rule: this.rule } : {}) };
  }
}

const MEDIA_TYPES = { "text/markdown": "md", "text/plain": "txt" } as const;

export function sourcePath(feature: string, media: SourceDocument["media_type"]): string {
  return `docs/features/${feature}-source.${MEDIA_TYPES[media]}`;
}

/** A path the engine stores source documents at; never a spec_path (Interview tools v1.1). */
export const SOURCE_PATH_RE = /^docs\/features\/F-\d{3,6}-source\.(md|txt)$/i;

// C0 controls other than tab, LF and CR, DEL, and C1 controls (SR-9).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// Characters a reader can't see but a model reads (SR-8): zero-width and joiners, bidi marks,
// embeddings, overrides and isolates, invisible operators, the word joiner block, the Mongolian
// vowel separator, soft hyphen, the Hangul fillers, and the Unicode tag block, which can spell out
// a whole hidden instruction. A byte order mark is allowed only as the first character.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]|[\u{e0000}-\u{e007f}]/u;

function linesMatching(lines: string[], re: RegExp): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (re.test(i === 0 ? l.replace(/^\ufeff/, "") : l)) out.push(i + 1);
  });
  return out;
}

/**
 * Markdown lines whose HTML a renderer would hide or interpret (SR-8): an HTML
 * comment, anywhere it opens or continues, and any raw tag outside code. Text
 * inside fenced or inline code is shown as written, so it isn't hidden.
 */
export function hiddenMarkdownLines(lines: string[]): number[] {
  const hits = new Set<number>();
  let fence: string | null = null;
  let inComment = false;
  lines.forEach((raw, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (!inComment && f) {
      if (!fence) fence = f[1]![0]!.repeat(f[1]!.length);
      else if (f[1]!.startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    let line = raw.replace(/(`+)[\s\S]*?\1/g, "");
    if (inComment) {
      hits.add(i + 1);
      const end = line.indexOf("-->");
      if (end < 0) return;
      inComment = false;
      line = line.slice(end + 3);
    }
    if (line.includes("<!--")) {
      hits.add(i + 1);
      const rest = line.slice(line.indexOf("<!--") + 4);
      if (!rest.includes("-->")) inComment = true;
    }
    // A tag, a closing tag, a declaration or a processing instruction (CommonMark's raw HTML).
    if (/<\/?[a-z][a-z0-9-]*(\s[^>]*)?\/?>|<![a-z]|<\?[a-z]/i.test(line)) hits.add(i + 1);
  });
  return [...hits].sort((a, b) => a - b);
}

/**
 * The engine's own checks on a `document` (channel v1.4, SR-8, SR-9), on the
 * raw request value: it fails closed, and a refusal names fields and line
 * numbers only.
 */
export function validateDocument(raw: unknown): SourceDocument {
  const bad = (msg: string, lines: number[] = []) => new DocumentRefused("invalid", msg, lines);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("document must be an object.");
  const d = raw as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!["name", "media_type", "text", "provenance"].includes(k)) throw bad("document has an unexpected key.");
  if (typeof d.media_type !== "string" || !(d.media_type in MEDIA_TYPES)) throw bad("document.media_type must be text/markdown or text/plain.");
  if (d.provenance !== "owner" && d.provenance !== "reference") throw bad("document.provenance must be owner or reference.");
  if (typeof d.name !== "string") throw bad("document.name must be a string.");
  const name = d.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").replace(new RegExp(INVISIBLE.source, "gu"), "").trim();
  if (!name || [...name].length > DOCUMENT_LIMITS.name) throw bad(`document.name must be 1 to ${DOCUMENT_LIMITS.name} characters.`);
  if (typeof d.text !== "string" || !d.text.trim()) throw bad("document.text must be non-empty text.");
  // A lone surrogate can't be stored as UTF-8, so it isn't valid text.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(d.text)) throw bad("document.text isn't valid Unicode.");
  if (Buffer.byteLength(d.text, "utf8") > DOCUMENT_LIMITS.textBytes) throw bad(`document.text is over ${DOCUMENT_LIMITS.textBytes} bytes.`);
  const lines = d.text.split(/\r\n|\r|\n/);
  const control = linesMatching(lines, CONTROL);
  if (control.length) throw bad("document.text has control characters other than tab, LF and CR.", control);
  const hidden = new Set(linesMatching(lines, INVISIBLE));
  if (d.media_type === "text/markdown") for (const n of hiddenMarkdownLines(lines)) hidden.add(n);
  if (hidden.size) {
    throw new DocumentRefused("hidden_content", "The document has text a reader can't see (an HTML comment, raw HTML, or a zero-width or bidi character); remove it and try again.", [...hidden].sort((a, b) => a - b));
  }
  return { name, media_type: d.media_type as SourceDocument["media_type"], text: d.text, provenance: d.provenance };
}

export function documentMeta(feature: string, doc: SourceDocument, blob: string): DocumentMeta {
  const buf = Buffer.from(doc.text, "utf8");
  return {
    name: doc.name, media_type: doc.media_type, provenance: doc.provenance, path: sourcePath(feature, doc.media_type),
    bytes: buf.length, sha256: sha256(buf), blob,
  };
}

export const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** 1-based line of a byte offset into the text, for mapping a scanner finding back. */
export function lineOfByte(text: Buffer, offset: number): number {
  let n = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text[i] === 0x0a) n++;
  return n;
}

// -- the spec's Sources table (Interview tools v1.1) ---------------------------------

export interface SourceRow {
  line: number;
  spec_ref: string;
  section: string;
  quote: string;
}

const collapse = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

/** Rows of the spec's `## Sources` table; null when the spec has no such section. */
export function sourcesTable(spec: string): SourceRow[] | null {
  const lines = spec.split(/\r?\n/);
  let inside = false;
  let found = false;
  const rows: SourceRow[] = [];
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) {
      inside = /^##\s+(\d+\.\s+)?Sources\s*$/i.test(line);
      found ||= inside;
      return;
    }
    if (!inside || !line.trim().startsWith("|")) return;
    const c = cells(line);
    if (c.length < 3 || /^-+$/.test(c[0]!.replace(/:/g, "")) || c[0]!.toLowerCase() === "spec ref") return;
    // A quote may be wrapped in one pair of straight or curly double quotes; they aren't part of it.
    const quote = c.slice(2).join("|").replace(/^["\u201c](.*)["\u201d]$/s, "$1");
    rows.push({ line: i + 1, spec_ref: c[0]!, section: c[1]!, quote });
  });
  return found ? rows : null;
}

/** A stable hash of the table's content, so a later spec version with a changed table needs a new confirmation. */
export function tableHash(rows: SourceRow[]): string {
  const canon = rows.map((r) => [collapse(r.spec_ref), collapse(r.section), collapse(r.quote)]);
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/**
 * Problems with the table against the stored document (SR-7): each row needs
 * a spec ref, a section and a quote within the limit, and each quote must be
 * in the document word for word after runs of whitespace are collapsed.
 * Returns the spec's line numbers with what is wrong; no document text.
 */
export function tableProblems(rows: SourceRow[], documentText: string): string[] {
  const doc = collapse(documentText);
  const out: string[] = [];
  if (rows.length === 0) out.push("the Sources table has no rows");
  if (rows.length > TOOL_LIMITS.sourceRows) out.push(`the Sources table has over ${TOOL_LIMITS.sourceRows} rows`);
  for (const r of rows.slice(0, TOOL_LIMITS.sourceRows)) {
    if (!r.spec_ref || !/^[A-Za-z0-9][A-Za-z0-9 ._\u00a7-]{0,40}$/.test(r.spec_ref)) out.push(`line ${r.line}: Spec ref must be an FR, AC, SR or section id`);
    else if (!r.section || [...r.section].length > 200) out.push(`line ${r.line}: Section must name the document's heading`);
    else if (!r.quote) out.push(`line ${r.line}: the quote is empty`);
    else if ([...r.quote].length > TOOL_LIMITS.sourceQuote) out.push(`line ${r.line}: the quote is over ${TOOL_LIMITS.sourceQuote} characters`);
    else if (!doc.includes(collapse(r.quote))) out.push(`line ${r.line}: the quote isn't in the document word for word`);
  }
  return out;
}
