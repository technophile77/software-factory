# 0005. Feature branches with per-agent sub-branches, squash-merged to main

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open decision 5; write-up in `docs/proposals/0005-branching-commits.md`

## Problem
ADR 0004 gives every agent its own worktree. Git can't check out one branch
in two worktrees, so parallel agents need their own branches, and the result
must reach `main` in a traceable, revertible way.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Feature branch + agent sub-branches, squash | Fits worktrees; traceable; one commit per feature on main | More branches; orchestrator merges agent work |
| One branch, agents take turns | Fewest branches | No parallel work; conflicts with ADR 0004 |
| Agent sub-branches, merge commits | Full history on main | Noisy; harder to revert a feature |

## Decision
- Feature branch: `feature/F-012-short-name`, from `main`, owned by the orchestrator.
- Agent branches: `feature/F-012/dev`, `feature/F-012/test`, `feature/F-012/security`, and so on.
  (The feature branch must never be named just `feature/F-012`, because Git
  can't have that ref alongside `feature/F-012/...`.)
- The orchestrator merges agent branches into the feature branch at gates.
- PR from the feature branch to `main`; the owner squash-merges.
- Config hygiene changes: one branch and PR per approved item, `config/H-007-short-name`.
- Every commit message starts with the feature or item id: `F-012: ...`, `H-007: ...`.

## Consequences
- `main` has one commit per feature or approved config change, so a revert is one step.
- Agent branches are deleted after the squash merge; their history stays in the PR.
