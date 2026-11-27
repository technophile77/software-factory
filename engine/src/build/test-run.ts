import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { realPath } from "../fsutil";
import type { Git } from "../git";
import { Children, killTree } from "../proc";
import { JunitError, MAX_RESULTS_BYTES, type TestCase, parseJunit, undoubled } from "./junit";

/**
 * F-015 FR-6, SR-8, SR-9: the engine runs a repo's declared test command
 * itself, with no model, and reads its JUnit results.
 */

export class TestRunError extends Error {
  override name = "TestRunError";
}

/** SR-9: what a test command gets of the engine's environment; never a token, proxy credential or socket. */
const ENV_KEEP_POSIX = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "TZ", "TERM"];
const ENV_KEEP_WIN = ["PATH", "Path", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "SystemDrive", "ComSpec", "PATHEXT", "windir", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ"];

export function testEnv(from: NodeJS.ProcessEnv, platform: NodeJS.Platform, toolchain: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [...(platform === "win32" ? ENV_KEEP_WIN : ENV_KEEP_POSIX), ...toolchain]) if (from[k] !== undefined) env[k] = from[k];
  for (const [k, v] of Object.entries(from)) if (k.startsWith("LC_") && v !== undefined) env[k] = v;
  env.CI = "true";
  return env;
}

function inside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * SR-9: `argv[0]` as an absolute path outside the worktree, so a file the
 * agents wrote can't stand in for the program. A bare name is looked up on
 * PATH, skipping relative entries and any inside the worktree.
 */
export function resolveProgram(argv0: string, worktree: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean = isFile): string {
  const wt = realOr(worktree);
  const sep = platform === "win32" ? /[\\/]/ : /\//;
  const outside = (p: string) => !inside(wt, realOr(p)) && !inside(worktree, p);
  if (sep.test(argv0)) {
    if (!path.isAbsolute(argv0)) throw new TestRunError("the test command's program is a relative path, which would run a file from the worktree");
    if (!outside(argv0)) throw new TestRunError("the test command's program is inside the worktree");
    if (!exists(argv0)) throw new TestRunError("the test command's program doesn't exist");
    return argv0;
  }
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter((d) => d && path.isAbsolute(d));
  for (const d of dirs) {
    if (!outside(d)) continue;
    for (const e of exts) {
      const full = path.join(d, argv0 + e);
      if (exists(full)) return full;
    }
  }
  throw new TestRunError("the test command's program isn't on PATH outside the worktree");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function realOr(p: string): string {
  try {
    return realPath(p);
  } catch {
    return path.resolve(p);
  }
}

/** One argument quoted for `cmd.exe /d /s /c` (SR-9): quotes doubled, metacharacters inside quotes. */
export function cmdQuote(arg: string): string {
  if (/[\r\n\0]/.test(arg)) throw new TestRunError("a test command argument has a line break");
  // cmd.exe expands %VAR% even inside quotes; ^ escaping doesn't work there, so refuse it.
  if (/%/.test(arg)) throw new TestRunError("a test command argument for a .cmd or .bat program has %, which cmd.exe would expand");
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** stdout and stderr interleaved, at most the cap. */
  output: string;
  truncated: boolean;
  durationMs: number;
}

/** Runs a command with no shell, kills its whole tree at the wall-time cap, keeps at most `maxOutput` bytes (H-0190). */
export function runCommand(o: { program: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; wallMs: number; maxOutput: number; platform: NodeJS.Platform; children: Children }): Promise<CommandResult> {
  const started = Date.now();
  const batch = o.platform === "win32" && /\.(cmd|bat)$/i.test(o.program);
  const root = o.env.SystemRoot ?? o.env.SYSTEMROOT ?? "C:\\Windows";
  const [bin, args, verbatim] = batch
    ? [path.join(root, "System32", "cmd.exe"), ["/d", "/s", "/c", `"${[o.program, ...o.args].map(cmdQuote).join(" ")}"`], true]
    : [o.program, o.args, false];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: o.cwd, env: o.env, shell: false, windowsHide: true, windowsVerbatimArguments: verbatim,
      detached: o.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) o.children.add(child.pid);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const take = (b: Buffer) => {
      if (size >= o.maxOutput) {
        truncated = true;
        return;
      }
      const part = b.subarray(0, o.maxOutput - size);
      if (part.length < b.length) truncated = true;
      chunks.push(part);
      size += part.length;
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, o.platform);
    }, o.wallMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new TestRunError(`the test command didn't start (${(e as NodeJS.ErrnoException).code ?? "error"})`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Children the command left behind go with it: the run is over.
      killTree(child, o.platform);
      if (child.pid) o.children.remove(child.pid);
      resolve({ code, signal, timedOut, output: Buffer.concat(chunks).toString("utf8"), truncated, durationMs: Date.now() - started });
    });
  });
}

