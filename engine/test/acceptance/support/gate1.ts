// Security Gate 1 (F-008) worlds: the F-007 milestone 2 rig (fake Docker,
// fake Agent SDK) plus what Gate 1 needs at the pinned factory version, a
// requirements analyst that takes a spec through the interview checks, and a
// security reviewer that writes its report file from inside its container.
// Everything is driven as the owner and the agents would: the channel, the
// agents' tools and their container's mounts. See F-008-test-plan.md.

import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSdk, fakeRuntime, type FakeSession } from "./agents";
import { FakeDocker, type ExecAction } from "./fake-docker";
import { git, listFiles, rand, REPO_ROOT, tryGit, waitFor, World, type Project, type ProjectSpec } from "./world";

export const STATE = "refs/heads/factory/state";
export const GATE1 = "security_gate_1";
export const READINESS = "readiness_gate";
export const INTERVIEW = "requirements_interview";
/** AC-3: the most a Gate 1 session may have. */
export const REVIEWER_TOOLS = ["Read", "Grep", "Glob", "Write", "Skill"];

type RunInfo = Awaited<ReturnType<NonNullable<World["engine"]>["runs"]>>[number];

export interface MasterEdit {
  /** Edits engine/config/models.yaml at the pinned version. */
  models?: (t: string) => string;
  /** Edits engine/config/limits.yaml at the pinned version. */
  limits?: (t: string) => string;
  /** Leave the reviewer's AGENT.md out. */
  noReviewerAgent?: boolean;
}

/** Puts what Gate 1 needs (the reviewer's AGENT.md, the security-review skill, the standards) into the master and re-points the tag. */
export function pinGate1Files(w: World, edit: MasterEdit = {}, tag = "v0.1.0") {
  const m = w.master;
  if (!edit.noReviewerAgent) {
    mkdirSync(join(m, "agents", "security-reviewer"), { recursive: true });
    writeFileSync(join(m, "agents", "security-reviewer", "AGENT.md"), readFileSync(join(REPO_ROOT, "agents", "security-reviewer", "AGENT.md")));
  } else {
    rmSync(join(m, "agents", "security-reviewer"), { recursive: true, force: true });
  }
  rmSync(join(m, "skills", "security-review"), { recursive: true, force: true });
  cpSync(join(REPO_ROOT, "skills", "security-review"), join(m, "skills", "security-review"), { recursive: true });
  mkdirSync(join(m, "docs"), { recursive: true });
  writeFileSync(join(m, "docs", "security-standards.md"), readFileSync(join(REPO_ROOT, "docs", "security-standards.md")));
  const cfg = (f: string, e?: (t: string) => string) => {
    const real = readFileSync(join(REPO_ROOT, "engine", "config", f), "utf8");
    writeFileSync(join(m, "engine", "config", f), e ? e(real) : real);
  };
  cfg("models.yaml", edit.models);
  cfg("limits.yaml", edit.limits);
  git(m, "add", "-A");
  tryGit(m, "commit", "-q", "-m", `gate 1 files ${rand(3)}`);
  git(m, "tag", "-f", tag);
}

/** Drops a top-level YAML section (the key line and its indented body). */
export function dropSection(text: string, key: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (new RegExp(`^${key}:`).test(l)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^\s/.test(l) || l === "")) continue;
    skipping = false;
    out.push(l);
  }
  // Keep the final line break: on a CRLF checkout (Windows CI) a last line left as "256\r" parses as a string, not a number.
  const joined = out.join("\n");
  return text.endsWith("\n") && !joined.endsWith("\n") ? `${joined}\n` : joined;
}

/** Edits one role's block of the manifest policy. */
export function editRole(manifest: string, role: string, edit: (block: string) => string): string {
  const start = manifest.indexOf(`\n    ${role}:`);
  if (start < 0) throw new Error(`no ${role} role in the manifest`);
  const rest = manifest.slice(start + 1);
  const next = rest.slice(1).search(/\n {4}[a-z][a-z-]*:/);
  const end = next < 0 ? manifest.length : start + 1 + 1 + next;
  return manifest.slice(0, start + 1) + edit(manifest.slice(start + 1, end)) + manifest.slice(end);
}

