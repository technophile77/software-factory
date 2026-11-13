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
// Characters a reader can't see but a model reads (SR-8), by Unicode property
// rather than a hand list (Gate 2 M1): every format character (bidi controls,
// zero-width characters and joiners, tags, Arabic number signs, interlinear
// annotation, musical formatting), private use, unassigned and surrogate code
// points, plus the invisible characters in visible classes: the combining
// grapheme joiner, Hangul and Khmer fillers, Mongolian variation selectors,
// the blank Braille pattern and the variation selectors, which can encode
// arbitrary bytes. FE0E and FE0F, which pick text or emoji style, stay
// allowed. A byte order mark is allowed only as the first character.
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}]|[\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\ufe00-\ufe0d]|[\u{e0100}-\u{e01ef}]/u;

function linesMatching(lines: string[], re: RegExp): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (re.test(i === 0 ? l.replace(/^\ufeff/, "") : l)) out.push(i + 1);
  });
  return out;
}

// Named entities for invisible characters that Markdown renderers decode.
const INVISIBLE_ENTITIES = /&(shy|zwj|zwnj|lrm|rlm|lre|rle|pdf|lro|rlo|ZeroWidthSpace|NoBreak|InvisibleTimes|InvisibleComma|it|ic|af|ApplyFunction|NegativeVeryThinSpace|NegativeThinSpace|NegativeMediumSpace|NegativeThickSpace|blank);/i;

