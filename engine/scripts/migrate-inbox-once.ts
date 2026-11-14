/**
 * F-011 FR-16, SR-20: the one-time move of open inbox item files on a
 * project's `factory/state` to GitHub issues. Not engine code: it runs once
 * per existing project, with the engine stopped, and is deleted from the
 * repo once the owner's projects are migrated (H-0164).
 *
 *   npm run migrate-inbox -- --project <config repo clone> --gitleaks <path> [--home <engine folder>]
 *
 * Each open item becomes a record and a rendered body through the engine's
 * normal filing path (the secrets scan included), and its old file is removed
 * in the same commit. The engine opens the issue at its next poll.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { systemClock } from "../src/clock";
import { ensureOwnerDir, findOnPath } from "../src/fsutil";
import { Git } from "../src/git";
import { Gitleaks, SecretsScanner } from "../src/gitleaks";
import { Inbox } from "../src/inbox/store";
import { Category, ItemInput, KIND_PREFIX, Kind, Part, Priority, SECTIONS } from "../src/inbox/model";
import { Logger, MemoryLogger } from "../src/log";
import { Children } from "../src/proc";
import { StateRepo } from "../src/state/state-repo";
import type { Clock } from "../src/clock";

const KINDS = Object.keys(KIND_PREFIX) as Kind[];
const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];
const CATEGORIES: Category[] = ["Product", "Architecture", "Interfaces", "Assumptions", "Security"];

/**
 * F-016 FR-12: the effect of an old engine item, from the fixed titles the
 * engine wrote before v0.5. Only items the engine filed get one; anything
 * else is record only (H-0182).
 */
const EFFECTS: Array<[RegExp, (m: RegExpExecArray) => ItemInput["effect"]]> = [
  [/^Gate 1 #(\d+) for (F-\d{3,6}): the owner's choice$/, (m) => ({ type: "gate1_choice", feature: m[2]!, finding: Number(m[1]) })],
  [/^Gate 1 #(\d+) for (F-\d{3,6}): accept the risk or send it back$/, (m) => ({ type: "gate1_risk", feature: m[2]!, finding: Number(m[1]) })],
  [/^Pinned owner keys changed$/, () => ({ type: "pins" })],
];

export interface Migrated {
  migrated: Array<{ from: string; id: string }>;
  /** Files that couldn't be read or filed, with why; they stay where they are. */
  skipped: Array<{ from: string; why: string }>;
  /** Closed items: nothing to carry over, left as they are. */
  closed: string[];
}

function sections(kind: Kind, body: string, author: string): Record<string, Part[]> {
  const out: Record<string, Part[]> = {};
  const names = new Set(SECTIONS[kind]);
  let name: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) {
      const key = name && names.has(name) ? name : SECTIONS[kind][0]!;
      // SR-20: the old text skipped the issue template's escaping, so all of it is outside text.
      (out[key] ??= []).push({ outside: name && !names.has(name) ? `${name}\n\n${text}` : text, author });
    }
    lines = [];
  };
  for (const l of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) {
      flush();
      name = h[1]!;
    } else lines.push(l);
  }
  flush();
  return out;
}

/** One old item file to the filing input, or why it can't be. */
export function parseOldItem(text: string, from: string): { item: ItemInput; id: string; status: string; dropped: number } | { why: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { why: "no front matter" };
  let front: Record<string, unknown>;
  try {
    front = YAML.parse(m[1]!) as Record<string, unknown>;
  } catch {
    return { why: "the front matter isn't YAML" };
  }
  if (!front || typeof front !== "object") return { why: "the front matter isn't a mapping" };
  const kind = (front.inbox ?? front.kind) as Kind;
  if (!KINDS.includes(kind)) return { why: `unknown kind ${JSON.stringify(front.inbox ?? front.kind)}` };
  const id = String(front.id ?? "");
  if (!new RegExp(`^${KIND_PREFIX[kind]}-\\d{4,}$`).test(id) || path.posix.basename(from, ".md") !== id) return { why: "its id doesn't match its file name" };
  const title = typeof front.title === "string" && front.title.trim() ? front.title.trim() : null;
  if (!title) return { why: "no title" };
  const priority = PRIORITIES.includes(front.priority as Priority) ? (front.priority as Priority) : "medium";
  const category = CATEGORIES.includes(front.category as Category) ? (front.category as Category) : undefined;
  const createdBy = typeof front.created_by === "string" ? front.created_by : "unknown";
  const options = Array.isArray(front.options)
    ? (front.options as Array<Record<string, unknown>>).filter((o) => typeof o?.id === "string" && typeof o?.label === "string").map((o) => ({ id: o.id as string, label: o.label as string }))
    : undefined;
  const effect = createdBy === "engine" ? EFFECTS.map(([re, f]) => { const x = re.exec(title); return x ? f(x) : undefined; }).find(Boolean) : undefined;
  const history = Array.isArray(front.history) ? (front.history as Array<Record<string, unknown>>) : [];
  const item: ItemInput = {
    kind, title, priority, blocking: front.blocking === true, created_by: createdBy,
    ...(kind === "decision" && category ? { category } : {}),
    ...(typeof front.feature === "string" && /^F-\d{3,6}$/.test(front.feature) ? { feature: front.feature } : {}),
    ...(kind === "decision" && options?.length ? { options } : {}),
    ...(kind === "decision" && typeof front.recommendation === "string" ? { recommendation: front.recommendation } : {}),
    ...(Array.isArray(front.steps) ? { steps: (front.steps as unknown[]).map(String) } : {}),
    ...(Array.isArray(front.links) ? { links: (front.links as Array<Record<string, unknown>>).filter((l) => typeof l?.kind === "string" && typeof l?.ref === "string").map((l) => ({ kind: l.kind as string, ref: l.ref as string })) } : {}),
    ...(effect ? { effect } : {}),
    sections: sections(kind, m[2]!, `the old item file, from ${createdBy}`),
  };
  return { item, id, status: String(front.status ?? "open"), dropped: history.filter((h) => h?.by === "owner").length };
}

