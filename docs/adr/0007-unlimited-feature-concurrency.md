# 0007. Unlimited feature concurrency

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open decision 10; write-up in `docs/proposals/0010-concurrency.md`

## Problem
Several features may be in flight in one repo, and several repos in one
project, while agents keep working as decisions wait.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Concurrent, 2 in build per repo (recommended in the proposal) | Bounded cost and conflicts | Features may queue |
| One at a time per repo | No conflicts | Stalls behind any pending decision |
| Unlimited | Maximum throughput | Unbounded cost; more merge conflicts; harder to follow |

## Decision
No limit on how many features run at once, in any stage, in any repo. The
engine starts work on a feature as soon as its stage allows.

Correctness safeguards that are not limits still apply:
- After any feature merges to `main`, the orchestrator rebases every other
  active feature branch and reruns its tests before its next gate.
- A merge conflict the orchestrator can't resolve without changing approved
  behavior goes to the Testing inbox; a conflict between two features'
  interface contract changes goes to the Decision inbox (Interfaces).

## Consequences
- Agent cost scales with the number of features in flight; the engine should
  show active features and agent time per feature so the owner can see it.
- The scheduler is simpler (no queue or slots).
- A limit can be introduced later as a new ADR superseding this one.
