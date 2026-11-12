import * as fs from "node:fs";
import * as path from "node:path";
import { ensureOwnerDir, writeFileAtomic } from "../fsutil";

/**
 * The engine's own record, outside every repo (SR-5, SR-17): transcript
 * chain heads, the feature ids it assigned, and its agent runs. No repo
 * writer can change it, which is what lets the chain head vouch for the
 * transcript on factory/state.
 */
export interface ChainHead {
  seq: number;
  head: string;
  /**
   * The head an append is about to commit. A kill between the commit and the
   * record update leaves the transcript one append ahead of `head`; this is
   * how the engine knows that append was its own (AC-12).
   */
  pending?: { seq: number; head: string };
}

export type RunStatus = "running" | "interrupted" | "complete" | "failed";

export interface RunUsed {
  turns: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface RunRecord {
  id: string;
  project: string;
  feature: string;
  role: string;
  stage: string;
  status: RunStatus;
  started_at: string;
  ended_at?: string;
  resumes: number;
  /** The agent session to resume, when the SDK reported one. */
  session_id?: string;
  /** The last commit the engine made for the run (ADR 0012: resume from here). */
  last_commit?: string;
  /** The analyst's worktree git dir, taken when the worktree was made (the agent can rewrite its `.git` link). */
  git_dir?: string;
  /** The analyst's checkout, so a resumed run starts where it was. */
  worktree?: string;
  /** What the run's ended sessions used, for caps that cover the whole run (F-008 SR-11). */
  used?: RunUsed;
  reason?: string;
}

interface Data {
  version: 1;
  chains: Record<string, ChainHead>;
  features: Record<string, string>;
  runs: Record<string, RunRecord>;
  /** Security alerts already filed, so a restart doesn't file the same one again. */
  alerts?: Record<string, string>;
}

export class EngineRecord {
  private data: Data;
  private readonly file: string;

  constructor(dir: string) {
    ensureOwnerDir(dir);
    this.file = path.join(dir, "record.json");
    this.data = { version: 1, chains: {}, features: {}, runs: {} };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Data>;
      if (raw.version !== 1 || typeof raw.chains !== "object" || typeof raw.features !== "object" || typeof raw.runs !== "object") {
        throw new Error("The engine record is unreadable; refusing to guess its contents.");
      }
      this.data = raw as Data;
    }
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  chain(key: string): ChainHead | null {
    return this.data.chains[key] ?? null;
  }

  setChain(key: string, head: ChainHead): void {
    this.data.chains[key] = head;
    this.save();
  }

  /** Records the head an append is about to commit, before it is committed. */
  setPending(key: string, pending: { seq: number; head: string } | null): void {
    const cur = this.data.chains[key] ?? { seq: 0, head: "" };
    const next: ChainHead = { seq: cur.seq, head: cur.head };
    if (pending) next.pending = pending;
    this.data.chains[key] = next;
    this.save();
  }

  /** Feature id → the project (config repo path) it was assigned to. */
  features(): Readonly<Record<string, string>> {
    return this.data.features;
  }

  assignFeature(id: string, project: string): void {
    if (this.data.features[id] && this.data.features[id] !== project) throw new Error(`${id} already belongs to another project`);
    this.data.features[id] = project;
    this.save();
  }

  runs(): RunRecord[] {
    return Object.values(this.data.runs);
  }

  run(id: string): RunRecord | null {
    return this.data.runs[id] ?? null;
  }

  alert(key: string): string | null {
    return this.data.alerts?.[key] ?? null;
  }

  setAlert(key: string, item: string): void {
    (this.data.alerts ??= {})[key] = item;
    this.save();
  }

  putRun(run: RunRecord): void {
    this.data.runs[run.id] = run;
    this.save();
  }
}
