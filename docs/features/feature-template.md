# Feature: <name>

- **Id:** F-<nnn>
- **Status:** Draft | In review | Approved | In development | Done
- **Requested by / date:**
- **Spec version:** 1
- **Repo:** <repos[].name> (only when the project has more than one code repo; F-015 FR-16, H-0198)

## 1. Objective and business purpose
Why this exists and who it is for.

## 2. Expected behavior
What the user sees and what the system does, in plain language.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | |

## 4. Acceptance criteria
Each one testable, with a clear pass/fail.
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | | FR-1 |

## 5. Constraints
Technical, performance, compatibility, time.

## 6. Edge cases
Including abuse cases from the security review.

## 7. Dependencies
Other features, services, libraries, data. A feature of the same project
listed here by id (F-<nnn>) must have its pull request merged before this
one starts development (F-015 FR-16, H-0198).

### Configuration changes needed before implementation
Every change this feature needs to factory configuration, a role policy or a
CI file, one row each (F-015 FR-28, H-0275). Status is `Pending` or
`Applied`. Check is `<role> may write <path>` or `<role> may not write <path>`
for a write rule, naming one file, and `—` for a change code can't test. The
readiness gate fails while a row isn't Applied, and the engine tests every
Check against the manifest before the build starts. Leave the table empty if
there are none.

| Id | Change | Check | Status |
|---|---|---|---|

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | | | Pending |

## 9. Security considerations
| Id | Requirement | Source (analyst / Security and Testability Review) | Status |
|---|---|---|---|
| SR-1 | | | |

## 10. Interface requirements
New or changed contracts. Each change links its Interfaces decision.

## 11. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