/**
 * SR-8 before the run: the results path must be inside the worktree and
 * not tracked in git, whatever is there from an earlier run is removed, and
 * its folder exists.
 */
export async function clearResults(git: Git, worktree: string, gitDir: string, rel: string): Promise<string> {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new TestRunError("test_results must be a path inside the worktree");
  const tracked = await git.out(worktree, ["--git-dir", gitDir, "--work-tree", worktree, "ls-files", "--", rel]);
  if (tracked) throw new TestRunError("test_results names a file tracked in git");
  const full = path.join(worktree, ...rel.split(/[\\/]/));
  fs.rmSync(full, { force: true, recursive: true });
  // Runners such as node --test-reporter-destination don't create the folder,
  // and a git-ignored one never exists in a fresh worktree.
  const dir = path.dirname(full);
  fs.mkdirSync(dir, { recursive: true });
  if (!inside(realOr(worktree), realOr(dir))) throw new TestRunError("the results folder is outside the worktree");
  return full;
}

/** SR-8 after the run: a regular file of at most 5 MiB whose real path is inside the worktree, parsed. */
export function readResults(worktree: string, rel: string): TestCase[] {
  const full = path.join(worktree, ...rel.split(/[\\/]/));
  let st: fs.Stats;
  try {
    st = fs.lstatSync(full);
  } catch {
    throw new TestRunError("the test command wrote no results file");
  }
  if (st.isSymbolicLink()) throw new TestRunError("the results file is a symlink");
  if (!st.isFile()) throw new TestRunError("the results file isn't a regular file");
  if (st.size > MAX_RESULTS_BYTES) throw new TestRunError("the results file is over 5 MiB");
  if (!inside(realOr(worktree), realOr(full))) throw new TestRunError("the results file is outside the worktree");
  try {
    return parseJunit(fs.readFileSync(full, "utf8"));
  } catch (e) {
    if (e instanceof JunitError) throw new TestRunError(`the results file can't be read: ${e.message}`);
    throw e;
  }
}

export interface SuiteRun {
  cases: TestCase[];
  /** Why the run is incomplete before its results are joined, if it is. */
  problem: string | null;
  /** Each command's exit and output, unscrubbed. */
  out: string[];
}

/**
 * FR-6, SR-8, SR-9: the build command, when set, then the test command, in a
 * worktree with the allowlisted environment and the caps, then the results
 * file. The stage 6 run and `run_tests` (FR-25) both run tests this way.
 */
export async function runSuite(o: {
  git: Git; worktree: string; gitDir: string; build: string[] | null; test: string[]; results: string;
  env: NodeJS.ProcessEnv; platform: NodeJS.Platform; wallMs: number; maxOutput: number; children: Children;
}): Promise<SuiteRun> {
  let problem: string | null = null;
  let cases: TestCase[] = [];
  const out: string[] = [];
  try {
    await clearResults(o.git, o.worktree, o.gitDir, o.results);
    for (const [what, argv] of [["build", o.build], ["test", o.test]] as const) {
      if (!argv) continue;
      const program = resolveProgram(argv[0]!, o.worktree, o.env, o.platform);
      const r = await runCommand({ program, args: argv.slice(1), cwd: o.worktree, env: o.env, wallMs: o.wallMs, maxOutput: o.maxOutput, platform: o.platform, children: o.children });
      out.push(`$ ${what} (exit ${r.code ?? r.signal ?? "none"}${r.timedOut ? ", killed at the time cap" : ""}${r.truncated ? ", output cut at the cap" : ""})`, r.output);
      if (r.timedOut) problem = `the ${what} command ran past the ${Math.round(o.wallMs / 60_000)}-minute cap`;
      else if (what === "build" && r.code !== 0) problem = `the build command failed (exit ${r.code ?? r.signal})`;
      if (problem) break;
    }
    if (!problem) cases = readResults(o.worktree, o.results);
  } catch (e) {
    if (!(e instanceof TestRunError)) throw e;
    problem = e.message;
  }
  return { cases, problem, out };
}