/** Moves every open item file under `inbox/` on the repo's factory/state to an issue record. */
export async function migrateInbox(o: { git: Git; scanner: SecretsScanner; repo: string; log: Logger; clock: Clock; tmpDir: string }): Promise<Migrated> {
  const state = new StateRepo(o.git, o.scanner, o.repo, o.log, o.tmpDir);
  await state.ensureWorktree();
  const inbox = new Inbox({ state, clock: o.clock, log: o.log, notify: () => undefined });
  const out: Migrated = { migrated: [], skipped: [], closed: [] };
  const files = (await state.list("inbox")).map((e) => e.path).filter((p) => /^inbox\/[a-z]+\/[A-Z]-\d{4,}\.md$/.test(p)).sort();
  for (const from of files) {
    const raw = await state.read(from);
    if (!raw) {
      out.skipped.push({ from, why: "it couldn't be read" });
      continue;
    }
    const parsed = parseOldItem(raw.toString("utf8"), from);
    if ("why" in parsed) {
      out.skipped.push({ from, why: parsed.why });
      continue;
    }
    if (parsed.status !== "open") {
      out.closed.push(from);
      continue;
    }
    if (await inbox.read(parsed.id)) {
      out.skipped.push({ from, why: `${parsed.id} already has a record` });
      continue;
    }
    // SR-20: owner actions in old files were never checked against a signed commit, so none is carried over.
    const notes = parsed.dropped ? [`${parsed.dropped} owner action(s) in the old file were not carried over: their commits weren't checked as signed (F-011 SR-20).`] : [];
    try {
      out.migrated.push({ from, id: await inbox.file(parsed.item, parsed.id, from, notes) });
    } catch (e) {
      out.skipped.push({ from, why: (e as Error).name === "SecretFound" ? "the secrets scan found a secret in it" : (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const project = flag("project");
  const gitleaks = flag("gitleaks");
  if (!project || !gitleaks || !path.isAbsolute(gitleaks)) {
    process.stderr.write("Usage: npm run migrate-inbox -- --project <config repo clone> --gitleaks <absolute path> [--home <engine folder>]\nStop the engine first.\n");
    return 2;
  }
  const home = path.resolve(flag("home") ?? path.join(os.homedir(), ".software-factory", "migrate"));
  ensureOwnerDir(home);
  const gitPath = findOnPath("git");
  if (!gitPath) throw new Error("git isn't on PATH");
  const children = new Children();
  const git = new Git({ gitPath, homeDir: path.join(home, "git"), children });
  const scanner = new Gitleaks({ binary: gitleaks, workDir: path.join(home, "gitleaks"), children });
  const log = new MemoryLogger();
  const tmpDir = path.join(home, "tmp");
  ensureOwnerDir(tmpDir);
  const r = await migrateInbox({ git, scanner, repo: path.resolve(project), log, clock: systemClock, tmpDir });
  for (const m of r.migrated) process.stdout.write(`${m.from} -> ${m.id}: issue opens at the engine's next poll\n`);
  for (const c of r.closed) process.stdout.write(`${c}: not open, left as it is\n`);
  for (const s of r.skipped) process.stderr.write(`${s.from}: not migrated: ${s.why}\n`);
  for (const l of log.lines) if (l.level === "warn") process.stderr.write(`${String(l.message)}\n`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return r.skipped.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
