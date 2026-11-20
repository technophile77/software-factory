/**
 * F-024: the windowed console's state, in plain TypeScript so it is tested
 * without a terminal. The screen (src/console-ui, Ink, ADR 0035) only draws
 * what `frame()` returns and passes keys to `key()`.
 *
 * Every string that reaches the model from the engine has been cleaned of
 * escape and control sequences by its producer (F-018 SR-1); engine and agent
 * text arrives already carrying the margin marker (F-024 SR-1).
 */
import { clean } from "../mcp/text";

export type Tab = "status" | "inbox" | "agents" | "transcript" | "log";

export interface Agent {
  run: string;
  feature: string;
  role: string;
  started_at: string;
  ended?: boolean;
  cost_usd?: number;
}

export interface TranscriptEntry {
  run: string;
  at: string;
  kind: "text" | "tool";
  text: string;
}

/** The keys the screen reports; names follow Ink's `useInput`. */
export interface Key {
  tab?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
}

/** One drawn screen: everything the screen layer needs, already fitted to its size. */
export interface Frame {
  tooSmall: boolean;
  title: string;
  tabs: Array<{ label: string; selected: boolean }>;
  windowTitle: string;
  lines: string[];
  prompt: string;
  input: string;
  hints: string;
}

export const MIN_COLS = 60;
export const MIN_ROWS = 16;
/** Title line, tab row, the window's borders and title, the answer bar's two lines and its borders. */
export const CHROME_ROWS = 9;
const MAX_CONVERSATION = 2000;
const MAX_LOG = 1000;
const MAX_PER_AGENT = 2000;
/** An ended agent stays listed this long (FR-6). */
export const ENDED_SHOWN_MS = 60_000;

const LABELS: Record<Tab, string> = { status: "Status", inbox: "Inbox", agents: "Agents", transcript: "Transcript", log: "Log" };

const time = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** Splits a line into pieces of at most `width` characters, at a space where one is near. */
export function wrap(line: string, width: number): string[] {
  const chars = Array.from(line);
  if (width < 1 || chars.length <= width) return [line];
  const out: string[] = [];
  let rest = chars;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width / 2) cut = width;
    out.push(rest.slice(0, cut).join("").trimEnd());
    rest = rest.slice(rest[cut] === " " ? cut + 1 : cut);
  }
  out.push(rest.join(""));
  return out;
}

export class ConsoleModel {
  tab: Tab = "status";
  cols = 80;
  rows = 24;
  project: string;
  /** "connected", or the reconnect countdown text while the engine is away (F-021 FR-16). */
  engine = "connecting";
  stale = false;
  busy: string | null = null;
  statusRows: string[] = [];
  inboxCount = 0;
  transcriptOn: boolean;
  agents: Agent[] = [];
  selectedRun: string | null = null;
  prompt: string | null = null;
  input = "";
  quit = false;
  /** How many times the answer bar has asked; each ask is answered once. */
  asks = 0;
  private conversation: string[] = [""];
  private log: string[] = [];
  private transcripts = new Map<string, string[]>();
  private skippedNote = new Map<string, number>();
  /** Lines scrolled up from the newest, per tab; 0 follows the newest. */
  private scroll: Record<Tab, number> = { status: 0, inbox: 0, agents: 0, transcript: 0, log: 0 };
  private seen: Record<Tab, number> = { status: 0, inbox: 0, agents: 0, transcript: 0, log: 0 };
  private listeners = new Set<() => void>();
  private submit: ((line: string | null) => void) | null = null;

  constructor(o: { project: string; transcript: boolean; now?: () => number }) {
    this.project = o.project;
    this.transcriptOn = o.transcript;
    this.now = o.now ?? Date.now;
  }

  private readonly now: () => number;

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  visibleTabs(): Tab[] {
    return this.transcriptOn ? ["status", "inbox", "agents", "transcript", "log"] : ["status", "inbox", "agents", "log"];
  }

  /** Whether the agents' transcript should be read now (FR-7, and the Agents window's list). */
  wantsTranscript(): boolean {
    return this.tab === "agents" || (this.transcriptOn && this.tab === "transcript");
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.changed();
  }

  // ---- what the console learns ----

  /** Text the command writes, as the line-by-line console would print it, shown in the Inbox window. */
  write(text: string): void {
    const parts = text.split("\n");
    this.conversation[this.conversation.length - 1] += parts[0]!;
    for (const p of parts.slice(1)) this.conversation.push(p);
    if (this.conversation.length > MAX_CONVERSATION) this.conversation.splice(0, this.conversation.length - MAX_CONVERSATION);
    this.changed();
  }

