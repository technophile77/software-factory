/**
 * F-015 SR-8: the JUnit XML results file, read by engine code with no XML
 * library. The file is written by code the agents wrote, so it is parsed as
 * hostile input: no DTD, no entities beyond XML's five and character
 * references, a depth limit, a fixed set of elements and capped text.
 */

export class JunitError extends Error {
  override name = "JunitError";
}

export const MAX_RESULTS_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 8 * 1024;
const MAX_DEPTH = 32;
const MAX_CASES = 20_000;

export type CaseStatus = "passed" | "failed" | "error" | "skipped";

export interface TestCase {
  /** `classname#name`, or the name alone when there is no class. */
  id: string;
  name: string;
  classname: string;
  status: CaseStatus;
  /** The failure's, error's or skip's message attribute. */
  message: string;
  /** The failure's or error's text, then the case's captured output. */
  detail: string;
}

interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const KEPT = new Set(["testsuites", "testsuite", "testcase", "failure", "error", "skipped", "system-out", "system-err"]);
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function cap(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

const REF = "(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,30});";

/**
 * A name as written in the test file when the reporter escaped it twice, as
 * Node's JUnit reporter does for quotes; matching uses both forms, while the
 * report keeps the name as read.
 */
export function undoubled(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_m, ref: string) => NAMED[ref]!);
}

function decode(s: string): string {
  if (new RegExp(`&(?!${REF})`).test(s)) throw new JunitError("the results file has a bare &");
  return s.replace(new RegExp(`&${REF}`, "g"), (_m, ref: string) => {
    if (ref.startsWith("#")) {
      const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new JunitError("a character reference is out of range");
      return String.fromCodePoint(cp);
    }
    const v = NAMED[ref];
    if (v === undefined) throw new JunitError("the results file uses an entity, which the engine doesn't expand");
    return v;
  });
}

/** Parses the document into the kept elements; anything else is skipped, but still checked. */
function parse(xml: string): Node {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new JunitError("the results file has a DTD, which the engine refuses");
  const root: Node = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: Array<{ node: Node | null; name: string }> = [{ node: root, name: "#root" }];
  let i = 0;
  const textTo = (t: string) => {
    const top = stack[stack.length - 1]!.node;
    if (top && top !== root && top.text.length < MAX_TEXT) top.text = cap(top.text + t);
  };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (xml.slice(i).trim()) textTo(decode(xml.slice(i)));
      break;
    }
    if (lt > i) textTo(decode(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new JunitError("an unclosed comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new JunitError("an unclosed CDATA section");
      textTo(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new JunitError("an unclosed processing instruction");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) throw new JunitError("the results file has a declaration the engine refuses");
    const gt = findTagEnd(xml, lt);
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name || stack.length === 0) throw new JunitError("the results file's elements don't nest");
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!m) throw new JunitError("a malformed tag");
    const name = m[1]!;
    const attrs = parseAttrs(body.slice(name.length));
    const parent = stack[stack.length - 1]!.node;
    const node: Node | null = parent && KEPT.has(name) ? { name, attrs, children: [], text: "" } : null;
    if (node) parent!.children.push(node);
    if (!selfClosing) {
      stack.push({ node, name });
      if (stack.length > MAX_DEPTH) throw new JunitError("the results file nests too deeply");
    }
  }
  if (stack.length !== 1) throw new JunitError("the results file ends inside an element");
  return root;
}

function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let j = from + 1; j < xml.length; j++) {
    const c = xml[j]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return j;
    else if (c === "<") break;
  }
  throw new JunitError("an unclosed tag");
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
  let pos = 0;
  while (pos < s.length) {
    if (/^\s*$/.test(s.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new JunitError("a malformed attribute");
    const k = m[1]!;
    if (Object.prototype.hasOwnProperty.call(attrs, k)) throw new JunitError("a repeated attribute");
    attrs[k] = cap(decode(m[3] ?? m[4] ?? ""));
    pos = re.lastIndex;
  }
  return attrs;
}

/** The test cases in a JUnit XML document, in file order. */
export function parseJunit(xml: string): TestCase[] {
  const root = parse(xml);
  const top = root.children;
  if (top.length !== 1 || (top[0]!.name !== "testsuites" && top[0]!.name !== "testsuite")) throw new JunitError("the results file isn't JUnit XML");
  const cases: TestCase[] = [];
  const walk = (n: Node) => {
    for (const c of n.children) {
      if (c.name === "testsuite") walk(c);
      else if (c.name === "testcase") {
        if (cases.length >= MAX_CASES) throw new JunitError("the results file lists too many tests");
        cases.push(testCase(c));
      }
    }
  };
  walk(top[0]!);
  return cases;
}

function testCase(c: Node): TestCase {
  const name = c.attrs.name ?? "";
  if (!name) throw new JunitError("a testcase has no name");
  const classname = c.attrs.classname ?? "";
  const failure = c.children.find((x) => x.name === "failure");
  const error = c.children.find((x) => x.name === "error");
  const skipped = c.children.find((x) => x.name === "skipped");
  const out = c.children.filter((x) => x.name === "system-out" || x.name === "system-err").map((x) => x.text).join("\n");
  const bad = failure ?? error;
  const status: CaseStatus = failure ? "failed" : error ? "error" : skipped ? "skipped" : "passed";
  const message = (bad ?? skipped)?.attrs.message ?? "";
  return { id: classname ? `${classname}#${name}` : name, name, classname, status, message, detail: cap([bad?.text ?? "", out].filter(Boolean).join("\n")) };
}
