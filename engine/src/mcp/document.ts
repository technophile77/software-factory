/**
 * Reads the document the owner names when starting a feature from one
 * (F-009 FR-2, SR-2, SR-4, SR-6). Only this code reads it, never Claude, and
 * only the file's name and size go back into the tool result.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Refused } from "./errors";
import { DOC_MAX_BYTES, DOC_PROVENANCE, DOC_TYPES } from "./limits";

export interface Document {
  name: string;
  media_type: string;
  text: string;
  provenance: string;
}

const WIN_DEVICES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;

function refuse(message: string): Refused {
  return new Refused("document_refused_locally", `${message} Nothing was sent.`);
}

/** UNC and device paths would make Windows open a remote share (sending the owner's credentials) or a device. */
function isUncOrDevice(p: string): boolean {
  const unified = p.replace(/\//g, "\\");
  return unified.startsWith("\\\\") || unified.startsWith("\\??\\");
}

/** The owner's path as a local file path; a relative one is read from the session's project folder. */
export function documentPath(raw: unknown, projectDir: string, windows = process.platform === "win32"): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0") || raw.length > 4096) throw refuse("The document path must be a file path.");
  const p = raw.trim();
  // Refused on every OS, so a test on one shows what another would do.
  if (isUncOrDevice(p)) throw refuse("Network (UNC) and device paths aren't accepted; copy the file to a local folder.");
  if (windows) {
    // A colon is only a drive letter's: "C:file" is drive-relative and "file:name" is a data stream.
    if (p.includes(":") && !/^[A-Za-z]:[\\/][^:]*$/.test(p)) throw refuse("That isn't a plain local file path.");
    const base = p.split(/[\\/]/).pop() ?? "";
    if (WIN_DEVICES.test(base.replace(/[ .]+$/, ""))) throw refuse("That name opens a device, not a file.");
  }
  return path.isAbsolute(p) ? p : path.join(projectDir, p);
}

export function readDocument(rawPath: unknown, provenance: unknown, projectDir: string): Document {
  if (!(DOC_PROVENANCE as readonly unknown[]).includes(provenance)) {
    throw new Refused("bad_request", "`document.provenance` must be owner or reference, from the owner's pick.");
  }
  const file = documentPath(rawPath, projectDir);
  // A linked folder on the way could lead to a share: the real path gets the same check.
  let real = file;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    // A missing file is reported below.
  }
  if (isUncOrDevice(real)) throw refuse("The document's folder links to a network share or device; copy the file to a local folder.");
  const media = DOC_TYPES[path.extname(file).toLowerCase()];
  if (!media) throw refuse("Only Markdown (.md, .markdown) and plain text (.txt) documents are accepted; convert other formats first.");
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch {
    throw refuse("The document can't be found or opened.");
  }
  if (before.isSymbolicLink()) throw refuse("The document is a link; name the file itself.");
  if (!before.isFile()) throw refuse("The document must be a regular file, not a folder, pipe or device.");
  const c = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(file, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0));
  } catch {
    throw refuse("The document can't be found or opened.");
  }
  let data: Buffer;
  try {
    const st = fs.fstatSync(fd);
    // The file opened must be the one checked: a swap in between is refused.
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) throw refuse("The document changed while it was being opened; try again.");
    if (st.size > DOC_MAX_BYTES) throw refuse(`The document is over ${DOC_MAX_BYTES / 1024} KiB.`);
    const buf = Buffer.alloc(DOC_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    data = buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  if (data.length > DOC_MAX_BYTES) throw refuse(`The document is over ${DOC_MAX_BYTES / 1024} KiB.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw refuse("The document isn't UTF-8 text.");
  }
  if (!text.trim()) throw refuse("The document is empty.");
  return { name: path.basename(file), media_type: media, text, provenance: provenance as string };
}
