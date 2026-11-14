import type { Entry } from "../state/transcript";
import { currentStage, currentType } from "../legacy-names";
import type { DocumentMeta } from "./document";

export type ItemKind = "question" | "assumption" | "source_confirmation";
/** Interview tools v1.1: what a question on a document-started feature is about. */
export type QuestionType = "gap" | "conflict" | "ambiguity";
export const QUESTION_TYPES: readonly string[] = ["gap", "conflict", "ambiguity"];
export type ItemStatus = "open" | "deferred" | "researching" | "answered" | "approved" | "rejected" | "superseded";
export type ReplyKind = "answer" | "more_info" | "defer" | "approve_assumption" | "reject_assumption" | "confirm_sources" | "reopen_sources";

export interface Finding {
  text: string;
  source: string;
}

export interface ItemContent {
  text: string;
  why: string;
  suggested?: string;
  options?: string[];
  findings?: Finding[];
  type?: QuestionType;
}

/** One row of a `source_confirmation` item, built by the engine from the spec's Sources table (SR-7). */
export interface SourceRef {
  spec_ref: string;
  section: string;
  quote: string;
  /** The spec's own line for spec_ref, copied by the engine (Code Review M3). */
  spec_line: string;
}

export interface Item extends ItemContent {
  id: string;
  revision: number;
  kind: ItemKind;
  status: ItemStatus;
  created_at: string;
  recorded_at?: string;
  research_calls: number;
  /** source_confirmation only: the rows shown, and what they were built from (engine-only). */
  sources?: SourceRef[];
  spec_version?: number;
  table_sha256?: string;
}

/** The channel's Item (v1.1), with nothing the engine keeps for itself. */
export interface WireItem extends ItemContent {
  id: string;
  revision: number;
  kind: ItemKind;
  status: ItemStatus;
  sources?: SourceRef[];
}

export interface ReplyRecord {
  reply_id: string;
  item: string;
  revision: number;
  kind: ReplyKind;
  text: string;
  status: ItemStatus;
  at: string;
}

export const QUESTION_REPLIES: readonly string[] = ["answer", "more_info", "defer"];
export const ASSUMPTION_REPLIES: readonly string[] = ["approve_assumption", "reject_assumption"];
/** Channel v1.4: the owner confirms the source list, or names spec refs to ask about as questions. */
export const SOURCE_REPLIES: readonly string[] = ["confirm_sources", "reopen_sources"];
/** Channel v1.3 advisor kinds: refused with kind_not_allowed until the advisor increment (FR-4). */
export const ADVISOR_REPLIES: readonly string[] = ["ask_advisor", "approve_advisor", "decline_advisor"];
export const REPLY_STATUS: Record<ReplyKind, ItemStatus> = {
  answer: "answered",
  more_info: "researching",
  defer: "deferred",
  approve_assumption: "approved",
  reject_assumption: "rejected",
  confirm_sources: "approved",
  reopen_sources: "rejected",
};
/** Statuses that still take an owner reply. */
export const REPLYABLE: readonly ItemStatus[] = ["open", "deferred", "researching"];

export function wire(item: Item): WireItem {
  const out: WireItem = { id: item.id, revision: item.revision, kind: item.kind, text: item.text, why: item.why, status: item.status };
  if (item.suggested !== undefined) out.suggested = item.suggested;
  if (item.options !== undefined) out.options = [...item.options];
  if (item.findings !== undefined) out.findings = item.findings.map((f) => ({ ...f }));
  if (item.type !== undefined) out.type = item.type;
  if (item.sources !== undefined) out.sources = item.sources.map((r) => ({ ...r }));
  return out;
}

export function content(src: Record<string, unknown>): ItemContent {
  const c: ItemContent = { text: src.text as string, why: src.why as string };
  if (src.suggested !== undefined) c.suggested = src.suggested as string;
  if (src.options !== undefined) c.options = [...(src.options as string[])];
  if (src.findings !== undefined) c.findings = (src.findings as Finding[]).map((f) => ({ text: f.text, source: f.source }));
  if (src.type !== undefined) c.type = src.type as QuestionType;
  return c;
}

/** A Security and Testability Review finding as the transcript keeps it (F-008): the reviewer's words, scanned before they were recorded. */
export interface StReviewRecord {
  n: number;
  criterion: string;
  severity: string;
  fix: string;
  explanation: string;
  needs_owner: boolean;
  /** The Security item filed for it, if any. */
  item?: string;
  /** F-016 FR-19: a Low finding at Rapid prototype, recorded as a known issue instead of asked. */
  recorded?: boolean;
}

