import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { InboxItem, ParseResult, Priority, Status } from "./types";

const ID_PATTERN = /^[DTH]-\d{4,}$/;
const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];
const STATUSES: Status[] = [
  "open",
  "approved",
  "rejected",
  "changes_requested",
  "research_requested",
  "deferred",
];
const INBOXES = ["decision", "testing", "hygiene"];
const CATEGORIES = ["Product", "Architecture", "Interfaces", "Assumptions", "Security"];

// Fields this module understands; anything else is carried in `extra` so a
// newer engine's fields survive an older extension writing the file (SR-5).
const KNOWN_FIELDS = [
  "schema",
  "id",
  "inbox",
  "title",
  "category",
  "priority",
  "effective_priority",
  "blocking",
  "status",
  "feature",
  "created_by",
  "created_at",
  "options",
  "recommendation",
  "links",
  "history",
] as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function isValidItemId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function parseItem(text: string, path: string): ParseResult {
  const fail = (message: string): ParseResult => ({ ok: false, error: { path, message } });

  const match = FRONTMATTER.exec(text);
  if (!match) return fail("missing YAML frontmatter");

  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch (e) {
    return fail(`invalid YAML: ${(e as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return fail("frontmatter is not a mapping");
  }
  const fm = data as Record<string, unknown>;

  for (const key of ["schema", "id", "inbox", "title", "priority", "status", "created_by", "created_at"]) {
    if (typeof fm[key] !== "string" || fm[key] === "") return fail(`missing or invalid field: ${key}`);
  }
  if (typeof fm.blocking !== "boolean") return fail("missing or invalid field: blocking");
  if (!String(fm.schema).startsWith("inbox-item/1.")) return fail(`unsupported schema: ${fm.schema}`);
  if (!isValidItemId(fm.id as string)) return fail(`invalid id: ${fm.id}`);
  if (!INBOXES.includes(fm.inbox as string)) return fail(`invalid inbox: ${fm.inbox}`);
  if (!PRIORITIES.includes(fm.priority as Priority)) return fail(`invalid priority: ${fm.priority}`);
  const effective = fm.effective_priority ?? fm.priority;
  if (!PRIORITIES.includes(effective as Priority)) return fail(`invalid effective_priority: ${effective}`);
  if (!STATUSES.includes(fm.status as Status)) return fail(`invalid status: ${fm.status}`);
  if (fm.category !== undefined && !CATEGORIES.includes(fm.category as string)) {
    return fail(`invalid category: ${fm.category}`);
  }
  if (fm.options !== undefined && !isListOf(fm.options, ["id", "label"])) return fail("invalid options");
  if (fm.links !== undefined && !isListOf(fm.links, ["kind", "ref"])) return fail("invalid links");
  // history is required: every item starts with its "filed" entry, and an
  // item without one can't show who raised it.
  if (fm.history === undefined) return fail("missing or invalid field: history");
  const history = fm.history;
  if (!isListOf(history, ["at", "by", "action"])) return fail("invalid history");

  // Null prototype so a "__proto__" key is kept as data, not dropped (SR-5).
  const extra: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(fm)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(k)) extra[k] = v;
  }

  const item: InboxItem = {
    schema: fm.schema as string,
    id: fm.id as string,
    inbox: fm.inbox as InboxItem["inbox"],
    title: fm.title as string,
    priority: fm.priority as Priority,
    effective_priority: effective as Priority,
    blocking: fm.blocking,
    status: fm.status as Status,
    created_by: fm.created_by as string,
    created_at: fm.created_at as string,
    history: history as InboxItem["history"],
    body: match[2],
    extra,
  };
  if (fm.category !== undefined) item.category = fm.category as InboxItem["category"];
  if (fm.feature !== undefined) item.feature = String(fm.feature);
  if (fm.options !== undefined) item.options = fm.options as InboxItem["options"];
  if (fm.recommendation !== undefined) item.recommendation = String(fm.recommendation);
  if (fm.links !== undefined) item.links = fm.links as InboxItem["links"];
  return { ok: true, item };
}

export function serializeItem(item: InboxItem): string {
  const { body, extra, ...known } = item;
  const fm: Record<string, unknown> = Object.create(null);
  for (const key of KNOWN_FIELDS) {
    const value = (known as Record<string, unknown>)[key];
    if (value !== undefined) fm[key] = value;
  }
  for (const [k, v] of Object.entries(extra)) fm[k] = v;
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${body}`;
}

function isListOf(value: unknown, requiredStringKeys: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        requiredStringKeys.every((k) => typeof (v as Record<string, unknown>)[k] === "string"),
    )
  );
}
