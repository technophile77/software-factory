import { realPath } from "../fsutil";
import { structureProblems } from "./structure";
import * as fs from "node:fs";
import * as path from "node:path";
import { SOURCE_PATH_RE, sourcesTable, tableHash } from "./document";
import type { InterviewState } from "./model";

export interface Check {
  name: string;
  passed: boolean;
  evidence: string;
}

export class SpecPathRefused extends Error {
  override name = "SpecPathRefused";
}

const MAX_SPEC_BYTES = 1024 * 1024;

/** `docs/features/F-nnn-<name>.md` for the session's own feature only (SR-12). */
export function specPathPattern(feature: string): RegExp {
  return new RegExp(`^docs/features/${feature}-[A-Za-z0-9][A-Za-z0-9._-]{0,100}\\.md$`);
}

/**
 * Reads the spec from the worktree under the Role policy path rule (ADR
 * 0015): the real path must be inside the worktree, and here it must be the
 * named path itself, so a link anywhere on the way is refused. A refusal
 * says nothing about where a link pointed or what it held (AC-19).
 */
export function readSpec(worktree: string, feature: string, specPath: string): string {
  const refuse = () => new SpecPathRefused("spec_path must be this feature's own docs/features spec, as a regular file.");
  if (typeof specPath !== "string" || specPath.normalize("NFC") !== specPath || !specPathPattern(feature).test(specPath) || SOURCE_PATH_RE.test(specPath)) throw refuse();
  let root: string;
  try {
    root = realPath(worktree);
  } catch {
    throw refuse();
  }
  const full = path.join(root, ...specPath.split("/"));
  let cur = root;
  for (const seg of specPath.split("/")) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      throw refuse();
    }
    if (st.isSymbolicLink()) throw refuse();
  }
  let real: string;
  try {
    real = realPath(full);
  } catch {
    throw refuse();
  }
  if (real.normalize("NFC") !== full.normalize("NFC")) throw refuse();
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(full, flags);
  } catch {
    throw refuse();
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SPEC_BYTES) throw refuse();
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

function sectionLines(spec: string, heading: RegExp): Array<{ n: number; line: string }> {
  const lines = spec.split(/\r?\n/);
  const out: Array<{ n: number; line: string }> = [];
  let inside = false;
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) inside = heading.test(line);
    else if (inside) out.push({ n: i + 1, line });
  });
  return out;
}

function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

export interface SpecAssumption {
  line: number;
  id: string;
  text: string;
  status: string;
}

export function specAssumptions(spec: string): SpecAssumption[] {
  const out: SpecAssumption[] = [];
  for (const { n, line } of sectionLines(spec, /^##\s+(\d+\.\s+)?Assumptions\s*$/i)) {
    if (!line.trim().startsWith("|")) continue;
    const c = cells(line);
    if (c.length < 4 || /^-+$/.test(c[0]!.replace(/:/g, "")) || c[0]!.toLowerCase() === "id") continue;
    const [id, text, , status] = c as [string, string, string, string];
    if (!text) continue;
    out.push({ line: n, id, text, status: status.toLowerCase() });
  }
  return out;
}

export interface SpecRequirement {
  line: number;
  id: string;
  text: string;
  source: string;
  status: string;
}

/** The rows of the spec's section 9 security requirements table (F-008 SR-7, FR-9). */
export function specSecurityRequirements(spec: string): SpecRequirement[] {
  const out: SpecRequirement[] = [];
  for (const { n, line } of sectionLines(spec, /^##\s+(\d+\.\s+)?Security (considerations|requirements)\s*$/i)) {
    if (!line.trim().startsWith("|")) continue;
    const c = cells(line);
    if (c.length < 4 || /^-+$/.test(c[0]!.replace(/:/g, "")) || c[0]!.toLowerCase() === "id") continue;
    const [id, text, source, status] = c as [string, string, string, string];
    if (!/^SR-\d+$/.test(id) || !text) continue;
    out.push({ line: n, id, text, source, status: status.toLowerCase() });
  }
  return out;
}

export function specVersion(spec: string): number | null {
  const m = /^- \*\*Spec version:\*\* (\d+)\s*$/m.exec(spec);
  return m ? Number(m[1]) : null;
}

/** Lines with a remote image or raw HTML outside code (SR-22); line numbers only. */
export function remoteContentLines(spec: string): number[] {
  const hits: number[] = [];
  const refImages = /!\[[^\]]*\]\[[^\]]*\]/.test(spec);
  let fence: string | null = null;
  spec.split(/\r?\n/).forEach((raw, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (!fence) fence = f[1]![0]!.repeat(f[1]!.length);
      else if (f[1]!.startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const line = raw.replace(/(`+)[^`]*?\1/g, "");
    const image = /!\[[^\]]*\]\(\s*<?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(line) ||
      (refImages && /^\s{0,3}\[[^\]]+\]:\s*<?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(line));
    const html = /<\s*\/?\s*[a-z!][^>]*>/i.test(line);
    if (image || html) hits.push(i + 1);
  });
  return hits;
}

