/**
 * `factory-engine interview` (F-018, ADR 0029): the spec interview in the
 * owner's terminal. Every item is printed whole, from the operations' own
 * `display`, right before its numbered choices (FR-4), and only the owner's
 * keystrokes are sent (FR-7). There is no model anywhere in this path.
 */
import { parseSourceIssue } from "../constants";
import type { Item } from "../mcp/items";
import { CONSOLE_KEY, type Operation } from "../mcp/operations";
import { clean } from "../mcp/text";

type Obj = Record<string, unknown>;

export type Runner = (op: Operation, req: Obj) => Promise<Obj>;

export interface TerminalIo {
  write(text: string): void;
  /** One line as typed, without its line ending; null once input has ended (Ctrl+D, Ctrl+C, closed). */
  line(prompt: string): Promise<string | null>;
  /**
   * Shows `label` with a spinner and the elapsed time on a line redrawn in
   * place, after `delayMs` (FR-14); the returned function clears it. Absent
   * where nothing is drawn, as in tests.
   */
  busy?(label: string, delayMs: number): () => void;
  /** True once the owner pressed Ctrl+C, so a wait with no prompt can stop too. */
  aborted?(): boolean;
  /**
   * Draws `text` on one line redrawn in place, over what it drew last; an
   * empty string clears it (F-021 FR-16). Absent where nothing is drawn.
   */
  redraw?(text: string): void;
  /** F-024: the windowed console, which shows the factory's status in a window of its own. */
  windowed?: boolean;
  /** F-024 FR-11: a status the command read; the windowed console shows it at once, so a reconnect clears "(stale)". */
  status?(st: Obj): void;
}

