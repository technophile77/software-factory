# Proposal 0026: The inbox lives in GitHub issues

- **Raised:** 2026-11-13, by the owner ("Do #2", review "Where the factory
  rebuilds existing tools", item 2; and "Is there already an extension for
  VS Code to view git issues, can't that be used in place of the inbox?")
- **Category:** Architecture (where inbox items are stored, ADR 0002 and
  0009). It also changes Security (what proves an owner action, ADR 0015
  decision 3) and approved requirements in F-001, F-011 and F-012, so those
  are Product decisions too.
- **Status:** Decided: option A (ADR 0022), by the owner on 2026-11-13 (decision card)
- **Scope:** the inbox: how items are stored, shown and acted on. The spec
  interview (F-005) is not changed; it stays a live session in Claude Code.

## Problem

The approved design keeps each inbox item as a file on `factory/state`
(ADR 0002, 0009). The VS Code extension shows the files (F-001, F-011), and
F-012 copies each blocking item to a GitHub issue so it can be answered from
the phone, then syncs the answer back. That is two stores for one item, and
code to keep them in step: render the issue, mark stale revisions, close
the issue when the item is acted on in VS Code, and the other way round
(F-012 FR-1 to FR-7).

GitHub issues already do what the inbox needs: labels for kind, category
and priority, open and closed state, comments and reactions as actions,
notifications in GitHub Mobile, and a record of who did what. F-012 and
ADR 0018 already accept a reaction by the owner's GitHub account as proof
of an owner action.

## The VS Code extension you asked about

Yes. Microsoft's **GitHub Pull Requests** extension
(`GitHub.vscode-pull-request-github`, MIT) lists issues in a sidebar from
saved searches (`githubIssues.queries`, GitHub search syntax), opens an
issue with its comments, lets you comment, and reviews and merges pull
requests. Its README confirms the issue list and the search syntax; a
query can name several repos (`repo:a/x repo:a/y`). I could not confirm
from its docs that it can add a reaction, so this proposal lets the owner
act by a short comment as well as by a reaction.

What it can't do that our inbox does: show an item as a card with one
button per allowed action, sort across repos by our priority (a query
per priority label does the same job), and ask "are you sure?" before a
risky action in a dialog.

## Options

### A. Issues are the inbox, and the GitHub extension is the VS Code view (recommended)

- The engine opens one issue per inbox item in the project's private
  config repo, labelled `factory-inbox`, kind, category and priority, with
  the body F-012 FR-3 already defines and one action comment per choice.
- The owner acts from anywhere: a 👍 on an action comment (as F-012
  today), or a comment such as `/choose 2`, `/defer` or `/approve`. The
  engine acts only on the owner's GitHub user id, verified through the
  API, on the item's current revision.
- Risky actions keep the confirmation step (F-011 FR-15, F-012 FR-8): the
  engine replies "Confirm?" and acts on a second 👍 or `/confirm`.
- Pull requests are merged in GitHub's own PR view (the extension, the web
  or GitHub Mobile), as ADR 0017 already allows; the engine sees the merge.
- After acting, the engine writes the outcome to `factory/state` and
  closes the issue, so every decision is still in Git history (ADR 0002's
  goal), but as a record, not as a second copy to keep in sync.
- The factory ships a ready-made `githubIssues.queries` setting, one query
  per priority, for the owner's VS Code.
- The F-001 inbox view in our extension is retired.

| | |
|---|---|
| Pros | One store, one way to act, on desktop and phone alike. F-012's sync code is never written, and most of F-011's VS Code work goes. Notifications, history and mobile come from GitHub. No new dependency |
| Cons | No buttons in VS Code: the owner reacts or types a short comment. Needs network to act (agents need it anyway). Changes four ADRs and three approved specs |

**Security, stated explicitly.** Anyone who holds the owner's GitHub
session or token could act as the owner on every inbox item, not just
from the phone. Today that is already true for PR merges (ADR 0017) and
phone actions (ADR 0018); this removes the SSH-signed commit (ADR 0015
decision 3) as the proof for VS Code actions. The control becomes
GitHub's sign-in and 2FA (OWASP LLM Top 10 2025, LLM06: high-impact
actions need human approval, which the verified owner action still is).
Agents still can't act: they run without tokens (ADR 0015 decision 1).
Issue text is visible to anyone with access to the private config repo,
so items keep the "no secrets in items" rule (S3.1).

### B. Issues are the inbox; our extension stays as a thin view over them

Same store as A. Our extension reads issues through VS Code's GitHub
sign-in and keeps the cards, buttons and confirm dialog.

| | |
|---|---|
| Pros | One store, and the VS Code experience stays as specified |
| Cons | We still build and maintain an inbox UI; most of F-011's VS Code work stays |

### C. Keep the approved design

Files on `factory/state`, the extension, and the F-012 phone mirror.

| | |
|---|---|
| Pros | No spec or ADR changes; works offline; signed owner actions |
| Cons | Two stores and the sync code between them, still to be built |

## What changes if A is approved

1. A new ADR records it, superseding ADR 0002 and 0011 for inbox
   items and amending 0009, 0015 decision 3, 0017 and 0018.
2. F-001, F-011 and F-012 are revised through the requirements interview
   (new versions, Security Gate 1 again), and the Inbox item contract gets
   a new major version. None of the three is built past F-001's view, so
   nothing that works today breaks before the new specs are approved.
3. Hygiene items (H-0161 to H-0165) for the engine, the config repo workflow,
   the query setting, and retiring the extension's inbox view.

## Recommendation

Option A. It answers your question directly: the GitHub extension becomes
the VS Code view, and the inbox stops being something we build. The cost
is typing a short comment instead of clicking a button.

## Cost of delay

Medium. F-011 and F-012 are approved and waiting to be built; building
them first would then be thrown away.

## Outcome (2026-11-13)

The owner chose option A. Recorded as ADR 0022. Hygiene items H-0161 to H-0165 cover the engine's issue store and owner-action reading, the config repo workflow, the `githubIssues.queries` setting, retiring the extension's inbox view, and the Inbox item contract's new major version. Spec changes go through the requirements interview before anything is built.
