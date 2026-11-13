# 0022. The inbox lives in GitHub issues

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner (decision card, option A)
- **Decision item:** `docs/proposals/0026-inbox-on-github-issues.md`

## Problem
Inbox items were files on `factory/state` (ADR 0002, 0009), shown by our
VS Code extension (F-001, F-011) and mirrored to GitHub issues for the
phone (F-012). Two stores for one item need sync code, and GitHub issues
already give labels, state, comments, reactions, notifications and a record
of who acted.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. Issues are the inbox; GitHub's VS Code extension is the view** | One store, one way to act on desktop and phone; no inbox UI or sync to build | No per-action buttons in VS Code; acting needs network; every action proven by the GitHub account |
| B. Issues are the inbox; our extension is a thin view | One store; buttons and confirm dialog stay | We still build an inbox UI |
| C. Keep files plus the phone mirror | No spec changes; offline; signed actions | Two stores and their sync |

## Implications
- **Security, residual risk (stated to the owner):** anyone holding the
  owner's GitHub session or token can act on any inbox item. The control
  is GitHub's sign-in and 2FA, as for merges (ADR 0017) and phone actions
  (ADR 0018). Agents can't act: they run without tokens (ADR 0015
  decision 1). Issues live only in the project's private config repo, and
  items never contain secrets (S3.1).
- **Standards:** OWASP LLM Top 10 2025, LLM06 (excessive agency): the
  verified owner action is the human approval for high-impact actions.
- **Maintenance:** F-012's sync code and F-011's VS Code inbox work are
  dropped; the engine renders issues and reads owner actions.

## Decision
1. Each inbox item is one issue in the project's private config repo,
   labelled `factory-inbox`, kind, category and priority, rendered by the
   engine from fixed templates, with one action comment per choice.
2. The owner acts by a 👍 on an action comment or by a command comment
   (`/choose <n>`, `/defer`, `/approve`, ...). The engine acts only on the
   configured owner's GitHub user id, verified through the API, on the
   item's current revision. Risky actions (F-011 FR-15) need a second
   confirming reaction or `/confirm`.
3. Pull requests are merged in GitHub's own PR view (Microsoft's GitHub
   Pull Requests extension, the web or GitHub Mobile); the engine sees the
   merge (ADR 0017).
4. After acting, the engine writes the outcome to `factory/state` and
   closes the issue, so the decision record stays in Git.
5. The factory ships a `githubIssues.queries` setting for Microsoft's
   GitHub Pull Requests extension, one query per priority; our
   extension's inbox view is retired.

## Consequences
- Supersedes ADR 0002 and ADR 0011 for inbox items. Amends ADR 0009
  (`factory/state` holds outcomes, not the items), ADR 0015 decision 3
  (owner actions on inbox items are proven by GitHub, not SSH signatures),
  ADR 0017 (no merge from our extension) and ADR 0018 (applies to every
  owner action, not just the phone).
- F-001, F-011 and F-012 are revised through the requirements interview,
  with Security Gate 1, and the Inbox item contract gets a new major
  version. Until those specs are approved, nothing is built against the
  old design.