export interface Timing {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realTiming: Timing = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** The command's own words for each `activity` code (F-018 FR-14, H-0225); engine text is never shown as status. */
export const ACTIVITY: Record<string, string> = {
  analyst_reviewing: "Analyst is reviewing your answers",
  analyst_researching: "Analyst is researching",
  analyst_writing_spec: "Analyst is writing the specification",
  security_reviewing: "Security reviewer is reviewing the specification",
  readiness_check: "Checking readiness",
  advisor_working: "Advisor is working",
  waiting_for_owner: "Waiting for your answer",
  waiting_for_decision: "Waiting for your decision",
  paused: "The feature is paused",
  idle: "The factory is idle",
  // F-021 v7 FR-12: the build stages.
  waiting_on_dependency: "Waiting for a feature it depends on",
  developer_working: "Developer is working",
  test_engineer_working: "Test engineer is working",
  merging: "Merging the branches",
  resolving_conflicts: "Resolving merge conflicts",
  tests_running: "Tests are running",
  classifying_failures: "Looking into failing tests",
  code_reviewing: "Code Review is running",
  validating: "Validation judge is checking the feature",
  opening_pr: "Opening the pull request",
  waiting_for_ci: "Pull request open, waiting for CI",
  pr_ready: "Pull request ready for your review",
  build_stopped: "The build is stopped",
  closed: "Closed (pull request merged)",
  cancelled: "Cancelled",
};

/**
 * F-021 v7 FR-2, FR-12: one line per feature the engine runs, in the
 * command's own words; ids come from the operation's checked lists.
 */
/** F-024 FR-4, FR-15: the command's own short words for each workflow stage; an unknown stage shows its checked id. */
export const STAGE: Record<string, string> = {
  request: "Request",
  requirements_interview: "Interview",
  security_testability_review: "Security review",
  security_gate_1: "Security review",
  readiness_gate: "Readiness",
  build_and_test_prep: "Building",
  orchestrator_review: "Testing",
  code_review: "Code review",
  validation: "Validation",
  pull_request: "Pull request",
  blocked: "Blocked",
  run_review: "Run review",
};

export interface FeatureRow {
  id: string;
  stage: string;
  activity: string;
}

/** F-024 FR-15: each running feature with its stage and activity in the command's words. */
export function featureRows(st: Obj): FeatureRow[] {
  const ids = Array.isArray(st.features) ? (st.features as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const stages = (st.stages ?? {}) as Record<string, string>;
  const activities = (st.activities ?? {}) as Record<string, string>;
  return ids.map((id) => {
    const s = stages[id];
    return { id, stage: s ? STAGE[s] ?? s : "", activity: ACTIVITY[activities[id] ?? ""] ?? "Working" };
  });
}

/** With `stage` (F-024 FR-4), each row also names the feature's stage: "F-003 (Building): Developer is working". */
export function statusLines(st: Obj, stage = false): string[] {
  const stages = (st.stages ?? {}) as Record<string, string>;
  const ids = Array.isArray(st.features) ? (st.features as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const activities = (st.activities ?? {}) as Record<string, string>;
  const waiting = (st.waiting_on ?? {}) as Record<string, string[]>;
  if (!ids.length) return ["No features are running."];
  return ids.map((id) => {
    const code = activities[id] ?? "";
    const decisions = waiting[id] ?? [];
    const label = code === "waiting_for_decision" && decisions.length ? `${ACTIVITY[code]} on ${decisions.join(", ")}` : ACTIVITY[code] ?? "Working";
    const s = stage && stages[id] ? ` (${STAGE[stages[id]!] ?? stages[id]})` : "";
    return `${id}${s}: ${label}`;
  });
}

/** F-021 FR-17: the features whose analyst waits for the owner's answer, from the operation's checked lists. */
export function waitingForAnswer(st: Obj): string[] {
  const ids = Array.isArray(st.features) ? (st.features as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const activities = (st.activities ?? {}) as Record<string, string>;
  return ids.filter((id) => activities[id] === "waiting_for_owner");
}

/** Stages from which the interview can still send the owner items, so the command keeps waiting. */
// security_gate_1: an engine from before the gate rename reports the old stage name.
const WAIT_STAGES = new Set(["requirements_interview", "security_testability_review", "security_gate_1", "readiness_gate"]);

const POLL_MS = 2000;
const STATUS_RETRY_MS = 2000;
/** Channel errors a busy engine can cause; a read that hit one is safe to repeat. */
const CHANNEL_HICCUPS = new Set(["connection_lost", "engine_unreachable", "timeout"]);

/** How often the inbox console's watch looks again (F-021 v7 FR-2). */
const WATCH_MS = 5000;

const NEXT_EVERY_MS = 15_000;
const ASK_AFTER_MS = 30 * 60_000;
const BUSY_DELAY_MS = 1000;

/** Errors that mean the engine is away; both commands wait for it to come back (F-021 FR-16). */
const ENGINE_GONE = new Set(["engine_not_running", "engine_unreachable", "connection_lost", "timeout"]);
const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 60_000;

const errorOf = (r: Obj): Obj => (r.error ?? {}) as Obj;
const engineAway = (r: Obj): boolean => r.ok !== true && ENGINE_GONE.has(String(errorOf(r).code));
/** Which way the connection failed, so a drop that keeps coming back can be told apart. */
const AWAY_WORDS: Record<string, string> = {
  timeout: "it didn't answer in time", connection_lost: "it closed the connection",
  engine_unreachable: "the connection couldn't be opened", engine_not_running: "it isn't running",
};
const awayReason = (r?: Obj): string => {
  const w = r ? AWAY_WORDS[String(errorOf(r).code)] : undefined;
  return w ? ` (${w})` : "";
};

const BUSY: Partial<Record<Operation, string>> = {
  status: "Connecting to the engine", start: "Sending your request", list: "Getting the feature list",
  open: "Opening the feature", approval: "Waiting for your approval on GitHub", next: "Waiting for the analyst",
  reply: "Sending your reply", state: "Checking the item", close: "Closing the session",
  inbox_open: "Opening the inbox", inbox_list: "Getting the inbox", inbox_show: "Getting the item",
  inbox_answer: "Sending your answer", inbox_confirm: "Sending the code", cancel: "Cancelling the feature",
};

const INBOX_ID = /^[DTHSMN]-\d{4,8}$/;

/** The owner stopped: input ended or they picked Stop. */
class Stop extends Error {}

const WAIT_S = 60;
const APPROVAL_WAIT_S = 120;

const FENCE_OPEN = /^(`{3,})text$/;

/**
 * Turns an operation's Markdown `display` into terminal text. Fenced blocks
 * hold engine-written text: each of their lines gets the margin marker, which
 * the command's own lines never start with (SR-2). Everything is cleaned
 * again, so no escape sequence reaches the terminal however a display was
 * built (SR-1).
 */
export function render(display: string, marker: string): string {
  const out: string[] = [];
  let bar: string | null = null;
  for (const raw of display.split("\n")) {
    const line = clean(raw, true);
    if (bar === null) {
      const m = FENCE_OPEN.exec(line);
      if (m) {
        bar = m[1]!;
        continue;
      }
      out.push(line.replace(/\*\*/g, ""));
    } else if (line === bar) {
      bar = null;
    } else {
      out.push(marker + line);
    }
  }
  return out.join("\n");
}

/** An answer option that only makes sense with the owner's own text, such as "Something else", "Other (describe)" or "Another way:". */
export const OPEN_OPTION_RE = /^(?:something else|other|another|none of (?:these|the above)|i'?ll describe)\b|(?::|\u2026|\.\.\.)$/i;

/** The question's answer choices: the suggested answer, then each option not equal to it (FR-5). */
export function answerChoices(item: Item): Array<{ text: string; recommended: boolean }> {
  const out: Array<{ text: string; recommended: boolean }> = [];
  // Only a real suggestion is offered; an empty one would record an empty answer as the owner's.
  if (item.suggested !== undefined && item.suggested.trim()) out.push({ text: item.suggested, recommended: true });
  for (const o of item.options ?? []) if (o !== item.suggested) out.push({ text: o, recommended: false });
  return out;
}

interface Choice {
  label: string;
  key: string;
}

export class TerminalInterview {
  private feature: string | null = null;
  private advisor = false;
  /** F-021: whether a console session is open, so it is closed on the way out. */
  private consoleOpen = false;
  /** F-021 FR-11: the decision ids last offered while waiting, so "Not now" isn't asked again until they change. */
  private offered = "";
  /** The last reply sent, so a lost one can be checked and, on the owner's word, resent. */
  private lastSent: { item: Item; kind: string; text: string } | null = null;
  /** Set when the engine came back, so a session it no longer knows is opened again without asking (FR-16). */
  private reconnected = false;
  /**
   * F-021 FR-17: the inbox console answers a feature's waiting questions in
   * place; the session then ends as soon as nothing more is waiting, instead
   * of following the analyst's work, and the console goes back to watching.
   */
  private answerOnly = false;
  /** FR-17: features whose waiting question the owner put off, until they stop waiting. */
  private putOff = new Set<string>();

  /**
   * Whether a factory runs on this PC (its pid, null without one, undefined
   * when none does). A factory that runs but doesn't answer for this project
   * has stopped the project, often until the owner confirms a change, so the
   * wait says that instead of "isn't running".
   */
  factoryRunning?: () => Promise<number | null | undefined>;
  /** F-021 FR-18: the hold reason last printed, so it is said once per hold. */
  private heldShown = "";
  /** The project argument this console was started with, for the confirm command it names. */
  projectArg = "<this project>";

  constructor(
    private readonly runner: Runner,
    private readonly io: TerminalIo,
    private readonly marker: string,
    private readonly timing: Timing = realTiming,
  ) {}

  /** F-024: the session the windowed console's own reads go under; null while none is open. */
  sessionKey(): string | null {
    return this.consoleOpen ? CONSOLE_KEY : this.feature;
  }

  /** Every engine call shows the spinner once it takes over a second (FR-14). */
  private async run(op: Operation, req: Obj): Promise<Obj> {
    const stop = this.io.busy?.(BUSY[op] ?? "Working", BUSY_DELAY_MS);
    try {
      return await this.runner(op, req);
    } finally {
      stop?.();
    }
  }

  /** Exit code (FR-11): 0 when the owner stopped or the interview finished, 1 when the engine was unreachable. */
  async main(featureArg?: string): Promise<number> {
    this.say("Don't type secrets into your answers: the interview transcript is committed to the project's config repo "
      + "and sent to the model provider (F-005 SR-4).");
    try {
      const status = await this.connect();
      if (status.ok !== true) {
        this.show(status);
        return 1;
      }
      this.advisor = status.advisor === true;
      if (featureArg) {
        await this.session(featureArg);
        return 0;
      }
      for (;;) {
        const feature = await this.pickFeature();
        if (feature) await this.session(feature);
      }
    } catch (e) {
      if (e instanceof Stop) return 0;
      throw e;
    } finally {
      await this.closeOpen();
    }
  }

  private say(text: string): void {
    this.io.write(text + "\n");
  }

  private show(r: Obj): void {
    if (typeof r.display === "string") this.say("\n" + render(r.display, this.marker));
  }

  private async closeOpen(): Promise<void> {
    const feature = this.feature;
    if (!feature) return;
    this.feature = null;
    const r = await this.run("close", { feature });
    if (r.ok !== true) this.say("The session couldn't be closed; the engine frees it after 30 minutes without a call.");
  }

  private async line(prompt: string): Promise<string> {
    const l = await this.io.line(prompt);
    if (l === null) throw new Stop();
    return l;
  }

  /**
   * A numbered menu. A pick needs Enter (SR-7); anything else is asked again,
   * unless `free` takes non-numeric text as the start of a typed answer.
   */
  private async choose(choices: Choice[], free = false): Promise<{ key: string } | { text: string }> {
    choices.forEach((c, i) => this.say(`  ${i + 1}. ${c.label}`));
    for (;;) {
      const l = await this.line(free ? "Pick a number, or type your answer: " : "Pick a number: ");
      const t = l.trim();
      if (/^\d+$/.test(t)) {
        const n = Number(t);
        if (n >= 1 && n <= choices.length) return { key: choices[n - 1]!.key };
        this.say(`There is no choice ${t}.`);
        continue;
      }
      if (free && t) return { text: await this.text(l) };
      this.say(`Type a number from 1 to ${choices.length}, then press Enter.`);
    }
  }

  /** Typed text over several lines; Enter on an empty line ends it (FR-6, OQ-2). */
  private async text(first?: string): Promise<string> {
    if (first === undefined) this.say("(Enter on an empty line finishes.)");
    const lines: string[] = first === undefined ? [] : [first];
    for (;;) {
      const l = await this.line(lines.length ? "... " : "> ");
      if (l === "") {
        if (lines.length) break;
        return "";
      }
      lines.push(l);
    }
    return lines.join("\n");
  }

  private async pickFeature(): Promise<string | null> {
    this.say("\nWhat would you like to do?");
    const c = await this.choose([
      { label: "Request a new feature", key: "new" },
      { label: "Detail an existing feature request", key: "existing" },
      { label: "Cancel a feature", key: "cancel" },
      { label: "Stop", key: "stop" },
    ]);
    if (!("key" in c) || c.key === "stop") throw new Stop();
    if (c.key === "cancel") {
      await this.cancelFeature();
      return null;
    }
    return c.key === "new" ? this.newFeature() : this.existing();
  }

  private async newFeature(): Promise<string | null> {
    const c = await this.choose([
      { label: "Describe it", key: "describe" },
      { label: "Start from a document", key: "document" },
      { label: "Back", key: "back" },
    ]);
    if (!("key" in c) || c.key === "back") return null;
    const req: Obj = {};
    if (c.key === "describe") {
      this.say("Describe the feature.");
      req.request = await this.text();
    } else {
      this.say("The whole document goes to the project's config repo on GitHub and to the model provider, like your "
        + "interview answers. Don't use a document that holds secrets or data that mustn't go there. Only Markdown (.md) "
        + "and plain text (.txt) up to 256 KiB are accepted.");
      const p = (await this.line("The document's path: ")).trim();
      if (!p) return null;
      this.say("A one-line title or note for the request.");
      req.request = await this.text();
      this.say("What is the document?");
      const prov = await this.choose([
        { label: "My requirements: its statements count as my answers; I confirm the list at the end", key: "owner" },
        { label: "Reference material: written by someone else, or not yet agreed; every requirement is asked as a question", key: "reference" },
      ]);
      if (!("key" in prov)) return null;
      req.document = { path: p, provenance: prov.key };
    }
    if (!(req.request as string).trim()) {
      this.say("Nothing was typed, so nothing was sent.");
      return null;
    }
    // F-015 FR-26: the feature's PR then closes the issue when it merges.
    for (;;) {
      const issue = (await this.line("The issue it comes from, as owner/repo#number (Enter if none): ")).trim();
      if (!issue) break;
      if (parseSourceIssue(issue)) {
        req.issue = issue;
        break;
      }
      this.say("That isn't owner/repo#number, for example example-org/acme-web#25.");
    }
    const r = await this.run("start", req);
    if (r.ok !== true) {
      this.show(r);
      return null;
    }
    this.say(`Started ${String(r.feature)}.`);
    return r.feature as string;
  }

  /**
   * F-015 FR-27: the owner picks a feature that isn't finished, gives an
   * optional reason, and confirms once by typing yes; nothing is sent before.
   */
  private async cancelFeature(): Promise<void> {
    const st = await this.run("status", {});
    if (st.ok !== true) return this.show(st);
    const activities = (st.activities ?? {}) as Record<string, string>;
    const ids = ((st.features ?? []) as string[]).filter((id) => activities[id] !== "closed" && activities[id] !== "cancelled");
    if (!ids.length) {
      this.say("No feature can be cancelled: every one is closed or cancelled already.");
      return;
    }
    this.say("\nWhich feature should be cancelled?");
    const c = await this.choose([...ids.map((id) => ({ label: `${id}: ${ACTIVITY[activities[id] ?? ""] ?? "status unknown"}`, key: id })), { label: "Back", key: "" }]);
    if (!("key" in c) || !c.key) return;
    this.say("Why? It goes on the record and, if there is one, on the pull request. Enter on its own gives no reason.");
    const reason = (await this.text()).trim();
    const sure = await this.line(`Cancel ${c.key}? Its agents stop, its open items and pull request close, and it can't be resumed. Its branches are kept. Type yes to cancel: `);
    if (sure?.trim().toLowerCase() !== "yes") {
      this.say("Not cancelled.");
      return;
    }
    const r = await this.run("cancel", { feature: c.key, ...(reason ? { reason } : {}) });
    if (r.ok !== true) return this.show(r);
    this.say(`${c.key} is cancelled.`);
  }

  private async existing(): Promise<string | null> {
    const r = await this.run("list", {});
    this.show(r);
    if (r.ok !== true) return null;
    const ids = (r.features as Array<{ id: string }>).map((f) => f.id);
    if (!ids.length) return null;
    this.say("\nWhich feature?");
    const c = await this.choose([...ids.map((id) => ({ label: id, key: id })), { label: "Back", key: "" }]);
    return "key" in c && c.key ? c.key : null;
  }

  /** Opens the feature, gets any GitHub approval, then runs items until the owner stops or nothing is left. */
  private async session(feature: string): Promise<void> {
    if (!(await this.open(feature))) return;
    let r = await this.run("next", { feature, wait_s: WAIT_S });
    for (;;) {
      const nxt = await this.handle(feature, r);
      if (nxt === null) {
        await this.closeOpen();
        return;
      }
      r = nxt;
    }
  }

  private async open(feature: string): Promise<boolean> {
    let r = await this.run("open", { feature });
    if (r.ok !== true && (r.error as Obj | undefined)?.name === "busy") {
      this.show(r);
      const c = await this.choose([{ label: "Take over that session (it ends the other one)", key: "take" }, { label: "Leave it", key: "leave" }]);
      if (!("key" in c) || c.key !== "take") return false;
      r = await this.run("open", { feature, takeover: true });
    }
    if (r.ok !== true) {
      this.show(r);
      return false;
    }
    this.feature = feature;
    if (r.advisor !== undefined) this.advisor = r.advisor === true;
    if (typeof r.approval_display === "string") {
      this.say("\n" + render(r.approval_display, this.marker));
      for (;;) {
        this.say("Waiting for your approval on GitHub...");
        const a = await this.run("approval", { feature, wait_s: APPROVAL_WAIT_S });
        if (a.ok === true && a.approved === true) break;
        if (a.ok !== true && (a.error as Obj | undefined)?.name === "approval_pending") continue;
        this.show(a);
        this.feature = null;
        return false;
      }
      this.say("Approved.");
    }
    return true;
  }

  /**
   * Shows one result of `next` or `reply` and gets the owner's reply to its
   * item. Returns the next result to show, or null when the session is over.
   */
  private async handle(feature: string, r: Obj): Promise<Obj | null> {
    if (r.ok !== true) return this.failed(feature, r);
    this.reconnected = false;
    const item = (r.item ?? r.next ?? null) as Item | null;
    if (this.answerOnly && (item === null || item.status === "researching" || r.waiting === true)) {
      if (r.interview_done !== true) this.say(`\nNothing more is waiting for you on ${feature}; back to watching the factory.`);
      return null;
    }
    // Security and Testability Review and the readiness check can still send the feature back with new questions.
    if (item === null && typeof r.stage === "string" && WAIT_STAGES.has(r.stage)) return this.waitForItem(feature);
    this.show(r);
    if (r.advice_running === true) this.say("The advisor is still working on this question. You can reply now, or check for its advice.");
    if (item === null) {
      if (r.interview_done === true) return null;
      if (r.waiting === true) return this.waitOrDefer(feature, null);
      return this.waitForItem(feature);
    }
    if (item.status === "researching" || r.waiting === true) return this.waitOrDefer(feature, item);
    const reply = await this.ask(item, r.advice_running === true);
    if (reply === "stop") return null;
    if (reply === "check") return this.run("next", { feature, wait_s: WAIT_S });
    return this.send(feature, item, reply.kind, reply.text);
  }

  private async waitOrDefer(feature: string, item: Item | null): Promise<Obj | null> {
    this.say("The analyst is still researching.");
    const choices: Choice[] = [{ label: "Keep waiting", key: "wait" }];
    if (item) choices.push({ label: "Defer the question", key: "defer" });
    choices.push({ label: "Stop for now", key: "stop" });
    const c = await this.choose(choices);
    if (!("key" in c) || c.key === "stop") return null;
    if (c.key === "defer" && item) return this.send(feature, item, "defer", "Defer");
    return this.waitForItem(feature);
  }

  /**
   * Waits for the next item, printing each change of the feature's activity
   * with the time and a spinner on the current one (FR-14). Returns the item's
   * `next` result, or null when the interview is over or the owner stops.
   */
  private async waitForItem(feature: string): Promise<Obj | null> {
    let since = this.timing.now();
    let shown: string | null = null;
    let asked = 0;
    let stop: (() => void) | undefined;
    const clear = () => {
      stop?.();
      stop = undefined;
    };
    try {
      for (;;) {
        if (this.io.aborted?.()) throw new Stop();
        let st = await this.runner("status", {});
        if (engineAway(st)) {
          clear();
          shown = null;
          st = await this.reconnect(false, st);
        }
        if (st.ok !== true) {
          clear();
          this.show(st);
          return null;
        }
        const stage = (st.stages as Record<string, string> | undefined)?.[feature];
        if (stage !== undefined && !WAIT_STAGES.has(stage)) {
          clear();
          this.say(`The interview for ${feature} is finished: the feature has moved on to the ${stage} stage.`);
          return null;
        }
        const code = (st.activities as Record<string, string> | undefined)?.[feature] ?? "";
        const decisions = (st.waiting_on as Record<string, string[]> | undefined)?.[feature] ?? [];
        // F-021 FR-11: the feature waits on the owner's decision, so it is offered here, once per set of items.
        if (decisions.length && decisions.join() !== this.offered) {
          clear();
          shown = null;
          this.offered = decisions.join();
          this.say(`\nThe factory needs your decision on ${decisions.join(", ")}.`);
          const c = await this.choose([{ label: "Answer it here", key: "answer" }, { label: "Not now (it stays open on GitHub and in factory-engine inbox)", key: "later" }]);
          if ("key" in c && c.key === "answer") {
            for (const id of decisions) if (!(await this.answerItem(feature, id))) break;
          }
          continue;
        }
        // F-021 FR-12: the ids come from the operations' checked list, never from engine text.
        const label = code === "waiting_for_decision" && decisions.length
          ? `${ACTIVITY[code]} on ${decisions.join(", ")}`
          : ACTIVITY[code] ?? "Working";
        const now = this.timing.now();
        const changed = label !== shown;
        if (changed) {
          clear();
          this.say(`[${new Date(now).toTimeString().slice(0, 8)}] ${label}`);
          stop = this.io.busy?.(label, 0);
          shown = label;
        }
        if (changed || now - asked >= NEXT_EVERY_MS) {
          asked = now;
          const n = await this.runner("next", { feature });
          // A dropped read loses nothing: the next poll reads the status again, with its own retries.
          if (n.ok !== true && CHANNEL_HICCUPS.has(String((n.error as Obj | undefined)?.code))) {
            asked = 0;
            await this.timing.sleep(STATUS_RETRY_MS);
            continue;
          }
          if (n.ok !== true || (n.item ?? null) !== null) {
            clear();
            return n;
          }
        }
        if (now - since >= ASK_AFTER_MS) {
          clear();
          this.say("Still waiting after 30 minutes.");
          const c = await this.choose([{ label: "Keep waiting", key: "wait" }, { label: "Stop for now", key: "stop" }]);
          if (!("key" in c) || c.key === "stop") return null;
          since = this.timing.now();
          shown = null;
        }
        await this.timing.sleep(POLL_MS);
      }
    } finally {
      clear();
    }
  }

  /** The item's choices; its display was printed just before (FR-4). */
  private async ask(item: Item, adviceRunning: boolean): Promise<{ kind: string; text: string } | "stop" | "check"> {
    for (;;) {
      if (item.kind === "question") {
        const answers = answerChoices(item);
        const choices: Choice[] = answers.map((a, i) => ({ label: a.recommended ? `${a.text} (recommended)` : a.text, key: `answer:${i}` }));
        choices.push({ label: "Type my own answer", key: "own" }, { label: "More information", key: "more" }, { label: "Defer", key: "defer" });
        if (this.advisor) choices.push({ label: "Ask the advisor", key: "advisor" });
        if (adviceRunning) choices.push({ label: "Check for the advisor's advice", key: "check" });
        choices.push({ label: "Stop for now", key: "stop" });
        this.say("\nYour answer:");
        const c = await this.choose(choices, true);
        if ("text" in c) return { kind: "answer", text: c.text };
        if (c.key.startsWith("answer:")) {
          const picked = answers[Number(c.key.slice(7))]!.text;
          if (!OPEN_OPTION_RE.test(picked.trim())) return { kind: "answer", text: picked };
          // An option like "Something else" means nothing without the owner's own words.
          this.say("Type what you have in mind.");
          const t = await this.text();
          if (t.trim()) return { kind: "answer", text: `${picked.trim()}: ${t}` };
          this.say("Nothing was typed, so nothing was sent.");
          continue;
        }
        if (c.key === "own") {
          this.say("Type your answer.");
          const t = await this.text();
          if (t.trim()) return { kind: "answer", text: t };
          this.say("Nothing was typed, so nothing was sent.");
        } else if (c.key === "more") {
          this.say("What should the analyst look into? Enter on its own means nothing specific.");
          const t = await this.text();
          return { kind: "more_info", text: t.trim() ? t : "Nothing specific" };
        } else if (c.key === "defer") return { kind: "defer", text: "Defer" };
        else if (c.key === "advisor") return { kind: "ask_advisor", text: "Ask the advisor" };
        else if (c.key === "check") return "check";
        else return "stop";
        continue;
      }
      if (item.kind === "assumption") return this.fixed([["Approve", "approve_assumption"], ["Reject", "reject_assumption"]]);
      if (item.kind === "advisor_proposal") return this.fixed([["Approve the advisor call", "approve_advisor"], ["Decline", "decline_advisor"]]);
      if (item.kind === "source_confirmation") {
        const c = await this.choose([{ label: "Confirm the list", key: "confirm" }, { label: "Reopen some lines", key: "reopen" }, { label: "Stop for now", key: "stop" }]);
        if (!("key" in c) || c.key === "stop") return "stop";
        if (c.key === "confirm") return { kind: "confirm_sources", text: "Confirm the list" };
        this.say("Which spec refs should the analyst ask about?");
        const t = await this.text();
        if (t.trim()) return { kind: "reopen_sources", text: t };
        this.say("Nothing was typed, so nothing was sent.");
        continue;
      }
      this.say("This item's kind isn't known to this command, so it can't be answered here.");
      return "stop";
    }
  }

  // ---- F-021: inbox items in the console ----

  /** `factory-engine inbox [<item id>]`. Exit code as FR-11 of F-018 (F-021 FR-14). */
  async inboxMain(itemArg?: string): Promise<number> {
    try {
      // The owner's rule (2026-11-27): the inbox never gives up on a refusal or failure; it says why and tries again.
      let wait = RECONNECT_FIRST_MS;
      for (;;) {
        const status = await this.connect();
        if (status.ok === true && (await this.openConsole())) break;
        if (status.ok !== true) this.show(status);
        wait = await this.retryWait(wait, "The console couldn't be opened.");
      }
      if (itemArg) {
        await this.answerItem(CONSOLE_KEY, itemArg);
        return 0;
      }
      wait = RECONNECT_FIRST_MS;
      for (;;) {
        const r = await this.inboxItems((op, req) => this.run(op, req));
        if (r.ok !== true) {
          if (r.error) this.show(r);
          wait = await this.retryWait(wait, "The open items couldn't be read.");
          if (!this.consoleOpen) await this.openConsole();
          continue;
        }
        wait = RECONNECT_FIRST_MS;
        const items = r.items as Array<{ id: string; kind: string; title: string; feature?: string; priority: string; blocking: boolean }>;
        if (!items.length) {
          const code = await this.watch();
          if (code !== null) return code;
          continue;
        }
        // F-021 FR-17: a feature waiting for the owner's answer is offered beside open items too, or it could wait unseen behind them.
        const st = await this.run("status", {});
        const asking = st.ok === true ? waitingForAnswer(st) : [];
        // F-021 FR-18: a held project's console lists only the hold item; say why, once per hold.
        const held = typeof st.held === "string" ? st.held : "";
        if (held && held !== this.heldShown) {
          this.say(`\n[${this.clock()}] This project is on hold: ${held}. Answer ${items.map((i) => i.id).join(", ")} to confirm the change, or press Ctrl+C and run \`factory-engine confirm --project ${this.projectArg}\`.`);
        }
        this.heldShown = held;
        this.say("\nOpen items:");
        const c = await this.choose([
          ...items.map((i) => ({ key: i.id, label: `${i.id} ${i.kind}${i.feature ? ` for ${i.feature}` : ""}, ${i.priority}${i.blocking ? ", blocking" : ""}: ${i.title}` })),
          ...asking.map((id) => ({ key: `ask:${id}`, label: `${id}: a question is waiting for you` })),
          { label: "Cancel a feature", key: "cancel" },
          { label: "Stop", key: "" },
        ]);
        if (!("key" in c) || !c.key) return 0;
        if (c.key === "cancel") await this.cancelFeature();
        else if (c.key.startsWith("ask:")) {
          this.answerOnly = true;
          try {
            await this.session(c.key.slice(4));
          } finally {
            this.answerOnly = false;
          }
        } else await this.answerItem(CONSOLE_KEY, c.key);
      }
    } catch (e) {
      if (e instanceof Stop) return 0;
      throw e;
    } finally {
      if (this.consoleOpen) {
        this.consoleOpen = false;
        const r = await this.run("close", { feature: CONSOLE_KEY });
        if (r.ok !== true) this.say("The session couldn't be closed; the engine ends it after 30 minutes without a call.");
      }
    }
  }

  /**
   * F-021 v7 FR-2: with nothing open the console stays, printing the
   * factory's status when it changes, until an item opens (null) or the
   * owner stops. Its inbox calls keep the console session alive.
   */
  private async watch(): Promise<number | null> {
    this.say("Nothing in this project's inbox is waiting for you. Watching the factory; press Ctrl+C to stop.");
    let shown = "";
    let failWait = RECONNECT_FIRST_MS;
    for (;;) {
      if (this.io.aborted?.()) throw new Stop();
      let st = await this.runner("status", {});
      if (engineAway(st)) {
        st = await this.reconnect(false, st);
        // The status is printed again, so the owner sees where the restarted factory stands.
        shown = "";
      }
      if (st.ok !== true) {
        this.show(st);
        failWait = await this.retryWait(failWait, "The factory's status couldn't be read.");
        continue;
      }
      failWait = RECONNECT_FIRST_MS;
      this.io.status?.(st);
      const text = statusLines(st).join("\n");
      // F-024: the windowed console shows the status in its own window.
      if (text !== shown && !this.io.windowed) {
        this.say(`\n[${new Date(this.timing.now()).toTimeString().slice(0, 8)}]\n${text}`);
        shown = text;
      }
      // F-021 FR-17: a feature waiting for the owner's answer is offered here, once until it stops waiting.
      const asking = waitingForAnswer(st);
      for (const id of [...this.putOff]) if (!asking.includes(id)) this.putOff.delete(id);
      const ask = asking.find((id) => !this.putOff.has(id));
      if (ask) {
        this.say(`\n${ask} has a question waiting for you.`);
        const c = await this.choose([{ label: "Answer it here", key: "answer" }, { label: "Not now", key: "later" }]);
        if ("key" in c && c.key === "answer") {
          this.answerOnly = true;
          try {
            await this.session(ask);
          } finally {
            this.answerOnly = false;
          }
          shown = "";
        } else this.putOff.add(ask);
        continue;
      }
      const r = await this.inboxItems(this.runner);
      // The inbox's own loop shows the failure and waits before it tries again.
      if (r.ok !== true) return null;
      if (Array.isArray(r.items) && r.items.length) {
        this.say("\nAn item is waiting for you.");
        return null;
      }
      await this.timing.sleep(WATCH_MS);
    }
  }

  /**
   * The open items. An engine that went away is waited for, and a console
   * session the restarted engine doesn't know is opened again, once per call
   * (F-021 FR-16).
   */
  private async inboxItems(call: Runner): Promise<Obj> {
    let reopened = false;
    for (;;) {
      const r = await call("inbox_list", { feature: CONSOLE_KEY });
      if (r.ok === true) return r;
      const err = errorOf(r);
      if (engineAway(r)) {
        const st = await this.reconnect(false, r);
        if (st.ok !== true) return st;
        continue;
      }
      if (reopened || (err.name !== "session_expired" && err.code !== "not_open")) return r;
      reopened = true;
      this.consoleOpen = false;
      // openConsole has shown why it failed.
      if (!(await this.openConsole())) return { ok: false };
    }
  }

  /**
   * The first status read. An engine that isn't running yet is waited for,
   * as after a restart (F-021 FR-16).
   */
  private async connect(): Promise<Obj> {
    const st = await this.run("status", {});
    return engineAway(st) ? this.reconnect(true) : st;
  }

  /**
   * F-021 FR-16: waits for the engine to come back, counting down to each
   * attempt on one redrawn line; the wait doubles from 1 s up to 60 s, with
   * no limit on attempts. Returns the status once `engine.status` answers,
   * or the failure when it is something other than the engine being away.
   */
  private async reconnect(starting = false, failure?: Obj): Promise<Obj> {
    this.say(starting
      ? `\n[${this.clock()}] The engine isn't running. Waiting for it to start; press Ctrl+C to stop.`
      : `\n[${this.clock()}] Lost the connection to the engine${awayReason(failure)}. Reconnecting until it is back; press Ctrl+C to stop.`);
    // A project restarting inside the factory is back within a second or two, so only one that stays away is called stopped.
    let toldStopped = false;
    const tellStopped = async () => {
      const pid = await this.factoryRunning?.().catch(() => undefined);
      if (pid === undefined) return;
      toldStopped = true;
      this.say(`[${this.clock()}] The factory is running${pid !== null ? ` (pid ${pid})` : ""} but isn't serving this project, so the project is stopped. The factory's window says why. ` +
        "If it found a change to the project's pinned keys (such as mcp_servers), answer its Security item on GitHub, or press Ctrl+C and run " +
        `\`factory-engine confirm --project ${this.projectArg}\`. Waiting for the project to come back; press Ctrl+C to stop.`);
    };
    let wait = RECONNECT_FIRST_MS;
    let st: Obj;
    try {
      for (let attempt = 1; ; attempt++) {
        for (let left = wait; left > 0; left -= 1000) {
          if (this.io.aborted?.()) throw new Stop();
          const text = `Reconnecting in ${Math.ceil(left / 1000)}s (attempt ${attempt})`;
          if (this.io.redraw) this.io.redraw(text);
          else if (left === wait) this.say(text);
          await this.timing.sleep(Math.min(1000, left));
        }
        this.io.redraw?.(`Reconnecting (attempt ${attempt})`);
        st = await this.runner("status", {});
        if (!engineAway(st)) break;
        if (attempt >= 2 && !toldStopped) await tellStopped();
        wait = Math.min(wait * 2, RECONNECT_MAX_MS);
      }
    } finally {
      this.io.redraw?.("");
    }
    if (st.ok === true) {
      this.reconnected = true;
      this.io.status?.(st);
      this.say(`[${this.clock()}] ${starting ? "Connected" : "Reconnected"} to the engine.`);
    }
    return st;
  }

  /**
   * Waits `wait` ms, counting down on one redrawn line, before the inbox tries
   * again after a refusal or failure; returns the next, doubled wait (to 60 s).
   */
  private async retryWait(wait: number, why: string): Promise<number> {
    this.say(`\n[${this.clock()}] ${why} Trying again until it works; press Ctrl+C to stop.`);
    try {
      for (let left = wait; left > 0; left -= 1000) {
        if (this.io.aborted?.()) throw new Stop();
        const text = `Trying again in ${Math.ceil(left / 1000)}s`;
        if (this.io.redraw) this.io.redraw(text);
        else if (left === wait) this.say(text);
        await this.timing.sleep(Math.min(1000, left));
      }
    } finally {
      this.io.redraw?.("");
    }
    return Math.min(wait * 2, RECONNECT_MAX_MS);
  }

  private clock(): string {
    return new Date(this.timing.now()).toTimeString().slice(0, 8);
  }

  private async openConsole(): Promise<boolean> {
    const r = await this.run("inbox_open", {});
    if (r.ok !== true) {
      this.show(r);
      return false;
    }
    this.consoleOpen = true;
    if (typeof r.approval_display === "string") {
      this.say("\n" + render(r.approval_display, this.marker));
      for (;;) {
        this.say("Waiting for your approval on GitHub...");
        const a = await this.run("approval", { feature: CONSOLE_KEY, wait_s: APPROVAL_WAIT_S });
        if (a.ok === true && a.approved === true) break;
        if (a.ok !== true && (a.error as Obj | undefined)?.name === "approval_pending") continue;
        this.show(a);
        return false;
      }
      this.say("Approved.");
    }
    return true;
  }

  /**
   * F-021 FR-3 to FR-8: one item printed whole, then its actions; the
   * owner's pick, its note, and for a risky action the engine's code. `key`
   * is the session the calls go under: the console's, or the interview's
   * feature (FR-11). Returns false when the owner wants to stop.
   */
  private async answerItem(key: string, id: string): Promise<boolean> {
    if (!INBOX_ID.test(id)) {
      this.say(`${id} isn't an inbox item id (like D-0007).`);
      return true;
    }
    for (;;) {
      const s = await this.run("inbox_show", { feature: key, item: id });
      if (s.ok !== true) {
        this.show(s);
        return true;
      }
      // FR-3: the whole item, then its actions; never a pick for an item not just printed.
      this.show(s);
      const actions = s.actions as Array<{ action: string; label: string }>;
      this.say("\nYour answer:");
      const c = await this.choose([...actions.map((a) => ({ label: a.label, key: a.action })), { label: "Back, without answering", key: "" }, { label: "Stop", key: "stop" }]);
      if (!("key" in c) || c.key === "stop") return false;
      if (!c.key) return true;
      const req: Obj = { feature: key, item: id, rev: s.rev, action: c.key };
      if (c.key === "changes" || c.key === "research") {
        this.say(c.key === "changes" ? "What should change?" : "What should be researched?");
        const note = await this.text();
        if (!note.trim()) {
          this.say("Nothing was typed, so nothing was sent.");
          continue;
        }
        req.note = note;
      } else if (c.key.startsWith("choose:") && /\bsend it to (the [a-z ]+)/i.test(actions.find((a) => a.action === c.key)?.label ?? "")) {
        // F-015 FR-21: the role works from the owner's note when there is one.
        const role = /\bsend it to (the [a-z]+(?: [a-z]+)?)/i.exec(actions.find((a) => a.action === c.key)!.label)![1]!.replace(/ to$/, "");
        this.say(`Add a note for ${role} (press Enter for none):`);
        const note = (await this.text()).trim();
        if (note) req.note = note;
      }
      let r = await this.run("inbox_answer", req);
      while (r.ok !== true && typeof r.reply_id === "string") {
        // A lost answer is never resent on its own (as F-018 FR-7); a resend carries the same reply id.
        this.show(r);
        this.say("The answer may already be recorded.");
        const again = await this.choose([{ label: "Send it again", key: "again" }, { label: "Don't send it", key: "no" }]);
        if (!("key" in again) || again.key !== "again") return true;
        r = await this.run("inbox_answer", { ...req, reply_id: r.reply_id });
      }
      if (r.ok !== true) {
        this.show(r);
        return true;
      }
      if (r.outcome === "changed") {
        this.show(r);
        continue;
      }
      if (r.outcome === "confirm") return this.confirmItem(key, id, s.rev as number, r);
      this.show(r);
      if (typeof r.action_display === "string") this.say(render(r.action_display, this.marker));
      return true;
    }
  }

  /** FR-6, SR-2: the confirm words are the engine's (marked); the code and the prompt are the command's own. */
  private async confirmItem(key: string, id: string, rev: number, r: Obj): Promise<boolean> {
    this.show(r);
    this.say(`To confirm, type the code ${String(r.code)} and press Enter. It is good until ${String(r.expires_at)}; anything else cancels.`);
    const typed = (await this.line("Code: ")).trim().toUpperCase().slice(0, 16);
    const c = await this.run("inbox_confirm", { feature: key, item: id, rev, code: typed || "-" });
    this.show(c);
    return true;
  }

  /** A choice whose label is the reply text, as the engine records it. */
  private async fixed(pairs: Array<[string, string]>): Promise<{ kind: string; text: string } | "stop"> {
    const c = await this.choose([...pairs.map(([label, kind]) => ({ label, key: kind })), { label: "Stop for now", key: "stop" }]);
    if (!("key" in c) || c.key === "stop") return "stop";
    return { kind: c.key, text: pairs.find(([, k]) => k === c.key)![0] };
  }

  private send(feature: string, item: Item, kind: string, text: string, replyId?: string): Promise<Obj> {
    this.lastSent = { item, kind, text };
    const req: Obj = { feature, item: item.id, revision: item.revision, status: item.status, kind, text, wait_s: WAIT_S };
    if (replyId) req.reply_id = replyId;
    return this.run("reply", req);
  }

  /** A failed `next` or `reply`. */
  private async failed(feature: string, r: Obj): Promise<Obj | null> {
    const err = (r.error ?? {}) as Obj;
    if (engineAway(r)) {
      // F-021 FR-16: wait for the engine, then carry on; a reply that may be lost is still the owner's to resend.
      const st = await this.reconnect(false, r);
      if (st.ok !== true) {
        this.show(st);
        return null;
      }
      if (typeof r.reply_id === "string") return this.lostReply(feature, r);
      return this.run("next", { feature, wait_s: WAIT_S });
    }
    if (err.name === "session_expired" || err.code === "not_open") {
      this.feature = null;
      // A restarted engine knows no session: open the feature again without asking (F-021 FR-16).
      if (this.reconnected) {
        this.reconnected = false;
        if (!(await this.open(feature))) return null;
        return this.run("next", { feature, wait_s: WAIT_S });
      }
    }
    this.show(r);
    switch (err.name) {
      case "stale":
        return this.run("next", { feature, wait_s: WAIT_S });
      case "session_expired": {
        const c = await this.choose([{ label: "Open the feature again", key: "open" }, { label: "Stop for now", key: "stop" }]);
        if (!("key" in c) || c.key === "stop" || !(await this.open(feature))) return null;
        return this.run("next", { feature, wait_s: WAIT_S });
      }
      case "kind_not_allowed":
        return this.run("next", { feature, wait_s: WAIT_S });
    }
    if (err.code === "advisor_unsupported") {
      this.advisor = false;
      return this.run("next", { feature, wait_s: WAIT_S });
    }
    if (typeof r.reply_id === "string") return this.lostReply(feature, r);
    return null;
  }

  /**
   * A reply that may or may not have been recorded (F-005 FR-13). Nothing is
   * resent unless the owner says so, and a resend carries the same reply id.
   */
  private async lostReply(feature: string, r: Obj): Promise<Obj | null> {
    const pending = this.lastSent;
    if (!pending) return null;
    this.say("The reply may already be recorded.");
    if (pending.kind === "ask_advisor") {
      const before = pending.item.advice?.length ?? 0;
      const n = await this.run("next", { feature });
      const it = (n.item ?? null) as Item | null;
      if (n.ok === true && it?.id === pending.item.id && (it.advice?.length ?? 0) > before) {
        this.say("It went through: the question now shows a new advisor call.");
        return n;
      }
      this.say("It can't be told whether the request to the advisor was sent.");
    } else {
      const st = await this.run("state", { feature, item: pending.item.id });
      if (st.ok === true) this.say(`The item is now ${String(st.status)}, revision ${String(st.revision)}.`);
      else this.show(st);
    }
    const c = await this.choose([{ label: "Send it again", key: "again" }, { label: "Don't send it", key: "no" }]);
    if (!("key" in c) || c.key !== "again") return this.run("next", { feature, wait_s: WAIT_S });
    const again = await this.send(feature, pending.item, pending.kind, pending.text, r.reply_id as string);
    if (again.ok === true && again.already_recorded === true) {
      this.say("It had been recorded; nothing was sent again.");
      return this.run("next", { feature, wait_s: WAIT_S });
    }
    return again;
  }
}
