/**
 * Inbox item v3.0 (F-011 H-0165): items are GitHub issues in the project's
 * config repo, and their records live on the config repo's factory/state at
 * `inbox/<id>.yaml`. This module holds the parts every other inbox module
 * shares: kinds, actions, ids and the record shape.
 */

export type Kind = "decision" | "testing" | "hygiene" | "spec" | "maturity" | "notice";
export type Category = "Product" | "Architecture" | "Interfaces" | "Assumptions" | "Security";
export type Priority = "critical" | "high" | "medium" | "low";

export const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];
export const KIND_PREFIX: Record<Kind, string> = { decision: "D", testing: "T", hygiene: "H", spec: "S", maturity: "M", notice: "N" };
export const KIND_TITLE: Record<Kind, string> = {
  decision: "Decision", testing: "Testing", hygiene: "Hygiene", spec: "Spec sign-off", maturity: "Maturity", notice: "Notice",
};
export const ID_RE = /^[DTHSMN]-\d{4,}$/;
export const OPTION_RE = /^[A-D]$/;

/** One sections block of the kind's template, in its fixed order (Inbox item v3.0 "Body"). */
export const SECTIONS: Record<Kind, string[]> = {
  decision: ["Context", "Options", "Project impact", "Recommendation", "Cost of delay"],
  testing: ["Expected", "Actual", "Logs", "Root cause", "Recovery attempts", "Recommended next step"],
  hygiene: ["File", "Reason", "Diff", "Benefits", "Risks", "Recommendation"],
  spec: ["Summary", "Readiness", "Open items"],
  maturity: ["Evidence", "Gaps", "Recommendation"],
  notice: ["Details"],
};

/**
 * Text for one section. `engine` text is the engine's own words, written as
 * is; `outside` text can come from outside the factory (reviewer quotes, PR
 * titles) and is fenced under a line naming its author (F-011 SR-10).
 */
export type Part = { engine: string } | { outside: string; author: string };

export interface ItemInput {
  kind: Kind;
  title: string;
  category?: Category;
  priority: Priority;
  blocking: boolean;
  repo?: string;
  feature?: string;
  created_by: string;
  /** Decision only: 2 to 4 options with ids A to D. */
  options?: Array<{ id: string; label: string }>;
  recommendation?: string;
  /** Testing only: the listed steps, numbered from 1. */
  steps?: string[];
  links?: Array<{ kind: string; ref: string }>;
  /** Keyed by the kind's section names; a missing section renders as "None.". */
  sections: Record<string, Part[]>;
  /** What the engine does once the owner acts (F-016 FR-3 to FR-9): fixed by code, never by item text (F-016 SR-4). */
  effect?: { type: string; [k: string]: unknown };
  /** Keeps a type's item from being filed twice (engine `alert` keys). */
  key?: string;
  /**
   * F-021 FR-4: detail kept only on the PC and shown only in the console.
   * Never rendered into the body, the record or anything sent anywhere (SR-5).
   */
  private?: Array<{ name: string; text: string }>;
}

/** An action's id, as the marker of its action comment names it: `choose:A`, `step:2`, `approve`, ... */
export type ActionId = string;

export function actionsFor(item: Pick<ItemInput, "kind" | "options" | "steps">): ActionId[] {
  switch (item.kind) {
    case "decision":
      return [...(item.options ?? []).map((o) => `choose:${o.id}`), "reject", "changes", "research", "defer", "restore"];
    case "hygiene":
      return ["approve", "reject", "changes", "defer"];
    case "testing":
      return [...(item.steps ?? []).map((_, i) => `step:${i + 1}`), "research", "defer"];
    case "spec":
      return ["approve", "changes", "defer"];
    case "maturity":
      return ["approve", "reject", "defer"];
    case "notice":
      return ["dismiss"];
  }
}

/** F-011 FR-11: actions that need a second, confirming step. */
export function isRisky(item: Pick<ItemInput, "kind" | "category">, action: ActionId): boolean {
  if (action === "approve") return item.kind === "hygiene" || item.kind === "maturity" || item.kind === "spec";
  return item.kind === "decision" && item.category === "Security" && action.startsWith("choose:");
}

/** Actions that leave the issue open (F-011 FR-7). */
export const KEEPS_OPEN = new Set<ActionId>(["defer", "restore", "research"]);

export type Status =
  | "open" | "approved" | "chosen" | "rejected" | "changes_requested" | "research_requested" | "deferred" | "dismissed" | "closed";

export type HistoryAction =
  | "filed" | "revised" | "confirm_requested" | "closed" | "migrated" | "reopened" | "effect_done"
  | "chosen" | "approved" | "rejected" | "changes_requested" | "research_requested" | "deferred" | "restored" | "dismissed" | "step_chosen";

export interface History {
  at: string;
  by: "engine" | "owner";
  action: HistoryAction;
  option?: string;
  step?: number;
  rev?: number;
  /** `console` from F-021: answered through the engine channel, proven by the local answer file (FR-10). */
  source?: "reaction" | "command" | "console";
  /** Console answers only: whether the console session signed in to GitHub (FR-13). */
  signed_in?: boolean;
  /** Console answers only: sha256 of the entry without this field, as the local answer file holds it (FR-10). */
  console_answer?: string;
  actor_id?: number;
  comment_id?: number;
  reaction_id?: number;
  ref?: string;
  note?: string;
  confirmed_by?: { source: "reaction" | "command"; comment_id: number; reaction_id?: number } | { source: "console" };
  /** confirm_requested only. */
  pending?: ActionId;
  code?: string;
  /** effect_done only (F-016 H-0180). */
  effect?: string;
  stage?: string;
  /** migrated only. */
  from?: string;
}

export interface Revision {
  rev: number;
  body_sha256: string;
  /** The body as GitHub returned it once the issue was found; actions on any other body record nothing (F-011 SR-8). */
  issue_body_sha256?: string;
  action_comments: Array<{ id: number; action: ActionId; sha256: string }>;
  dispatched?: boolean;
}

export interface InboxRecord {
  schema: "inbox-record/3.0";
  id: string;
  kind: Kind;
  title: string;
  category?: Category;
  priority: Priority;
  effective_priority: Priority;
  blocking: boolean;
  status: Status;
  repo: string;
  feature?: string;
  created_by: string;
  created_at: string;
  issue?: number;
  options?: Array<{ id: string; label: string }>;
  recommendation?: string;
  steps?: string[];
  links: Array<{ kind: string; ref: string }>;
  effect?: { type: string; [k: string]: unknown };
  key?: string;
  revisions: Revision[];
  /** Never read as commands (F-011 SR-17). */
  engine_comments: number[];
  /** Comment and reaction ids already answered with "Not recorded", so each gets one reply. */
  refused?: Array<{ comment_id?: number; reaction_id?: number; reason: string }>;
  history: History[];
}

/** The record's own path and the rendered body's path for a revision, on the config repo's factory/state. */
export const recordPath = (id: string) => `inbox/${id}.yaml`;
export const bodyPath = (id: string, rev: number) => `inbox/${id}.rev${rev}.md`;

export const currentRevision = (r: InboxRecord): Revision => r.revisions[r.revisions.length - 1]!;
