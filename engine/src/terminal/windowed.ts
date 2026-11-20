/**
 * F-024: the windowed console's terminal side. `windowedIo` gives the command
 * flows of F-018 and F-021 a TerminalIo whose text lands in the Inbox window
 * and whose prompts are asked in the answer bar; `Poller` keeps the Status,
 * Agents, Transcript and Log windows current while those flows run or wait.
 */
import { CONSOLE_KEY } from "../mcp/operations";
import { clean } from "../mcp/text";
import { type Agent, ConsoleModel, type TranscriptEntry } from "./console-model";
import { type Runner, type TerminalIo, type Timing, featureRows, statusLines } from "./interview";

type Obj = Record<string, unknown>;

const STATUS_EVERY_MS = 5000;
const TICK_MS = 1000;
const AWAY = new Set(["engine_not_running", "engine_unreachable", "connection_lost", "timeout"]);

/** A status the console read, in the Status window and the side pane (FR-4, FR-15); `count` is null when the inbox wasn't read. */
function showStatus(model: ConsoleModel, st: Obj, count: number | null): void {
  model.setStatus(statusLines(st, true), count, featureRows(st));
}

export function windowedIo(model: ConsoleModel, timing: Timing): TerminalIo {
  return {
    windowed: true,
    write: (t) => model.write(t),
    line: (prompt) => model.ask(prompt),
    busy: (label, delayMs) => {
      let shown = false;
      let gone = false;
      void timing.sleep(delayMs).then(() => {
        if (gone) return;
        shown = true;
        model.setBusy(label);
      });
      return () => {
        gone = true;
        if (shown) model.setBusy(null);
      };
    },
    aborted: () => model.quit,
    redraw: (text) => model.away(text || null),
    status: (st) => showStatus(model, st, null),
  };
}

/**
 * Reads the engine for the windows that aren't the command's own flow:
 * status every 5 seconds, and the agents' transcript once a second while the
 * Agents or Transcript window is shown and with each status otherwise, so the
 * side pane's agents stay current (FR-6, FR-7, FR-15). Each read is a separate
 * call through the same operations, so it never holds up the command.
 */
export class Poller {
  private after: number | undefined;
  private unsupported = false;
  private stopped = false;

  constructor(
    private readonly model: ConsoleModel,
    private readonly runner: Runner,
    /** The session the reads go under: the console's, or the interview's feature; null while none is open. */
    private readonly sessionKey: () => string | null,
    private readonly timing: Timing,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    let sinceStatus = STATUS_EVERY_MS;
    while (!this.stopped && !this.model.quit) {
      if (sinceStatus >= STATUS_EVERY_MS) {
        sinceStatus = 0;
        await this.status();
      }
      // FR-7, FR-15: once a second while Agents or Transcript is shown; otherwise with the status, for the side pane's agents.
      if (this.model.wantsTranscript() || sinceStatus === 0) await this.transcript();
      await this.timing.sleep(TICK_MS);
      sinceStatus += TICK_MS;
    }
  }

  async status(): Promise<void> {
    const st = await this.runner("status", {});
    if (st.ok !== true) {
      if (AWAY.has(String((st.error as Obj | undefined)?.code)) && !this.model.stale) this.model.away("engine away");
      return;
    }
    let count: number | null = null;
    if (this.sessionKey() === CONSOLE_KEY) {
      const r = await this.runner("inbox_list", { feature: CONSOLE_KEY });
      if (r.ok === true && Array.isArray(r.items)) count = r.items.length;
    }
    showStatus(this.model, st, count);
  }

  async transcript(): Promise<void> {
    const key = this.sessionKey();
    if (!key || this.unsupported) return;
    const r = await this.runner("transcript", { feature: key, ...(this.after !== undefined ? { after: this.after } : {}) });
    if (r.ok !== true) {
      const code = String((r.error as Obj | undefined)?.code);
      if (code === "transcript_unsupported") {
        this.unsupported = true;
        this.model.addLog("This engine can't show agents or their transcript; update it.");
      }
      // A restarted engine numbers its entries from the start again.
      if (AWAY.has(code)) this.after = undefined;
      return;
    }
    this.after = r.next as number;
    this.model.setAgents(r.agents as Agent[]);
    const entries = (r.entries as Array<TranscriptEntry & { feature: string; role: string }>).map((e) => ({ run: e.run, at: e.at, kind: e.kind, text: clean(e.text) }));
    this.model.addTranscript(entries, r.skipped as number);
  }
}
