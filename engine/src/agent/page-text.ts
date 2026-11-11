/**
 * fetch_page's text half (SR-21, H-0083): a page reaches the web reader as
 * plain text with its hidden content removed: comments, scripts and styles,
 * metadata, hidden elements, and zero-width, bidi and tag characters. The
 * point is that nothing a person reading the page wouldn't see reaches the
 * model. When unsure (an unclosed hidden element), the rest is dropped.
 */

/** Zero-width, bidi control, invisible separator and Unicode tag characters. */
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8]|\udb40[\udc00-\udc7f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg", "math", "iframe", "object", "embed", "canvas", "audio", "video", "picture", "select", "datalist", "dialog"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "table", "tr", "blockquote", "pre", "dl", "dt", "dd", "figure", "figcaption", "address", "form", "fieldset", "hr", "br", "summary", "details"]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»", euro: "€", pound: "£", deg: "°", times: "×" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, "").replace(CONTROL, "");
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?(?=\\s|$|/)`, "i");
  const m = re.exec(attrs);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** Hidden by markup or inline style: the `hidden` attribute, aria-hidden, hidden inputs, and styles that make text invisible. */
export function hiddenByAttributes(tag: string, attrs: string): boolean {
  if (attr(attrs, "hidden") !== null) return true;
  if ((attr(attrs, "aria-hidden") ?? "").toLowerCase() === "true") return true;
  if (tag === "input" && (attr(attrs, "type") ?? "").toLowerCase() === "hidden") return true;
  const style = (attr(attrs, "style") ?? "").toLowerCase().replace(/\s+/g, "");
  if (!style) return false;
  return /(^|;)display:none/.test(style) || /(^|;)visibility:(hidden|collapse)/.test(style) || /(^|;)opacity:0(\.0+)?(;|$|!)/.test(style)
    || /(^|;)font-size:0([a-z%]*)?(;|$|!)/.test(style) || /(^|;)(width|height|max-width|max-height):0([a-z%]*)?(;|$|!)/.test(style)
    || /(^|;)clip(-path)?:/.test(style) || /(^|;)text-indent:-\d{3,}/.test(style) || /(^|;)(left|top):-\d{3,}/.test(style)
    || /(^|;)color:transparent/.test(style);
}

export function htmlToText(html: string): string {
  const out: string[] = [];
  const tagRe = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<\/?([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let skipTag: string | null = null;
  let skipDepth = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (skipTag === null && m.index > last) out.push(decodeEntities(html.slice(last, m.index)));
    last = tagRe.lastIndex;
    const name = m[1]?.toLowerCase();
    if (!name) continue;
    const closing = m[0][1] === "/";
    const attrs = m[2] ?? "";
    const selfClosing = /\/\s*$/.test(attrs) || VOID.has(name);
    if (skipTag !== null) {
      if (name === skipTag && !selfClosing) skipDepth += closing ? -1 : 1;
      if (skipDepth === 0) skipTag = null;
      continue;
    }
    if (closing) {
      if (BLOCK.has(name)) out.push("\n");
      continue;
    }
    if ((SKIP.has(name) || hiddenByAttributes(name, attrs)) && !selfClosing) {
      skipTag = name;
      skipDepth = 1;
      continue;
    }
    if (name === "img") {
      const alt = attr(attrs, "alt");
      if (alt && !hiddenByAttributes(name, attrs)) out.push(` ${alt} `);
    }
    if (BLOCK.has(name)) out.push("\n");
    if (name === "td" || name === "th") out.push(" ");
  }
  // An unclosed hidden element hides the rest, as a browser would.
  if (skipTag === null && last < html.length) out.push(decodeEntities(html.slice(last).replace(/<[^>]*$/, "")));
  return out.join("");
}

function tidy(s: string): string {
  return stripInvisible(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface PageText {
  text: string;
  truncated: boolean;
}

/** The page as the reader sees it, at most `maxChars` characters (code points). */
export function pageText(body: Buffer, contentType: string, maxChars: number): PageText | null {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  const isHtml = ct === "text/html" || ct === "application/xhtml+xml";
  if (!isHtml && ct !== "text/plain") return null;
  const charset = /charset\s*=\s*"?([A-Za-z0-9_-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  let raw: string;
  try {
    raw = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8").decode(body);
  } catch {
    raw = new TextDecoder("utf-8").decode(body);
  }
  const text = tidy(isHtml ? htmlToText(raw) : raw);
  const chars = [...text];
  if (chars.length <= maxChars) return { text, truncated: false };
  return { text: chars.slice(0, maxChars).join(""), truncated: true };
}