const MISSING = "mapped to a criterion but not in the results file";

/** A mapped test id's file and test name: `tests/test_x.py::test_a`, `test/x.test.js#May`. */
function splitTest(t: string): { file: string; name: string } {
  const i = t.indexOf("::") >= 0 ? t.indexOf("::") : t.lastIndexOf("#");
  if (i < 0) return { file: "", name: t };
  const sep = t.startsWith("::", i) ? 2 : 1;
  const name = t.slice(i + sep).split("::").pop()!;
  return { file: t.slice(0, i), name };
}

/** `tests/test_x.py` and `tests.test_x` alike, for matching a file to a result's class or id. */
const fileKey = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.(py|[cm]?[jt]sx?)$/, "").replace(/\//g, ".").toLowerCase();

/**
 * F-015 FR-24: why a mapped test is missing from the results: its file failed
 * to load, the same name is under another id, nothing from its file ran, or
 * none of these.
 */
export function whyMissing(t: string, cases: TestCase[]): string {
  const { file, name } = splitTest(t);
  const key = file ? fileKey(file) : "";
  const fromFile = (c: TestCase) => !!key && [c.classname, c.id, c.name].some((x) => fileKey(x).includes(key));
  // A load error is reported as the file itself, or as an error that says it couldn't collect or import it; not a test of the file that errored.
  const isFile = (c: TestCase) => !!key && [c.name, c.id].some((x) => fileKey(x).endsWith(key));
  const loadError = cases.find((c) => c.status === "error" && (isFile(c) || (fromFile(c) && /collect|import|load|syntax/i.test(`${c.message}\n${c.detail}`))));
  if (loadError) {
    const line = (loadError.message || loadError.detail).split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "no message";
    return `${MISSING}: its file failed to load (${loadError.id}: ${line})`;
  }
  const same = cases.find((c) => c.name === name || undoubled(c.name) === name);
  if (same) return `${MISSING}: a test with the same name is in the results as ${same.id}`;
  if (key && !cases.some(fromFile)) return `${MISSING}: no test from ${file} is in the results`;
  return MISSING;
}

export interface RunReport {
  commit: string;
  complete: boolean;
  /** Why the run is incomplete, when it is. */
  incomplete: string | null;
  tests_run: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{ test: string; expected: string; actual: string; log_ref: string }>;
  not_run: Array<{ test: string; reason: string }>;
  /** FR-29: tests the test engineer listed as CI-only that skipped here; the PR's required CI runs them. */
  ci_pending: Array<{ test: string; reason: string }>;
  /** AC id to its tests and how each did. */
  criteria: Record<string, Array<{ test: string; status: TestCase["status"] | "missing" }>>;
}

/**
 * A pytest node id (`tests/test_x.py::Class::test_y`) as JUnit names it
 * (`tests.test_x.Class` and `test_y`), with a parametrized test's cases
 * (`test_y[a]`) counted as the one test: the worst status of them all.
 */
function pytestStatus(t: string, cases: TestCase[]): TestCase["status"] | null {
  const hits = pytestHits(t, cases);
  if (!hits.length) return null;
  const rank: Array<TestCase["status"]> = ["error", "failed", "skipped", "passed"];
  return rank.find((r) => hits.some((c) => c.status === r)) ?? hits[0]!.status;
}

function pytestHits(t: string, cases: TestCase[]): TestCase[] {
  const parts = t.split("::");
  if (parts.length < 2) return [];
  const module = parts[0]!.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.py$/, "").split("/").join(".");
  const name = parts.at(-1)!;
  const classname = [module, ...parts.slice(1, -1)].join(".");
  const params = !name.includes("[");
  return cases.filter((c) => c.classname === classname && (c.name === name || (params && c.name.startsWith(`${name}[`))));
}

