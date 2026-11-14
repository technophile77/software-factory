import * as crypto from "node:crypto";
import YAML from "yaml";
import { Clock, iso } from "../clock";
import type { Logger } from "../log";
import type { StateRepo } from "../state/state-repo";
import { MAX_NOTE_CHARS, confirmCode, looksLikeCommand, parseCommand } from "./commands";
import { IssueComment, IssuesApi, WORKFLOW_LOGIN } from "./github-issues";
import {
  ActionId, History, ID_RE, InboxRecord, ItemInput, KEEPS_OPEN, KIND_PREFIX, PRIORITIES, Revision, SECTIONS, Status,
  actionsFor, bodyPath, currentRevision, isRisky, recordPath,
} from "./model";
import { InboxLocal, PrivateDetail, MAX_PRIVATE_SECTION_CHARS } from "./local";
import {
  ACTION_MARKER_RE, ITEM_MARKER_RE, RefuseReason, actionComment, actionLabel, actionWords, engineText, normalBody, priorityLower,
  renderBody, renderLabels, renderTitle, sha256,
} from "./render";

export const CONFIRM_MS = 15 * 60 * 1000;
/** F-011 section 6: no issue after two polls is reported, not retried in a loop. */
const POLLS_BEFORE_MISSING = 2;

/** One owner action the engine recorded: what the effects of F-016 act on. */
export interface Recorded {
  id: string;
  record: InboxRecord;
  entry: History;
}

/** What polling needs; filing needs none of it, so items are recorded even while GitHub can't be reached. */
export interface InboxConnection {
  api: IssuesApi;
  /** `owner/name` of the config repo, from its origin. */
  repo: string;
  /** The pinned owner's GitHub user id: the only account whose actions count (F-011 SR-2). */
  ownerId: number;
}

export interface InboxOptions {
  state: StateRepo;
  clock: Clock;
  log: Logger;
  /** OS notification on the PC (F-011 FR-13, FR-15, section 6). */
  notify: (title: string, text: string) => void;
  random?: (n: number) => Buffer;
  /** F-021: the engine-folder store for private detail and console answer proofs. Without it, items carry no private detail and console answers are refused. */
  local?: InboxLocal;
  /** F-021 SR-5: replaces any secret the scan finds in private detail before it is stored. */
  scrub?: (text: string) => Promise<string>;
}

/** F-021 section 2 step 1: the fixed line an issue gets when its item has private detail. */
export const privateLine = (id: string) =>
  `More detail is on the PC that runs the factory: run \`factory-engine inbox ${id}\` there.`;

/** What a console answer came to (F-021 FR-5 to FR-7; Engine control channel v1.6 `inbox.answer`). */
export type ConsoleResult =
  | { recorded: Recorded }
  | { confirm: { words: string; code: string; expires_at: string } }
  | { already: { by: "github" | "console" | "engine"; action?: string } }
  | { changed: { rev: number } }
  | { refused: "unknown item" | "not allowed" | "no console" | "confirm failed" | "note too long" };

/**
 * The project's inbox on GitHub issues (F-011 H-0161). Filing writes the
 * record and the rendered body on factory/state, where the secrets scan runs
 * (F-011 SR-7); each poll then has the config repo's workflow open the issue
 * (FR-4), binds the issue and its action comments, and reads the owner's
 * reactions and commands (FR-5 to FR-8). Everything here is code: no agent
 * reads a comment or writes an issue (FR-20).
 */
const OPEN: ReadonlySet<string> = new Set(["open", "deferred"]);

export class Inbox {
  private privacy: { ok: boolean; reason: string } | null = null;
  private readonly waiting = new Map<string, number>();
  private readonly told = new Set<string>();
  private readonly random: (n: number) => Buffer;
  private c: InboxConnection | null = null;
  /** Open items by feature, for engine.status (F-016 FR-10); kept in step with every record read or written. */
  private readonly open = new Map<string, { feature: string; open: boolean }>();

  constructor(private readonly o: InboxOptions) {
    this.random = o.random ?? crypto.randomBytes;
  }