/**
 * The interview checks of the readiness gate (F-007 FR-12, F-005 FR-8, FR-9,
 * SR-11, development-workflow stage 4): check 6 fails while a question is
 * open, deferred or being researched; check 5 fails while an assumption is
 * pending, or when the spec's assumptions table doesn't match the owner's
 * approve_assumption replies in the transcript. Evidence names ids and line
 * numbers only, never spec or transcript text.
 */
export function readinessChecks(input: {
  spec: string;
  specVersion: number;
  state: InterviewState;
  chainIntact: boolean;
  /** For a document-started feature: whether the branch's copy still matches the stored hash (Gate 2 L1). */
  sourceIntact?: boolean;
}): Check[] {
  const { spec, state } = input;
  const checks: Check[] = [];

  const declared = specVersion(spec);
  checks.push({
    name: "spec_version",
    passed: declared === input.specVersion,
    evidence: declared === null ? "The spec has no '- **Spec version:** N' line." : `The spec says version ${declared}; the analyst reported ${input.specVersion}.`,
  });

  checks.push({
    name: "transcript_intact",
    passed: input.chainIntact,
    evidence: input.chainIntact ? "The transcript matches the engine's own chain." : "The transcript, here or on the remote, has entries the engine didn't write; the checks can't rely on it.",
  });

  const structure = structureProblems(spec);
  checks.push({
    name: "spec_structure",
    passed: structure.length === 0,
    evidence: structure.length ? `${structure.join("; ")}.` : "Every heading and table header row matches the template.",
  });

  const unresolved = state.list("question").filter((q) => q.status === "open" || q.status === "deferred" || q.status === "researching");
  checks.push({
    name: "check_6_blocking_decisions",
    passed: unresolved.length === 0,
    evidence: unresolved.length ? `Questions not answered: ${unresolved.map((q) => `${q.id} (${q.status})`).join(", ")}.` : "Every question is answered.",
  });

  const problems: string[] = [];
  const assumptions = state.list("assumption");
  const pending = assumptions.filter((a) => a.status === "open");
  if (pending.length) problems.push(`pending assumptions: ${pending.map((a) => a.id).join(", ")}`);
  const approved = new Map<string, string>();
  for (const r of state.replies.values()) {
    const a = state.items.get(r.item);
    if (r.kind === "approve_assumption" && a && a.status === "approved" && r.revision === a.revision) approved.set(norm(a.text), a.id);
  }
  const notApproved = new Map(assumptions.filter((a) => a.status !== "approved").map((a) => [norm(a.text), a.id]));
  for (const row of specAssumptions(spec)) {
    const key = norm(row.text);
    if (!row.status.startsWith("approved")) {
      problems.push(`line ${row.line}: an assumption the spec doesn't mark approved`);
    } else if (!approved.has(key)) {
      problems.push(`line ${row.line}: marked approved, but no approve_assumption entry matches it`);
    }
    if (notApproved.has(key)) problems.push(`line ${row.line}: matches ${notApproved.get(key)}, which the owner didn't approve`);
  }
  checks.push({
    name: "check_5_assumptions",
    passed: problems.length === 0,
    evidence: problems.length ? `${problems.join("; ")}.` : "No pending assumption; every approved assumption in the spec matches an approve_assumption entry.",
  });

  // Interview tools v1.1 (SR-7): for the owner's own document, the latest
  // confirmation must be approved and built from the spec's current table.
  if (state.document) {
    checks.push({
      name: "source_unchanged",
      passed: input.sourceIntact === true,
      evidence: input.sourceIntact === true ? `${state.document.path} matches the SHA-256 recorded at the start.` : `${state.document.path} is missing, not a regular file, or changed since the start.`,
    });
  }
  if (state.document?.provenance === "owner") {
    const confirmations = state.list("source_confirmation");
    const latest = confirmations[confirmations.length - 1];
    const rows = sourcesTable(spec);
    let evidence: string;
    let passed = false;
    if (!rows) evidence = "The spec has no '## Sources' table.";
    else if (!latest) evidence = "No source confirmation was filed (interview_confirm_sources).";
    else if (latest.status !== "approved") evidence = `${latest.id} is ${latest.status}, not confirmed by the owner.`;
    else if (latest.table_sha256 !== tableHash(rows, spec)) evidence = `The Sources table, or a spec line it backs, changed after ${latest.id} was confirmed; file a new confirmation.`;
    else {
      passed = true;
      evidence = `${latest.id} confirmed by the owner, for this Sources table and these spec lines.`;
    }
    checks.push({ name: "sources_confirmed", passed, evidence });
  }

  const remote = remoteContentLines(spec);
  checks.push({
    name: "no_remote_images_or_html",
    passed: remote.length === 0,
    evidence: remote.length ? `Remote image or raw HTML on lines ${remote.join(", ")}; the owner should look at them.` : "None found.",
  });
  return checks;
}