/** Every case from one test file, so a CI-only entry can name a whole Linux-only file (FR-29). */
function fileHits(file: string, cases: TestCase[]): TestCase[] {
  if (!/\.py$/.test(file)) return [];
  const module = file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.py$/, "").split("/").join(".");
  return cases.filter((c) => c.classname === module || c.classname.startsWith(`${module}.`));
}

/**
 * The run report (testing-strategy.md § Run report): counts, failures, what
 * didn't run and why, and the test engineer's criteria map joined to the
 * results. An unexplained skip or a mapped test missing from the results
 * makes the run incomplete, and an incomplete run is not a pass. A skip the
 * test engineer listed as CI-only is explained and pending on CI (FR-29);
 * `noRequiredCheck` says nothing would ever run it, which makes the run incomplete.
 */
export function runReport(commit: string, cases: TestCase[], criteriaMap: Record<string, string[]>, problem: string | null = null, logRef = "", ciOnly: ReadonlyArray<{ test: string; reason: string }> = [], noRequiredCheck = false): RunReport {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const named = (t: string, c: TestCase, name: string) => name === t || `${c.classname}#${name}` === t || t.endsWith(`#${name}`);
  const find = (t: string) => byId.get(t) ?? cases.find((c) => named(t, c, c.name)) ?? cases.find((c) => named(t, c, undoubled(c.name)));
  const ciCases = new Map<TestCase, string>();
  for (const x of ciOnly) {
    const hit = find(x.test);
    for (const c of hit ? [hit] : x.test.includes("::") ? pytestHits(x.test, cases) : fileHits(x.test, cases)) if (c.status === "skipped") ciCases.set(c, x.reason);
  }
  const ci_pending = [...ciCases].map(([c, reason]) => ({ test: c.id.slice(0, 300), reason: (reason || c.message || "CI-only").slice(0, 1000) }));
  const not_run = cases.filter((c) => c.status === "skipped" && !ciCases.has(c)).map((c) => ({ test: c.id.slice(0, 300), reason: (c.message || "skipped with no reason").slice(0, 1000) }));
  const criteria: RunReport["criteria"] = {};
  const missing: string[] = [];
  for (const [ac, tests] of Object.entries(criteriaMap)) {
    criteria[ac] = tests.map((t) => {
      const status = find(t)?.status ?? pytestStatus(t, cases);
      if (!status) missing.push(t);
      return { test: t, status: status ?? "missing" };
    });
  }
  for (const t of missing) not_run.push({ test: t.slice(0, 300), reason: whyMissing(t, cases).slice(0, 1000) });
  const unexplained = cases.filter((c) => c.status === "skipped" && !c.message.trim() && !ciCases.has(c));
  const incomplete = problem ?? (cases.length === 0 ? "the results file lists no tests"
    : ciOnly.length && noRequiredCheck ? "CI-only tests need a required CI check on main"
    : unexplained.length ? `${unexplained.length} test${unexplained.length > 1 ? "s were" : " was"} skipped with no reason`
      : missing.length ? `${missing.length} mapped test${missing.length > 1 ? "s are" : " is"} missing from the results` : null);
  const bad = cases.filter((c) => c.status === "failed" || c.status === "error");
  return {
    commit, complete: incomplete === null, incomplete,
    tests_run: cases.filter((c) => c.status !== "skipped").length,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: bad.length,
    skipped: cases.length - cases.filter((c) => c.status !== "skipped").length,
    failures: bad.map((c) => ({ test: c.id.slice(0, 300), expected: "pass", actual: (c.message || c.status).slice(0, 2000), log_ref: logRef.slice(0, 500) })),
    not_run,
    ci_pending,
    criteria,
  };
}