export interface Rig {
  w: World;
  docker: FakeDocker;
  sdk: FakeSdk;
}

export async function gate1Rig(o: { project?: ProjectSpec; master?: MasterEdit; boot?: boolean; before?: (w: World) => void } = {}): Promise<Rig> {
  const w = await World.create([o.project ?? {}], { agentFiles: true });
  pinGate1Files(w, o.master);
  const docker = new FakeDocker(join(w.root, "bin"));
  const sdk = new FakeSdk(docker);
  const proxyScript = join(w.root, "bin", "proxy.js");
  writeFileSync(proxyScript, "// stands in for dist/proxy.js; the fake Docker plays the proxy\n");
  w.agents = await fakeRuntime(w.root, docker, sdk, proxyScript);
  o.before?.(w);
  if (o.boot !== false) await w.boot();
  return { w, docker, sdk };
}

/** Commits a file on the config repo's main, locally and on the remote. */
export function commitOnMain(p: Project, files: Record<string, string>, symlinks: Record<string, string> = {}) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(p.configRepo, rel, ".."), { recursive: true });
    writeFileSync(join(p.configRepo, rel), content);
  }
  for (const [rel, target] of Object.entries(symlinks)) {
    mkdirSync(join(p.configRepo, rel, ".."), { recursive: true });
    rmSync(join(p.configRepo, rel), { force: true });
    symlinkSync(target, join(p.configRepo, rel));
  }
  git(p.configRepo, "add", "-A");
  git(p.configRepo, "commit", "-q", "-m", `main change ${rand(3)}`);
  git(p.configRepo, "push", "-q", p.bare, "main");
}

// -- Specs ---------------------------------------------------------------------

export interface SrRow {
  id: string;
  text: string;
  source: string;
  status: string;
}

export const ANALYST_SR: SrRow = { id: "SR-1", text: "Exported cells that start with =, +, - or @ are escaped.", source: "Analyst", status: "Approved" };

/** A spec in the feature template's shape with the given section 9 rows. */
export function g1Spec(feature: string, o: { version?: number; srs?: SrRow[]; behavior?: string } = {}): string {
  const srs = o.srs ?? [ANALYST_SR];
  return `# Feature: CSV export

- **Id:** ${feature}
- **Status:** In review
- **Requested by / date:** Owner, 2026-11-12
- **Spec version:** ${o.version ?? 3}

## 1. Objective and business purpose
Let people export their data as CSV.

## 2. Expected behavior
${o.behavior ?? "A button downloads a CSV file of the current table."}

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Export all rows as CSV. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given rows, when export is pressed, then a CSV with every row downloads. | FR-1 |

## 5. Constraints
None.

## 6. Edge cases
Empty table.

## 7. Dependencies
None.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
${srs.map((r) => `| ${r.id} | ${r.text} | ${r.source} | ${r.status} |`).join("\n")}

## 10. Interface requirements
None.

## 11. Readiness gate
- [ ] Clear objective

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| ${o.version ?? 3} | 2026-11-12 | Interview | — |
`;
}

export function featureBranch(w: World, feature: string): string {
  const ref = git(w.project().clone, "for-each-ref", "--format=%(refname)", `refs/heads/feature/${feature}-*`).trim().split("\n")[0];
  if (!ref) throw new Error(`no branch for ${feature}`);
  return ref;
}

/** The spec's path in the worktree, as the analyst's instructions name it (docs/features/<branch slug>.md). */
export function specRel(w: World, feature: string): string {
  return `docs/features/${featureBranch(w, feature).replace(/^refs\/heads\/feature\//, "")}.md`;
}

// -- Agents --------------------------------------------------------------------

export interface AnalystStep {
  /** A question to ask first; the session then waits for the owner's reply turn. */
  ask?: (firstTurn: string) => { text: string; why: string; suggested?: string };
  /** After the owner's reply: an assumption to propose; the session then waits for the owner's reply to it. */
  assume?: (reply: string | null) => { text: string; why: string } | null;
  /** The spec to write; return null to write nothing. */
  spec: (ctx: { feature: string; firstTurn: string; reply: string | null }) => string | null;
  version?: number;
  /** Skip interview_spec_ready. */
  noSpecReady?: boolean;
}