  setStatus(rows: string[], inboxCount: number | null): void {
    const before = new Map(this.statusRows.map((r) => [r.split(":")[0], r]));
    for (const r of rows) {
      const id = r.split(":")[0];
      if (before.get(id) !== r && r.includes(":")) this.addLog(r);
    }
    this.statusRows = rows;
    if (inboxCount !== null) {
      if (inboxCount > this.inboxCount) this.addLog(`${inboxCount} inbox item${inboxCount === 1 ? "" : "s"} waiting for you`);
      this.inboxCount = inboxCount;
    }
    if (this.stale) this.addLog("Connected to the engine again");
    this.stale = false;
    this.engine = "connected";
    this.changed();
  }

  away(text: string | null): void {
    if (text) {
      if (!this.stale) this.addLog("Lost the connection to the engine");
      this.stale = true;
      this.engine = text;
    } else if (this.engine !== "connected") {
      this.engine = this.stale ? "reconnected" : "connected";
    }
    this.changed();
  }

  setBusy(label: string | null): void {
    this.busy = label;
    this.changed();
  }

  setAgents(agents: Agent[]): void {
    const was = new Map(this.agents.map((a) => [a.run, a]));
    for (const a of agents) {
      const old = was.get(a.run);
      if (!old) this.addLog(`${a.feature} ${a.role} started`);
      else if (a.ended && !old.ended) this.addLog(`${a.feature} ${a.role} ended`);
    }
    this.agents = agents;
    // FR-6: the pick stays until it is gone or the owner picks another; with none, the newest.
    if (!this.selectedRun || !agents.some((a) => a.run === this.selectedRun)) this.selectedRun = agents.length ? agents[agents.length - 1]!.run : null;
    this.changed();
  }

  addTranscript(entries: TranscriptEntry[], skipped: number): void {
    if (skipped > 0) for (const run of new Set(entries.map((e) => e.run))) this.skippedNote.set(run, (this.skippedNote.get(run) ?? 0) + skipped);
    for (const e of entries) {
      const lines = this.transcripts.get(e.run) ?? [];
      if (skipped > 0 && this.skippedNote.has(e.run)) {
        lines.push(`(${this.skippedNote.get(e.run)} earlier lines not shown)`);
        this.skippedNote.delete(e.run);
      }
      const at = `[${time(Date.parse(e.at))}] `;
      if (e.kind === "tool") lines.push(`${at}* ${clean(e.text, true)}`);
      else clean(e.text).split("\n").forEach((l, i) => lines.push((i === 0 ? at : " ".repeat(at.length)) + l));
      if (lines.length > MAX_PER_AGENT) lines.splice(0, lines.length - MAX_PER_AGENT);
      this.transcripts.set(e.run, lines);
    }
    this.changed();
  }

  addLog(text: string): void {
    this.log.push(`[${time(this.now())}] ${text}`);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.changed();
  }

  /** The Inbox window's last lines, printed after the screen closes when the command failed, so the reason stays readable. */
  lastWritten(n: number): string {
    return this.conversation.slice(-n).join("\n").trim();
  }

  // ---- the answer bar ----

  /** Asks in the answer bar; resolves with the line, or null once the owner quits. */
  ask(prompt: string): Promise<string | null> {
    if (this.quit) return Promise.resolve(null);
    this.prompt = prompt;
    this.asks++;
    this.input = "";
    this.tab = "inbox";
    this.scroll.inbox = 0;
    this.changed();
    return new Promise((resolve) => (this.submit = resolve));
  }

  private answer(line: string | null): void {
    const s = this.submit;
    this.submit = null;
    this.prompt = null;
    this.input = "";
    this.changed();
    s?.(line);
  }

  stop(): void {
    this.quit = true;
    this.answer(null);
  }

  // ---- keys (FR-2, FR-6, FR-7, FR-9, FR-12) ----

  key(input: string, k: Key): void {
    if (k.ctrl && input === "c") return this.stop();
    if (k.tab) return this.cycle(k.shift ? -1 : 1);
    const typing = this.prompt !== null;
    if (k.upArrow || k.downArrow || k.pageUp || k.pageDown || k.home || k.end) return this.move(k);
    if (typing) {
      if (k.return) return this.answer(this.input);
      if (k.backspace || k.delete) {
        this.input = Array.from(this.input).slice(0, -1).join("");
        return this.changed();
      }
      if (input && !k.ctrl && !k.escape) {
        this.input += clean(input, true);
        this.changed();
      }
      return;
    }
    if (input === "q") return this.stop();
    if (input === "v") return this.toggleTranscript();
    if (/^[1-9]$/.test(input)) {
      const t = this.visibleTabs()[Number(input) - 1];
      if (t) this.select(t);
      return;
    }
    if (k.return && this.tab === "agents" && this.transcriptOn) this.select("transcript");
  }

  toggleTranscript(): void {
    this.transcriptOn = !this.transcriptOn;
    if (!this.transcriptOn && this.tab === "transcript") this.tab = "agents";
    else if (this.transcriptOn) this.tab = "transcript";
    this.addLog(this.transcriptOn ? "Transcript shown" : "Transcript hidden");
  }

