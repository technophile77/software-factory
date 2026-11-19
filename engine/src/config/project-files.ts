import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { PATHS_FILE } from "../constants";
import { realPath, sha256Hex } from "../fsutil";
import type { Git } from "../git";
import type { OsApi } from "../os/ffi";
import { checkConfig, projectFile } from "../schemas/config";
import { manifestName } from "./manifest";
import { ConfigError, checkOwnerFile, checkProjectClone, readPathsFile } from "./paths-file";

/** F-023 FR-2: the folder in the master clone that holds one file per project. */
export const PROJECTS_DIR = "projects";
const FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\.yaml$/;
const MAX_FILES = 200;

export interface ProjectFile {
  name: string;
  url: string;
  path: string;
}

/** One `*.yaml` in `projects/`: what it holds, or why it was refused (SR-1: refused whole). */
export interface ProjectEntry {
  file: string;
  /** Changes whenever the file's bytes do. */
  key: string;
  project?: ProjectFile;
  error?: string;
}

const projectsDir = (master: string) => path.join(master, PROJECTS_DIR);

/** Whether the folder exists; a link in its place is refused, since it could lead anywhere. */
function dirState(master: string): "missing" | "ok" {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(projectsDir(master));
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ConfigError(`${PROJECTS_DIR}/ in the master clone is not a plain folder.`);
  return "ok";
}

/**
 * The cheap half of the 5-second check (FR-4): each project file's name with
 * its size and modified time, read without opening any file.
 */
export function listProjectFiles(master: string): Map<string, string> {
  const out = new Map<string, string>();
  if (dirState(master) === "missing") return out;
  for (const n of fs.readdirSync(projectsDir(master)).filter((n) => n.endsWith(".yaml")).sort().slice(0, MAX_FILES)) {
    try {
      const st = fs.lstatSync(path.join(projectsDir(master), n));
      // Mode, owner and change time too: a chmod or an ACL change can make a refused file acceptable.
      out.set(n, `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.uid}:${st.ino}`);
    } catch {
      // Removed between the listing and the stat: it is gone.
    }
  }
  return out;
}

/** Reads and checks one project file (FR-2, SR-1). Never throws: a refusal is the entry's `error`. */
export function readProjectFile(master: string, file: string, os: OsApi): ProjectEntry {
  const full = path.join(projectsDir(master), file);
  const label = `${PROJECTS_DIR}/${file}`;
  let raw: Buffer;
  try {
    raw = fs.readFileSync(full);
  } catch {
    raw = Buffer.alloc(0);
  }
  const entry: ProjectEntry = { file, key: sha256Hex(raw) };
  try {
    const m = FILE_RE.exec(file);
    if (!m) throw new ConfigError(`${label}: the file name must be <project name>.yaml.`);
    checkOwnerFile(full, label, os);
    let doc: unknown;
    try {
      doc = YAML.parse(raw.toString("utf8"), { uniqueKeys: true, maxAliasCount: 0 });
    } catch {
      throw new ConfigError(`${label} is not valid YAML.`);
    }
    checkConfig(label, doc, projectFile);
    const d = doc as { name: string; config_repo: { url: string; path: string } };
    if (d.name !== m[1]) throw new ConfigError(`${label} names the project ${d.name}; the file must be ${d.name}.yaml.`);
    if (!path.isAbsolute(d.config_repo.path)) throw new ConfigError(`${label}: config_repo.path must be absolute.`);
    entry.project = { name: d.name, url: d.config_repo.url, path: d.config_repo.path };
  } catch (e) {
    entry.error = e instanceof ConfigError ? e.message : `${label} couldn't be read.`;
  }
  return entry;
}

/**
 * Edge case "two project files name the same config repo or the same name":
 * both are refused until one is removed. Names compare without case, since
 * Windows and macOS folders do.
 */
export function refuseDuplicates(entries: ProjectEntry[]): void {
  const by = new Map<string, ProjectEntry[]>();
  for (const e of entries) {
    if (!e.project) continue;
    let where = path.resolve(e.project.path);
    try {
      where = realPath(where);
    } catch {
      // Not cloned yet: compared as written.
    }
    for (const k of [`name:${e.project.name.toLowerCase()}`, `path:${process.platform === "linux" ? where : where.toLowerCase()}`]) {
      by.set(k, [...(by.get(k) ?? []), e]);
    }
  }
  for (const [k, list] of by) {
    if (list.length < 2) continue;
    const what = k.startsWith("name:") ? "the same project name" : "the same config repo";
    for (const e of list) {
      e.error = `${PROJECTS_DIR}/${e.file} and ${list.filter((x) => x !== e).map((x) => `${PROJECTS_DIR}/${x.file}`).join(", ")} name ${what}; remove one.`;
      delete e.project;
    }
  }
}

