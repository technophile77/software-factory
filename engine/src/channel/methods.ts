import { Clock } from "../clock";
import { ID_RE, MAX_NEXT_WAIT_S, REFUSED_MESSAGE, RPC, type SourceIssue, parseSourceIssue } from "../constants";

export type { SourceIssue };
import { DocumentRefused, SourceDocument, validateDocument } from "../interview/document";
import { FeatureInterview, InterviewError } from "../interview/feature";
import { wire } from "../interview/model";
import { SecretFound } from "../state/state-repo";
import { bodySections } from "../inbox/render";
import { Handler, RpcError } from "./framing";
import type { ConsoleResult } from "../inbox/store";
import type { InboxRecord } from "../inbox/model";
import type { PrivateDetail } from "../inbox/local";
import { SessionManager } from "./sessions";
import type { LiveAgent, LiveEntry } from "../agent/live-transcript";

/** F-021: what the channel needs from the project's inbox to answer items in the console. */
export interface ConsoleInbox {
  list(): Promise<InboxRecord[]>;
  show(id: string): Promise<{ record: InboxRecord; rev: number; body: string; private: PrivateDetail | null; actions: Array<{ action: string; label: string }> } | null>;
  answer(a: { id: string; rev: number; action: string; note?: string; session: number; signedIn: boolean }): Promise<ConsoleResult>;
  confirm(a: { id: string; rev: number; code: string; session: number; signedIn: boolean }): Promise<ConsoleResult>;
}

export interface ProjectChannel {
  name: string;
  sessions: SessionManager;
  /** This project's features with an interview. */
  features(): FeatureInterview[];
  /** One of this project's features, or null. Ids are per project (F-023 FR-9). */
  feature(id: string): FeatureInterview | null;
  /** Channel v1.4: `document` has passed validateDocument; the engine scans and stores it (F-009). v1.8: `issue` is the source issue (F-015 FR-26). */
  startFeature(request: string, document?: SourceDocument, issue?: SourceIssue): Promise<string>;
  /** Channel v1.9 (F-015 FR-27): the owner cancels the feature; the reason has passed the length check. */
  cancelFeature(f: FeatureInterview, reason: string): Promise<void>;
  /** F-021: the project's inbox for console answers, or null while it has none. */
  inbox(): ConsoleInbox | null;
  /** F-021 FR-18 (channel v1.7, H-0265): the project's live agent transcript after `after`. */
  transcript(after: number | undefined): { agents: Array<LiveAgent & { cost_usd?: number }>; entries: LiveEntry[]; next: number; skipped: number };
  /**
   * F-021 FR-18 (channel v1.10): while the project is held for a pinned-key
   * change, the hold's words and which inbox records the console may see.
   */
  held?(): { reason: string; shows(r: InboxRecord): boolean } | null;
  /** Files the Security item behind a -32008 for a secret the scan found (H-0084). */
  secretRefused(where: string, found: SecretFound, feature?: string): Promise<void>;
}

export interface EngineControl {
  status(): { version: string; capabilities: string[]; uptime_s: number; features: Array<{ id: string; project: string; stage: string; active_agents: number; activity?: string }> };
  pause(feature?: string): string[];
  resume(feature?: string): string[];
  shutdown(): void;
}

const MAX_REQUEST_CHARS = 4000;

/** The engine refused a source issue before anything was started: not a project repo, not found, or not open. */
export class SourceIssueRefused extends Error {}

/** F-015 FR-27: the feature is already final, so there is nothing to cancel. */
export class CancelRefused extends Error {}

const INBOX_ITEM_RE = /^[DTHSMN]-\d{4,8}$/;
const ACTION_RE = /^(?:choose:[A-D]|step:[1-9]\d?|approve|reject|changes|research|defer|restore|dismiss)$/;
const CODE_RE = /^[A-Z0-9]{4}$/;
const MAX_NOTE_CHARS = 4000;
/** Results of console answers by reply_id, so a resent call after a lost reply gets the first result, not a second answer. */
const REPLY_KEEP_MS = 30 * 60_000;

function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new RpcError(RPC.invalidParams, `${what} must be an id.`);
  return v;
}

