# Testing strategy

## Principles

- **Tests come from the spec, not the code.** The test engineer derives tests
  from acceptance criteria, edge cases, and interface contracts.
- **Every acceptance criterion has at least one test**, and the run report maps
  criteria to tests.
- **Both paths:** each behavior is tested for success and for at least one
  relevant failure.
- **Contracts are tested as contracts:** signatures, types, request/response
  shapes, and compatibility rules from `interface-contracts.md`.
- **Never weaken a test to make it pass.** A test that seems wrong goes to the
  orchestrator, which decides with the spec in hand.

## Run report

Each run reports: commit tested, tests run / passed / failed / skipped,
criteria-to-test map, failures with expected vs actual and logs, and anything
that did not run and why. A run with unexplained skips is incomplete, and an
incomplete run is not a pass.

## Failure handling

The orchestrator classifies each failure and handles it by cause. Approved by
the owner on 2026-11-08 (open decision 6, `proposals/0006-retry-limits.md`).

| Failure cause | Automatic reruns | Then |
|---|---|---|
| Environment, infrastructure, flaky | Up to 2 reruns | Testing inbox |
| Product code | No rerun; developer fixes | Up to 3 fix cycles, then Testing inbox |
| Test code | No rerun; test engineer fixes, citing the spec | Up to 3 fix cycles, then Testing inbox |
| Dependency | No rerun | Testing inbox right away |
| Incomplete run | 1 rerun | Testing inbox |
| Unclear | Orchestrator investigates once | Testing inbox |

- A test that fails and then passes on rerun is logged as flaky. The same
  test flaky 3 times in one feature goes to the Testing inbox even if it passed.
- If the developer and test engineer go back and forth on the same test
  twice, the disagreement goes to the Decision inbox (Assumptions or Product).
- A feature in stage 6 for more than 4 hours of agent time is escalated.
- These numbers live in factory config and change only through the
  configuration hygiene process.

## Test framework

Chosen per project as an Architecture decision.
