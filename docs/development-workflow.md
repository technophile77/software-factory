# Development workflow

The nine-stage lifecycle every feature follows, including small ones. The
machine-readable version lives in `workflows/feature-development/`.

| Stage | Owner | Gate to leave the stage |
|---|---|---|
| 1. Feature request | Owner | Request recorded; analyst assigned |
| 2. Requirements interview | Requirements analyst | Spec drafted; assumptions submitted |
| 3. Security requirements review (Gate 1) | Security reviewer | Report filed; approved security requirements merged into spec |
| 4. Readiness gate | Orchestrator | All six readiness checks pass (below) |
| 5. Development and test prep | Developer, then test engineer (sequential, F-015) | Developer reports done; test suite ready |
| 6. Orchestrator review | Orchestrator | Tests pass and the run was complete |
| 7. Final security review (Gate 2) | Security reviewer | No blocking findings |
| 8. Validation | Validation judge | PASS |
| 9. Pull request | Orchestrator | Items 1 to 11 of `definition-of-done.md` met; PR open; marked ready once item 12 is met (at Rapid prototype by the local test run, ADR 0030) |

The owner merges in GitHub's PR view (F-011, ADR 0022). Nobody else merges,
except the engine for a hygiene PR identical to an approved hygiene change
(F-011 FR-10), and, at Rapid prototype, Claude for a PR whose content the
owner has approved, once the tests covering it pass locally (ADR 0030).

## Readiness gate (stage 4)

1. Clear objective.
2. Defined expected behavior.
3. Testable acceptance criteria.
4. Documented constraints.
5. Explicit assumptions.
6. All blocking decisions resolved (approved, not deferred).

For a spec written through an interview (F-005), check 5 also fails while any
assumption is pending, and check 6 fails while any interview question is
`open` or `deferred`. Every assumption the spec marks approved must match an
`approve_assumption` entry in the interview transcript
(`.factory/interviews/<feature>/`); a mismatch fails check 5.

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

Retry limits for stage 6 are in `testing-strategy.md`.

## Engine code and agents (F-015)

Stages 6 and 9 are engine code: the engine runs each repo's declared test
command and reads its JUnit XML results, reruns, counts fix cycles against
the retry table, files Testing items, pushes the feature branch, opens the
PR and reads its CI. The orchestrator agent runs only when a test run
fails, read-only, to name each failure's cause; the engine then applies the
retry table to that cause. Code and tests go to the feature's one code repo;
the spec, transcripts, reports and records stay in the private config repo
(ADR 0028).