export interface AnalystLog {
  firstTurns: string[];
  asked: any[];
  ready: any[];
  sessions: FakeSession[];
}

/**
 * Plays the requirements analyst, one step per session in order: it reads
 * its first turn, may ask one question and wait for the owner's reply, writes
 * the spec in its container and reports it ready.
 */
export function playAnalyst(r: Rig, feature: () => string, steps: AnalystStep[]): AnalystLog {
  const log: AnalystLog = { firstTurns: [], asked: [], ready: [], sessions: [] };
  let i = 0;
  r.sdk.behaviours.analyst = async (s) => {
    const step = steps[i++];
    log.sessions.push(s);
    const first = (await s.nextTurn()) ?? "";
    log.firstTurns.push(first);
    if (!step) return;
    const f = await waitFor(() => feature(), 10_000, "the feature id");
    let reply: string | null = null;
    if (step.ask) {
      const a = await s.call("interview_ask", step.ask(first));
      log.asked.push(a.value);
      reply = await s.nextTurn();
      const a2 = step.assume?.(reply);
      if (a2) {
        const res = await s.call("interview_propose_assumption", a2);
        log.asked.push(res.value);
        await s.nextTurn();
      }
    }
    const text = step.spec({ feature: f, firstTurn: first, reply });
    const rel = specRel(r.w, f);
    if (text !== null) await s.exec([{ write: `/workspace/${rel}`, content: text }]);
    if (!step.noSpecReady) {
      const res = await s.call("interview_spec_ready", { spec_path: rel, spec_version: step.version ?? 3 });
      log.ready.push(res.value);
    }
  };
  return log;
}

export interface ReviewerCtx {
  session: FakeSession;
  /** 1 for the first reviewer session of the test, and so on. */
  index: number;
  turn: string;
  /** The report path the engine named, relative to /workspace. */
  reportRel: string;
  feature: string;
  /** The commit the reviewer reviews: the turn's, or the branch head. */
  commit: string;
}

export type ReviewerAct = (ctx: ReviewerCtx) => ExecAction[] | Promise<ExecAction[]>;

export interface ReviewerLog {
  turns: string[];
  ctx: ReviewerCtx[];
  exits: Array<number | null>;
}

/** The last 40-hex commit id the turn names. */
function commitIn(text: string): string | null {
  const all = text.match(/\b[0-9a-f]{40}\b/g);
  return all ? all[all.length - 1]! : null;
}

