# Proposal: test retry limits and escalation thresholds (open decision 6)

- **Category:** Product
- **Blocks:** stage 6 failure handling in the engine
- **Status:** Awaiting owner

## Problem
The orchestrator should fix routine failures without bothering the owner, but
must never retry forever or quietly accept failures.

## Options

### A. Retry by cause, with fix cycles (recommended)
| Failure cause | Automatic reruns | Then |
|---|---|---|
| Environment, infrastructure, flaky | Up to 2 reruns | Testing inbox |
| Product code | No rerun; sent to developer to fix | Up to 3 fix cycles, then Testing inbox |
| Test code | No rerun; sent to test engineer to fix, citing the spec | Up to 3 fix cycles, then Testing inbox |
| Dependency | No rerun | Testing inbox right away (often needs an Architecture decision) |
| Incomplete run | 1 rerun | Testing inbox |
| Unclear | Orchestrator investigates once | Testing inbox |

Also:
- A test that fails then passes on rerun is logged as **flaky**. The same test
  flaky 3 times in a feature goes to the Testing inbox, even if it passed.
- If the developer and test engineer disagree about the spec (a test
  "fixed" back and forth twice), it goes to the Decision inbox as an
  Assumptions or Product question instead.
- A feature stuck in stage 6 for more than 4 hours of agent time is escalated.

| | |
|---|---|
| Pros | Only retries when retrying can help; bounded; catches flaky tests and spec disagreements |
| Cons | Several numbers to tune |

### B. Strict: 1 rerun, 1 fix cycle
| | |
|---|---|
| Pros | You see problems quickly |
| Cons | Many interruptions for problems the agents would have solved |

### C. Lenient: up to 5 reruns and 5 fix cycles
| | |
|---|---|
| Pros | Fewest interruptions |
| Cons | Slow, costly, and can hide real instability |

## Recommendation
**A.** The numbers go in factory config so they can be tuned later through
the hygiene process.
