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

The orchestrator classifies each failure: test code, product code,
environment, dependency, infrastructure, or incomplete run. It retries only
when a retry could change the result (flaky environment, infrastructure), and
escalates to the Testing inbox when the limit is hit or the cause is unclear.
The limit and thresholds are open decision 6.

## Test framework

Chosen per project as an Architecture decision.