  private select(t: Tab): void {
    this.tab = t;
    this.seen[t] = this.count(t);
    this.changed();
  }

  private cycle(d: number): void {
    const tabs = this.visibleTabs();
    const i = tabs.indexOf(this.tab);
    this.select(tabs[(i + d + tabs.length) % tabs.length]!);
  }

  private move(k: Key): void {
    if (this.tab === "agents" && (k.upArrow || k.downArrow) && this.agents.length) {
      const i = Math.max(0, this.agents.findIndex((a) => a.run === this.selectedRun));
      const j = Math.min(this.agents.length - 1, Math.max(0, i + (k.upArrow ? -1 : 1)));
      this.selectedRun = this.agents[j]!.run;
      return this.changed();
    }
    const page = Math.max(1, this.rows - CHROME_ROWS - 1);
    const s = this.scroll[this.tab];
    const step = k.upArrow ? 1 : k.downArrow ? -1 : k.pageUp ? page : k.pageDown ? -page : k.home ? Number.MAX_SAFE_INTEGER : -s;
    this.scroll[this.tab] = Math.max(0, s + step);
    this.changed();
  }

  // ---- drawing ----

  private count(t: Tab): number {
    if (t === "inbox") return this.inboxCount;
    if (t === "log") return this.log.length;
    if (t === "agents") return this.agents.filter((a) => !a.ended).length;
    return 0;
  }

  private content(t: Tab): string[] {
    switch (t) {
      case "status":
        return this.statusRows.length ? this.statusRows : ["No features are running."];
      case "inbox":
        return this.conversation;
      case "agents":
        if (!this.agents.length) return ["No agents are running."];
        return this.agents.map((a) => {
          const mins = Math.max(0, Math.floor((this.now() - Date.parse(a.started_at)) / 60_000));
          const cost = a.cost_usd !== undefined ? `, $${a.cost_usd.toFixed(2)}` : "";
          return `${a.run === this.selectedRun ? ">" : " "} ${a.feature} ${a.role}: ${a.ended ? "ended" : `${mins} min`}${cost}`;
        });
      case "transcript": {
        if (!this.selectedRun) return ["No agents are running."];
        return this.transcripts.get(this.selectedRun) ?? ["Nothing yet from this agent."];
      }
      case "log":
        return this.log.length ? this.log : ["Nothing has happened yet."];
    }
  }

  frame(marker: string): Frame {
    const tooSmall = this.cols < MIN_COLS || this.rows < MIN_ROWS;
    const sel = this.agents.find((a) => a.run === this.selectedRun);
    const windowTitle = this.tab === "transcript" && sel ? `Transcript: ${sel.feature} ${sel.role}${sel.ended ? " (ended)" : ""}` : LABELS[this.tab];
    const width = Math.max(1, this.cols - 2);
    const height = Math.max(1, this.rows - CHROME_ROWS);
    const wrapped = this.content(this.tab).flatMap((l) => {
      // A wrapped piece of engine text keeps the marker, so no line of it looks like the command's own (SR-1).
      const marked = marker && l.startsWith(marker);
      return wrap(l, width).map((p, i) => (marked && i > 0 ? marker + p : p));
    });
    const max = Math.max(0, wrapped.length - height);
    const off = Math.min(this.scroll[this.tab], max);
    this.scroll[this.tab] = off;
    const lines = wrapped.slice(Math.max(0, wrapped.length - height - off), wrapped.length - off);
    const running = this.statusRows.filter((r) => r.includes(":")).length;
    const summary = `${running} feature${running === 1 ? "" : "s"} running, ${this.inboxCount} item${this.inboxCount === 1 ? "" : "s"} waiting`;
    const engine = this.engine === "connected" ? "engine connected" : this.engine === "connecting" ? "connecting" : this.engine;
    const title = [this.project, engine, summary, this.busy ?? ""].filter(Boolean).join("  |  ") + (this.stale ? "  (stale)" : "");
    const tabs = this.visibleTabs().map((t, i) => {
      const n = this.count(t) - (t === "inbox" ? 0 : this.seen[t]);
      const badge = t === this.tab || n <= 0 ? "" : ` (${t === "inbox" ? this.inboxCount : n})`;
      return { label: `${i + 1} ${LABELS[t]}${badge}`, selected: t === this.tab };
    });
    if (this.tab !== "inbox" && this.tab !== "status") this.seen[this.tab] = this.count(this.tab);
    const hints = this.prompt !== null
      ? "Enter sends  |  Tab: next window  |  Up/Down scroll  |  Ctrl+C quits"
      : `Tab or 1-${tabs.length}: windows  |  Up/Down ${this.tab === "agents" ? "pick an agent" : "scroll"}  |  v: ${this.transcriptOn ? "hide" : "show"} transcript  |  q: quit`;
    return { tooSmall, title, tabs, windowTitle, lines, prompt: this.prompt ?? "", input: this.input, hints };
  }
}
