import { PRIORITY_ORDER } from "./queue";
import type { HistoryEntry, InboxItem, OwnerAction } from "./types";

export class ActionError extends Error {}

export function applyAction(item: InboxItem, action: OwnerAction, at: string): InboxItem {
  if (item.status === "approved" || item.status === "rejected") {
    throw new ActionError(`${item.id} is already ${item.status}`);
  }

  const next: InboxItem = { ...item, history: [...item.history] };
  const entry: HistoryEntry = { at, by: "owner", action: "approved" };

  switch (action.type) {
    case "approve": {
      if (item.options && item.options.length > 0) {
        if (!action.option) throw new ActionError("Choose an option before approving.");
        if (!item.options.some((o) => o.id === action.option)) {
          throw new ActionError(`Unknown option: ${action.option}`);
        }
      }
      next.status = "approved";
      entry.action = "approved";
      if (action.option) entry.option = action.option;
      break;
    }
    case "reject":
      next.status = "rejected";
      entry.action = "rejected";
      break;
    case "request_changes":
      requireNote(action.note, "Say what should change.");
      next.status = "changes_requested";
      entry.action = "changes_requested";
      break;
    case "request_research":
      requireNote(action.note, "Say what to research.");
      next.status = "research_requested";
      entry.action = "research_requested";
      break;
    case "defer": {
      // Deferral only lowers the sort position; blocking stays as filed,
      // because deferring is never approval (spec §4.1).
      const i = PRIORITY_ORDER.indexOf(item.effective_priority);
      next.effective_priority = PRIORITY_ORDER[Math.min(i + 1, PRIORITY_ORDER.length - 1)];
      next.status = "deferred";
      entry.action = "deferred";
      break;
    }
    case "restore":
      if (item.status !== "deferred") throw new ActionError(`${item.id} is not deferred`);
      next.effective_priority = item.priority;
      next.status = "open";
      entry.action = "restored";
      break;
  }

  if ("note" in action && action.note) entry.note = action.note;
  next.history.push(entry);
  return next;
}

function requireNote(note: string | undefined, message: string): void {
  if (!note || note.trim() === "") throw new ActionError(message);
}
