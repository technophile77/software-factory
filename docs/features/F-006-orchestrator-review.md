# F-006 Orchestrator review (stage 6)

- **Feature:** F-006 Advisor agent, spec v7
- **Date:** 2026-11-11
- **Result:** tests passed and the run was complete. Validation PASS at Rapid prototype.

| Check | Passed | Evidence |
|---|---|---|
| Spec approved, readiness gate passed | Yes | Spec v5 passed readiness after the owner approved H-0060 to H-0064; amendments H-0075 to H-0077 approved (v6). v7 restates FR-11's version check from the owner's F-005 OQ-3 answer |
| Assumptions approved | Yes | A-1 to A-3 approved by the owner in the interview (card); A-3 narrowed by the owner's SR-7 approval |
| Security and Testability Review filed | Yes | `F-006-security-testability-review.md`; 12 findings folded in as SR-1 to SR-12, four of them owner Security decisions, all approved |
| Developer complete | Yes | `F-006-dev-report.md` (build and fix round 1), with every part deferred to the engine feature listed |
| Independent tests pass on the final code | Yes | `F-006-test-report.md` round 2 on `c94c594`: 84 F-006 client tests, 17 F-006 checker tests, F-005 acceptance 154, all pass on Python 3.11 to 3.13. Re-run by the judge on `8db0cf1`: spec-interview 356 pass, onboard-repo 295 pass, 1 skipped |
| No unexplained skips | Yes | One onboard-repo skip (Python 3.10 not installed). The live engine, Windows and macOS not run, as for F-005 |
| Coverage at the Rapid prototype bar ("Reported") | Yes | `interview_client.py` 85% of lines with the spec-interview suite (stdlib `trace`, `8db0cf1`; subprocess runs of the client are not counted, so this is a floor). No branch figure until the coverage.py decision is filed |
| Code Review has no blocking finding | Yes | `F-006-code-review.md`: 2 Medium, 3 Low, closed by H-0075 to H-0077 and fix round 1 |
| Validation | PASS | `F-006-validation.md` re-validation on `8db0cf1` |
| Contracts compliant | Yes | Channel v1.2 (with H-0075), Inbox item v1.1, Role policy v2.3 (with H-0076), all owner-approved; no unapproved diff |

Known issues carried forward (count against promotion to Alpha):
- Everything engine-side waits for the engine: FR-2 to FR-8, FR-10, the engine halves of the ACs, and SR-1, SR-3, SR-4, SR-6, SR-8, SR-10 to SR-12 (full list in the dev report).
- The advisor's shell waits for the R2-1 sandbox and its own Security decision (SR-9).
- SR-3's real fix is tied to F-003 R2-4 and F-005 SR-5 before Alpha.
- Validation minors n1 (the contract's `engine.json` example still shows 1.1; fix at the next channel change), n3, n4, m2 (coverage.py decision).
