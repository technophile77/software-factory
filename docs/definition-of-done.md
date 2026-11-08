# Definition of done

A feature is not done because the developer says so. It is ready for a pull
request only when every box below is checked, each with the evidence named.

| # | Condition | Evidence |
|---|---|---|
| 1 | Requirements approved | Feature spec status is `Approved`; approval recorded |
| 2 | Assumptions approved | Every assumption in the spec has an approved decision |
| 3 | Security requirements addressed | Gate 1 report; each security requirement traced to code or test |
| 4 | Implementation complete | Developer completion report |
| 5 | Independent tests passed | Test engineer's run report against the final commit |
| 6 | Orchestrator review complete | Orchestrator review note |
| 7 | Final security review passed | Gate 2 report with no blocking findings |
| 8 | Validation judge issued PASS | Judge report |
| 9 | Required documentation updated | Listed in the judge report |
| 10 | Interface contracts compliant | No unapproved diff to `interface-contracts.md`; contract tests pass |
| 11 | No unresolved blocking issues | All three inboxes have no open blocking item for this feature |

The orchestrator opens the PR only after all eleven are met. The owner decides
whether to merge.

What counts as "blocking" for items 7 and 8 depends on open decisions 7
(security severity) and 8 (judge scoring). See `open-decisions.md`.
