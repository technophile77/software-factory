import * as fs from "node:fs";
import * as path from "node:path";
import { norm, specSecurityRequirements } from "../interview/readiness";
import type { Standards } from "./standards";

export const GATE1_STAGE = "security_gate_1";
export const REVIEWER_ROLE = "security-reviewer";

export interface Gate1Finding {
  criterion: string;
  severity: string;
  location: string;
  explanation: string;
  /** The suggested requirement, or for a choice, what the options are about. */
  fix: string;
  blocks: boolean;
  needs_owner: boolean;
  options?: Array<{ id: string; label: string }>;
  recommendation?: string;
}

export interface Gate1Report {
  summary: string;
  findings: Gate1Finding[];
  checklist: Array<{ question: string; answer: string }>;
  permissions_added: string[];
  abuse_cases: string[];
  not_applicable: Array<{ criterion: string; reason: string }>;
}

export interface Expected {
  feature: string;
  commit: string;
  standards: Standards;
  /** The spec as the gate reviewed it, for SR-7. */
  spec: string;
  maxBytes: number;
}

export type ReportResult = { ok: true; report: Gate1Report } | { ok: false; errors: string[] };

const CAP = { summary: 2000, location: 500, text: 4000, answer: 2000, label: 200, list: 50, item: 1000 } as const;
const MAX_DEPTH = 8;
const OPTION_IDS = ["A", "B", "C", "D"];
// Control characters other than tab and newline would let text hide or reorder what the owner reads.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/;
const ENVELOPE = new Set(["schema", "role", "feature", "stage", "commit", "outcome", "summary", "items_filed", "artifacts", "body"]);
const BODY = new Set(["gate", "findings", "checklist", "permissions_added", "abuse_cases", "not_applicable"]);
const FINDING = new Set(["criterion", "severity", "location", "explanation", "fix", "blocks", "needs_owner", "options", "recommendation"]);
// SR-7: an empty report must point at the spec for each answer.
const CITES_SPEC = /\b(section|§)\s*\d+|\b(FR|SR|AC|A|OQ)-\d+\b/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function depth(v: unknown, d = 0): number {
  if (d > MAX_DEPTH) return d;
  if (Array.isArray(v)) return Math.max(d, ...v.map((x) => depth(x, d + 1)));
  if (isObj(v)) return Math.max(d, ...Object.values(v).map((x) => depth(x, d + 1)));
  return d;
}

/**
 * SR-8: reads the report from the engine-owned report folder without
 * following a link: the named file must be a regular file of at most
 * `maxBytes`. Returns null when it is missing, and a reason when it can't be
 * used; the content is never echoed.
 */
