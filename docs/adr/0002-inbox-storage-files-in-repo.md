# 0002. Inbox items and decisions stored as one file per item in the repo

- **Status:** Superseded by 0022 for inbox items
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open decision 3; write-up in `docs/proposals/0003-inbox-storage.md`

## Problem
Decision, testing, and configuration hygiene items must persist, show status
and priority, keep a full history, and be traceable in Git.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| One file per item in the repo | Every decision in Git history; diffable, revertible; readable without the extension; no database | Queries scan files; large logs don't belong in Git |
| SQLite | Fast queries, transactions | Binary; not traceable in Git |
| Files + SQLite index | Traceable and fast | Two stores to keep in sync |

## Implications
- **Maintenance:** no database to run or migrate; the item schema is an interface contract.
- **Performance:** fine at the expected volume (dozens of open items).
- **Security:** anyone with repo access can read decisions; items must never contain secrets (S3.1).
- **Long term:** a rebuildable index can be added later without changing the record.

## Decision
Each inbox item is one file under `.factory/inbox/<inbox>/<id>`, committed to
Git. The VS Code extension and the engine read and watch these files.
Large logs and transcripts are stored outside Git and linked from the item.

## Consequences
- The item file format (fields, encoding such as JSON or Markdown with
  frontmatter) is a new **Interfaces** decision.
- Where large logs and transcripts live is a follow-on decision.
- State changes to items are commits, so the decision record is the Git log.
