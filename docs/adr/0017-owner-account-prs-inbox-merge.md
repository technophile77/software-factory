# 0017. PRs opened and merged with the owner's own account; the inbox click is the approval

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner (thread "Spec one inbox for all approvals")
- **Decision item:** F-011 OQ-2; write-up in `docs/proposals/0021-owner-approval-merges.md`

## Problem
ADR 0006 needs a factory machine account: it opens PRs and `main` requires
the owner's approving review. The owner doesn't want a second account and
wants the work attributed to him. With his own token he is the PR author,
GitHub won't let an author approve their own PR, and every merge needs an
admin bypass. He also wants to approve PRs in the inbox, not on GitHub.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A. Signed approval record + required check | GitHub enforces the owner's decision against the factory's own token | A signing step per approval; a workflow and script per repo |
| **B. The inbox click merges, with the owner's sign-in** | One click; one account; no bypass; nothing extra to set up | GitHub can't tell the click from other use of the owner's credentials |
| C. Machine account (ADR 0006) | GitHub's own review rule | A second account; work attributed to it |

## Implications
- **Security, residual risk (stated to the owner):** the engine's token is
  the owner's and can merge, so an engine bug, a leaked token, or a program
  running as the owner could merge a PR whose CI is green without a click.
  Agents can't: they run in containers with no tokens (ADR 0015). Required
  CI still applies to every merge. A lightweight safeguard is F-011 OQ-9.
- **Standards:** OWASP LLM Top 10 2025, LLM06 (excessive agency): high-impact
  actions need human approval; the click is that approval.
- **Maintenance:** no approval workflow or record format to keep.

## Decision
1. In `owner_token` mode (the default) the engine opens PRs with a
   fine-grained token of the owner's. No machine account is needed.
2. The owner approves a PR with **Approve and merge** in the inbox and
   confirms it in a dialog that names the PR, its head commit and its
   checks (owner, 2026-11-13). That is the whole approval; there is no
   signing step. The extension
   merges through GitHub's API with the owner's VS Code GitHub sign-in,
   passing the head commit the card showed, so a later push is never merged
   on that click.
3. `main` has a ruleset requiring a pull request and the level's CI checks,
   with no required review and no bypass actors.
4. `machine_account` mode keeps ADR 0006's model for anyone who wants it:
   the inbox click submits the owner's real GitHub review instead.

## Consequences
- Supersedes ADR 0006. ADR 0008 (CI as a required gate) is unchanged.
- Onboarding (F-003 FR-2, FR-10) checks and prepares the new ruleset
  instead of a required owner review (F-011 H-0123).
- `development-workflow.md` "The owner merges" becomes "the owner approves in
  the inbox, which merges" (F-011 H-0122).