/** Every project file, checked; duplicates refused. */
export function readProjectFiles(master: string, os: OsApi): ProjectEntry[] {
  const entries = [...listProjectFiles(master).keys()].map((f) => readProjectFile(master, f, os));
  refuseDuplicates(entries);
  return entries;
}

/**
 * Makes `file` owner-only, as SR-1 asks of a project file: mode 0600, or on
 * Windows an ACL that lets only the owner, SYSTEM and Administrators write.
 */
export function restrictToOwner(file: string, os: OsApi): void {
  if (os.platform !== "win32") {
    fs.chmodSync(file, 0o600);
    return;
  }
  const sid = os.windows().currentUserSid();
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error("bad SID");
  const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  // An elevated administrator's new files belong to Administrators; the file must be the owner's own.
  try {
    execFileSync(icacls, [file, "/setowner", `*${sid}`], { stdio: "pipe", windowsHide: true });
  } catch {
    // Without the privilege to change the owner, the check at read time says why the file is refused.
  }
  execFileSync(icacls, [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"], { stdio: "pipe", windowsHide: true });
}

/** The project file's text; `schema` first so a reader sees the format at once. */
export function projectFileText(p: ProjectFile): string {
  return YAML.stringify({ schema: "project-file/1.0", name: p.name, config_repo: { url: p.url, path: p.path } });
}

/** Writes `projects/<name>.yaml`, owner-only, as onboarding or the import does (FR-3, FR-6). */
export function writeProjectFile(master: string, p: ProjectFile, os: OsApi): string {
  fs.mkdirSync(projectsDir(master), { recursive: true, mode: 0o700 });
  const file = path.join(projectsDir(master), `${p.name}.yaml`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, projectFileText(p), { mode: 0o600, flag: "wx" });
  try {
    restrictToOwner(tmp, os);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/** `https://github.com/o/r.git` and `https://github.com/o/r` are one repo. */
export function sameRepoUrl(a: string, b: string): boolean {
  const n = (u: string) => u.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  return n(a) === n(b);
}

export interface ImportResult {
  imported: string[];
  /** Paths that couldn't be named; the engine shows each as a refused project this once. */
  failed: Array<{ path: string; reason: string }>;
}

/**
 * FR-3: once, when `projects/` is missing, each path in the old paths file
 * becomes a project file, named by the manifest on main and with the clone's
 * `origin`. The paths file gets today's checks first (SR-13), and each path
 * gets `checkProjectPath`'s, so nothing the old engine would refuse is
 * imported. `null` when there was nothing to import.
 */
export async function importPathsFile(master: string, os: OsApi, git: Git): Promise<ImportResult | null> {
  if (dirState(master) !== "missing" || !fs.existsSync(path.join(master, PATHS_FILE))) return null;
  const listed = readPathsFile(master, os);
  const out: ImportResult = { imported: [], failed: [] };
  const files: ProjectFile[] = [];
  for (const p of listed) {
    try {
      const { real, origin } = await checkProjectClone(p, master, git);
      const name = await manifestName(git, real);
      if (!origin) throw new ConfigError("The clone has no origin remote.");
      const url = origin;
      const f = { name, url, path: p };
      const shape = projectFile.safeParse({ schema: "project-file/1.0", name: f.name, config_repo: { url: f.url, path: f.path } });
      if (!shape.success) throw new ConfigError(`its origin ${url.slice(0, 200)} isn't a GitHub repo URL the engine can use.`);
      if (files.some((x) => x.name.toLowerCase() === f.name.toLowerCase())) throw new ConfigError(`another listed path is also named ${f.name}.`);
      files.push(f);
    } catch (e) {
      out.failed.push({ path: p, reason: e instanceof ConfigError ? e.message : "the path couldn't be checked" });
    }
  }
  fs.mkdirSync(projectsDir(master), { recursive: true, mode: 0o700 });
  for (const f of files) {
    writeProjectFile(master, f, os);
    out.imported.push(f.name);
  }
  return out;
}
