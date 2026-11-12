import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigError } from "../config/paths-file";
import { realPath } from "../fsutil";

/**
 * A branch tree the engine won't write into a worktree on the host. Anyone
 * who can push to the config repo shapes the tree, and the files are written
 * as the owner, so a tree that could steer a write elsewhere is refused
 * whole (Security Gate 2, H2).
 */
export class WorktreeRefused extends ConfigError {
  override name = "WorktreeRefused";
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const WIN_BAD_CHARS = /[<>:"|?*\\\x00-\x1f]/;
// Code points HFS+ and APFS ignore when they compare names, as git's core.protectHFS lists them.
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * Why one path segment is refused, or null. Everywhere: empty, `.`, `..`,
 * `.git` in any case, a NUL. On Windows also what NTFS would read as
 * another name: trailing dots or spaces, `:` (alternate data streams),
 * characters Windows refuses, device names (with any extension), and 8.3
 * short-name forms (`GIT~1`), which can alias a long name.
 */
export function badSegment(seg: string, platform: NodeJS.Platform): string | null {
  if (seg === "" || seg === "." || seg === "..") return "an empty, '.' or '..' segment";
  if (seg.includes("\0") || seg.includes("/")) return "a NUL or slash";
  const folded = seg.normalize("NFC").replace(HFS_IGNORED, "").toLowerCase();
  if (folded === ".git") return "a .git entry";
  if (platform === "win32") {
    if (/[. ]$/.test(seg)) return "a name ending in a dot or space";
    if (WIN_BAD_CHARS.test(seg)) return "a character Windows doesn't allow in names (or ':', a data stream)";
    if (WIN_RESERVED.test(seg.split(".")[0]!.trimEnd())) return "a Windows device name";
    if (/~[0-9]/.test(seg)) return "an 8.3 short-name form";
  }
  return null;
}

/** The key two names share if the file system would see them as one. */
function collisionKey(p: string, caseInsensitive: boolean, platform: NodeJS.Platform): string {
  let k = p.normalize("NFC");
  if (platform === "darwin") k = k.replace(HFS_IGNORED, "");
  return caseInsensitive ? k.toLowerCase() : k;
}

/**
 * Checks a whole tree before anything is written: only regular files
 * (no symbolic links, no submodules), no refused segment, and no two paths
 * that the worktree's file system would treat as the same, nor a file that
 * another entry needs as a folder.
 */
export function checkTree(entries: TreeEntry[], caseInsensitive: boolean, platform: NodeJS.Platform): void {
  const files = new Map<string, string>();
  const dirs = new Map<string, string>();
  for (const e of entries) {
    if (e.mode === "120000") throw new WorktreeRefused(`The branch's tree holds a symbolic link (${e.path.slice(0, 200)}); the engine doesn't write links into a worktree.`);
    if (e.mode === "160000") throw new WorktreeRefused(`The branch's tree holds a submodule (${e.path.slice(0, 200)}); the engine doesn't populate submodules.`);
    if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) throw new WorktreeRefused(`The branch's tree holds an entry that isn't a regular file (${e.path.slice(0, 200)}).`);
    const segs = e.path.split("/");
    for (const s of segs) {
      const why = badSegment(s, platform);
      if (why) throw new WorktreeRefused(`The branch's tree holds a path with ${why} (${e.path.slice(0, 200)}).`);
    }
    const key = collisionKey(e.path, caseInsensitive, platform);
    if (files.has(key) || dirs.has(key)) throw new WorktreeRefused(`Two paths in the branch's tree are the same file on this system (${(files.get(key) ?? dirs.get(key))!.slice(0, 200)} and ${e.path.slice(0, 200)}).`);
    files.set(key, e.path);
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join("/");
      const dk = collisionKey(d, caseInsensitive, platform);
      if (files.has(dk)) throw new WorktreeRefused(`A path in the branch's tree is both a file and a folder on this system (${files.get(dk)!.slice(0, 200)} and ${e.path.slice(0, 200)}).`);
      const seen = dirs.get(dk);
      if (seen !== undefined && seen !== d) throw new WorktreeRefused(`Two folders in the branch's tree are the same folder on this system (${seen.slice(0, 200)} and ${d.slice(0, 200)}).`);
      dirs.set(dk, d);
    }
  }
}

/** Whether names in `dir` match without regard to case, found by asking the file system itself. */
export function caseInsensitiveAt(dir: string): boolean {
  const name = `.case-probe-${process.pid}-${Math.random().toString(36).slice(2).replace(/[0-9]/g, "x")}`;
  fs.writeFileSync(path.join(dir, name), "", { flag: "wx" });
  try {
    return fs.existsSync(path.join(dir, name.toUpperCase()));
  } finally {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * Writes one file below `root`, which holds only what this writer made:
 * each parent folder is made one level at a time and must then be a real
 * folder (not a link) whose real path is where it should be, and the file is
 * created new, without following a link.
 */
export function writeNew(root: string, rel: string, content: Buffer, executable: boolean): void {
  const segs = rel.split("/");
  const realRoot = realPath(root);
  let dir = root;
  let realDir = realRoot;
  for (const s of segs.slice(0, -1)) {
    dir = path.join(dir, s);
    realDir = path.join(realDir, s);
    try {
      fs.mkdirSync(dir, { mode: 0o755 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new WorktreeRefused(`${rel.slice(0, 200)}: a parent isn't a plain folder.`);
    if (realPath(dir) !== realDir) throw new WorktreeRefused(`${rel.slice(0, 200)}: a parent resolves outside the worktree.`);
  }
  const file = path.join(dir, segs.at(-1)!);
  // Windows has no O_NOFOLLOW, and O_EXCL there creates the target of a
  // dangling link; so any existing entry, a link included, is refused first,
  // and the opened file's real path is checked before anything is written.
  if (lstatOrNull(file)) throw new WorktreeRefused(`${rel.slice(0, 200)}: another entry already wrote this name.`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(file, flags, executable ? 0o755 : 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new WorktreeRefused(`${rel.slice(0, 200)}: another entry already wrote this name.`);
    throw e;
  }
  try {
    if (realPath(file) !== path.join(realDir, segs.at(-1)!)) throw new WorktreeRefused(`${rel.slice(0, 200)}: the file resolves outside the worktree.`);
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
