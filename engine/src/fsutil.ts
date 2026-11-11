import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const isWindows = process.platform === "win32";

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

/** Absolute path of `name` on PATH, resolved once so later spawns can't be redirected. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = isWindows ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}
