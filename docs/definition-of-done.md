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
| 11 | No unresolved blocking issues | The inbox has no open blocking item of any kind for this feature |
| 12 | CI green on the PR head | Required CI checks for the repo's maturity level pass (ADR 0008) |

The orchestrator opens the PR once items 1 to 11 are met, and marks it ready
for the owner only when item 12 is met too. The owner decides
whether to merge.

What blocks at items 7 and 8 depends on the repo's maturity level: see
`security-standards.md` and `agents/validation-judge/AGENT.md`.
