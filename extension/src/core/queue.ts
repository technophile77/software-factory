import type { Priority, QueueEntry } from "./types";

export const PRIORITY_ORDER: Priority[] = ["critical", "high", "medium", "low"];

export function sortQueue(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort(
    (a, b) =>
      PRIORITY_ORDER.indexOf(a.item.effective_priority) - PRIORITY_ORDER.indexOf(b.item.effective_priority) ||
      byTime(a.item.created_at, b.item.created_at) ||
      compare(a.repo, b.repo) ||
      compare(a.item.id, b.item.id),
  );
}

export function groupByStatus(entries: QueueEntry[]): {
  open: QueueEntry[];
  deferred: QueueEntry[];
  decided: QueueEntry[];
} {
  const open: QueueEntry[] = [];
  const deferred: QueueEntry[] = [];
  const decided: QueueEntry[] = [];
  for (const e of entries) {
    if (e.item.status === "deferred") deferred.push(e);
    else if (e.item.status === "approved" || e.item.status === "rejected") decided.push(e);
    else open.push(e);
  }
  return { open: sortQueue(open), deferred: sortQueue(deferred), decided: sortQueue(decided) };
}

export function countOpenBlocking(entries: QueueEntry[]): number {
  return entries.filter(
    (e) => e.item.blocking && e.item.status !== "approved" && e.item.status !== "rejected",
  ).length;
}

// Plain code-unit comparison, so ordering is identical on every OS locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Timestamps may carry different offsets, so compare instants, not text.
function byTime(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return compare(a, b);
  return ta - tb;
}
