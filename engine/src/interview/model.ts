import type { Entry } from "../state/transcript";

export type ItemKind = "question" | "assumption";
export type ItemStatus = "open" | "deferred" | "researching" | "answered" | "approved" | "rejected" | "superseded";
export type ReplyKind = "answer" | "more_info" | "defer" | "approve_assumption" | "reject_assumption";

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
}

export interface Item extends ItemContent {
  id: string;
  revision: number;
  kind: ItemKind;
  status: ItemStatus;
  created_at: string;
  recorded_at?: string;
  research_calls: number;
}

/** The channel's Item (v1.1), with nothing the engine keeps for itself. */
export interface WireItem extends ItemContent {
  id: string;
  revision: number;
  kind: ItemKind;
  status: ItemStatus;
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
/** Channel v1.3 advisor kinds: refused with kind_not_allowed until the advisor increment (FR-4). */
export const ADVISOR_REPLIES: readonly string[] = ["ask_advisor", "approve_advisor", "decline_advisor"];
export const REPLY_STATUS: Record<ReplyKind, ItemStatus> = {
  answer: "answered",
  more_info: "researching",
  defer: "deferred",
  approve_assumption: "approved",
  reject_assumption: "rejected",
};
/** Statuses that still take an owner reply. */
export const REPLYABLE: readonly ItemStatus[] = ["open", "deferred", "researching"];

export function wire(item: Item): WireItem {
  const out: WireItem = { id: item.id, revision: item.revision, kind: item.kind, text: item.text, why: item.why, status: item.status };
  if (item.suggested !== undefined) out.suggested = item.suggested;
  if (item.options !== undefined) out.options = [...item.options];
  if (item.findings !== undefined) out.findings = item.findings.map((f) => ({ ...f }));
  return out;
}

export function content(src: Record<string, unknown>): ItemContent {
  const c: ItemContent = { text: src.text as string, why: src.why as string };
  if (src.suggested !== undefined) c.suggested = src.suggested as string;
  if (src.options !== undefined) c.options = [...(src.options as string[])];
  if (src.findings !== undefined) c.findings = (src.findings as Finding[]).map((f) => ({ text: f.text, source: f.source }));
  return c;
}

/** Everything the engine knows about one feature's interview, rebuilt from its transcript. */
export class InterviewState {
  title = "";
  branch = "";
  request = "";
  stage = "requirements_interview";
  readonly items = new Map<string, Item>();
  readonly order: string[] = [];
  readonly replies = new Map<string, ReplyRecord>();
  /** Reply ids recorded but not yet handed to the analyst. */
  readonly undelivered: string[] = [];
  researchCalls = 0;
  lastSpecReady: { passed: boolean; at: string } | null = null;

  apply(e: Entry): void {
    switch (e.type) {
      case "feature_started":
        this.title = e.title as string;
        this.branch = e.branch as string;
        this.request = e.request as string;
        break;
      case "item_created": {
        const src = e.item as Record<string, unknown>;
        const item: Item = {
          ...content(src), id: src.id as string, kind: src.kind as ItemKind, revision: 0, status: "open",
          created_at: e.at, research_calls: 0,
        };
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
        this.lastSpecReady = { passed: e.passed as boolean, at: e.at };
        break;
      case "stage":
        this.stage = e.stage as string;
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
    return `${kind === "question" ? "Q" : "A"}-${String(n).padStart(3, "0")}`;
  }
}
