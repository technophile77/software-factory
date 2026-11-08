# Maturity levels

Rules are in spec section 16. This file holds the numbers: what each
promotion needs, and how strict each gate is at each level.

**Status: DRAFT.** Neither table is approved. The orchestrator must not
promote, demote, or relax a gate based on them until the owner approves them.

Where levels are recorded: `.factory/maturity.yaml` in each repo, and the
project manifest for the project level (proposed, follows ADR 0002).

## Promotion criteria (cumulative)

A jump past a level needs the evidence for every level in between.

| Move | Testing required | Other evidence |
|---|---|---|
| → Prototype | Builds and a smoke test runs | Purpose written down |
| Prototype → Alpha | Every acceptance criterion of core features has a passing test; unit tests on core logic; failure paths for core features | Gate 2 security on the whole codebase; known issues listed |
| Alpha → Beta | All acceptance criteria tested, including edge cases; contract tests for every interface; integration tests; coverage target (TBD) | No open security findings above an agreed severity; user-facing docs; tester feedback channel |
| Beta → Release | Full regression suite green on a clean environment; performance/load tests against stated targets; upgrade and rollback tested | Dependency audit; no open blocking bugs; release notes |
| Release → Production ready | Tests pass in a production-like environment; backup/restore tested; failure/recovery tested | Monitoring and alerting; runbook; full security review; owner sign-off |

## Gate bar per level

Every level runs every gate. Only the bar changes.

| Gate | Prototype | Alpha | Beta | Release / Production ready |
|---|---|---|---|---|
| Requirements interview | Short; assumptions allowed if approved | Full | Full | Full |
| Test engineer | Happy path for each acceptance criterion | All acceptance criteria + core failure paths | Plus edge cases and contract tests | Plus regression and non-functional tests |
| Security gates 1 and 2 (approved) | Critical blocks | Critical and High block | Critical and High block | Critical, High, and Medium block |
| Required CI jobs (approved) | Build, smoke test | + unit, acceptance tests, secret scan | + contract, integration tests, dependency audit | + full regression, performance tests, coverage report |
| Validation judge (approved) | Full checklist; any number of Major findings (logged) | Full checklist; up to 3 Major | Full checklist; up to 1 Major | Full checklist; no Major |

The security row is approved (open decision 7, see `security-standards.md`). The validation judge row is approved (open decision 8), and the CI row (ADR 0008). The other rows are still draft.
