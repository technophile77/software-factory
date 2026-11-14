/**
 * F-020 FR-4, SR-5: the one-time move of a project's inbox records from
 * `inbox/<id>.yaml` (Inbox item v3.1) to `inbox/<id>.json` (v4.0) on its
 * config repo's `factory/state`. Not engine code: it runs once per existing
 * project, with the engine stopped, and is deleted once the owner's projects
 * are migrated. Until it has run, the engine refuses to run the project
 * (SR-4).
 *
 *   npm run migrate-inbox-json -- --project <config repo clone> --gitleaks <path> [--home <engine folder>]
 *
 * Each record is checked against the v3 shape before it is converted, so a
 * forged or broken file is reported and left in place, never carried over.
 * The script commits locally only; the engine pushes factory/state as usual.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { iso, systemClock } from "../src/clock";
import type { Clock } from "../src/clock";
import { ensureOwnerDir, findOnPath } from "../src/fsutil";
import { Git } from "../src/git";
import { Gitleaks, SecretsScanner } from "../src/gitleaks";
import { recordPath } from "../src/inbox/model";
import { MemoryLogger } from "../src/log";
import type { Logger } from "../src/log";
import { Children } from "../src/proc";
import { INBOX_RECORD_SCHEMA, inboxRecord } from "../src/schemas/inbox-record";
import { MAX_JSON_BYTES, jsonFileContent } from "../src/schemas/json-file";
import { StateRepo } from "../src/state/state-repo";

/** The v3.1 record: the same fields as v4.0 under the old schema name. */
const v3Record = inboxRecord.extend({ schema: z.literal("inbox-record/3.0") });

export interface MigratedJson {
  migrated: Array<{ from: string; to: string }>;
  /** Files left in place, each with why. Never their content (SR-5). */
  skipped: Array<{ from: string; why: string }>;
}

/** One v3 YAML record to its v4 record, or why it can't be. */
export function convertRecord(text: string, from: string, commit: string, at: string): { record: z.infer<typeof inboxRecord> } | { why: string } {
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) return { why: `larger than ${MAX_JSON_BYTES} bytes` };
  let data: unknown;
  try {
    // The core schema has no custom tags; the alias cap stops an alias bomb.
    data = YAML.parse(text, { schema: "core", maxAliasCount: 100 });
  } catch {
    return { why: "not readable YAML" };
  }
  const r = v3Record.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0]!;
    return { why: `${first.path.join(".") || "(top level)"} is invalid (${first.code})` };
  }
  if (path.posix.basename(from, ".yaml") !== r.data.id) return { why: "its id doesn't match its file name" };
  const history = [...r.data.history, { at, by: "engine" as const, action: "migrated" as const, from, note: `from ${from} at factory/state ${commit} (F-020)` }];
  return { record: { ...r.data, schema: INBOX_RECORD_SCHEMA, history } };
}

export async function migrateInboxJson(o: { git: Git; scanner: SecretsScanner; repo: string; log: Logger; clock: Clock; tmpDir: string }): Promise<MigratedJson> {
  const state = new StateRepo(o.git, o.scanner, o.repo, o.log, o.tmpDir);
  await state.ensureWorktree();
  const out: MigratedJson = { migrated: [], skipped: [] };
  const files = (await state.list("inbox")).map((e) => e.path).filter((p) => /^inbox\/[^/]+\.ya?ml$/.test(p)).sort();
  const existing = new Set((await state.list("inbox")).map((e) => e.path));
  for (const from of files) {
    const raw = await state.read(from);
    if (!raw) {
      out.skipped.push({ from, why: "it couldn't be read" });
      continue;
    }
    const commit = await state.head();
    const c = convertRecord(raw.toString("utf8"), from, commit, iso(o.clock.now()));
    if ("why" in c) {
      out.skipped.push({ from, why: c.why });
      continue;
    }
    const to = recordPath(c.record.id);
    if (existing.has(to)) {
      out.skipped.push({ from, why: `${to} already exists` });
      continue;
    }
    try {
      await state.commit([{ path: to, content: jsonFileContent(to, c.record, inboxRecord) }], `${c.record.id}: migrated from ${from} (F-020)`, [from]);
      existing.add(to);
      out.migrated.push({ from, to });
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
    process.stderr.write("Usage: npm run migrate-inbox-json -- --project <config repo clone> --gitleaks <absolute path> [--home <engine folder>]\nStop the engine first.\n");
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
  const r = await migrateInboxJson({ git, scanner, repo: path.resolve(project), log, clock: systemClock, tmpDir });
  for (const m of r.migrated) process.stdout.write(`${m.from} -> ${m.to}\n`);
  for (const s of r.skipped) process.stderr.write(`${s.from}: not migrated: ${s.why}\n`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (r.skipped.length) process.stderr.write("The engine won't run this project while any YAML record is left. Fix or remove the files above, then run this again.\n");
  return r.skipped.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
