import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ensureOwnerDir, writeFileAtomic } from "../fsutil";
import { ID_RE } from "./model";

/**
 * F-021: what the inbox keeps only on the PC, in the engine folder: private
 * detail (FR-4) and the proof of each console answer (FR-10). Nothing here is
 * ever committed to factory/state, sent to GitHub or put in a prompt (SR-5).
 * Files are owner-only, written atomically, read with a size limit and checked
 * against their schema; a file that fails is treated as missing (SR-6).
 */

const MAX_FILE_BYTES = 256 * 1024;
export const MAX_PRIVATE_SECTION_CHARS = 40_000;

const PrivateFile = z.object({
  schema: z.literal("inbox-private/1.0"),
  id: z.string().regex(ID_RE),
  rev: z.number().int().min(1),
  sections: z.array(z.object({ name: z.string().min(1).max(80), text: z.string().max(MAX_PRIVATE_SECTION_CHARS) })).max(10),
}).strict();
export type PrivateDetail = z.infer<typeof PrivateFile>["sections"];

const AnswerFile = z.object({
  schema: z.literal("console-answer/1.0"),
  id: z.string().regex(ID_RE),
  /** The entry's index in the record's history. */
  n: z.number().int().min(0),
  rev: z.number().int().min(1),
  action: z.string().max(40),
  note: z.string().max(4_000).optional(),
  at: z.string().max(40),
  session: z.number().int().min(0),
  entry_sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ConsoleAnswer = z.infer<typeof AnswerFile>;

export class InboxLocal {
  constructor(private readonly dir: string) {}

  private file(kind: "private" | "answers", name: string): string {
    const d = path.join(this.dir, kind);
    ensureOwnerDir(this.dir);
    ensureOwnerDir(d);
    return path.join(d, name);
  }

  private read(file: string): unknown {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
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
