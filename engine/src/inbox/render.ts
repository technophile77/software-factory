import * as crypto from "node:crypto";
import { plain } from "../gate1/render";
import {
  ActionId, InboxRecord, ItemInput, KIND_TITLE, Kind, Part, Priority, SECTIONS,
} from "./model";

/** GitHub's issue body limit is 65,536 characters; the marker and revision line need the rest. */
export const MAX_BODY_CHARS = 60_000;
const MAX_TITLE_CHARS = 120;
const MAX_FENCED_CHARS = 8_000;

export const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** GitHub stores bodies with CRLF from some clients and trims the end; hashes compare this form. */
export const normalBody = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\s+$/, "");

/**
 * F-011 SR-10: outside text inside a fenced block, which Markdown never
 * reads as links, images, headings or HTML. The fence is longer than any
 * backtick run in the text, so the text can't close it. @mentions are broken
 * with a zero-width joiner so GitHub notifies nobody, and image links lose
 * their scheme so nothing is fetched even if a renderer ignores the fence.
 */
export function fenced(text: string, author: string): string {
  let t = text.replace(/\r\n?/g, "\n");
  if (t.length > MAX_FENCED_CHARS) t = `${t.slice(0, MAX_FENCED_CHARS)}\n[cut by the engine at ${MAX_FENCED_CHARS} characters]`;
  t = t.replace(/@(?=[A-Za-z0-9])/g, "@‍").replace(/!\[/g, "!‍[").replace(/https?:\/\//gi, (m) => m.replace("//", "/‍/"));
  const longest = Math.max(2, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `Written by ${plain(author)}, shown as plain text:\n\n${fence}text\n${t}\n${fence}`;
}

function part(p: Part): string {
  return "engine" in p ? p.engine : fenced(p.outside, p.author);
}

/** F-011 FR-1, SR-19: `<id> <Kind>[ (<Category>)]: <title>`, at most 120 characters. */
export function renderTitle(id: string, item: Pick<ItemInput, "kind" | "category" | "title">): string {
  if (item.category === "Security") return `${id} Decision (Security): needs your decision`;
  const head = `${id} ${KIND_TITLE[item.kind]}${item.kind === "decision" && item.category ? ` (${item.category})` : ""}: `;
  const title = item.title.replace(/\s+/g, " ").trim();
  return (head + title).length <= MAX_TITLE_CHARS ? head + title : `${head}${title.slice(0, MAX_TITLE_CHARS - head.length - 1)}…`;
}

export function renderLabels(item: Pick<InboxRecord, "kind" | "category" | "effective_priority" | "blocking">): string[] {
  return [
    "factory-inbox",
    `kind:${item.kind}`,
    ...(item.kind === "decision" && item.category ? [`category:${item.category.toLowerCase()}`] : []),
    `priority:${item.effective_priority}`,
    ...(item.blocking ? ["blocking"] : []),
  ];
}

/** Inbox item v3.0 "Body": the marker, the kind's sections in order, then the revision line. */
export function renderBody(id: string, rev: number, item: ItemInput): string {
  const out = [`<!-- factory-item: ${id} rev ${rev} -->`];
  for (const name of SECTIONS[item.kind]) {
    const parts = item.sections[name];
    out.push(`## ${name}`, parts?.length ? parts.map(part).join("\n\n") : "None.");
  }
  out.push(`Revision ${rev}.`);
  const body = out.join("\n\n");
  if (body.length > MAX_BODY_CHARS) throw new Error(`the rendered body of ${id} is over ${MAX_BODY_CHARS} characters`);
  return body;
}

/** The label line of an action comment (Inbox item v3.0 "Action comments"). */
export function actionLabel(item: Pick<ItemInput, "options" | "steps">, action: ActionId): string {
  const [verb, arg] = action.split(":");
  switch (verb) {
    case "choose": {
      const o = item.options?.find((x) => x.id === arg);
      return `Option ${arg}: ${plain(o?.label ?? "")}`;
    }
    case "step":
      return `Step ${arg}: ${plain(item.steps?.[Number(arg) - 1] ?? "")}`;
    case "approve": return "Approve";
    case "reject": return "Reject";
    case "changes": return "Request changes: reply with /changes <note>";
    case "research": return "Ask for more research: reply with /research <note>";
    case "defer": return "Defer";
    case "restore": return "Restore priority";
    case "dismiss": return "Dismiss";
    default: throw new Error(`unknown action ${action}`);
  }
}

export function actionComment(id: string, rev: number, item: Pick<ItemInput, "options" | "steps">, action: ActionId): string {
  return `<!-- factory-action: ${id} rev ${rev} ${action} -->\n${actionLabel(item, action)}`;
}

export const ACTION_MARKER_RE = /^<!-- factory-action: ([DTHSMN]-\d{4,}) rev ([1-9]\d{0,5}) ([a-z]+(?::[A-Z0-9]{1,2})?) -->(?:\n|$)/;
export const ITEM_MARKER_RE = /^<!-- factory-item: ([DTHSMN]-\d{4,}) rev ([1-9]\d{0,5}) -->(?:\n|$)/;

/**
 * Engine comments (Inbox item v3.0, F-011 SR-17): fixed texts, each starting
 * with a word that is not a command, whatever the fields hold.
 */
export const engineText = {
  /** `what` and `target` are built from engine text and already-escaped labels (actionWords). */
  confirm: (what: string, target: string, code: string) =>
    `Confirm: ${what} ${target}. React 🚀 or reply /confirm ${code} within 15 minutes.`,
  recorded: (what: string) => `Recorded: ${what}.`,
  /** F-021 FR-8, SR-7: the owner answered in the console. */
  recordedConsole: (what: string) => `Recorded from the console: ${what}.`,
  notRecorded: (reason: RefuseReason) => `Not recorded: ${reason}.`,
  stale: (rev: number) => `Stale: revision ${rev} replaces this.`,
  reopened: () => "Reopened: the factory's record still has this item open. Act on it here, or Dismiss or Reject it.",
};

export type RefuseReason =
  | "changed since" | "two actions chosen" | "confirm expired" | "comment edited" | "not a command" | "not the owner";

/** What the owner chose, in words for `Recorded:` and the confirm comment. */
export function actionWords(item: Pick<ItemInput, "options" | "steps">, action: ActionId): string {
  return actionLabel(item, action).replace(/: reply with .*$/, "");
}

export function priorityLower(p: Priority): Priority {
  return p === "critical" ? "high" : p === "high" ? "medium" : "low";
}

export function kindOf(id: string): Kind {
  return ({ D: "decision", T: "testing", H: "hygiene", S: "spec", M: "maturity", N: "notice" } as const)[id[0] as "D"];
}
