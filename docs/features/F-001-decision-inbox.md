# Feature: Decision inbox in VS Code

- **Id:** F-001
- **Status:** Draft (requirements interview in progress)
- **Requested by / date:** Alex, 2026-11-08
- **Spec version:** 1

## 1. Objective and business purpose
Give the owner one place in VS Code to see and act on every pending decision,
so they never have to read item files or watch agents. First feature the
factory builds for itself; usable immediately with agents run by hand.

## 2. Expected behavior
A "Factory" view in the VS Code activity bar lists open decision items from
`.factory/inbox/decision/`, sorted by effective priority, with blocking items
marked. Selecting one opens a detail card with everything needed to decide,
and buttons for the five actions. Acting on an item updates its file and
records the action in Git.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Read every decision item file that matches the Inbox item v1.0 contract. |
| FR-2 | Show items in a tree view, grouped by status (open, deferred, decided), sorted by effective priority then age. |
| FR-3 | Mark blocking items visibly; show a count of open blocking items on the view's badge. |
| FR-4 | Show a detail card with every required decision-card field and the body sections. |
| FR-5 | Provide Approve, Reject, Request changes, Ask for more research, Defer, and Restore priority. |
| FR-6 | Approve requires choosing an option when the item has options. Request changes and Ask for more research require a note. |
| FR-7 | Defer lowers effective priority one step, keeps `blocking`, keeps the item visible; Restore sets it back to `priority`. |
| FR-8 | Each action appends a `history` entry and is recorded as one Git commit starting with the item id. |
| FR-9 | Refresh automatically when item files change on disk. |
| FR-10 | Show malformed item files as errors in the view instead of hiding them. |
| FR-11 | Links in an item open the file, diff, or URL. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given three open items with priorities low, high, critical, when the view opens, then they appear critical, high, low. | FR-2 |
| AC-2 | Given an open blocking item, then it shows a blocking marker and the badge counts it. | FR-3 |
| AC-3 | Given an item with options, when the owner approves without picking an option, then the action is refused with a message. | FR-6 |
| AC-4 | Given a high-priority blocking item, when deferred, then it is still listed, effective priority is medium, blocking is still true, and history has a `deferred` entry. | FR-7, FR-8 |
| AC-5 | Given a deferred item, when restored, then effective priority equals priority again. | FR-7 |
| AC-6 | Given any action, then exactly one commit is created whose message starts with the item id and touches only that item file. | FR-8 |
| AC-7 | Given an item file edited outside VS Code, then the view updates within 2 seconds. | FR-9 |
| AC-8 | Given a file with invalid frontmatter, then the view lists it as an error with the file name. | FR-10 |
| AC-9 | Given a card, then it shows title, category, priority, status, blocking, context, options with pros and cons, impact, recommendation, and cost of delay. | FR-4 |

## 5. Constraints
- TypeScript VS Code extension (ADR 0003): tree view + one webview.
- Must follow Inbox item v1.0 exactly.
- Works on Windows, macOS, and Linux.

## 6. Edge cases
- No `.factory` folder: show a friendly empty state.
- Two edits to the same item at once (owner and an agent).
- Very long bodies; Markdown in bodies must be rendered safely.
- Item files with unknown extra fields (must be preserved on write).

## 7. Dependencies
- Inbox item v1.0 contract. No engine needed.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | Only the decision inbox is in scope; testing and hygiene inboxes come later. | | Pending |
| A-2 | Where item files live and which branch their commits go to (main is protected by ADR 0006). | | Asked |
| A-3 | Multi-root workspaces: items from every folder are shown, labeled by repo. | | Pending |

## 9. Security considerations
| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | Item bodies are untrusted: render Markdown with scripts and raw HTML disabled, under a strict webview content security policy. | Analyst (S1.2, S6.1) | Proposed |
| SR-2 | The extension never runs commands or opens links from an item without the owner clicking them. | Analyst (S6.1) | Proposed |

## 10. Interface requirements
Uses Inbox item v1.0 unchanged.

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [ ] Assumptions explicit and approved
- [ ] Blocking decisions resolved (A-2)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-08 | Draft | — |