function hiddenEntity(line: string): boolean {
  if (INVISIBLE_ENTITIES.test(line)) return true;
  for (const m of line.matchAll(/&#(x[0-9a-f]{1,8}|[0-9]{1,9});/gi)) {
    const cp = m[1]![0]!.toLowerCase() === "x" ? parseInt(m[1]!.slice(1), 16) : parseInt(m[1]!, 10);
    if (cp > 0x10ffff || CONTROL.test(String.fromCodePoint(cp)) || INVISIBLE.test(String.fromCodePoint(cp))) return true;
  }
  return false;
}

/**
 * Lines with anything a Markdown renderer could hide or interpret as HTML
 * (SR-8): an HTML comment, from where it opens to where it closes; a tag
 * name after `<` or `</`, even at the end of a line; a declaration, CDATA or
 * processing instruction; and an entity for an invisible character. These are
 * refused even inside code: renderers disagree on where code starts and ends
 * (escaped backticks, indented and list-item fences, info strings), so a
 * check that skips code can be led past HTML that a renderer shows as HTML
 * (Gate 2 H1). The owner can write `&lt;` for a literal `<`.
 */
export function hiddenMarkdownLines(lines: string[]): number[] {
  const hits = new Set<number>();
  let inComment = false;
  lines.forEach((raw, i) => {
    let line = raw;
    if (inComment) {
      hits.add(i + 1);
      const end = line.indexOf("-->");
      if (end < 0) return;
      inComment = false;
      line = line.slice(end + 3);
    }
    if (line.includes("<!--")) {
      hits.add(i + 1);
      if (!line.slice(line.lastIndexOf("<!--") + 4).includes("-->")) inComment = true;
    }
    if (/<\/?[a-z][a-z0-9-]*(?=[\s/>]|$)|<!|<\?/i.test(line) || hiddenEntity(line)) hits.add(i + 1);
  });
  return [...hits].sort((a, b) => a - b);
}

// Markdown's own ways to hide text (SR-8 as extended by the owner, Gate 2 M2).
// A link reference definition renders as nothing, so one with a title, or one
// no link uses (the `[//]: # (comment)` idiom), is text only the analyst sees.
// Block quote and list markers, and any indent, are dropped first: a definition
// inside a quote or list item renders as nothing too (validation M1), and one
// in an indented code block is refused like HTML in code (Gate 2 H1).
const CONTAINER = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*/;
const TITLE_START = /^["'(]/;
const SPACE_ENTITIES = /&(nbsp|ensp|emsp|emsp13|emsp14|numsp|puncsp|thinsp|ThinSpace|hairsp|VeryThinSpace|MediumSpace|NonBreakingSpace|ThickSpace|Tab|NewLine);/gi;

// Link text made only of whitespace, hard line breaks, invisible characters,
// entities for them, backticks (a blank code span) or emphasis marks around
// those shows nothing, so the link's title or target is hidden. Markup is
// dropped before entities are decoded: `&#42;` shows a visible `*`.
function blankLinkText(text: string): boolean {
  const decoded = text
    .replace(/\\(?=\n)/g, "")
    // A code span shows its content as written, entities included.
    .replace(/(`+)([\s\S]*?)\1/g, (_m, _t, body: string) => (body.trim() ? "x" : ""))
    .replace(/[`*_~]/g, "")
    .replace(SPACE_ENTITIES, " ")
    .replace(/&#(x[0-9a-f]{1,8}|[0-9]{1,9});/gi, (e, n: string) => {
      const cp = n[0]!.toLowerCase() === "x" ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : e;
    });
  // A variation selector with no character before it draws nothing (D-5).
  return !decoded.replace(new RegExp(INVISIBLE.source, "gu"), "").replace(/[\s\ufe0e\ufe0f]/gu, "");
}

function linkLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Lines with Markdown's own ways to hide text (SR-8 as extended, Gate 2 M2).
 * Link labels and link text may run over several lines in CommonMark, so the
 * checks run on the whole text, with block quote and list markers dropped
 * from each line, and a hit names every line it covers (validation round 2 M1).
 */
export function hiddenLinkLines(lines: string[]): number[] {
  const hits = new Set<number>();
  const bare = lines.map((l) => l.replace(CONTAINER, ""));
  const text = bare.join("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of bare) {
    starts.push(at);
    at += l.length + 1;
  }
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const span = (from: number, to: number, into: Set<number>) => {
    for (let i = lineAt(from); i <= lineAt(Math.max(from, to - 1)); i++) into.add(i);
  };
  // A blank line ends a paragraph, so no label or link text crosses one.
  const oneParagraph = (t: string) => !/\n[ \t]*\n/.test(t);

  for (const m of text.matchAll(/!?\[([^[\]]*)\](?=[(\[])/g)) {
    if (oneParagraph(m[1]!) && blankLinkText(m[1]!)) {
      const lineHits = new Set<number>();
      span(m.index!, m.index! + m[0].length, lineHits);
      for (const i of lineHits) hits.add(i + 1);
    }
  }

  const defs: Array<{ line: number; label: string; blank: boolean }> = [];
  const defLines = new Set<number>();
  for (const m of text.matchAll(/^\[((?:\\[\s\S]|[^\\\]])+)\]:[ \t]*(\S*)[ \t]*(.*)$/gm)) {
    if (!oneParagraph(m[1]!)) continue;
    const covered = new Set<number>();
    span(m.index!, m.index! + m[0].length, covered);
    const first = Math.min(...covered);
    let last = Math.max(...covered);
    for (const i of covered) defLines.add(i);
    const blankLabel = blankLinkText(m[1]!);
    defs.push({ line: first + 1, label: linkLabel(m[1]!), blank: blankLabel });
    // A definition whose label is blank text makes every use of it a link with no visible text (D-2).
    if (blankLabel) hits.add(first + 1);
    // The destination or the title may sit on the next line.
    let title = m[3]!;
    if (!m[2] && last + 1 < bare.length) {
      last++;
      defLines.add(last);
      title = bare[last]!.trim().replace(/^\S+/, "");
    }
    if (title.trim()) hits.add(first + 1);
    else if (last + 1 < bare.length && TITLE_START.test(bare[last + 1]!)) {
      hits.add(first + 1);
      hits.add(last + 2);
    }
  }
  if (defs.length) {
    // Definition lines blanked out in place, so offsets still map to lines.
    const body = bare.map((l, i) => (defLines.has(i) ? " ".repeat(l.length) : l)).join("\n");
    const used = new Set<string>();
    // Every use of a label with blank text, such as the shortcut `[&nbsp;]` or
    // a backslash hard break over two lines, shows no text (D-2, D-3).
    const blank = new Set(defs.filter((d) => d.blank).map((d) => d.label));
    for (const u of body.matchAll(/\[((?:\\[\s\S]|[^\\\]])+)\]/g)) {
      const label = linkLabel(u[1]!);
      used.add(label);
      if (blank.has(label) && oneParagraph(u[1]!)) {
        const lineHits = new Set<number>();
        span(u.index!, u.index! + u[0].length, lineHits);
        for (const i of lineHits) hits.add(i + 1);
      }
    }
    for (const d of defs) if (!used.has(d.label)) hits.add(d.line);
  }
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
  // Plain text gets the same HTML checks (SR-8 doesn't limit them to Markdown): the analyst or a
  // viewer may still render it, and the owner can write it without HTML.
  for (const n of hiddenMarkdownLines(lines)) hidden.add(n);
  for (const n of hiddenLinkLines(lines)) hidden.add(n);
  if (hidden.size) {
    throw new DocumentRefused("hidden_content", "The document has text a reader can't see (an HTML comment, raw HTML, a zero-width or bidi character, a link definition with a title or that no link uses, or a link or image with empty text); remove it and try again.", [...hidden].sort((a, b) => a - b));
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const plainCell = (c: string) => collapse(c.replace(/[*_`]/g, ""));

/**
 * The spec's own line for a spec ref, outside the Sources table: a table row
 * whose first cell is the ref, a line that opens with it (`FR-3:`,
 * `- **FR-3** ...`), or a heading that starts with it (`## 4. Behaviour`).
 * Null when the spec has none. The owner sees this line beside its quote, and
 * the confirmation is bound to it (Gate 2 M3, owner decision 2026-11-12).
 */
export function specLine(spec: string, ref: string): string | null {
  const want = collapse(ref).replace(/^\u00a7\s*/, "");
  const opens = new RegExp(`^(?:[-*+]\\s+)?[*_\`]*${escapeRe(want)}[*_\`]*(?:[:.)]|\\s|$)`, "i");
  let inSources = false;
  for (const raw of spec.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      inSources = /^(\d+\.\s+)?Sources\s*$/i.test(h[2]!.trim());
      if (!inSources && opens.test(h[2]!.replace(/^\u00a7\s*/, ""))) return line;
      continue;
    }
    if (inSources || !line) continue;
    if (line.startsWith("|")) {
      if (plainCell(cells(line)[0] ?? "").toLowerCase() === want.toLowerCase()) return line;
    } else if (opens.test(line)) return line;
  }
  return null;
}

/**
 * A stable hash of the table's content and of each spec ref's own line, so a
 * later spec version that changes the table, or a line the owner confirmed,
 * needs a new confirmation.
 */
export function tableHash(rows: SourceRow[], spec: string): string {
  const canon = rows.map((r) => [collapse(r.spec_ref), collapse(r.section), collapse(r.quote), collapse(specLine(spec, r.spec_ref) ?? "")]);
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

interface DocSection {
  heading: string;
  /** Text blocks under the heading, its subsections included, each collapsed. */
  blocks: string[];
}

/**
 * The document's headings, each with the blocks under it. A block ends at a
 * blank line, a heading, a list item, a table row or a code fence, so a quote
 * can't be stitched together across structure (Gate 2 M3).
 */
function documentSections(text: string): DocSection[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Array<DocSection & { level: number; open: boolean }> = [];
  const whole: DocSection & { level: number; open: boolean } = { heading: "", blocks: [], level: 0, open: true };
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    const b = collapse(block.join(" "));
    block = [];
    if (!b) return;
    whole.blocks.push(b);
    for (const s of out) if (s.open) s.blocks.push(b);
  };
  lines.forEach((raw, i) => {
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(raw);
    const next = lines[i + 1] ?? "";
    const setext = raw.trim() && !block.length && /^ {0,3}(=+|-+)[ \t]*$/.test(next) ? (next.trim()[0] === "=" ? 1 : 2) : 0;
    if (atx || setext) {
      flush();
      const level = atx ? atx[1]!.length : setext;
      for (const s of out) if (s.level >= level) s.open = false;
      out.push({ heading: collapse(atx ? (atx[2] ?? "") : raw), blocks: [], level, open: true });
      return;
    }
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(raw) && out.length && i > 0 && collapse(lines[i - 1]!) === out[out.length - 1]!.heading) return;
    if (!raw.trim() || /^ {0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/.test(raw)) return flush();
    // Any line with an unescaped pipe may be a table row (GFM allows rows
    // without outer pipes), so it is a block of its own (test defect D-1).
    const row = /(^|[^\\])\|/.test(raw);
    if (/^\s*([-*+]|\d{1,9}[.)])\s/.test(raw) || row || /^\s*(```|~~~)/.test(raw)) flush();
    block.push(raw);
    if (row) flush();
  });
  flush();
  return [whole, ...out];
}

const words = (s: string) => s.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Problems with the table against the stored document and the spec (SR-7,
 * Gate 2 M3): each row needs a spec ref the spec has a line for, a Section
 * that is one of the document's headings ("-" when it has none), and a quote
 * of at least 5 words or 25 characters that sits in one block under that
 * heading, matching after runs of whitespace are collapsed.
 * Returns the spec's line numbers with what is wrong; no document text.
 */
export function tableProblems(rows: SourceRow[], documentText: string, spec: string): string[] {
  const sections = documentSections(documentText);
  const headed = sections.length > 1;
  const out: string[] = [];
  if (rows.length === 0) out.push("the Sources table has no rows");
  if (rows.length > TOOL_LIMITS.sourceRows) out.push(`the Sources table has over ${TOOL_LIMITS.sourceRows} rows`);
  for (const r of rows.slice(0, TOOL_LIMITS.sourceRows)) {
    const quote = collapse(r.quote);
    const section = collapse(r.section);
    const under = headed ? sections.slice(1).filter((s) => s.heading.toLowerCase() === section.toLowerCase()) : section === "-" ? sections.slice(0, 1) : [];
    if (!r.spec_ref || !/^[A-Za-z0-9\u00a7][A-Za-z0-9 ._\u00a7-]{0,40}$/.test(r.spec_ref)) out.push(`line ${r.line}: Spec ref must be an FR, AC, SR or section id`);
    else if (specLine(spec, r.spec_ref) === null) out.push(`line ${r.line}: the spec has no line for ${r.spec_ref}`);
    else if (!under.length) out.push(`line ${r.line}: Section must be one of the document's headings${headed ? "" : " (\"-\" for a document without headings)"}`);
    else if (!quote) out.push(`line ${r.line}: the quote is empty`);
    else if ([...r.quote].length > TOOL_LIMITS.sourceQuote) out.push(`line ${r.line}: the quote is over ${TOOL_LIMITS.sourceQuote} characters`);
    else if (words(quote) < 5 && [...quote].length < 25) out.push(`line ${r.line}: the quote is under 5 words and 25 characters`);
    else if (!under.some((s) => s.blocks.some((b) => b.includes(quote)))) out.push(`line ${r.line}: the quote isn't in one paragraph, list item or table row under that heading`);
  }
  return out;
}
