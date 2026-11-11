import { EventEmitter } from "node:events";
import { Clock, iso } from "../clock";
import { INTERVIEW_STAGE } from "../constants";
import { Logger } from "../log";
import type { EngineRecord } from "../state/record";
import type { Change } from "../state/state-repo";
import { Entry, EntryBody, makeEntry, serialize } from "../state/transcript";
import { FramedReply, frameTurn } from "./frame";
import {
  ADVISOR_REPLIES, ASSUMPTION_REPLIES, InterviewState, Item, ItemContent, ItemKind, QUESTION_REPLIES, REPLY_STATUS,
  REPLYABLE, ReplyKind, WireItem, wire,
} from "./model";

/** Commits the feature's whole transcript text, plus any other state files, as one commit. */
export type Persist = (feature: string, transcript: string, extra: Change[], message: string) => Promise<string>;

export class InterviewError extends Error {
  constructor(readonly code: "stale" | "unknown" | "kind" | "tampered", message: string) {
    super(message);
    this.name = "InterviewError";
  }
}

export interface ReplyParams {
  item: string;
  revision: number;
  reply_id: string;
  kind: string;
  text: string;
}

export interface ReplyResult {
  status: string;
  next?: WireItem | null;
}

/**
 * One feature's interview. Every change is an entry appended to the
 * transcript and committed before it takes effect, so what the engine says
 * happened is exactly what the transcript records (FR-11, channel v1.1:
 * only the engine writes it, append-only).
 */
export class FeatureInterview {
  readonly state = new InterviewState();
  readonly changed = new EventEmitter();
  /** False once the transcript holds entries the engine didn't write (SR-17). */
  chainIntact = true;
  paused = false;
  private entries: Entry[] = [];
  private readonly firstResults = new Map<string, ReplyResult>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly chainKey: string,
    private readonly deps: { persist: Persist; record: EngineRecord; clock: Clock; log: Logger },
  ) {
    this.changed.setMaxListeners(0);
  }

  load(entries: Entry[], intact: boolean): void {
    this.entries = entries;
    this.chainIntact = intact;
    for (const e of entries) this.state.apply(e);
  }

  get length(): number {
    return this.entries.length;
  }

  /** Runs `f` alone: checks and the append they lead to can't interleave with another change. */
  exclusive<T>(f: () => Promise<T>): Promise<T> {
    const run = this.lock.then(f);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Appends entries; the state changes only once the commit has landed. Call inside exclusive(). */
  async append(bodies: EntryBody[], message: string, extra: Change[] = []): Promise<Entry[]> {
    if (!this.chainIntact) throw new InterviewError("tampered", "This feature's transcript was changed outside the engine; see the Security item.");
    const at = iso(this.deps.clock.now());
    const added: Entry[] = [];
    let prev = this.entries[this.entries.length - 1] ?? null;
    for (const b of bodies) {
      prev = makeEntry(prev, b, at);
      added.push(prev);
    }
    const all = [...this.entries, ...added];
    const last = all[all.length - 1]!;
    this.deps.record.setPending(this.chainKey, { seq: last.seq, head: last.hash });
    let commit: string;
    try {
      commit = await this.deps.persist(this.id, serialize(all), extra, `${this.id}: ${message}`);
    } catch (e) {
      this.deps.record.setPending(this.chainKey, null);
      throw e;
    }
    this.entries = all;
    this.deps.record.setChain(this.chainKey, { seq: last.seq, head: last.hash });
    for (const e of added) this.state.apply(e);
    this.changed.emit("change", commit);
    return added;
  }

  // -- analyst side (Interview tools v1.0) ----------------------------------------

  openQuestion(): Item | undefined {
    return this.state.list("question").find((q) => q.status === "open");
  }

  async create(kind: ItemKind, c: ItemContent): Promise<WireItem> {
    const id = this.state.nextId(kind);
    await this.append([{ type: "item_created", item: { id, kind, ...c } }], `${kind} ${id}`);
    return wire(this.state.items.get(id)!);
  }

  async revise(id: string, c: ItemContent): Promise<number> {
    const item = this.state.items.get(id)!;
    const revision = item.revision + 1;
    await this.append([{ type: "item_revised", item: id, revision, ...c }], `revise ${id}`);
    this.changed.emit("itemReady", id);
    return revision;
  }

  // -- owner side (channel v1.1) --------------------------------------------------

  /** Deferred items first, each once per session (`shown`), then open items. */
  pick(shown: Set<string>): Item | null {
    for (const it of this.state.list()) {
      if (it.status === "deferred" && !shown.has(it.id)) {
        shown.add(it.id);
        return it;
      }
    }
    return this.state.list().find((it) => it.status === "open") ?? null;
  }

  researching(): Item | null {
    return this.state.list().find((it) => it.status === "researching") ?? null;
  }

  reply(p: ReplyParams, shown: Set<string>): Promise<ReplyResult> {
    return this.exclusive(async () => {
      const first = this.firstResults.get(p.reply_id);
      if (first) return first;
      const earlier = this.state.replies.get(p.reply_id);
      if (earlier) return { status: earlier.status, next: null };
      const item = this.state.items.get(p.item);
      if (!item) throw new InterviewError("unknown", "Unknown item.");
      if (p.revision !== item.revision || !REPLYABLE.includes(item.status)) {
        throw new InterviewError("stale", "The item has changed since it was shown.");
      }
      const allowed = item.kind === "question" ? QUESTION_REPLIES : ASSUMPTION_REPLIES;
      if (ADVISOR_REPLIES.includes(p.kind) || !allowed.includes(p.kind)) {
        throw new InterviewError("kind", "That reply kind isn't allowed for this item.");
      }
      const status = REPLY_STATUS[p.kind as ReplyKind];
      await this.append([{
        type: "reply", item: item.id, revision: item.revision, reply_id: p.reply_id, kind: p.kind, text: p.text, status,
      }], `reply to ${item.id}`);
      if (status === "deferred") shown.add(item.id);
      const next = this.pick(shown);
      const result: ReplyResult = { status, next: next ? wire(next) : null };
      this.firstResults.set(p.reply_id, result);
      return result;
    });
  }

  /**
   * The analyst's next-turn message: every reply not yet handed over, framed
   * (Interview tools v1.0), and recorded as delivered so a resumed run
   * doesn't send it twice. Null when there is nothing new.
   */
  takeTurn(): Promise<{ message: string; replies: string[] } | null> {
    return this.exclusive(async () => {
      const ids = [...this.state.undelivered];
      if (!ids.length) return null;
      const replies: FramedReply[] = ids.map((id) => {
        const r = this.state.replies.get(id)!;
        return { item: r.item, revision: r.revision, kind: r.kind, text: r.text };
      });
      const { message } = frameTurn(replies);
      await this.append([{ type: "delivered", replies: ids }], "replies handed to the analyst");
      return { message, replies: ids };
    });
  }

  stage(): string {
    return this.state.stage || INTERVIEW_STAGE;
  }
}
