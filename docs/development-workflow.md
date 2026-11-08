# Development workflow

The nine-stage lifecycle every feature follows, including small ones. The
machine-readable version lives in `workflows/feature-development/`.

| Stage | Owner | Gate to leave the stage |
|---|---|---|
| 1. Feature request | Owner | Request recorded; analyst assigned |
| 2. Requirements interview | Requirements analyst | Spec drafted; assumptions submitted |
| 3. Security requirements review (Gate 1) | Security reviewer | Report filed; approved security requirements merged into spec |
| 4. Readiness gate | Orchestrator | All six readiness checks pass (below) |
| 5. Development and test prep | Developer, test engineer in parallel | Developer reports done; test suite ready |
| 6. Orchestrator review | Orchestrator | Tests pass and the run was complete |
| 7. Final security review (Gate 2) | Security reviewer | No blocking findings |
| 8. Validation | Validation judge | PASS |
| 9. Pull request | Orchestrator | All of `definition-of-done.md` met; PR open |

The owner merges. Nobody else does.

## Readiness gate (stage 4)

1. Clear objective.
2. Defined expected behavior.
3. Testable acceptance criteria.
4. Documented constraints.
5. Explicit assumptions.
6. All blocking decisions resolved (approved, not deferred).

If any check fails, the orchestrator sends the gap back to the analyst.
A deferred decision is not an approval, so a deferred blocking decision fails
check 6.

## Going backwards

| From | Result | Goes to |
|---|---|---|
| 6 | Tests fail after retries | Testing inbox; developer or test engineer per root cause |
| 7 | Blocking security finding | Developer, then back to 6 |
| 8 | FAIL | Orchestrator decides: developer, test engineer, or analyst |
| 8 | NEEDS HUMAN REVIEW | Decision inbox, category per the finding |
| Any | Spec found wrong or incomplete | Analyst; the spec is re-approved |

Retry limits for stage 6 are open decision 6.
