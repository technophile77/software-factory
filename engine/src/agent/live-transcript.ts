/**
 * F-021 FR-18 (channel v1.7, H-0265): what each running agent session says
 * and does, kept in memory for `factory-engine inbox -v`. Never written to
 * disk, a repo or GitHub (SR-8). Tool calls are kept as the tool's name and
 * target only; tool output never reaches this buffer.
 */

export type EntryKind = "text" | "tool";

export interface LiveEntry {
  seq: number;
  at: string;
  run: string;
  feature: string;
  role: string;
  kind: EntryKind;
  text: string;
}

export const PER_RUN = 500;
export const FIRST_READ = 50;
export const MAX_TEXT = 8000;
const COMMAND_CHARS = 200;
/** An ended run's lines stay a little, so a console reading once a second still gets its last words. */
const KEEP_ENDED_MS = 60_000;
/** Enough dropped seqs to count what a console missed after a long pause. */
const DROP_LOG = 10_000;

interface RunBuffer {
  project: string;
  feature: string;
  role: string;
  startedAt: string;
  entries: LiveEntry[];
  endedAt: number | null;
}

/** A running (or just ended) agent session, for the console's Agents window (F-024 FR-6). */
export interface LiveAgent {
  run: string;
  feature: string;
  role: string;
  started_at: string;
  ended?: true;
}

/** The one line a tool call shows: its name and what it works on, never its output. */
export function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const short = (name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name) || name;
  let target = "";
  switch (name) {
    case "Read": case "Write": case "Edit": case "NotebookEdit":
      target = s("file_path") || s("notebook_path");
      break;
    case "Grep":
      target = [s("pattern"), s("path")].filter(Boolean).join(" in ");
      break;
    case "Glob":
      target = [s("pattern"), s("path")].filter(Boolean).join(" in ");
      break;
    case "Bash":
      target = s("command").slice(0, COMMAND_CHARS);
      break;
    case "WebFetch":
      target = s("url");
      break;
    case "WebSearch":
      target = s("query");
      break;
    case "Skill":
      target = s("skill");
      break;
    case "Task": case "Agent":
      target = s("description");
      break;
  }
  return (target ? `${short} ${target}` : short).slice(0, MAX_TEXT);
}

export class LiveTranscript {
  private seq = 0;
  private readonly runs = new Map<string, RunBuffer>();
  /** Per project, the seqs dropped before a console read them, oldest first. */
  private readonly dropped = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The run's first session started; it is listed as an agent from now, before it says anything. */
  begin(runId: string, who: { project: string; feature: string; role: string }): void {
    const b = this.runs.get(runId);
    if (b) b.endedAt = null;
    else this.runs.set(runId, { ...who, startedAt: new Date(this.now()).toISOString(), entries: [], endedAt: null });
  }

  add(runId: string, who: { project: string; feature: string; role: string }, kind: EntryKind, text: string): void {
    if (!text.trim()) return;
    this.begin(runId, who);
    const b = this.runs.get(runId)!;
    b.entries.push({ seq: ++this.seq, at: new Date(this.now()).toISOString(), run: runId, feature: who.feature, role: who.role, kind, text: text.slice(0, MAX_TEXT) });
    if (b.entries.length > PER_RUN) this.drop(b.project, b.entries.splice(0, b.entries.length - PER_RUN));
  }

  /** The run's sessions are over; its lines go after a short while. */
  end(runId: string): void {
    const b = this.runs.get(runId);
    if (b) b.endedAt = this.now();
  }

  /**
   * The project's entries after `after`, oldest first. With no `after`, the
   * newest few, so a console that just started isn't flooded.
   */
  read(project: string, after: number | undefined): { agents: LiveAgent[]; entries: LiveEntry[]; next: number; skipped: number } {
    this.prune();
    const all: LiveEntry[] = [];
    const agents: LiveAgent[] = [];
    for (const [run, b] of this.runs) {
      if (b.project !== project) continue;
      all.push(...b.entries);
      agents.push({ run, feature: b.feature, role: b.role, started_at: b.startedAt, ...(b.endedAt !== null ? { ended: true as const } : {}) });
    }
    all.sort((a, b) => a.seq - b.seq);
    agents.sort((a, b) => a.started_at.localeCompare(b.started_at));
    if (!after) return { agents, entries: all.slice(-FIRST_READ), next: this.seq, skipped: 0 };
    const entries = all.filter((e) => e.seq > after);
    const skipped = (this.dropped.get(project) ?? []).filter((s) => s > after).length;
    return { agents, entries, next: this.seq, skipped };
  }

  private drop(project: string, gone: LiveEntry[]): void {
    const log = this.dropped.get(project) ?? [];
    log.push(...gone.map((e) => e.seq));
    if (log.length > DROP_LOG) log.splice(0, log.length - DROP_LOG);
    this.dropped.set(project, log);
  }

  private prune(): void {
    const t = this.now();
    for (const [id, b] of this.runs) if (b.endedAt !== null && t - b.endedAt > KEEP_ENDED_MS) this.runs.delete(id);
  }
}
