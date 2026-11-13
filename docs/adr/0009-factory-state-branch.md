# 0009. Inbox items live on a dedicated factory/state branch

- **Status:** Accepted; amended by 0022: `factory/state` holds inbox records, not items
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** F-001 requirements interview, assumption A-2

## Problem
ADR 0002 stores each inbox item as a committed file. ADR 0006 protects `main`
so only reviewed PRs reach it. Item commits can't go through a PR each, and
the factory's token can't bypass protection.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Dedicated `factory/state` branch | Full Git history; owner and agents can both write; no PRs | A second branch to know about |
| Main with owner admin bypass | Simple for the owner | Agents can't file items |
| Items on feature branches | Items travel with features | No home for cross-feature items; scanning many branches |

## Decision
- Each managed repo has a long-lived `factory/state` branch, not protected.
- It is checked out as a Git worktree at `.factory/`, which is git-ignored on
  `main` and feature branches.
- The engine and the VS Code extension commit inbox items, agent reports, and
  maturity records there. Each commit message starts with the item or feature id.
- `factory/state` is never merged into `main`.

## Consequences
- Supersedes nothing; refines where ADR 0002's files are committed.
- Agent reports (`.factory/runs/`) also live on `factory/state`, not on
  feature branches as the Agent report v1.0 contract says; that contract
  needs a minor update (Interfaces decision).
- The factory token needs write access to `factory/state` only, plus PR rights.
