import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir } from "../fsutil";
import type { CommandResult } from "./test-run";

/**
 * F-015 FR-8, ADR 0024 as amended 2026-11-14, H-0196: Semgrep CE from a
 * factory-owned venv on the owner's PC, installed only from the hash-pinned
 * requirements file. Anything that can't be installed or verified fails
 * Code Review closed.
 */

export const SEMGREP_VERSION = "1.183.0";
const MAX_FINDINGS = 200;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

export class SemgrepError extends Error {
  override name = "SemgrepError";
}

export interface SemgrepFinding {
  rule: string;
  severity: string;
  path: string;
  line: number;
  message: string;
}

export type Run = (program: string, args: string[], cwd: string) => Promise<CommandResult>;

const binDir = (venv: string, platform: NodeJS.Platform) => path.join(venv, platform === "win32" ? "Scripts" : "bin");
const exe = (name: string, platform: NodeJS.Platform) => (platform === "win32" ? `${name}.exe` : name);

/**
 * The semgrep program in a venv keyed by the requirements file's hash, so a
 * changed file (each bump is a new S4.1 check) gets a fresh venv. Installs it
 * when it is missing or its marker doesn't match, then checks the version.
 */
export async function semgrepVenv(o: { root: string; requirements: string; python: string; platform: NodeJS.Platform; run: Run }): Promise<string> {
  let req: Buffer;
  try {
    req = fs.readFileSync(o.requirements);
  } catch {
    throw new SemgrepError("the Semgrep requirements file can't be read");
  }
  const hash = crypto.createHash("sha256").update(req).digest("hex");
  const venv = path.join(o.root, hash.slice(0, 16));
  const marker = path.join(venv, "factory-installed.json");
  const program = path.join(binDir(venv, o.platform), exe("semgrep", o.platform));
  const installed = (() => {
    try {
      return (JSON.parse(fs.readFileSync(marker, "utf8")) as { requirements_sha256?: unknown }).requirements_sha256 === hash && fs.existsSync(program);
    } catch {
      return false;
    }
  })();
  if (!installed) {
    fs.rmSync(venv, { recursive: true, force: true });
    ensureOwnerDir(o.root);
    const step = async (what: string, program: string, args: string[]) => {
      const r = await o.run(program, args, o.root);
      if (r.timedOut || r.code !== 0) throw new SemgrepError(`the Semgrep venv couldn't be set up: ${what} ${r.timedOut ? "ran past its time cap" : `exited ${r.code ?? r.signal}`}`);
    };
    await step("venv", o.python, ["-m", "venv", venv]);
    const py = path.join(binDir(venv, o.platform), exe("python", o.platform));
    // H-0196: hashes for every package and wheels only, so no package's build code runs. --no-deps (owner,
    // 2026-11-20): the file pins the whole tree, and it pins mcp past the exact version Semgrep asks for, to fix
    // GHSA-qx49-fqc8-xw99; pip's dependency check would refuse that.
    await step("pip install", py, ["-m", "pip", "install", "--no-deps", "--require-hashes", "--only-binary", ":all:", "--no-input", "--disable-pip-version-check", "-r", o.requirements]);
  }
  const v = await o.run(program, ["--version"], o.root);
  if (v.code !== 0 || v.output.trim() !== SEMGREP_VERSION) throw new SemgrepError(`the Semgrep venv doesn't hold Semgrep ${SEMGREP_VERSION}`);
  if (!installed) fs.writeFileSync(marker, JSON.stringify({ requirements_sha256: hash, version: SEMGREP_VERSION }));
  return program;
}

/**
 * Semgrep on the commits since `base` only (the feature diff), with metrics off
 * and `nosemgrep` comments ignored (ADR 0024). Results go to a file outside the
 * worktree, so the command's own output can't be mistaken for them.
 */
export async function runSemgrep(o: { program: string; worktree: string; base: string; outFile: string; run: Run }): Promise<SemgrepFinding[]> {
  fs.rmSync(o.outFile, { force: true });
  const r = await o.run(o.program, ["scan", "--config", "p/default", "--metrics=off", "--disable-nosem", "--baseline-commit", o.base, "--json", "--output", o.outFile, "--quiet"], o.worktree);
  // 0 is a clean scan and 1 a scan with findings; anything else is Semgrep failing.
  if (r.timedOut || (r.code !== 0 && r.code !== 1)) throw new SemgrepError(`Semgrep failed (${r.timedOut ? "it ran past its time cap" : `exit ${r.code ?? r.signal}`})`);
  return parseSemgrep(readOut(o.outFile));
}

function readOut(file: string): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new SemgrepError("Semgrep wrote no results");
  }
  if (!st.isFile() || st.size > MAX_JSON_BYTES) throw new SemgrepError("Semgrep's results aren't a regular file of at most 16 MiB");
  return fs.readFileSync(file, "utf8");
}

/** The findings in Semgrep's JSON; a scan that reports errors is a failed scan, so nothing passes unscanned. */
export function parseSemgrep(text: string): SemgrepFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new SemgrepError("Semgrep's results aren't JSON");
  }
  const d = doc as { results?: unknown; errors?: unknown };
  if (!d || typeof d !== "object" || !Array.isArray(d.results)) throw new SemgrepError("Semgrep's results have no results list");
  const errors = Array.isArray(d.errors) ? (d.errors as Array<{ level?: unknown }>).filter((e) => e?.level !== "warn") : [];
  if (errors.length) throw new SemgrepError(`Semgrep reported ${errors.length} error${errors.length > 1 ? "s" : ""} while scanning`);
  const str = (v: unknown, cap: number) => (typeof v === "string" ? v.slice(0, cap) : "");
  return (d.results as Array<Record<string, unknown>>).slice(0, MAX_FINDINGS).map((x) => {
    const extra = (x.extra ?? {}) as Record<string, unknown>;
    const start = (x.start ?? {}) as Record<string, unknown>;
    return { rule: str(x.check_id, 200), severity: str(extra.severity, 20), path: str(x.path, 300), line: typeof start.line === "number" ? start.line : 0, message: str(extra.message, 1000) };
  });
}
