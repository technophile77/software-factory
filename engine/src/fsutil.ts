import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const isWindows = process.platform === "win32";

/**
 * A path's canonical form, for comparing two paths. On Windows only the
 * native call expands 8.3 short names (C:\Users\RUNNER~1) and settles case,
 * so a path from the user and one from git compare equal.
 */
export function realPath(p: string): string {
  return isWindows ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

export function euid(): number | null {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

/** Creates `dir` (and parents) owner-only, or checks an existing one is. */
export function ensureOwnerDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain folder`);
  if (isWindows) return;
  if (st.uid !== euid()) throw new Error(`${dir} is not owned by this user`);
  // mkdir leaves an existing folder's mode alone, and umask can widen a new one.
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  if ((fs.lstatSync(dir).mode & 0o077) !== 0) throw new Error(`${dir} could not be made owner-only`);
}

/**
 * Writes owner-only (0600) through a temporary file and a rename, so a reader
 * never sees half a file and a crash leaves the old one.
 */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (!isWindows) fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const isFileAt = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Absolute path of `name` on PATH, resolved once so later spawns can't be
 * redirected. Only fully absolute PATH entries count and the current
 * directory never does, though Windows would otherwise search it first. On
 * Windows a name that already ends in a PATHEXT extension (`docker.exe`) is
 * looked up as is; any other name gets each extension in turn.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, isFile: (p: string) => boolean = isFileAt): string | null {
  const P = platform === "win32" ? path.win32 : path.posix;
  if (!name || name === "." || name === ".." || name.includes("/") || (platform === "win32" && /[\\:]/.test(name))) return null;
  let names = [name];
  if (platform === "win32") {
    const exts = (env.PATHEXT ?? ".EXE;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => /^\.[a-z0-9]+$/.test(e));
    const own = P.extname(name).toLowerCase();
    if (!own || !exts.includes(own)) names = exts.map((e) => name + e);
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(P.delimiter)) {
    // On Windows `\dir` passes isAbsolute but follows the current drive; only `C:\…` and UNC paths are fixed.
    if (!dir || !P.isAbsolute(dir) || (platform === "win32" && !/^([A-Za-z]:\\|\\\\)/.test(dir))) continue;
    for (const n of names) {
      const p = P.join(dir, n);
      if (isFile(p)) return p;
    }
  }
  return null;
}