function waitS(v: unknown, max: number): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new RpcError(RPC.invalidParams, "wait_s must be a non-negative integer.");
  return Math.min(v, max);
}

function only(params: Record<string, unknown>, keys: string[]): void {
  for (const k of Object.keys(params)) if (!keys.includes(k)) throw new RpcError(RPC.invalidParams, "Unexpected parameter.");
}

function inboxItem(v: unknown): string {
  if (typeof v !== "string" || !INBOX_ITEM_RE.test(v)) throw new RpcError(RPC.invalidParams, "item must be an inbox item id.");
  return v;
}

function revision(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new RpcError(RPC.invalidParams, "rev must be a positive integer.");
  return v;
}

/** Engine control channel v1.6 `inbox.answer` / `inbox.confirm` results (H-0245). */
function consoleWire(r: ConsoleResult): Record<string, unknown> {
  if ("recorded" in r) return { recorded: true };
  if ("refused" in r) return { refused: r.refused.replace(/ /g, "_") };
  return r;
}

/** Channel v1.1-v1.6 methods for one project's channel. Session state never crosses projects (SR-16). */
export function methods(project: ProjectChannel, engine: EngineControl, clock: Clock): Handler {
  const replies = new Map<string, { at: number; result: Record<string, unknown> }>();
  const inbox = (): ConsoleInbox => {
    const i = project.inbox();
    if (!i) throw new RpcError(RPC.unknown, "This project's inbox isn't available.");
    return i;
  };
  const feature = (fid: unknown): FeatureInterview => {
    const f = project.feature(id(fid, "feature"));
    if (!f) throw new RpcError(RPC.unknown, "Unknown feature.");
    return f;
  };

  async function next(f: FeatureInterview, shown: Set<string>, wait: number) {
    const deadline = clock.now() + wait * 1000;
    for (;;) {
      const it = f.pick(shown);
      if (it) return wire(it);
      const busy = f.researching();
      if (!busy || clock.now() >= deadline) return busy ? wire(busy) : null;
      // Wake on the next change to the feature, or at the deadline.
      const ac = new AbortController();
      const onChange = () => ac.abort();
      f.changed.once("change", onChange);
      await clock.sleep(deadline - clock.now(), ac.signal);
      f.changed.off("change", onChange);
    }
  }

  const HELD_METHODS = new Set(["engine.status", "inbox.open", "inbox.close", "inbox.list", "inbox.show", "inbox.answer", "inbox.confirm"]);
  /** FR-18: a held project's console reaches only the hold item; any other id reads as unknown. */
  const heldShows = async (item: string): Promise<void> => {
    const h = project.held?.();
    if (!h) return;
    const r = (await inbox().list()).find((x) => x.id === item);
    if (!r || !h.shows(r)) throw new RpcError(RPC.unknown, "Unknown item.");
  };

  return async (method, p) => {
    const held = project.held?.() ?? null;
    if (held && !HELD_METHODS.has(method)) throw new RpcError(RPC.projectHeld, `${project.name} is on hold: ${held.reason}.`);
    switch (method) {
      case "engine.status":
        if (held) {
          const st = engine.status();
          return { version: st.version, capabilities: st.capabilities, uptime_s: st.uptime_s, features: [], held: { reason: held.reason } };
        }
        only(p, []);
        return engine.status();
      case "engine.pause":
        only(p, ["feature"]);
        if (p.feature !== undefined) feature(p.feature);
        return { paused: engine.pause(p.feature as string | undefined) };
      case "engine.resume":
        only(p, ["feature"]);
        if (p.feature !== undefined) feature(p.feature);
        return { resumed: engine.resume(p.feature as string | undefined) };
      case "engine.shutdown":
        only(p, []);
        // Answer first; the engine stops once this reply is on its way.
        setImmediate(() => engine.shutdown());
        return { ok: true };
      case "feature.start": {
        only(p, ["request", "document", "issue"]);
        if (typeof p.request !== "string" || !p.request.trim() || [...p.request].length > MAX_REQUEST_CHARS) {
          throw new RpcError(RPC.invalidParams, `request must be non-empty text up to ${MAX_REQUEST_CHARS} characters.`);
        }
        const issue = p.issue === undefined ? undefined : parseSourceIssue(p.issue);
        if (issue === null) throw new RpcError(RPC.invalidParams, "issue must be owner/repo#number.");
        try {
          const doc = p.document === undefined ? undefined : validateDocument(p.document);
          return { feature: await project.startFeature(p.request, doc, issue) };
        } catch (e) {
          if (e instanceof SourceIssueRefused) throw new RpcError(RPC.invalidParams, e.message);
          // The owner's own document, refused before anything is stored: the client may show lines and rule ids (H-0105).
          if (e instanceof DocumentRefused) throw new RpcError(RPC.documentRefused, e.message, e.data());
          if (e instanceof SecretFound) {
            await project.secretRefused("feature.start", e);
            throw new RpcError(RPC.refused, REFUSED_MESSAGE);
          }
          throw e;
        }
      }
      case "feature.cancel": {
        only(p, ["feature", "reason"]);
        const f = feature(p.feature);
        if (p.reason !== undefined && (typeof p.reason !== "string" || [...p.reason].length > MAX_NOTE_CHARS)) {
          throw new RpcError(RPC.invalidParams, `reason must be text up to ${MAX_NOTE_CHARS} characters.`);
        }
        try {
          await project.cancelFeature(f, (p.reason ?? "").trim());
          return { ok: true };
        } catch (e) {
          if (e instanceof CancelRefused) throw new RpcError(RPC.invalidParams, e.message);
          if (e instanceof SecretFound) {
            await project.secretRefused("feature.cancel", e, f.id);
            throw new RpcError(RPC.refused, REFUSED_MESSAGE);
          }
          throw e;
        }
      }
      case "interview.list":
        only(p, []);
        return {
          features: project.features()
            .filter((f) => f.chainIntact)
            .map((f) => ({ id: f.id, title: f.state.title, ...f.state.counts() })),
        };
      case "interview.open": {
        only(p, ["feature", "takeover"]);
        const f = feature(p.feature);
        if (p.takeover !== undefined && typeof p.takeover !== "boolean") throw new RpcError(RPC.invalidParams, "takeover must be true or false.");
        // The Security item was filed when the tampering was found.
        if (!f.chainIntact) throw new RpcError(RPC.refused, REFUSED_MESSAGE);
        return project.sessions.open(f.id, p.takeover === true);
      }
      case "interview.awaitApproval":
        only(p, ["session", "wait_s"]);
        return project.sessions.awaitApproval(p.session, waitS(p.wait_s, 900));
      case "interview.next": {
        only(p, ["session", "wait_s"]);
        const wait = waitS(p.wait_s, MAX_NEXT_WAIT_S);
        const s = project.sessions.approved(p.session);
        return { item: await next(feature(s.feature), s.shown, wait) };
      }
      case "interview.reply": {
        only(p, ["session", "item", "revision", "reply_id", "kind", "text"]);
        const s = project.sessions.approved(p.session);
        const f = feature(s.feature);
        const item = id(p.item, "item");
        const replyId = id(p.reply_id, "reply_id");
        if (typeof p.revision !== "number" || !Number.isSafeInteger(p.revision) || p.revision < 0) {
          throw new RpcError(RPC.invalidParams, "revision must be a non-negative integer.");
        }
        if (typeof p.kind !== "string") throw new RpcError(RPC.invalidParams, "kind must be a string.");
        if (typeof p.text !== "string") throw new RpcError(RPC.invalidParams, "text must be a string.");
        try {
          return await f.reply({ item, revision: p.revision, reply_id: replyId, kind: p.kind, text: p.text }, s.shown);
        } catch (e) {
          if (e instanceof InterviewError) {
            if (e.code === "tampered") throw new RpcError(RPC.refused, REFUSED_MESSAGE);
            const code = { stale: RPC.stale, unknown: RPC.unknown, kind: RPC.kindNotAllowed, cancelled: RPC.invalidParams }[e.code];
            throw new RpcError(code, e.message);
          }
          if (e instanceof SecretFound) {
            await project.secretRefused("interview.reply", e, f.id);
            throw new RpcError(RPC.refused, REFUSED_MESSAGE);
          }
          throw e;
        }
      }
      case "interview.state": {
        only(p, ["feature", "item"]);
        const f = feature(p.feature);
        const it = f.state.items.get(id(p.item, "item"));
        if (!it) throw new RpcError(RPC.unknown, "Unknown item.");
        return { status: it.status, revision: it.revision, ...(it.recorded_at ? { recorded_at: it.recorded_at } : {}) };
      }
      case "interview.close":
        only(p, ["session"]);
        project.sessions.close(p.session);
        return { ok: true };
      // Channel v1.6 (F-021, H-0245): the owner answers inbox items in the console too.
      case "inbox.open":
        only(p, []);
        return project.sessions.openConsole();
      case "inbox.close":
        only(p, ["session"]);
        project.sessions.close(p.session);
        return { ok: true };
      case "engine.transcript": {
        only(p, ["session", "after"]);
        project.sessions.approved(p.session);
        const after = p.after;
        if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0)) {
          throw new RpcError(RPC.invalidParams, "after must be a non-negative integer.");
        }
        return project.transcript(after as number | undefined);
      }
      case "inbox.list": {
        only(p, ["session"]);
        project.sessions.approved(p.session);
        return {
          items: (await inbox().list()).filter((r) => !held || held.shows(r)).map((r) => ({
            id: r.id, kind: r.kind, title: r.title, ...(r.feature ? { feature: r.feature } : {}),
            priority: r.effective_priority, blocking: r.blocking, rev: r.revisions[r.revisions.length - 1]!.rev,
          })),
        };
      }
      case "inbox.show": {
        only(p, ["session", "item"]);
        project.sessions.approved(p.session);
        await heldShows(inboxItem(p.item));
        const shown = await inbox().show(inboxItem(p.item));
        if (!shown) throw new RpcError(RPC.unknown, "Unknown item.");
        const r = shown.record;
        return {
          id: r.id, rev: shown.rev, kind: r.kind, title: r.title, status: r.status, ...(r.feature ? { feature: r.feature } : {}),
          sections: bodySections(shown.body), ...(shown.private ? { private: shown.private } : {}), actions: shown.actions,
        };
      }
      case "inbox.answer": {
        only(p, ["session", "item", "rev", "action", "note", "reply_id"]);
        const s = project.sessions.approved(p.session);
        const replyId = id(p.reply_id, "reply_id");
        const item = inboxItem(p.item);
        await heldShows(item);
        const rev = revision(p.rev);
        if (typeof p.action !== "string" || !ACTION_RE.test(p.action)) throw new RpcError(RPC.invalidParams, "action must be an inbox action.");
        if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > MAX_NOTE_CHARS)) throw new RpcError(RPC.invalidParams, `note must be text up to ${MAX_NOTE_CHARS} characters.`);
        const now = clock.now();
        for (const [k, v] of replies) if (now - v.at > REPLY_KEEP_MS) replies.delete(k);
        const seen = replies.get(`${s.no}/${replyId}`);
        if (seen) return seen.result;
        try {
          const result = consoleWire(await inbox().answer({ id: item, rev, action: p.action, ...(p.note !== undefined ? { note: p.note } : {}), session: s.no, signedIn: s.signedIn }));
          replies.set(`${s.no}/${replyId}`, { at: now, result });
          return result;
        } catch (e) {
          if (e instanceof SecretFound) {
            await project.secretRefused("inbox.answer", e);
            throw new RpcError(RPC.refused, REFUSED_MESSAGE);
          }
          throw e;
        }
      }
      case "inbox.confirm": {
        only(p, ["session", "item", "rev", "code"]);
        const s = project.sessions.approved(p.session);
        // A malformed code is a wrong code: it still ends the attempt (F-021 SR-2).
        const code = typeof p.code === "string" && CODE_RE.test(p.code) ? p.code : "-";
        await heldShows(inboxItem(p.item));
        try {
          return consoleWire(await inbox().confirm({ id: inboxItem(p.item), rev: revision(p.rev), code, session: s.no, signedIn: s.signedIn }));
        } catch (e) {
          if (e instanceof SecretFound) {
            await project.secretRefused("inbox.confirm", e);
            throw new RpcError(RPC.refused, REFUSED_MESSAGE);
          }
          throw e;
        }
      }
      default:
        throw new RpcError(RPC.methodNotFound, "Method not found.");
    }
  };
}
