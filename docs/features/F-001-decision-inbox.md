# Feature: Decision inbox in VS Code

- **Id:** F-001
- **Status:** Superseded by F-011 v29 (ADR 0022; owner, 2026-11-13). Built and validated at v2; the extension is removed by H-0164 once F-011's engine side ships and the owner's projects are migrated.
- **Requested by / date:** Alex, 2026-11-08
- **Spec version:** 3

> **Superseded.** ADR 0022 moves inbox items to GitHub issues in the
> project's config repo, shown by Microsoft's GitHub Pull Requests extension
> instead of this extension's Decisions view. Carried into F-011 v20: FR-2
> and FR-12 (one queue across repos, by priority; F-011 FR-1, FR-12), FR-5
> to FR-8 (actions, notes, defer and restore, one record commit per action;
> F-011 FR-2, FR-7, FR-8), SR-1 (untrusted text rendered inert; F-011 SR-10),
> SR-4's id pattern (in Inbox item v3.0). Withdrawn: FR-1, FR-3, FR-4, FR-9 to
> FR-11, SR-2, SR-3, SR-5 and the AC-7 integration test, all about our own
> view, and A-2 (items as files). The text below is v2, kept for the record.

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
| FR-8 | Each action appends a `history` entry and is recorded as one Git commit on `factory/state` starting with the item id. |
| FR-9 | Refresh automatically when item files change on disk. |
| FR-10 | Show malformed item files as errors in the view instead of hiding them. |
| FR-11 | Links in an item open the file, diff, or URL. |
| FR-12 | With several repos open, show one combined queue across all of them, each item labeled with its repo. |

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
| AC-10 | Given two open repos each with an open item, then both appear in one list, sorted together, each labeled with its repo name. | FR-12 |
| AC-11 | Given an item link pointing outside its repo (e.g. `../../secret`), when clicked, then it is refused with a message. | SR-3 |
| AC-12 | Given an item body containing `<script>` or an `onerror` attribute, then nothing executes and the text is shown inert. | SR-1 |
| AC-9 | Given a card, then it shows title, category, priority, status, blocking, context, options with pros and cons, impact, recommendation, and cost of delay. | FR-4 |

**Evidence for AC-7 (owner decision, 2026-11-09).** At Rapid prototype, AC-7 is accepted by code inspection: a file watcher on the decision inbox with a 200 ms debounced reload. Before F-001 can count toward promotion to Alpha, a VS Code integration test (`@vscode/test-electron`) must cover AC-7, FR-9, SR-2 and the AC-2 tree marker.

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
| A-1 | Only the decision inbox is in scope; testing and hygiene inboxes come later. | Owner, 2026-11-08 | Approved |
| A-2 | Item files live on the `factory/state` branch, checked out at `.factory/`; actions commit there. | ADR 0009 | Approved |
| A-3 | Multi-root workspaces: one combined queue across all open repos, each item labeled with its repo. | Owner, 2026-11-08 | Approved |

## 9. Security considerations
| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | Item bodies are untrusted: render Markdown with raw HTML disabled, under a webview content security policy that allows no scripts except the extension's own (nonce) and no remote resources. | Analyst; Security and Testability Review (S1.2, S6.1) | Accepted |
| SR-2 | The extension never runs commands or opens links from an item without the owner clicking them. | Analyst (S6.1) | Accepted |
| SR-3 | File links resolve only inside the item's repo; URL links open only for `https:`. Anything else is refused. | Security and Testability Review (S1.4) | Accepted |
| SR-4 | Git is invoked with an argument list, never through a shell; item ids must match `^[DTH]-\d{4,}$` before use in paths or commit messages. | Security and Testability Review (S1.3) | Accepted |
| SR-5 | Writes are atomic (write to a temp file, then rename) and preserve unknown frontmatter fields. | Security and Testability Review (S5.1) | Accepted |

## 10. Interface requirements
Uses Inbox item v1.0 unchanged.

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit and approved (A-1, A-2, A-3)
- [x] Blocking decisions resolved (A-2, ADR 0009)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-08 | Draft | — |
| 2 | 2026-11-08 | Assumptions resolved; Security and Testability Review security requirements added | Owner, 2026-11-09 |
| 2.1 | 2026-11-09 | Evidence rule for AC-7 recorded (inspection now, integration test before Alpha); no requirement changed | Owner, 2026-11-09 |
| 3 | 2026-11-13 | Superseded by F-011 v20 for ADR 0022 (proposal 0026); requirements carried or withdrawn as listed at the top | Owner, 2026-11-13 (F-011 v29 sign-off, decision card) |
