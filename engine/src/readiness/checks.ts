import type { Check } from "../interview/readiness";
import { allowedBy, type Rules } from "../policy/glob";

/**
 * F-016 FR-7 and OQ-1: the structural code checks for readiness checks 1 to
 * 4. They catch what needs no judgment: a missing or empty section, an
 * acceptance criterion not in Given/When/Then form, a requirement no
 * criterion covers, a criterion covering a requirement that doesn't exist.
 * Evidence names section numbers and ids only, never spec text.
 */

const SECTIONS: Array<{ n: number; name: string; check: string }> = [
  { n: 1, name: "Objective", check: "clear_objective" },
  { n: 2, name: "Expected behavior", check: "expected_behavior_defined" },
  { n: 3, name: "Functional requirements", check: "expected_behavior_defined" },
  { n: 4, name: "Acceptance criteria", check: "acceptance_criteria_testable" },
  { n: 5, name: "Constraints", check: "constraints_documented" },
];

/** The body lines of `## <n>. ...`, up to the next `## ` heading, outside code fences. */
function section(spec: string, n: number): string[] | null {
  const lines = spec.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${n}\\.\\s+\\S`).test(l));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  return out;
}

function tableRows(lines: string[]): string[][] {
  return lines
    .filter((l) => l.trim().startsWith("|"))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim()))
    .filter((c) => c.length >= 2 && !/^:?-+:?$/.test(c[0]!) && c[0]!.toLowerCase() !== "id");
}

/** `FR-3`, `FR-1 to FR-9`, `FR-1, FR-4`: the FR numbers a Covers cell names. */
export function coveredFrs(cell: string): number[] {
  const out = new Set<number>();
  for (const m of cell.matchAll(/FR-(\d+)\s*(?:to|-|–)\s*FR-(\d+)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i - Math.min(a, b) < 200; i++) out.add(i);
  }
  for (const m of cell.matchAll(/FR-(\d+)/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

export function structuralChecks(spec: string): Check[] {
  const gaps = new Map<string, string[]>();
  const gap = (check: string, why: string) => gaps.set(check, [...(gaps.get(check) ?? []), why]);

  for (const s of SECTIONS) {
    const body = section(spec, s.n);
    if (!body) gap(s.check, `section ${s.n} (${s.name}) is missing`);
    else if (!body.some((l) => l.trim() && !/^\|?\s*:?-{3,}/.test(l.trim()))) gap(s.check, `section ${s.n} (${s.name}) is empty`);
  }

  const frRows = tableRows(section(spec, 3) ?? []).filter((c) => /^FR-\d+$/.test(c[0]!));
  const frs = new Set(frRows.filter((c) => c[1]).map((c) => Number(c[0]!.slice(3))));
  if (!frs.size) gap("expected_behavior_defined", "section 3 has no FR-<n> row with a requirement");

  const acRows = tableRows(section(spec, 4) ?? []).filter((c) => /^AC-\d+$/.test(c[0]!));
  if (!acRows.length) gap("acceptance_criteria_testable", "section 4 has no AC-<n> row");
  const covered = new Set<number>();
  for (const c of acRows) {
    const [id, text = "", covers = ""] = c;
    if (!/\bgiven\b/i.test(text) || !/\bthen\b/i.test(text)) gap("acceptance_criteria_testable", `${id} is not in Given/When/Then form`);
    const named = coveredFrs(covers);
    if (!named.length && !/\bSR-\d+/.test(covers)) gap("acceptance_criteria_testable", `${id} names no requirement in Covers`);
    for (const n of named) {
      if (!frs.has(n)) gap("acceptance_criteria_testable", `${id} covers FR-${n}, which section 3 doesn't have`);
      covered.add(n);
    }
  }
  const uncovered = [...frs].filter((n) => !covered.has(n));
  if (uncovered.length) gap("acceptance_criteria_testable", `no acceptance criterion covers ${uncovered.map((n) => `FR-${n}`).join(", ")}`);

  return ["clear_objective", "expected_behavior_defined", "acceptance_criteria_testable", "constraints_documented"].map((name) => {
    const g = gaps.get(name);
    return { name: `structure_${name}`, passed: !g, evidence: g ? `${[...new Set(g)].join("; ")}.` : "The structural checks pass." };
  });
}

/** The four checks the orchestrator judges after the code checks pass (OQ-1 (c)). */
export const JUDGED_CHECKS = ["clear_objective", "expected_behavior_defined", "acceptance_criteria_testable", "constraints_documented"] as const;

/** F-015 FR-28: one row of section 7's "Configuration changes needed before implementation" table. */
export interface ConfigChange {
  id: string;
  change: string;
  /** The code-testable form, or null for a change code can't test. */
  check: { role: string; may: boolean; path: string } | null;
  status: string;
  /** Why the Check cell can't be read, if it can't. */
  bad?: string;
}

const CONFIG_HEADING = /^###\s+Configuration changes needed before implementation\s*$/i;
const CHECK_RE = /^`?([a-z][a-z0-9-]{0,40}) may (not )?write ([^\s`]{1,300})`?$/;

/** The table's rows, or none when the spec has no such table (specs from before H-0275). */
export function configChanges(spec: string): ConfigChange[] {
  const body = section(spec, 7) ?? [];
  const start = body.findIndex((l) => CONFIG_HEADING.test(l.trim()));
  if (start < 0) return [];
  const lines: string[] = [];
  for (const l of body.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l.trim())) break;
    lines.push(l);
  }
  return tableRows(lines).filter((c) => /^C-\d+$/.test(c[0]!)).map((c) => {
    const [id, change = "", raw = "", status = ""] = c as [string, string?, string?, string?];
    const cell = raw.trim();
    if (!cell || /^(?:—|-|–|n\/a)$/i.test(cell)) return { id, change, check: null, status };
    const m = CHECK_RE.exec(cell);
    if (!m) return { id, change, check: null, status, bad: `${id}'s Check isn't "<role> may write <path>" or "<role> may not write <path>"` };
    return { id, change, check: { role: m[1]!, may: !m[2], path: m[3]! }, status };
  });
}

/** F-015 FR-28 (1), FR-28 (3): every row applied, every Check readable. */
export function configChangesCheck(spec: string): Check {
  const why: string[] = [];
  for (const r of configChanges(spec)) {
    if (r.bad) why.push(r.bad);
    if (r.status.toLowerCase() !== "applied") why.push(`${r.id} is not Applied`);
  }
  return { name: "config_changes_applied", passed: !why.length, evidence: why.length ? `${why.join("; ")}.` : "Every configuration change the spec needs is applied." };
}

/**
 * F-015 FR-28 (2): each row's Check tested against the roles' write rules as
 * the engine loaded them. `rulesOf` throws when a role's policy can't be read.
 */
export function failedConfigChecks(spec: string, rulesOf: (role: string) => Rules): Array<{ id: string; why: string }> {
  const out: Array<{ id: string; why: string }> = [];
  for (const r of configChanges(spec)) {
    if (r.bad) {
      out.push({ id: r.id, why: r.bad });
      continue;
    }
    if (!r.check) continue;
    const { role, may, path: file } = r.check;
    let rules: Rules;
    try {
      rules = rulesOf(role);
    } catch (e) {
      out.push({ id: r.id, why: `the ${role} role's policy can't be read (${(e as Error).message.slice(0, 200)})` });
      continue;
    }
    if (allowedBy(rules, file) !== may) out.push({ id: r.id, why: `the manifest says ${role} may${may ? " not" : ""} write ${file}` });
  }
  return out;
}