export function readReportFile(dir: string, name: string, maxBytes: number): { text: string } | { missing: true } | { refused: string } {
  const full = path.join(dir, name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(full);
  } catch {
    return { missing: true };
  }
  if (!st.isFile()) return { refused: "the report is not a regular file" };
  if (st.size > maxBytes) return { refused: `the report is over ${Math.floor(maxBytes / 1024)} KiB` };
  let fd: number;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return { refused: "the report couldn't be opened as a regular file" };
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > maxBytes) return { refused: "the report changed while it was read" };
    const buf = Buffer.alloc(fst.size);
    fs.readSync(fd, buf, 0, fst.size, 0);
    return { text: buf.toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * FR-4, FR-5, SR-7: checks a Gate 1 report. Errors name the field and the
 * rule only, never the reviewer's text, so they can go back to the reviewer
 * and into the log as engine words.
 */
export function validateReport(text: string, x: Expected): ReportResult {
  const errors: string[] = [];
  const err = (m: string) => {
    if (errors.length < 40) errors.push(m);
  };
  if (Buffer.byteLength(text, "utf8") > x.maxBytes) return { ok: false, errors: [`the report is over ${Math.floor(x.maxBytes / 1024)} KiB`] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["the report is not valid JSON"] };
  }
  if (depth(doc) > MAX_DEPTH) return { ok: false, errors: [`the report is nested deeper than ${MAX_DEPTH} levels`] };
  if (!isObj(doc)) return { ok: false, errors: ["the report must be a JSON object"] };

  const str = (v: unknown, where: string, cap: number, required = true): string => {
    if (typeof v !== "string" || (required && !v.trim())) {
      err(`${where} must be a non-empty string`);
      return "";
    }
    if (v.length > cap) err(`${where} is over ${cap} characters`);
    if (CONTROL.test(v)) err(`${where} holds control or bidirectional characters`);
    return v;
  };
  const strList = (v: unknown, where: string): string[] => {
    if (!Array.isArray(v)) {
      err(`${where} must be a list (empty if there are none)`);
      return [];
    }
    if (v.length > CAP.list) err(`${where} has more than ${CAP.list} entries`);
    return v.slice(0, CAP.list).map((s, i) => str(s, `${where}[${i}]`, CAP.item));
  };

  for (const k of Object.keys(doc)) if (!ENVELOPE.has(k)) err(`unexpected field '${k.slice(0, 40)}' (the engine fills the rest)`);
  if (doc.schema !== "agent-report/1.0") err("schema must be agent-report/1.0");
  if (doc.role !== REVIEWER_ROLE) err(`role must be ${REVIEWER_ROLE}`);
  if (doc.feature !== x.feature) err(`feature must be ${x.feature}`);
  if (doc.stage !== GATE1_STAGE) err(`stage must be ${GATE1_STAGE}`);
  if (doc.commit !== x.commit) err(`commit must be ${x.commit}, the commit you were given`);
  if (doc.outcome !== "complete") err("outcome must be complete");
  const summary = str(doc.summary, "summary", CAP.summary);
  if (doc.items_filed !== undefined && !(Array.isArray(doc.items_filed) && doc.items_filed.length === 0)) err("items_filed must be empty: the engine files items");
  if (doc.artifacts !== undefined && !(Array.isArray(doc.artifacts) && doc.artifacts.length === 0)) err("artifacts must be empty: the engine fills them");

  const body = doc.body;
  if (!isObj(body)) return { ok: false, errors: [...errors, "body must be an object"] };
  for (const k of Object.keys(body)) if (!BODY.has(k)) err(`unexpected body field '${k.slice(0, 40)}'`);
  if (body.gate !== 1) err("body.gate must be 1");

  const findings: Gate1Finding[] = [];
  if (!Array.isArray(body.findings)) err("body.findings must be a list (empty if there are none)");
  else {
    if (body.findings.length > CAP.list) err(`body.findings has more than ${CAP.list} entries`);
    body.findings.slice(0, CAP.list).forEach((f, i) => {
      const w = `body.findings[${i}]`;
      if (!isObj(f)) return err(`${w} must be an object`);
      for (const k of Object.keys(f)) if (!FINDING.has(k)) err(`unexpected field ${w}.${k.slice(0, 40)}`);
      if (typeof f.criterion !== "string" || !x.standards.criteria.has(f.criterion)) err(`${w}.criterion must be a criterion id from the standards you were given`);
      if (typeof f.severity !== "string" || !x.standards.severities.includes(f.severity)) err(`${w}.severity must be one of ${x.standards.severities.join(", ")}`);
      if (typeof f.blocks !== "boolean") err(`${w}.blocks must be true or false`);
      if (f.needs_owner !== undefined && typeof f.needs_owner !== "boolean") err(`${w}.needs_owner must be true or false`);
      const needsOwner = f.needs_owner === true;
      const out: Gate1Finding = {
        criterion: String(f.criterion), severity: String(f.severity),
        location: str(f.location, `${w}.location`, CAP.location),
        explanation: str(f.explanation, `${w}.explanation`, CAP.text),
        fix: str(f.fix, `${w}.fix`, CAP.text),
        blocks: f.blocks === true, needs_owner: needsOwner,
      };
      if (needsOwner) {
        if (!Array.isArray(f.options) || f.options.length < 2 || f.options.length > OPTION_IDS.length) err(`${w}.options must list 2 to ${OPTION_IDS.length} options for a finding that needs the owner`);
        else {
          out.options = f.options.map((o, j) => {
            const ow = `${w}.options[${j}]`;
            if (!isObj(o)) {
              err(`${ow} must be an object`);
              return { id: "", label: "" };
            }
            if (o.id !== OPTION_IDS[j]) err(`${ow}.id must be ${OPTION_IDS[j]}`);
            return { id: String(o.id), label: str(o.label, `${ow}.label`, CAP.label) };
          });
          if (typeof f.recommendation !== "string" || !out.options.some((o) => o.id === f.recommendation)) err(`${w}.recommendation must be one of the option ids`);
          else out.recommendation = f.recommendation;
        }
      } else if (f.options !== undefined || f.recommendation !== undefined) {
        err(`${w} has options but needs_owner isn't true`);
      }
      findings.push(out);
    });
  }

  const checklist: Gate1Report["checklist"] = [];
  if (!Array.isArray(body.checklist)) err("body.checklist must list every Gate 1 checklist question with its answer");
  else {
    const given = new Map<string, unknown>();
    body.checklist.slice(0, CAP.list).forEach((c, i) => {
      if (!isObj(c) || typeof c.question !== "string") return err(`body.checklist[${i}] must be { question, answer }`);
      given.set(norm(c.question), c.answer);
    });
    x.standards.checklist.forEach((q, i) => {
      const a = given.get(norm(q));
      if (a === undefined) return err(`body.checklist has no answer for checklist question ${i + 1}`);
      const answer = str(a, `the answer to checklist question ${i + 1}`, CAP.answer);
      checklist.push({ question: q, answer });
    });
  }

  const permissions = strList(body.permissions_added, "body.permissions_added");
  const abuse = strList(body.abuse_cases, "body.abuse_cases");
  const notApplicable: Gate1Report["not_applicable"] = [];
  if (!Array.isArray(body.not_applicable)) err("body.not_applicable must be a list (empty if there are none)");
  else {
    body.not_applicable.slice(0, CAP.list).forEach((n, i) => {
      if (!isObj(n)) return err(`body.not_applicable[${i}] must be { criterion, reason }`);
      if (typeof n.criterion !== "string" || !/^[SP]\d{1,2}(\.\d{1,2})?$/.test(n.criterion)) err(`body.not_applicable[${i}].criterion must be a criterion or group id`);
      notApplicable.push({ criterion: String(n.criterion), reason: str(n.reason, `body.not_applicable[${i}].reason`, CAP.item) });
    });
  }

  // SR-7: the engine can't tell an honest empty report from a steered one, so an empty one must show its work.
  if (Array.isArray(body.findings) && body.findings.length === 0) {
    if (!specSecurityRequirements(x.spec).length) err("a report with no findings isn't accepted for a spec whose section 9 has no security requirement");
    checklist.forEach((c, i) => {
      if (c.answer && !CITES_SPEC.test(c.answer)) err(`with no findings, the answer to checklist question ${i + 1} must cite the spec section or requirement ids it relies on`);
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, report: { summary, findings, checklist, permissions_added: permissions, abuse_cases: abuse, not_applicable: notApplicable } };
}
