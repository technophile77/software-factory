// Shapes from the Inbox item v1.0 contract (docs/interface-contracts.md).
// The core modules are free of VS Code imports so they can be tested in plain Node.

export type Priority = "critical" | "high" | "medium" | "low";

export type Status =
  | "open"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "research_requested"
  | "deferred";

export type Category = "Product" | "Architecture" | "Interfaces" | "Assumptions" | "Security";

export type HistoryAction =
  | "filed"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "research_requested"
  | "deferred"
  | "restored";

export interface HistoryEntry {
  at: string;
  by: string;
  action: HistoryAction;
  option?: string;
  note?: string;
}

export interface ItemOption {
  id: string;
  label: string;
}

export interface ItemLink {
  kind: string;
  ref: string;
}

export interface InboxItem {
  schema: string;
  id: string;
  inbox: "decision" | "testing" | "hygiene";
  title: string;
  category?: Category;
  priority: Priority;
  effective_priority: Priority;
  blocking: boolean;
  status: Status;
  feature?: string;
  created_by: string;
  created_at: string;
  options?: ItemOption[];
  recommendation?: string;
  links?: ItemLink[];
  history: HistoryEntry[];
  /** Markdown body after the frontmatter. */
  body: string;
  /** Frontmatter fields this version doesn't know about; written back unchanged. */
  extra: Record<string, unknown>;
}

export interface ItemError {
  path: string;
  message: string;
}

export type ParseResult = { ok: true; item: InboxItem } | { ok: false; error: ItemError };

export type OwnerAction =
  | { type: "approve"; option?: string; note?: string }
  | { type: "reject"; note?: string }
  | { type: "request_changes"; note: string }
  | { type: "request_research"; note: string }
  | { type: "defer"; note?: string }
  | { type: "restore" };

/** A repo folder open in the workspace, with its checked-out `.factory/` state worktree. */
export interface RepoRoot {
  name: string;
  repoDir: string;
  factoryDir: string;
}

export interface QueueEntry {
  repo: string;
  path: string;
  item: InboxItem;
}

export type ResolvedLink =
  | { kind: "file"; absPath: string }
  | { kind: "url"; url: string }
  | { kind: "refused"; reason: string };

/** Runs git with an argument list in a directory. Never a shell (SR-4). */
export type GitRunner = (cwd: string, args: string[]) => Promise<void>;
