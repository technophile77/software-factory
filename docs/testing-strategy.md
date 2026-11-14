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

## Test types

| Type | What it is |
|---|---|
| Unit | Tests one function or module in isolation, from its contract |
| Acceptance | Tests each acceptance criterion of the spec end to end |
| Contract | Tests an interface against `interface-contracts.md` |
| Integration | Tests components together, in the real host (for example the VS Code extension host) |
| Regression | The full existing suite, plus one test for every fixed bug, so a fixed bug cannot come back |
| Stochastic | Randomized tests: property tests (many generated inputs checked against a rule) and fuzzing (malformed input thrown at parsers). Mutation testing (planted bugs the suite must catch) measures the suite itself |

Testing for a feature is complete only when every type required at the
repo's maturity level is present and passing. Production ready requires
every type.

## Pass bars by maturity level

Every test that runs must pass: 100%, with no unexplained skips, at every
level. The percentages below are coverage only. "New code" means lines the
change adds or edits. Security-critical code is code that parses outside
input, resolves paths, checks permissions, or runs external commands.

| | Prototype | Alpha | Beta | Release | Production ready |
|---|---|---|---|---|---|
| Unit tests | Core logic | All modules | All modules | All modules | All modules |
| Coverage, whole repo (line / branch) | Reported | 60% / 50% | 75% / 65% | 85% / 75% | 85% / 75% |
| Coverage, new code (line / branch) | Reported | 70% / 60% | 80% / 70% | 90% / 80% | 90% / 80% |
| Security-critical code (branch) | Reported | 80% | 90% | 95% | 95% |
| Regression | A test for each fixed bug | + full suite on every change | + full suite on every change | + clean environment, upgrade and rollback | + production-like environment |
| Stochastic | None | Property tests on parsers and validators of outside input, 100 cases each | Property tests on all core logic and contracts, 1,000 cases; fuzzing 10 min per parser, weekly | Fuzzing 1 hour per parser, weekly, zero crashes | + mutation score of at least 60% |

- Every stochastic run records its seed. A failure found this way becomes a
  regression test with that input.
- Coverage below the bar is a test failure of cause "test code" and follows
  the failure table below.
- Tools (coverage, property testing, fuzzing, mutation) are chosen per
  project as Architecture decisions, after the security review in S4.1.

## Run report

Each run reports: commit tested, tests run / passed / failed / skipped,
criteria-to-test map, failures with expected vs actual and logs, and anything
that did not run and why. A run with unexplained skips is incomplete, and an
incomplete run is not a pass.

It also has a **tool choice** table: for each test type required at the
repo's level, the best-fit tool and why, the tool used, and the link to the
owner's decision for any substitute (see Test tools).

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

### Which role a failure counts against

The run review (F-002) attributes each failure to a role, so repeated
problems can lead to a model or effort change for that role.

| Root cause or event | Counts against |
|---|---|
| Product code | Software developer |
| Test code | Test engineer |
| Spec found wrong or incomplete; readiness gate sent back | Requirements analyst |
| A security finding at Code Review, in CI, or after merge that Security and Testability Review should have required | Security reviewer |
| Judge verdict overturned by the owner, or a defect found after a PASS that the checklist covers | Validation judge |
| Misclassified root cause, or an incomplete run accepted | Orchestrator |
| Environment, infrastructure, dependency, flaky | No role |

## Continuous integration

CI (GitHub Actions) re-runs the jobs for the repo's maturity level on a
clean machine, on every PR and every push to `main` (ADR 0008). At Rapid
prototype no job is required, so CI never holds a merge; the tests covering
a change must pass locally before its PR opens instead (ADR 0030). A red
CI run is a test failure like any other and follows the table above, and
red CI on `main` after a merge is fixed forward or reverted at once. CI
results are evidence for the judge and for maturity promotions.

## Test tools

Each tool is chosen per project as an Architecture decision, after its S4.1
security review. Tools are chosen by fit, never by what is already approved
(owner, 2026-11-10, H-0020):

- **Best fit first.** For each test type required at the repo's level, the
  test engineer names the tool that best fits the stack and the job, and why,
  before looking at what is approved. "Already approved" is never a reason on
  its own.
- **Ask, don't substitute.** If the best fit isn't approved, the test
  engineer files a tool decision that compares it with any approved
  alternative. That test type stays open until the owner decides.
- **Substitutes need the owner.** Using an approved tool instead of the best
  fit needs the owner's explicit OK on that decision, recorded in the run
  report with what the substitute can't do.
- **No stand-ins for a test type.** A tool counts only for the types it
  actually provides: random inputs in a unit test are not property tests,
  and coverage is not mutation testing.
