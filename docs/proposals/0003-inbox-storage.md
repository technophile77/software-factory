# Proposal: persistent storage for inbox items and decisions (open decision 3)

- **Category:** Architecture
- **Blocks:** the three inboxes, the decision record, the extension's data layer
- **Cost of delay:** no inbox can be built
- **Status:** Decided: option A (ADR 0002)

## Problem
Inbox items (decisions, testing problems, hygiene proposals) need to persist,
show status and priority, keep a full history, and be linkable to files,
logs, and diffs. The spec also wants a persistent record of decisions and
Git-based traceability.

## Options

### A. Files in the repository, one per item (recommended)
`.factory/inbox/<type>/<id>.json` (or Markdown with frontmatter), plus
`.factory/runs/` for logs and transcripts (git-ignored or stored separately
if large). The extension watches the folder.

| | |
|---|---|
| Pros | Every decision is in Git history: traceable, diffable, revertible; readable without the extension; no database to run; agents can read and write them with normal tools |
| Cons | Querying many items means scanning files; concurrent writes need care (one file per item avoids most conflicts); large logs don't belong in Git |
| Security | Decisions are visible to anyone with repo access; secrets must never be written to items |

### B. SQLite file managed by the extension/engine

| | |
|---|---|
| Pros | Fast queries, transactions, easy prioritized views |
| Cons | Binary file, not diffable; decisions not traceable in Git unless exported; agents need an API to touch it |

### C. Hybrid: files are the record, SQLite is a rebuildable index

| | |
|---|---|
| Pros | Git traceability plus fast queries |
| Cons | Two things to keep in sync; more to build up front |

## Recommendation
**A** now, moving to **C** only if the inbox gets slow. The volume (a few
dozen open items) doesn't justify a database, and Git traceability is a hard
requirement in the spec.
