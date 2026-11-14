# F-016 Orchestrator review (stage 6)

- **Feature:** F-016 The engine acts on the owner's inbox answers and runs the readiness gate, spec v19. The F-011 engine side was built with it.
- **Date:** 2026-11-14
- **Commit reviewed:** `b78f493` (judged by validation round 3). Later commits change only the `streviewunresolved` item's wording (m17), the validation report and this note.
- **Result:** tests pass, the live trial is complete, and validation PASSES at Rapid prototype (round 3).

| Check | Passed | Evidence |
|---|---|---|
| Spec approved, readiness gate passed | Yes | Readiness passed on v10. Every later change (v11 to v19) is in the spec change log with the owner's approval, by card and typed in thread |
| Assumptions approved | Yes | A-1 approved. No assumption taken on the owner's behalf |
| Security and Testability Review filed | Yes | `F-016-security-testability-review.md`; FR-19 and FR-20 now let code, not the reviewer, decide what blocks |
| Developer complete | Yes | `F-016-dev-report.md`, including the live trial fixes table (spec v13 to v19) |
| Independent tests pass on the final code | Partly | `F-016-test-report.md` covers AC-1 to AC-14 independently. AC-15 to AC-22 are covered only by the developer's tests (validation M4, logged) |
| Live check (AC-11) | Yes | F-002 in `factory-e2e-trial` reached `build_and_test_prep` on 2026-11-14 10:33Z after the owner's confirmed Approve on S-0001 (test report, "AC-11 live trial") |
| Code Review has no blocking finding | Yes | `F-016-code-review.md`: review and re-review PASS; R1 to R3 fixed, R4 logged. No pass covers the v13 to v19 code (validation M5, logged) |
| CI | Yes (advisory) | Main was red on Windows and macOS from PR #60 to #84. F-016 failures were fixed forward in PRs #84 and #87; run 43596631776 passes every F-016 test on all three platforms. The last red test (F-020 schemas, CRLF) was fixed by its own thread in PR #88 |
| Validation | PASS | `F-016-validation.md` round 3 on `b78f493`: 0 Not met, 0 Blocking, 0 Needs owner; Majors M4 and M5 logged |
| Contracts compliant | Yes | Inbox item v3.1 (H-0180), Engine control channel v1.5 (H-0183), owner-approved |

Known issues carried forward (count against promotion to Alpha):
- M4: test engineer tests from the spec for AC-15 to AC-22.
- M5: a Code Review pass on the v13 to v19 engine code and the later fixes (`e8fa693`, `0c758eb`, `bccf224`).
- Spec tidy-ups that need the owner (m12, m16): status line and section 11 still name v10; FR-14, AC-16 and H-0188 name the retired spec-interview skill; no change-log row for the H-0249 rename.
- Minors m2 to m11, m13 to m15 in the validation report.
- F-002's 5 Low findings from its last review are known issues of that trial feature, not of F-016.
