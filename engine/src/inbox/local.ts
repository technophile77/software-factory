import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ensureOwnerDir, writeFileAtomic } from "../fsutil";
import { consoleAnswer as AnswerFile, inboxPrivate as PrivateFile } from "../schemas/inbox-local";
import { ID_RE } from "./model";

export { MAX_PRIVATE_SECTION_CHARS } from "../schemas/inbox-local";

/**
 * F-021: what the inbox keeps only on the PC, in the engine folder: private
 * detail (FR-4) and the proof of each console answer (FR-10). Nothing here is
 * ever committed to factory/state, sent to GitHub or put in a prompt (SR-5).
 * Files are owner-only, written atomically, read with a size limit and checked
 * against their schema; a file that fails is treated as missing (SR-6).
 */

const MAX_FILE_BYTES = 256 * 1024;

export type PrivateDetail = z.infer<typeof PrivateFile>["sections"];
export type ConsoleAnswer = z.infer<typeof AnswerFile>;

/**
 * Files live at `<engine home>/private/<project>/` and
 * `<engine home>/answers/<project>/` (Inbox item contract, H-0246), where
 * `<project>` is a fixed key for the project's config repo path.
 */
export class InboxLocal {
  constructor(private readonly home: string, private readonly project: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(project)) throw new Error("the inbox's project key must be a plain name");
  }

  private file(kind: "private" | "answers", name: string): string {
    const top = path.join(this.home, kind);
    const d = path.join(top, this.project);
    ensureOwnerDir(this.home);
    ensureOwnerDir(top);
    ensureOwnerDir(d);
    return path.join(d, name);
  }

  private read(file: string): unknown {
    // Checked and read through one descriptor, so the file can't be swapped between the two; a link isn't followed.
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  writePrivate(id: string, rev: number, sections: PrivateDetail): void {
    const doc = PrivateFile.parse({ schema: "inbox-private/1.0", id, rev, sections });
    writeFileAtomic(this.file("private", `${id}.rev${rev}.json`), JSON.stringify(doc, null, 2));
  }

  readPrivate(id: string, rev: number): PrivateDetail | null {
    if (!ID_RE.test(id)) return null;
    const r = PrivateFile.safeParse(this.read(this.file("private", `${id}.rev${rev}.json`)));
    return r.success && r.data.id === id && r.data.rev === rev ? r.data.sections : null;
  }

  writeAnswer(a: Omit<ConsoleAnswer, "schema">): void {
    const doc = AnswerFile.parse({ schema: "console-answer/1.0", ...a });
    writeFileAtomic(this.file("answers", `${a.id}.${a.n}.json`), JSON.stringify(doc, null, 2));
  }

  readAnswer(id: string, n: number): ConsoleAnswer | null {
    if (!ID_RE.test(id) || !Number.isSafeInteger(n) || n < 0) return null;
    const r = AnswerFile.safeParse(this.read(this.file("answers", `${id}.${n}.json`)));
    return r.success && r.data.id === id && r.data.n === n ? r.data : null;
  }
}