/** F-008: where the feature's Security and Testability Review stands. */
export interface StReviewState {
  /** Reviewer runs started, the correction resume not counted separately (SR-11 counts runs). */
  runs: number;
  /** The findings of the last valid report. */
  findings: StReviewRecord[];
  /** True from a report with findings until the FR-9 check passes. */
  pending: boolean;
  /** Why the feature waits on the owner, if it does. */
  blocked: string | null;
  /** Findings already filed as Security items under FR-13, by number. */
  riskFiled: number[];
  /** When the last valid report was recorded. */
  reportAt: string | null;
  /** How many items the interview held when that report was recorded: only later questions can answer its findings. */
  itemsAtReport: number;
  /** F-016 FR-3: choice findings the owner decided in the inbox, by number. */
  decided: Map<number, { item: string; option: string; label: string }>;
  /** F-016 FR-5: findings the owner accepted as a risk, by number, with the item. */
  accepted: Map<number, string>;
  /** F-016 FR-15: times this report's unresolved findings went back to the analyst without the owner. */
  unresolvedSent: number;
  /** F-016 FR-15: every send-back since the report, the owner's option A included, so each later failure files its own item. */
  unresolvedRounds: number;
  /** F-016 H-0182: extra runs the owner allowed past the run limit. */
  extraRuns: number;
}

/**
 * F-016: why the feature came back to the interview from an owner answer or
 * the readiness gate. The analyst gets these as data; they last until the
 * spec next passes the interview checks.
 */
export interface Return {
  why: "st_review_choice" | "st_review_reask" | "st_review_risk_accepted" | "st_review_unresolved" | "readiness_failed" | "signoff_changes" | "owner_note";
  item?: string;
  finding?: number;
  option?: string;
  label?: string;
  note?: string;
  checks?: Array<{ name: string; evidence: string }>;
  /** F-016 FR-15: what the Security and Testability Review check found missing. */
  evidence?: string;
}

/** F-016 FR-7 to FR-9: the readiness gate and spec sign-off. */
export interface ReadinessState {
  /** The last result and the spec commit it was for. */
  last: { passed: boolean; commit: string; at: string } | null;
  /** Orchestrator runs started (H-0184 caps them per feature). */
  runs: number;
  /** The open Spec sign-off item and the commit and version it names. */
  signoff: { item: string; commit: string; version: number | null } | null;
  signedOff: { item: string; commit: string; version: number | null } | null;
}

/** Everything the engine knows about one feature's interview, rebuilt from its transcript. */
export class InterviewState {
  title = "";
  branch = "";
  request = "";
  /** Set when the feature started from a document (channel v1.4); the text is on the feature branch. */
  document: DocumentMeta | null = null;
  stage = "requirements_interview";
  readonly items = new Map<string, Item>();
  readonly order: string[] = [];
  readonly replies = new Map<string, ReplyRecord>();
  /** Reply ids recorded but not yet handed to the analyst. */
  readonly undelivered: string[] = [];
  researchCalls = 0;
  lastSpecReady: { passed: boolean; at: string; spec_path: string; spec_version: number } | null = null;
  readonly stReview: StReviewState = { runs: 0, findings: [], pending: false, blocked: null, riskFiled: [], reportAt: null, itemsAtReport: 0, decided: new Map(), accepted: new Map(), extraRuns: 0, unresolvedSent: 0, unresolvedRounds: 0 };
  readonly readiness: ReadinessState = { last: null, runs: 0, signoff: null, signedOff: null };
  returns: Return[] = [];