/** Plays the security reviewer: each session gets the next act; past the end the last one repeats. */
export function playReviewer(r: Rig, feature: () => string, acts: ReviewerAct[]): ReviewerLog {
  const log: ReviewerLog = { turns: [], ctx: [], exits: [] };
  let index = 0;
  let commit: string | null = null;
  r.sdk.behaviours.reviewer = async (s) => {
    const n = ++index;
    const turn = (await s.nextTurn()) ?? "";
    log.turns.push(turn);
    const m = /\/workspace\/(\.factory\/runs\/[^\s`'"]+?\.json)/.exec(turn);
    const f = feature();
    commit = commitIn(turn) ?? commit ?? git(r.w.project().clone, "rev-parse", featureBranch(r.w, f)).trim();
    const ctx: ReviewerCtx = { session: s, index: n, turn, reportRel: m ? m[1]! : "", feature: f, commit };
    log.ctx.push(ctx);
    const act = acts[Math.min(n - 1, acts.length - 1)];
    if (!act) return;
    const actions = await act(ctx);
    log.exits.push(await s.exec(actions));
  };
  return log;
}

/** The checklist questions of the Gate 1 checklist at the pinned version, read independently of the engine. */
export function checklistQuestions(w: World): string[] {
  const text = readFileSync(join(w.master, "docs", "security-standards.md"), "utf8");
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) inside = /^##\s+Gate 1\b.*checklist/i.test(line);
    else if (inside && line.startsWith("- ")) out.push(line.slice(2).trim());
  }
  if (!out.length) throw new Error("no Gate 1 checklist in the standards");
  return out;
}

export interface Finding {
  criterion: string;
  severity: string;
  location: string;
  explanation: string;
  fix: string;
  blocks: boolean;
  needs_owner?: boolean;
  options?: Array<{ id: string; label: string }>;
  recommendation?: string;
}

export function requirementFinding(o: Partial<Finding> = {}): Finding {
  return {
    criterion: "S1.1",
    severity: "High",
    location: "Section 9",
    explanation: "The spec doesn't say how values that look like formulas are handled when exported.",
    fix: "Exported cells are prefixed with a single quote when they start with =, +, - or @.",
    blocks: true,
    needs_owner: false,
    ...o,
  };
}

export function choiceFinding(o: Partial<Finding> = {}): Finding {
  return {
    criterion: "S8.5",
    severity: "Medium",
    location: "Section 2",
    explanation: "The export could run in the browser or on the server; each widens a different permission.",
    fix: "Choose where the export runs.",
    blocks: true,
    needs_owner: true,
    options: [
      { id: "A", label: "Export in the browser" },
      { id: "B", label: "Export on the server" },
    ],
    recommendation: "A",
    ...o,
  };
}

/** A report in the Agent report v1.3 security-reviewer shape that the spec's rules accept. */
export function reportDoc(w: World, ctx: ReviewerCtx, o: { findings?: Finding[]; summary?: string; answer?: string; permissions?: string[]; abuse?: string[] } = {}): Record<string, any> {
  return {
    schema: "agent-report/1.0",
    role: "security-reviewer",
    feature: ctx.feature,
    stage: GATE1,
    commit: ctx.commit,
    outcome: "complete",
    summary: o.summary ?? "The spec covers the export's input handling; see section 9.",
    items_filed: [],
    artifacts: [],
    body: {
      gate: 1,
      findings: o.findings ?? [],
      checklist: checklistQuestions(w).map((question) => ({ question, answer: o.answer ?? "Yes: section 2 and SR-1 in section 9 cover it." })),
      permissions_added: o.permissions ?? ["None beyond the existing download, see section 2."],
      abuse_cases: o.abuse ?? ["A cell holding a formula, covered by SR-1 in section 9."],
      not_applicable: [{ criterion: "S4", reason: "No new dependency, see section 7." }],
    },
  };
}

/** The act of writing `content` as the named report. */
export function writeReport(content: (ctx: ReviewerCtx) => string): ReviewerAct {
  return (ctx) => [{ write: `/workspace/${ctx.reportRel}`, content: content(ctx) }];
}

export function validReport(w: World, o: Parameters<typeof reportDoc>[2] = {}): ReviewerAct {
  return writeReport((ctx) => JSON.stringify(reportDoc(w, ctx, o), null, 2));
}

// -- Observations --------------------------------------------------------------

export async function stageOf(w: World, feature: string): Promise<string | undefined> {
  const s = await w.ok("engine.status");
  return (s.features as Array<{ id: string; stage: string }>).find((f) => f.id === feature)?.stage;
}

// Windows CI runners take several times longer per git and pipe call; a Gate 1 run with a correction can pass 30 s there.
export async function waitStage(w: World, feature: string, stage: string, ms = process.platform === "win32" ? 90_000 : 30_000): Promise<void> {
  try {
    // One channel connection per poll: polled every 25 ms, a Windows named pipe runs out of instances and drops
    // connections, so a failed poll counts as "not there yet" and the polls are spaced.
    await waitFor(async () => {
      const at = await stageOf(w, feature).catch(() => undefined);
      if (at !== stage) await new Promise((r) => setTimeout(r, 200));
      return at === stage;
    }, ms, `${feature} at ${stage}`);
  } catch (e) {
    throw new Error(`${(e as Error).message}; engine.status says ${await stageOf(w, feature).catch(() => "nothing")}`);
  }
}

export async function reviewerRuns(w: World, feature: string): Promise<RunInfo[]> {
  return (await w.engine!.runs()).filter((r) => r.feature === feature && r.role === "security-reviewer");
}

export async function analystRuns(w: World, feature: string): Promise<RunInfo[]> {
  return (await w.engine!.runs()).filter((r) => r.feature === feature && r.role === "requirements-analyst");
}

/** Waits until `count` reviewer runs exist and none is running. */
export async function reviewerSettled(w: World, feature: string, count = 1, ms = 40_000): Promise<RunInfo[]> {
  return waitFor(async () => {
    const runs = await reviewerRuns(w, feature);
    return runs.length >= count && runs.every((x) => x.status !== "running") ? runs : undefined;
  }, ms, `${count} settled reviewer run(s) for ${feature}`);
}

/** The analyst's run ended (complete or failed). */
export async function analystSettled(w: World, feature: string, count = 1, ms = 40_000): Promise<RunInfo[]> {
  return waitFor(async () => {
    const runs = await analystRuns(w, feature);
    return runs.length >= count && runs.every((x) => x.status !== "running") ? runs : undefined;
  }, ms, `${count} settled analyst run(s) for ${feature}`);
}

/** Every Gate 1 agent report, wherever the engine committed it: factory/state or the feature branch. */
export function gate1Reports(w: World, feature: string): Array<{ where: string; path: string; doc: any }> {
  const p = w.project();
  const out: Array<{ where: string; path: string; doc: any }> = [];
  const look = (ref: string, prefix: string) => {
    const names = tryGit(p.clone, "ls-tree", "-r", "--name-only", ref, "--", `${prefix}runs/${feature}/${GATE1}`) ?? "";
    for (const n of names.split("\n").filter(Boolean)) {
      const text = tryGit(p.clone, "show", `${ref}:${n}`);
      if (!text) continue;
      try {
        out.push({ where: ref, path: n, doc: JSON.parse(text) });
      } catch {
        out.push({ where: ref, path: n, doc: { unparsable: text } });
      }
    }
  };
  look(STATE, "");
  const branch = tryGit(p.clone, "for-each-ref", "--format=%(refname)", `refs/heads/feature/${feature}-*`)?.trim();
  if (branch) look(branch, ".factory/");
  return out;
}

export function renderingRel(feature: string) {
  return `docs/features/${feature}-security-gate1.md`;
}

/** The rendered Gate 1 report on the feature branch, or null. */
export function rendering(w: World, feature: string): string | null {
  return tryGit(w.project().clone, "show", `${featureBranch(w, feature)}:${renderingRel(feature)}`);
}

export function engineLog(w: World): string {
  return listFiles(w.logDir).map((f) => readFileSync(f, "utf8")).join("\n");
}

/** The feature's transcript as committed on factory/state, every file joined. */
export function committedTranscript(w: World, feature: string): string {
  const p = w.project();
  const names = tryGit(p.clone, "ls-tree", "-r", "--name-only", STATE, "--", `interviews/${feature}`) ?? "";
  return names.split("\n").filter(Boolean).map((n) => tryGit(p.clone, "show", `${STATE}:${n}`) ?? "").join("\n");
}

/** Distinct Security items by id. */
export function securityItems(w: World): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of w.securityItems()) m.set(i.id, i.text);
  return m;
}

/** Security items filed after a snapshot of ids. */
export function newSecurityItems(w: World, before: Map<string, string>): Array<{ id: string; text: string }> {
  return [...securityItems(w)].filter(([id]) => !before.has(id)).map(([id, text]) => ({ id, text }));
}

/** The docker `run` argument lists for the reviewer's containers. */
export function reviewerRunsArgs(r: Rig): string[][] {
  return r.docker.commands().filter((c) => c[0] === "run" && /security-reviewer/.test(c[c.indexOf("--name") + 1] ?? ""));
}

export function mountsOf(args: string[]): Array<Record<string, string | true>> {
  return args.flatMap((a, i) => (a === "--mount" ? [args[i + 1]!] : [])).map((v) => {
    const kv: Record<string, string | true> = {};
    for (const part of v.split(",")) {
      const e = part.indexOf("=");
      kv[e < 0 ? part : part.slice(0, e)] = e < 0 ? true : part.slice(e + 1);
    }
    return kv;
  });
}

export const isReadOnly = (m: Record<string, string | true>) => m.readonly === true || m.readonly === "true" || m.ro === true || m.ro === "true";

/** Holds an act until the test releases it. */
export function gate<T = void>(): { wait: Promise<T>; open: (v: T) => void } {
  let open!: (v: T) => void;
  const wait = new Promise<T>((r) => (open = r));
  return { wait, open };
}
