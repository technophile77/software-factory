# Proposal: multiple features and concurrent workflows (open decision 10)

- **Category:** Architecture
- **Blocks:** the engine's scheduler
- **Status:** Decided: option C, unlimited (ADR 0007)

## Problem
Several features may be in flight in one repo, and several repos in one
project. The spec wants agents to keep working on unrelated tasks while
decisions wait, without features stepping on each other.

## Options

### A. Concurrent features with a per-repo build limit (recommended)
- Any number of features can be in stages 1 to 4 (requirements, security
  review, readiness) at once; these don't touch code.
- Per repo, at most **2 features** in stages 5 to 9 at a time (configurable).
  Others wait in a queue, ordered by the owner's priority.
- A feature blocked on a decision releases its slot so another can move.
- Two features that change the same interface contract or the same files
  listed in their specs are not built at the same time.
- After any feature merges to `main`, the orchestrator rebases other active
  feature branches and reruns their tests before their next gate.
- Each repo runs independently; a project-level view shows all of them.

| | |
|---|---|
| Pros | Work keeps moving; bounded cost; avoids the most common conflicts |
| Cons | Rebases and reruns add agent time |

### B. One feature at a time per repo
| | |
|---|---|
| Pros | No conflicts; simplest scheduler |
| Cons | Everything stalls behind a feature waiting on a decision |

### C. Unlimited concurrency
| | |
|---|---|
| Pros | Maximum throughput |
| Cons | Unbounded cost; frequent conflicts; hard to follow |

## Recommendation
**A**, starting with a limit of 2 and tuning through the hygiene process.
