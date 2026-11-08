# Proposal: Git branching and commit strategy (open decision 5)

- **Category:** Architecture
- **Blocks:** engine worktree setup, automatic PRs
- **Status:** Decided: option A (ADR 0005)

## Constraint from ADR 0004
Each agent has its own worktree, and Git can't check out one branch in two
worktrees, so parallel agents need their own branches.

## Options

### A. Feature branch with per-agent sub-branches (recommended)
- `feature/F-012-short-name` from `main`, owned by the orchestrator.
- Agents work on `feature/F-012/dev`, `feature/F-012/test`, and so on.
- The orchestrator merges agent branches into the feature branch at gates.
- The PR goes from the feature branch to `main`; the owner squash-merges.
- Config hygiene changes: one branch and one PR per approved item, `config/H-007-short-name`.
- Commit messages start with the feature or item id: `F-012: add login rate limit`.

| | |
|---|---|
| Pros | Fits worktrees; each agent's work is traceable; one clean commit per feature on `main` |
| Cons | More branches; the orchestrator resolves merges between dev and test branches |

### B. One branch per feature, agents take turns
| | |
|---|---|
| Pros | Fewest branches |
| Cons | No parallel developer and tester; conflicts with ADR 0004 |

### C. Same as A, but merge commits instead of squash
| | |
|---|---|
| Pros | Keeps every agent commit on `main` |
| Cons | Noisy history; harder to revert a whole feature |

## Recommendation
**A.** It is what ADR 0004 needs, and squash merges keep `main` easy to read
and to roll back one feature at a time.