  /**
   * F-021 FR-7: the poll, console answers and the engine's own changes to an
   * item (revise, reopen, withdraw) take turns, so no record is written from
   * two places at once and the first answer from either path wins.
   */
  private turn: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turn.then(fn);
    this.turn = run.catch(() => undefined);
    return run;
  }

  connect(c: InboxConnection): void {
    this.c = c;
  }

  get connected(): boolean {
    return this.c !== null;
  }

  private get api(): IssuesApi {
    if (!this.c) throw new Error("the inbox isn't connected to GitHub");
    return this.c.api;
  }

  private get repo(): string {
    return this.c!.repo;
  }

  private get ownerId(): number {
    return this.c!.ownerId;
  }

  // ---- records ----

  async records(): Promise<InboxRecord[]> {
    const listed = await this.o.state.list("inbox").catch(() => []);
    const out: InboxRecord[] = [];
    for (const e of listed) {
      const m = /^inbox\/([DTHSMN]-\d{4,})\.yaml$/.exec(e.path);
      if (!m) continue;
      const r = await this.read(m[1]!);
      if (r) out.push(r);
    }
    return out;
  }

  async read(id: string): Promise<InboxRecord | null> {
    if (!ID_RE.test(id)) return null;
    const raw = await this.o.state.read(recordPath(id));
    if (!raw) return null;
    const r = YAML.parse(raw.toString("utf8")) as InboxRecord;
    if (r?.schema !== "inbox-record/3.0" || r.id !== id) throw new Error(`the inbox record ${id} is malformed`);
    this.track(r);
    return r;
  }

  private async write(r: InboxRecord, message: string, extra: Array<{ path: string; content: string }> = [], removes: string[] = []): Promise<void> {
    await this.o.state.commit([{ path: recordPath(r.id), content: YAML.stringify(r) }, ...extra], `${r.id}: ${message}`, removes);
    this.track(r);
  }

  private track(r: InboxRecord): void {
    if (r.feature) this.open.set(r.id, { feature: r.feature, open: OPEN.has(r.status) });
  }

  /** The ids of a feature's items still waiting on the owner, as last read or written. */
  waitingOn(feature: string): string[] {
    return [...this.open].filter(([, v]) => v.open && v.feature === feature).map(([id]) => id).sort();
  }

  /** The next id of a prefix: one more than the highest record, or old item file, of that prefix. */
  async nextId(kind: ItemInput["kind"]): Promise<string> {
    const prefix = KIND_PREFIX[kind];
    let max = 0;
    for (const dir of ["inbox", `inbox/${kind}`, "inbox/decision"]) {
      for (const e of await this.o.state.list(dir).catch(() => [])) {
        const m = new RegExp(`(?:^|/)${prefix}-(\\d{4,})\\.(?:yaml|md)$`).exec(e.path);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return `${prefix}-${String(max + 1).padStart(4, "0")}`;
  }

  /** An open item with this key, if one exists, so a condition files once. */
  async openByKey(key: string): Promise<InboxRecord | null> {
    return (await this.records()).find((r) => r.key === key && r.status === "open") ?? null;
  }

  /**
   * Files an item (F-011 FR-1 to FR-4): validates it, renders it, and commits
   * its record and body; the next poll dispatches it. `id`, `migratedFrom`
   * and `notes` are only passed by the one-time migration script, to keep an
   * item's old id and remove its old file in the same commit (FR-16).
   */
  file(item: ItemInput, id?: string, migratedFrom?: string, notes: string[] = []): Promise<string> {
    // The next id comes from the committed tree, so two items filed at once would both take it (D-0001 twice in the live trial).
    const run = this.filing.then(() => this.fileNow(item, id, migratedFrom, notes));
    this.filing = run.catch(() => undefined);
    return run;
  }

  private filing: Promise<unknown> = Promise.resolve();

  private async fileNow(item: ItemInput, id: string | undefined, migratedFrom: string | undefined, notes: string[]): Promise<string> {
    checkItem(item);
    id ??= await this.nextId(item.kind);
    if (!ID_RE.test(id) || id[0] !== KIND_PREFIX[item.kind]) throw new Error(`${id} is not a ${item.kind} id`);
    const at = iso(this.o.clock.now());
    await this.keepPrivate(id, 1, item);
    const body = renderBody(id, 1, this.withPrivateLine(id, item));
    const r: InboxRecord = {
      schema: "inbox-record/3.0", id, kind: item.kind, title: item.title,
      ...(item.category ? { category: item.category } : {}),
      priority: item.priority, effective_priority: item.priority, blocking: item.blocking, status: "open",
      repo: item.repo ?? "project",
      ...(item.feature ? { feature: item.feature } : {}),
      created_by: item.created_by, created_at: at,
      ...(item.options ? { options: item.options } : {}),
      ...(item.recommendation ? { recommendation: item.recommendation } : {}),
      ...(item.steps ? { steps: item.steps } : {}),
      links: item.links ?? [],
      ...(item.effect ? { effect: item.effect } : {}),
      ...(item.key ? { key: item.key } : {}),
      revisions: [{ rev: 1, body_sha256: sha256(normalBody(body)), action_comments: [], dispatched: false }],
      engine_comments: [],
      history: [
        { at, by: "engine", action: "filed" },
        ...(migratedFrom ? [{ at, by: "engine" as const, action: "migrated" as const, from: migratedFrom, ...(notes.length ? { note: notes.join(" ") } : {}) }] : []),
      ],
    };
    await this.write(r, migratedFrom ? `migrated from ${migratedFrom}` : item.title.replace(/\s+/g, " ").slice(0, 100), [{ path: bodyPath(id, 1), content: body }], migratedFrom ? [migratedFrom] : []);
    return id;
  }

  /** F-011 FR-8: a changed item gets a new revision; its old action comments are marked stale at the next poll. */
  revise(id: string, item: ItemInput): Promise<number> {
    return this.exclusive(() => this.reviseNow(id, item));
  }

  private async reviseNow(id: string, item: ItemInput): Promise<number> {
    checkItem(item);
    const r = await this.read(id);
    if (!r || r.status !== "open") throw new Error(`${id} is not open`);
    const rev = currentRevision(r).rev + 1;
    await this.keepPrivate(id, rev, item);
    const body = renderBody(id, rev, this.withPrivateLine(id, item));
    r.title = item.title;
    if (item.options) r.options = item.options;
    if (item.recommendation) r.recommendation = item.recommendation;
    if (item.steps) r.steps = item.steps;
    if (item.effect) r.effect = item.effect;
    r.revisions.push({ rev, body_sha256: sha256(normalBody(body)), action_comments: [], dispatched: false });
    r.history.push({ at: iso(this.o.clock.now()), by: "engine", action: "revised", rev });
    await this.write(r, `revision ${rev}`, [{ path: bodyPath(id, rev), content: body }]);
    return rev;
  }

  /**
   * F-016 FR-9: an answered item is opened again so it can be revised
   * (F-011 FR-8), on GitHub too. If the issue can't be reopened now, the
   * next poll reopens it, since the record is open.
   */
  reopen(id: string): Promise<void> {
    return this.exclusive(() => this.reopenNow(id));
  }

  private async reopenNow(id: string): Promise<void> {
    const r = await this.read(id);
    if (!r) throw new Error(`no inbox record ${id}`);
    if (r.status === "open") return;
    r.status = "open";
    // "reopened" is written only once the issue is open again; until then the poll's check reopens it.
    const opened = this.c && r.issue !== undefined && (await this.api.updateIssue(this.repo, r.issue, { state: "open" }).then(() => true, () => false));
    if (opened) r.history.push({ at: iso(this.o.clock.now()), by: "engine", action: "reopened" });
    await this.write(r, "reopened for a revision");
  }

  /** F-016 FR-16: an open item the engine no longer needs answered is closed with the engine's reason. */
  withdraw(id: string, why: string): Promise<void> {
    return this.exclusive(() => this.withdrawNow(id, why));
  }

  private async withdrawNow(id: string, why: string): Promise<void> {
    const r = await this.read(id);
    if (!r || r.status !== "open") return;
    r.status = "closed";
    r.history.push({ at: iso(this.o.clock.now()), by: "engine", action: "closed" });
    await this.write(r, "withdrawn");
    if (!this.c || r.issue === undefined) return;
    // The record already says closed, so a failed comment or close leaves only a stale issue, never a live action.
    await this.reply(r, `Withdrawn by the engine: ${why} Nothing needs your answer here.`).catch(() => undefined);
    await this.api.updateIssue(this.repo, r.issue, { state: "closed" }).catch(() => undefined);
    await this.write(r, "withdrawn: issue closed").catch(() => undefined);
  }

  /**
   * The record change that says an effect ran (F-016 H-0180, SR-5, SR-7),
   * for the caller to commit in the same commit as the feature's stage.
   */
  async effectChange(id: string, effect: string, stage?: string): Promise<{ path: string; content: string }> {
    const r = await this.read(id);
    if (!r) throw new Error(`no inbox record ${id}`);
    r.history.push({ at: iso(this.o.clock.now()), by: "engine", action: "effect_done", effect, ...(stage ? { stage } : {}) });
    return { path: recordPath(id), content: YAML.stringify(r) };
  }

  /** Records that an effect ran, for effects with no feature to commit with. */
  async effectDone(id: string, effect: string): Promise<void> {
    const c = await this.effectChange(id, effect);
    await this.o.state.commit([c], `${id}: effect ${effect}`);
  }

  /**
   * F-016 FR-2, SR-5: owner actions recorded but not yet carried out, as a
   * restarted engine finds them. An action is carried out when an
   * `effect_done` follows it in the record.
   */
  async pendingEffects(): Promise<Recorded[]> {
    const out: Recorded[] = [];
    for (const r of await this.records()) {
      const lastOwner = r.history.map((h) => h.by === "owner").lastIndexOf(true);
      if (lastOwner < 0) continue;
      if (r.history.slice(lastOwner + 1).some((h) => h.action === "effect_done")) continue;
      out.push({ id: r.id, record: r, entry: r.history[lastOwner]! });
    }
    return out;
  }

  // ---- privacy (F-011 FR-15, SR-9) ----

  /**
   * F-016 Gate 2 M1 (owner decision 2026-11-14): an answer this engine didn't
   * record in this run is checked on GitHub before it has any effect. The
   * pinned owner's 👍 must still be on the workflow's action comment for that
   * action, or the owner's command comment must still say it, and a risky
   * action needs its 🚀 or `/confirm` still there too. A GitHub that can't be
   * reached throws, so the answer waits; anything else that doesn't match is
   * false.
   */
  async verify(rec: Recorded): Promise<boolean> {
    const r = rec.record;
    const e = rec.entry;
    if (e.source === "console") return this.verifyConsole(rec);
    const action = actionOfEntry(e);
    if (e.by !== "owner" || e.actor_id !== this.ownerId || !r.issue || e.comment_id === undefined || !action) return false;
    // An answer to an earlier revision is stale (F-011 FR-8); one whose comment or reaction an earlier answer
    // already used, or that the poll refused, is a replay. Everything else is checked against GitHub, not the record.
    if (e.rev !== currentRevision(r).rev) return false;
    const before = r.history.slice(0, r.history.indexOf(e));
    const sameUse = (h: History) => h.by === "owner" && h.comment_id === e.comment_id && h.reaction_id === e.reaction_id;
    if (before.some(sameUse) || this.refusedAlready(r, { comment_id: e.comment_id, ...(e.reaction_id !== undefined ? { reaction_id: e.reaction_id } : {}) })) return false;
    const issue = await this.api.issue(this.repo, r.issue);
    if (!issue || issue.author !== WORKFLOW_LOGIN || ITEM_MARKER_RE.exec(normalBody(issue.body))?.[1] !== r.id) return false;
    const comments = await this.api.comments(this.repo, r.issue);
    const c = comments.find((x) => x.id === e.comment_id);
    if (!c) return false;
    if (e.source === "reaction") {
      const m = ACTION_MARKER_RE.exec(normalBody(c.body));
      if (c.author !== WORKFLOW_LOGIN || !m || m[1] !== r.id || Number(m[2]) !== e.rev || m[3] !== action) return false;
      if (!(await this.api.reactions(this.repo, c.id)).some((x) => x.id === e.reaction_id && x.userId === this.ownerId && x.content === "+1")) return false;
    } else {
      const cmd = c.authorId === this.ownerId && c.updatedAt === c.createdAt ? parseCommand(c.body) : null;
      if (!cmd || cmd.kind !== "action" || cmd.action !== action || (cmd.note ?? undefined) !== (e.note ?? undefined)) return false;
    }
    if (!isRisky(r, action)) return true;
    // The confirm must answer the engine's request for this action, within 15 minutes of that request's comment on GitHub (FR-6).
    const k = e.confirmed_by;
    const asked = before.filter((h) => h.action === "confirm_requested" && h.pending === action && h.rev === e.rev).pop();
    if (!k || k.source === "console" || !asked?.code) return false;
    const request = comments.find((x) => x.id === asked.comment_id && x.authorId === this.ownerId && x.body.startsWith("Confirm:") && x.body.includes(`/confirm ${asked.code}`));
    const cc = comments.find((x) => x.id === k.comment_id);
    if (!request || !cc) return false;
    const inTime = (at: string) => Date.parse(at) >= Date.parse(request.createdAt) && Date.parse(at) - Date.parse(request.createdAt) <= CONFIRM_MS;
    if (k.source === "reaction") {
      if (cc.id !== request.id) return false;
      return (await this.api.reactions(this.repo, cc.id)).some((x) => x.id === k.reaction_id && x.userId === this.ownerId && x.content === "rocket" && inTime(x.createdAt));
    }
    const cmd = cc.authorId === this.ownerId && cc.updatedAt === cc.createdAt ? parseCommand(cc.body) : null;
    return cmd?.kind === "confirm" && cmd.code === asked.code && inTime(cc.createdAt);
  }

  async checkPrivacy(): Promise<{ ok: boolean; reason: string }> {
    try {
      const p = await this.api.repoPrivacy(this.repo);
      const others = p.collaboratorIds.filter((x) => x !== this.ownerId);
      this.privacy = !p.private
        ? { ok: false, reason: "the config repo is public" }
        : others.length
          ? { ok: false, reason: `the config repo has ${others.length} collaborator(s) besides the owner` }
          : { ok: true, reason: "" };
    } catch (e) {
      this.privacy = { ok: false, reason: `the config repo's visibility couldn't be checked (${(e as Error).message})` };
    }
    if (!this.privacy.ok && !this.told.has(`privacy:${this.privacy.reason}`)) {
      this.told.add(`privacy:${this.privacy.reason}`);
      this.o.log.warn(`Inbox: nothing is filed on GitHub because ${this.privacy.reason} (F-011 FR-15).`);
      this.o.notify("Factory inbox stopped", `Nothing is filed because ${this.privacy.reason}.`);
    }
    return this.privacy;
  }

  // ---- the poll ----

  /**
   * One poll (F-011 FR-5): dispatches undelivered revisions, binds issues
   * and action comments, and reads actions on every open item. A GitHub
   * error ends this poll for the project; the next poll retries, and the
   * record's ids keep anything from being recorded twice (section 6).
   */
  poll(): Promise<Recorded[]> {
    return this.exclusive(() => this.pollNow());
  }

  private async pollNow(): Promise<Recorded[]> {
    if (!this.c) return [];
    const privacy = await this.checkPrivacy();
    if (!privacy.ok) return [];
    const recorded: Recorded[] = [];
    const all = await this.records();
    for (const r of all) if (r.status !== "open") await this.syncConsole(r);
    const open = all.filter((r) => r.status === "open");
    let listed: Awaited<ReturnType<IssuesApi["openIssues"]>> | null = null;
    for (const r of open) {
      const rev = currentRevision(r);
      if (!rev.dispatched) {
        await this.dispatch(r, rev);
        continue;
      }
      if (r.issue === undefined) {
        listed ??= await this.api.openIssues(this.repo);
        const found = listed.find((i) => i.author === WORKFLOW_LOGIN && ITEM_MARKER_RE.exec(normalBody(i.body))?.[1] === r.id);
        if (!found) {
          this.missing(r);
          continue;
        }
        r.issue = found.number;
        await this.write(r, `issue #${found.number}`);
        if (r.blocking) this.o.notify(`Factory: ${r.id} needs you`, renderTitle(r.id, r));
      }
      recorded.push(...(await this.read1(r)));
    }
    return recorded;
  }

  private missing(r: InboxRecord): void {
    const n = (this.waiting.get(r.id) ?? 0) + 1;
    this.waiting.set(r.id, n);
    if (n === POLLS_BEFORE_MISSING && !this.told.has(`missing:${r.id}`)) {
      this.told.add(`missing:${r.id}`);
      this.o.log.warn(`Inbox: ${r.id} has no issue after ${n} polls; check the config repo's factory-inbox workflow and Actions.`);
      this.o.notify("Factory inbox: an item didn't appear", `${r.id} has no issue in the config repo. Check its factory-inbox workflow.`);
    }
  }

  private async dispatch(r: InboxRecord, rev: Revision): Promise<void> {
    const body = (await this.o.state.read(bodyPath(r.id, rev.rev)))?.toString("utf8");
    if (body === undefined) throw new Error(`${r.id} has no rendered body for revision ${rev.rev}`);
    const comments = actionsFor({ kind: r.kind, ...(r.options ? { options: r.options } : {}), ...(r.steps ? { steps: r.steps } : {}) })
      .map((a) => actionComment(r.id, rev.rev, r, a));
    if (rev.rev > 1 && r.issue !== undefined) {
      // FR-8: the body moves to the new revision and the old action comments say so before new ones are posted.
      await this.api.updateIssue(this.repo, r.issue, { body });
      for (const old of r.revisions.slice(0, -1).flatMap((x) => x.action_comments)) {
        await this.api.editComment(this.repo, old.id, engineText.stale(rev.rev)).catch(() => undefined);
      }
    }
    await this.api.dispatch(this.repo, {
      item: r.id, rev: rev.rev, ...(rev.rev > 1 && r.issue !== undefined ? { issue: r.issue } : { title: renderTitle(r.id, r), body, labels: renderLabels(r) }),
      comments,
    });
    rev.dispatched = true;
    await this.write(r, `revision ${rev.rev} sent to the inbox workflow`);
  }

  /** Binds the current revision's action comments: the workflow's, with the marker, one per allowed action, in order. */
  private bind(r: InboxRecord, rev: Revision, comments: IssueComment[], body: string): boolean {
    if (rev.action_comments.length) return true;
    if (sha256(normalBody(body)) !== rev.body_sha256) return false;
    const want = actionsFor({ kind: r.kind, ...(r.options ? { options: r.options } : {}), ...(r.steps ? { steps: r.steps } : {}) });
    const mine = comments.filter((c) => c.author === WORKFLOW_LOGIN && c.authorType === "Bot").filter((c) => {
      const m = ACTION_MARKER_RE.exec(normalBody(c.body));
      return m && m[1] === r.id && Number(m[2]) === rev.rev;
    });
    if (mine.length !== want.length) return false;
    const bound = mine.map((c, i) => {
      const action = ACTION_MARKER_RE.exec(normalBody(c.body))![3]!;
      return action === want[i] && normalBody(c.body) === actionComment(r.id, rev.rev, r, action) ? { id: c.id, action, sha256: sha256(normalBody(c.body)) } : null;
    });
    if (bound.some((b) => b === null)) return false;
    rev.action_comments = bound as Revision["action_comments"];
    rev.issue_body_sha256 = sha256(normalBody(body));
    return true;
  }

  private refusedAlready(r: InboxRecord, k: { comment_id?: number; reaction_id?: number }): boolean {
    return (r.refused ?? []).some((x) => (k.comment_id !== undefined && x.comment_id === k.comment_id && x.reaction_id === k.reaction_id));
  }

  /** A reaction or command already recorded, or already waiting on its confirm, is never read again. */
  private usedAlready(r: InboxRecord, k: { comment_id?: number; reaction_id?: number }): boolean {
    return r.history.some((h) =>
      (h.action === "confirm_requested" && (() => {
        const c = (h as History & { chosen?: Chosen }).chosen;
        return !!c && (k.reaction_id !== undefined ? c.reaction_id === k.reaction_id : c.reaction_id === undefined && c.comment_id === k.comment_id);
      })()) ||
      (k.reaction_id !== undefined && (h.reaction_id === k.reaction_id || githubConfirm(h)?.reaction_id === k.reaction_id)) ||
      (k.reaction_id === undefined && k.comment_id !== undefined && (h.comment_id === k.comment_id && h.source === "command" || githubConfirm(h)?.comment_id === k.comment_id && githubConfirm(h)?.source === "command")));
  }

  private async reply(r: InboxRecord, text: string): Promise<void> {
    const id = await this.api.comment(this.repo, r.issue!, text);
    r.engine_comments.push(id);
  }

  private async refuse(r: InboxRecord, keys: Array<{ comment_id?: number; reaction_id?: number }>, reason: RefuseReason): Promise<void> {
    const fresh = keys.filter((k) => !this.refusedAlready(r, k));
    if (!fresh.length) return;
    r.refused = [...(r.refused ?? []), ...fresh.map((k) => ({ ...k, reason }))];
    await this.reply(r, engineText.notRecorded(reason));
    await this.write(r, `not recorded: ${reason}`);
  }

  /** Reads one bound item's actions and records at most one (F-011 FR-5 to FR-8). */
  private async read1(r: InboxRecord): Promise<Recorded[]> {
    const issue = await this.api.issue(this.repo, r.issue!);
    if (!issue) {
      // Section 6: a deleted issue leaves the item open in the record; the owner is told once.
      if (!this.told.has(`deleted:${r.id}`)) {
        this.told.add(`deleted:${r.id}`);
        this.o.log.warn(`Inbox: the issue of ${r.id} was deleted; the item stays open in the record.`);
        this.o.notify("Factory inbox: an issue was deleted", `${r.id} is still open in the factory's record.`);
      }
      return [];
    }
    const rev = currentRevision(r);
    const comments = await this.api.comments(this.repo, r.issue!);
    const wasBound = rev.action_comments.length > 0;
    if (!this.bind(r, rev, comments, issue.body)) {
      this.missing(r);
      return [];
    }
    if (!wasBound) await this.write(r, `revision ${rev.rev} action comments found`);
    if (issue.state === "closed") {
      // Reopened once after the engine last closed it, so an owner who closes it again by hand isn't fought.
      const lastClosed = r.history.map((h) => h.action === "closed").lastIndexOf(true);
      if (!r.history.slice(lastClosed + 1).some((h) => h.action === "reopened")) {
        await this.api.updateIssue(this.repo, r.issue!, { state: "open" });
        await this.reply(r, engineText.reopened());
        r.history.push({ at: iso(this.o.clock.now()), by: "engine", action: "reopened" });
        await this.write(r, "reopened");
      }
      return [];
    }
    const bodyChanged = sha256(normalBody(issue.body)) !== rev.issue_body_sha256;
    const engine = new Set(r.engine_comments);
    const actionIds = new Set(r.revisions.flatMap((x) => x.action_comments.map((c) => c.id)));
    const now = this.o.clock.now();

    type Cand = { action: ActionId; source: "reaction" | "command"; comment: IssueComment; reaction_id?: number; note?: string };
    const cands: Cand[] = [];
    const confirms: Array<{ source: "reaction" | "command"; comment: IssueComment; reaction_id?: number; code?: string; at: number }> = [];

    // Reactions: 👍 on an action comment of any revision; old ones are stale (AC-7). Other emoji are ignored.
    for (const old of r.revisions) {
      for (const ac of old.action_comments) {
        const c = comments.find((x) => x.id === ac.id);
        for (const re of await this.api.reactions(this.repo, ac.id)) {
          if (re.content !== "+1" || re.userId !== this.ownerId) continue;
          const key = { comment_id: ac.id, reaction_id: re.id };
          if (this.usedAlready(r, key)) continue;
          if (old.rev !== rev.rev || bodyChanged) {
            await this.refuse(r, [key], "changed since");
            continue;
          }
          if (!c || sha256(normalBody(c.body)) !== ac.sha256) {
            await this.refuse(r, [key], "comment edited");
            continue;
          }
          if (ac.action === "changes" || ac.action === "research") {
            await this.refuse(r, [key], "not a command");
            continue;
          }
          cands.push({ action: ac.action, source: "reaction", comment: c, reaction_id: re.id });
        }
      }
    }
    // 🚀 on the engine's latest confirm comment.
    const pending = this.pendingConfirm(r);
    if (pending?.comment_id !== undefined) {
      for (const re of await this.api.reactions(this.repo, pending.comment_id)) {
        if (re.content !== "rocket" || re.userId !== this.ownerId || this.usedAlready(r, { comment_id: pending.comment_id, reaction_id: re.id })) continue;
        const c = comments.find((x) => x.id === pending.comment_id);
        if (c) confirms.push({ source: "reaction", comment: c, reaction_id: re.id, at: Date.parse(re.createdAt) || now });
      }
    }
    // Commands: the owner's own comments, never the engine's or the workflow's (SR-17).
    for (const c of comments) {
      if (c.authorId !== this.ownerId || engine.has(c.id) || actionIds.has(c.id) || !looksLikeCommand(c.body)) continue;
      const key = { comment_id: c.id };
      if (this.usedAlready(r, key) || this.refusedAlready(r, key)) continue;
      if (c.updatedAt !== c.createdAt) {
        await this.refuse(r, [key], "comment edited");
        continue;
      }
      const cmd = parseCommand(c.body);
      if (!cmd) {
        await this.refuse(r, [key], "not a command");
        continue;
      }
      if (bodyChanged) {
        await this.refuse(r, [key], "changed since");
        continue;
      }
      if (cmd.kind === "confirm") {
        if (!pending || cmd.code !== pending.code) await this.refuse(r, [key], pending ? "not a command" : "confirm expired");
        else confirms.push({ source: "command", comment: c, code: cmd.code, at: Date.parse(c.createdAt) || now });
        continue;
      }
      const allowed = actionsFor({ kind: r.kind, ...(r.options ? { options: r.options } : {}), ...(r.steps ? { steps: r.steps } : {}) });
      if (!allowed.includes(cmd.action)) {
        await this.refuse(r, [key], "not a command");
        continue;
      }
      cands.push({ action: cmd.action, source: "command", comment: c, ...(cmd.note !== undefined ? { note: cmd.note } : {}) });
    }

    // A confirm records the pending action (FR-6), once, within 15 minutes, at the same revision.
    if (pending && confirms.length) {
      const c = confirms[0]!;
      const key = { comment_id: c.comment.id, ...(c.reaction_id !== undefined ? { reaction_id: c.reaction_id } : {}) };
      if (pending.rev !== rev.rev || bodyChanged) {
        await this.refuse(r, [key], "changed since");
      } else if (now - Date.parse(pending.at) > CONFIRM_MS || c.at - Date.parse(pending.at) > CONFIRM_MS) {
        await this.refuse(r, [key], "confirm expired");
      } else {
        return [await this.record(r, pending.chosen, { source: c.source, comment_id: c.comment.id, ...(c.reaction_id !== undefined ? { reaction_id: c.reaction_id } : {}) })];
      }
    }

    const distinct = [...new Set(cands.map((c) => c.action))];
    if (distinct.length > 1) {
      await this.refuse(r, cands.map((c) => ({ comment_id: c.comment.id, ...(c.reaction_id !== undefined ? { reaction_id: c.reaction_id } : {}) })), "two actions chosen");
      return [];
    }
    if (!cands.length) return [];
    const cand = cands[0]!;
    const chosen: Chosen = {
      action: cand.action, source: cand.source, comment_id: cand.comment.id, url: cand.comment.url,
      ...(cand.reaction_id !== undefined ? { reaction_id: cand.reaction_id } : {}), ...(cand.note !== undefined ? { note: cand.note } : {}),
    };
    if (isRisky(r, cand.action)) {
      await this.askConfirm(r, chosen);
      return [];
    }
    return [await this.record(r, chosen)];
  }

  private pendingConfirm(r: InboxRecord): { chosen: Chosen; code: string; at: string; rev: number; comment_id?: number } | null {
    const last = [...r.history].reverse().find((h) => h.action === "confirm_requested" || (h.by === "owner"));
    if (!last || last.action !== "confirm_requested") return null;
    const c = (last as History & { chosen?: Chosen }).chosen;
    if (!c) return null;
    return { chosen: c, code: last.code!, at: last.at, rev: last.rev!, ...(last.comment_id !== undefined ? { comment_id: last.comment_id } : {}) };
  }

  private async askConfirm(r: InboxRecord, chosen: Chosen): Promise<void> {
    const code = confirmCode(this.random);
    const text = engineText.confirm(actionWords(r, chosen.action), confirmTarget(r, chosen.action), code);
    const id = await this.api.comment(this.repo, r.issue!, text);
    r.engine_comments.push(id);
    const entry: History & { chosen: Chosen } = {
      at: iso(this.o.clock.now()), by: "engine", action: "confirm_requested", rev: currentRevision(r).rev, pending: chosen.action, code, comment_id: id, chosen,
    };
    r.history.push(entry);
    await this.write(r, "confirm requested");
  }

  private async record(r: InboxRecord, chosen: Chosen, confirmedBy?: History["confirmed_by"]): Promise<Recorded> {
    const [verb, arg] = chosen.action.split(":");
    const m = RECORDS[verb!]!;
    const entry: History = {
      at: iso(this.o.clock.now()), by: "owner", action: m.action,
      ...(verb === "choose" ? { option: arg! } : {}), ...(verb === "step" ? { step: Number(arg) } : {}),
      rev: currentRevision(r).rev, source: chosen.source, actor_id: this.ownerId, comment_id: chosen.comment_id,
      ...(chosen.reaction_id !== undefined ? { reaction_id: chosen.reaction_id } : {}),
      ref: chosen.url,
      ...(chosen.note !== undefined ? { note: chosen.note } : {}),
      ...(confirmedBy ? { confirmed_by: confirmedBy } : {}),
    };
    r.history.push(entry);
    if (verb === "defer") r.effective_priority = priorityLower(r.effective_priority);
    if (verb === "restore") r.effective_priority = r.priority;
    r.status = m.status;
    // FR-7: the record first, so the action stands whatever happens to the issue after.
    await this.write(r, `${m.action}${verb === "choose" ? ` ${arg}` : ""} by the owner`);
    await this.reply(r, engineText.recorded(actionWords(r, chosen.action)));
    if (verb === "defer" || verb === "restore") {
      await this.api.updateIssue(this.repo, r.issue!, { labels: renderLabels(r) });
    } else if (!KEEPS_OPEN.has(chosen.action)) {
      await this.api.updateIssue(this.repo, r.issue!, { state: "closed" });
      r.history.push({ at: iso(this.o.clock.now()), by: "engine", action: "closed" });
    }
    await this.write(r, "replied");
    return { id: r.id, record: r, entry };
  }
  // ---- the console (F-021) ----

  /** Console confirms waiting for their code, by item; one try each (SR-2). Kept in memory: a restart just asks again. */
  private readonly confirms = new Map<string, { action: ActionId; note?: string; code: string; rev: number; at: number; session: number }>();

  /** FR-4, SR-5: private detail goes to the engine folder only, after the secrets scan. */
  private async keepPrivate(id: string, rev: number, item: ItemInput): Promise<void> {
    if (!item.private?.length || !this.o.local) return;
    const sections: PrivateDetail = [];
    for (const s of item.private.slice(0, 10)) {
      const text = s.text.slice(0, MAX_PRIVATE_SECTION_CHARS);
      sections.push({ name: s.name.replace(/\s+/g, " ").trim().slice(0, 80) || "Detail", text: this.o.scrub ? await this.o.scrub(text) : text });
    }
    this.o.local.writePrivate(id, rev, sections);
  }

  /** The issue says detail exists, never what it is (FR-4). */
  private withPrivateLine(id: string, item: ItemInput): ItemInput {
    if (!item.private?.length || !this.o.local) return item;
    const context = SECTIONS[item.kind][0]!;
    return { ...item, sections: { ...item.sections, [context]: [...(item.sections[context] ?? []), { engine: privateLine(id) }] } };
  }

  /** FR-2: open items, blocking first, then by effective priority, then by id. */
  async consoleList(): Promise<InboxRecord[]> {
    const rank = (p: string) => PRIORITIES.indexOf(p as (typeof PRIORITIES)[number]);
    return (await this.records()).filter((r) => r.status === "open")
      .sort((a, b) => Number(b.blocking) - Number(a.blocking) || rank(a.effective_priority) - rank(b.effective_priority) || a.id.localeCompare(b.id));
  }

  /** FR-3: the current revision's body as the issue shows it, the private detail, and the actions in order. */
  async consoleShow(id: string): Promise<{ record: InboxRecord; rev: number; body: string; private: PrivateDetail | null; actions: Array<{ action: ActionId; label: string }> } | null> {
    const r = await this.read(id);
    if (!r) return null;
    const rev = currentRevision(r).rev;
    const body = (await this.o.state.read(bodyPath(id, rev)))?.toString("utf8") ?? "";
    const actions = actionsFor(shape(r)).map((a) => ({ action: a, label: actionLabel(r, a) }));
    return { record: r, rev, body, private: this.o.local?.readPrivate(id, rev) ?? null, actions };
  }

  /**
   * FR-5 to FR-7: an action picked in the console. Under the inbox's lock the
   * record must still be open and at the revision the owner saw; otherwise
   * the owner is told what happened instead. A risky action gets a code to
   * confirm (FR-6) and records nothing yet.
   */
  consoleAnswer(a: { id: string; rev: number; action: string; note?: string; session: number; signedIn: boolean }): Promise<ConsoleResult> {
    return this.exclusive(async () => {
      const r = await this.read(a.id);
      const gate = this.consoleGate(r, a.rev);
      if (gate) return gate;
      if (!this.o.local) return { refused: "no console" };
      if (!actionsFor(shape(r!)).includes(a.action)) return { refused: "not allowed" };
      const needsNote = a.action === "changes" || a.action === "research";
      const note = needsNote ? (a.note ?? "").trim() : undefined;
      if (needsNote && !note) return { refused: "not allowed" };
      if (note !== undefined && note.length > MAX_NOTE_CHARS) return { refused: "note too long" };
      if (isRisky(r!, a.action)) {
        const code = confirmCode(this.random);
        const at = this.o.clock.now();
        this.confirms.set(a.id, { action: a.action, ...(note !== undefined ? { note } : {}), code, rev: a.rev, at, session: a.session });
        return { confirm: { words: `Confirm: ${actionWords(r!, a.action)} ${confirmTarget(r!, a.action)}.`, code, expires_at: iso(at + CONFIRM_MS) } };
      }
      return { recorded: await this.recordConsole(r!, a.action, note, a.session, a.signedIn, false) };
    });
  }

  /** FR-6, SR-2: the code from this engine's own confirm, for the same session, action's item and revision, within 15 minutes; one try. */
  consoleConfirm(a: { id: string; rev: number; code: string; session: number; signedIn: boolean }): Promise<ConsoleResult> {
    return this.exclusive(async () => {
      const pending = this.confirms.get(a.id);
      this.confirms.delete(a.id);
      const r = await this.read(a.id);
      const gate = this.consoleGate(r, a.rev);
      if (gate) return gate;
      if (!pending || pending.session !== a.session || pending.rev !== a.rev || pending.code !== a.code || this.o.clock.now() - pending.at > CONFIRM_MS) {
        return { refused: "confirm failed" };
      }
      return { recorded: await this.recordConsole(r!, pending.action, pending.note, a.session, a.signedIn, true) };
    });
  }

  /** FR-7: an item answered elsewhere, withdrawn or revised since the owner saw it. */
  private consoleGate(r: InboxRecord | null, rev: number): ConsoleResult | null {
    if (!r) return { refused: "unknown item" };
    if (r.status !== "open") {
      // Owner answers never leave "closed"; only the engine's withdrawal does (F-016 FR-16).
      const lastOwner = [...r.history].reverse().find((h) => h.by === "owner");
      if (r.status === "closed" || !lastOwner) return { already: { by: "engine" } };
      const action = actionOfEntry(lastOwner);
      return { already: { by: lastOwner.source === "console" ? "console" : "github", ...(action ? { action: actionWords(r, action) } : {}) } };
    }
    const now = currentRevision(r).rev;
    return rev === now ? null : { changed: { rev: now } };
  }

  /**
   * FR-8, FR-10: the record first, with the proof written to the engine
   * folder just before it, then the issue. A GitHub that can't be reached
   * leaves the comment and the close to the next poll (`syncConsole`).
   */
  private async recordConsole(r: InboxRecord, action: ActionId, note: string | undefined, session: number, signedIn: boolean, confirmed: boolean): Promise<Recorded> {
    const [verb, arg] = action.split(":");
    const m = RECORDS[verb!]!;
    const entry: History = {
      at: iso(this.o.clock.now()), by: "owner", action: m.action,
      ...(verb === "choose" ? { option: arg! } : {}), ...(verb === "step" ? { step: Number(arg) } : {}),
      rev: currentRevision(r).rev, source: "console", signed_in: signedIn,
      ...(note !== undefined ? { note } : {}),
      ...(confirmed ? { confirmed_by: { source: "console" as const } } : {}),
    };
    const hash = entryHash(entry);
    this.o.local!.writeAnswer({ id: r.id, n: r.history.length, rev: entry.rev!, action, ...(note !== undefined ? { note } : {}), at: entry.at, session, entry_sha256: hash });
    entry.console_answer = hash;
    r.history.push(entry);
    if (verb === "defer") r.effective_priority = priorityLower(r.effective_priority);
    if (verb === "restore") r.effective_priority = r.priority;
    r.status = m.status;
    await this.write(r, `${m.action}${verb === "choose" ? ` ${arg}` : ""} by the owner in the console`);
    if (KEEPS_OPEN.has(action)) {
      // The item stays open, so its issue does too; a failed comment or label change is only cosmetic.
      if (this.c && r.issue !== undefined) {
        await this.reply(r, engineText.recordedConsole(actionWords(r, action))).catch(() => undefined);
        if (verb === "defer" || verb === "restore") await this.api.updateIssue(this.repo, r.issue, { labels: renderLabels(r) }).catch(() => undefined);
        await this.write(r, "console answer posted").catch(() => undefined);
      }
    } else {
      await this.syncConsole(r).catch(() => undefined);
    }
    return { id: r.id, record: r, entry };
  }

  /** FR-8: closes the issue of an item answered in the console, once, with the fixed comment. */
  private async syncConsole(r: InboxRecord): Promise<void> {
    if (!this.c) return;
    const i = r.history.map((h) => h.by === "owner").lastIndexOf(true);
    const e = r.history[i];
    if (!e || e.source !== "console") return;
    const action = actionOfEntry(e);
    if (!action || KEEPS_OPEN.has(action) || r.history.slice(i + 1).some((h) => h.by === "engine" && h.action === "closed")) return;
    if (r.issue === undefined) {
      if (currentRevision(r).dispatched) {
        const found = (await this.api.openIssues(this.repo)).find((x) => x.author === WORKFLOW_LOGIN && ITEM_MARKER_RE.exec(normalBody(x.body))?.[1] === r.id);
        // The workflow hasn't opened it yet: the next poll looks again.
        if (!found) return;
        r.issue = found.number;
      }
    }
    if (r.issue !== undefined) {
      await this.reply(r, engineText.recordedConsole(actionWords(r, action)));
      await this.api.updateIssue(this.repo, r.issue, { state: "closed" });
    }
    r.history.push({ at: iso(this.o.clock.now()), by: "engine", action: "closed" });
    await this.write(r, "answered in the console: issue closed");
  }

  /** FR-10: a console answer this run didn't record counts only if the engine folder holds its proof. */
  private verifyConsole(rec: Recorded): boolean {
    const r = rec.record;
    const e = rec.entry;
    const action = actionOfEntry(e);
    const n = r.history.indexOf(e);
    if (!this.o.local || e.by !== "owner" || !action || n < 0 || e.rev !== currentRevision(r).rev || !e.console_answer) return false;
    const file = this.o.local.readAnswer(r.id, n);
    return !!file && file.entry_sha256 === e.console_answer && entryHash(e) === e.console_answer && file.rev === e.rev && file.action === action && file.at === e.at;
  }

}

/** What each action verb records and the status it leaves, for both answer paths. */
const RECORDS: Record<string, { action: History["action"]; status: Status }> = {
  choose: { action: "chosen", status: "chosen" },
  step: { action: "step_chosen", status: "approved" },
  approve: { action: "approved", status: "approved" },
  reject: { action: "rejected", status: "rejected" },
  changes: { action: "changes_requested", status: "changes_requested" },
  research: { action: "research_requested", status: "open" },
  defer: { action: "deferred", status: "open" },
  restore: { action: "restored", status: "open" },
  dismiss: { action: "dismissed", status: "dismissed" },
};

/** The record fields `actionsFor` reads. */
const shape = (r: InboxRecord) => ({ kind: r.kind, ...(r.options ? { options: r.options } : {}), ...(r.steps ? { steps: r.steps } : {}) });

/**
 * F-021 FR-10: the hash of a console answer's history entry, without its
 * own `console_answer`, over sorted keys so a record read back and written
 * again in another key order still matches.
 */
export function entryHash(e: History): string {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).filter((k) => k !== "console_answer").sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
  return sha256(JSON.stringify(canon(e)));
}