  apply(entry: Entry): void {
    const e = current(entry);
    switch (e.type) {
      case "feature_started":
        this.title = e.title as string;
        this.branch = e.branch as string;
        this.request = e.request as string;
        if (e.document) this.document = { ...(e.document as DocumentMeta) };
        break;
      case "item_created": {
        const src = e.item as Record<string, unknown>;
        const item: Item = {
          ...content(src), id: src.id as string, kind: src.kind as ItemKind, revision: 0, status: "open",
          created_at: e.at, research_calls: 0,
        };
        if (item.kind === "source_confirmation") {
          item.sources = (src.sources as SourceRef[]).map((r) => ({ spec_ref: r.spec_ref, section: r.section, quote: r.quote, spec_line: r.spec_line ?? "" }));
          item.spec_version = src.spec_version as number;
          item.table_sha256 = src.table_sha256 as string;
          // A newer confirmation replaces any earlier one still waiting.
          for (const other of this.list("source_confirmation")) if (REPLYABLE.includes(other.status)) other.status = "superseded";
        }
        this.items.set(item.id, item);
        this.order.push(item.id);
        break;
      }
      case "item_revised": {
        const item = this.items.get(e.item as string);
        if (!item) break;
        const next = content(e as unknown as Record<string, unknown>);
        delete item.suggested;
        delete item.options;
        delete item.findings;
        delete item.type;
        Object.assign(item, next, { revision: e.revision as number, status: "open" as ItemStatus });
        break;
      }
      case "reply": {
        const item = this.items.get(e.item as string);
        if (!item) break;
        const rec: ReplyRecord = {
          reply_id: e.reply_id as string, item: item.id, revision: e.revision as number, kind: e.kind as ReplyKind,
          text: e.text as string, status: e.status as ItemStatus, at: e.at,
        };
        item.status = rec.status;
        item.recorded_at = e.at;
        this.replies.set(rec.reply_id, rec);
        this.undelivered.push(rec.reply_id);
        break;
      }
      case "delivered":
        for (const id of e.replies as string[]) {
          const i = this.undelivered.indexOf(id);
          if (i >= 0) this.undelivered.splice(i, 1);
        }
        break;
      case "research_requested": {
        const item = e.item ? this.items.get(e.item as string) : undefined;
        if (item) item.research_calls++;
        this.researchCalls++;
        break;
      }
      case "spec_ready":
        this.lastSpecReady = { passed: e.passed as boolean, at: e.at, spec_path: e.spec_path as string, spec_version: e.spec_version as number };
        if (e.passed) this.returns = [];
        break;
      case "returned":
        this.returns.push({ ...(e.return as Return) });
        if ((e.return as Return).why === "st_review_unresolved") {
          this.stReview.unresolvedRounds++;
          if (!(e.return as Return).item) this.stReview.unresolvedSent++;
        }
        break;
      case "st_review_decided":
        this.stReview.decided.set(e.finding as number, { item: e.item as string, option: e.option as string, label: e.label as string });
        break;
      case "st_review_risk_accepted":
        this.stReview.accepted.set(e.finding as number, e.item as string);
        break;
      case "st_review_reask": {
        const n = e.finding as number;
        this.stReview.riskFiled = this.stReview.riskFiled.filter((x) => x !== n);
        this.stReview.accepted.delete(n);
        this.stReview.decided.delete(n);
        // F-016 H-0182: a re-asked finding is settled by an interview question now, not by its Security item.
        const rec = this.stReview.findings.find((x) => x.n === n);
        if (rec) rec.needs_owner = false;
        break;
      }
      case "st_review_unblocked":
        this.stReview.blocked = null;
        break;
      case "st_review_extra_run":
        this.stReview.extraRuns++;
        this.stReview.blocked = null;
        break;
      case "readiness_run":
        this.readiness.runs++;
        break;
      case "readiness_result":
        this.readiness.last = { passed: e.passed as boolean, commit: e.commit as string, at: e.at };
        break;
      case "signoff_filed":
        this.readiness.signoff = { item: e.item as string, commit: e.commit as string, version: (e.version as number | null) ?? null };
        break;
      case "spec_signed_off":
        this.readiness.signedOff = { item: e.item as string, commit: e.commit as string, version: (e.version as number | null) ?? null };
        this.readiness.signoff = null;
        break;
      case "signoff_withdrawn":
        this.readiness.signoff = null;
        break;
      case "stage":
        this.stage = e.stage as string;
        break;
      case "st_review_run":
        this.stReview.runs++;
        break;
      case "st_review_report":
        this.stReview.findings = (e.findings as StReviewRecord[]).map((f) => ({ ...f }));
        this.stReview.pending = this.stReview.findings.some((f) => !f.recorded);
        this.stReview.riskFiled = [];
        this.stReview.reportAt = e.at;
        this.stReview.itemsAtReport = this.order.length;
        this.stReview.decided.clear();
        this.stReview.accepted.clear();
        this.stReview.unresolvedSent = 0;
        this.stReview.unresolvedRounds = 0;
        break;
      case "st_review_blocked":
        this.stReview.blocked = e.reason as string;
        for (const n of (e.risk as number[] | undefined) ?? []) if (!this.stReview.riskFiled.includes(n)) this.stReview.riskFiled.push(n);
        break;
      case "st_review_resolved":
        if (e.passed) {
          this.stReview.pending = false;
          this.stReview.blocked = null;
        }
        break;
      default:
        // session_approved, cap_reached and other audit entries change no state.
        break;
    }
  }

  list(kind?: ItemKind): Item[] {
    return this.order.map((id) => this.items.get(id)!).filter((i) => !kind || i.kind === kind);
  }

  counts(): { open: number; deferred: number; pending_assumptions: number } {
    const qs = this.list("question");
    return {
      open: qs.filter((q) => q.status === "open").length,
      deferred: qs.filter((q) => q.status === "deferred").length,
      pending_assumptions: this.list("assumption").filter((a) => a.status === "open").length,
    };
  }

  nextId(kind: ItemKind): string {
    const n = this.list(kind).length + 1;
    return `${{ question: "Q", assumption: "A", source_confirmation: "S" }[kind]}-${String(n).padStart(3, "0")}`;
  }
}

/** Entries written before the gate rename read as if written with the new ids (see legacy-names.ts). */
function current(e: Entry): Entry {
  const type = currentType(e.type as string);
  const stage = typeof e.stage === "string" ? currentStage(e.stage) : e.stage;
  const ret = e.return as Return | undefined;
  const why = ret && typeof ret.why === "string" ? (currentType(ret.why) as Return["why"]) : undefined;
  if (type === e.type && stage === e.stage && why === ret?.why) return e;
  return { ...e, type, ...(stage !== undefined ? { stage } : {}), ...(ret ? { return: { ...ret, why: why! } } : {}) } as Entry;
}