interface Chosen {
  action: ActionId;
  source: "reaction" | "command";
  comment_id: number;
  reaction_id?: number;
  url: string;
  note?: string;
}

/** F-011 FR-11: the confirm comment's fixed target per kind. */
function confirmTarget(r: InboxRecord, action: ActionId): string {
  switch (r.kind) {
    case "hygiene": return `for ${r.id}, which lands on main`;
    case "maturity": return `for ${r.id} (${r.repo})`;
    case "spec": return `for ${r.feature ?? r.id}: development starts on the signed-off spec`;
    default: {
      const o = r.options?.find((x) => `choose:${x.id}` === action);
      return `on ${r.id}: you accept what option ${o?.id ?? "?"} means for the project`;
    }
  }
}

function checkItem(item: ItemInput): void {
  if (!PRIORITIES.includes(item.priority)) throw new Error("unknown priority");
  if (item.kind === "decision") {
    const o = item.options ?? [];
    if (o.length < 2 || o.length > 4 || !o.every((x, i) => x.id === "ABCD"[i]) || !o.some((x) => x.id === item.recommendation)) {
      throw new Error("a decision item needs 2 to 4 options with ids A to D and one of them recommended");
    }
    if (!item.category) throw new Error("a decision item needs a category");
  }
  if (item.kind === "testing" && !(item.steps?.length && item.steps.length <= 9)) throw new Error("a testing item needs 1 to 9 steps");
}

/** A confirm given on GitHub; console confirms carry no comment or reaction. */
function githubConfirm(h: History): { source: "reaction" | "command"; comment_id: number; reaction_id?: number } | undefined {
  return h.confirmed_by && h.confirmed_by.source !== "console" ? h.confirmed_by : undefined;
}

/** The action an owner history entry recorded, as action comments name it. */
function actionOfEntry(e: History): ActionId | null {
  switch (e.action) {
    case "chosen": return e.option ? `choose:${e.option}` : null;
    case "step_chosen": return e.step ? `step:${e.step}` : null;
    case "approved": return "approve";
    case "rejected": return "reject";
    case "changes_requested": return "changes";
    case "research_requested": return "research";
    case "deferred": return "defer";
    case "restored": return "restore";
    case "dismissed": return "dismiss";
    default: return null;
  }
}


