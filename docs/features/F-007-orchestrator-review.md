# F-007 Orchestrator review (stage 6)

- **Feature:** F-007 Run spec interviews on the real engine, spec v44
- **Date:** 2026-11-12
- **Commit reviewed:** `8623f3a` (engine code as `797a8e1`); this note and spec v44 change documents only
- **Result:** tests passed and the run was complete. Validation PASS at Rapid prototype, after the owner's AC-13 answer (v44).

| Check | Passed | Evidence |
|---|---|---|
| Spec approved, readiness gate passed | Yes | Readiness passed 2026-11-11 (v26). Every later change (v27 to v44) is in the spec change log with the owner's decision card |
| Assumptions approved | Yes | Approved in the interview and by decision cards; none taken on the owner's behalf |
| Security and Testability Review filed | Yes | `F-007-security-testability-review.md`: findings folded in as SR-1 to SR-23, S4.1 component reviews 1 to 7 (review 7: OSV-Scanner) |
| Developer complete | Yes | `F-007-dev-report.md`: milestone 1, fix rounds 1 and 2, milestone 2, Code Review fixes, and "After Code Review" for the later commits |
| Independent tests pass on the final code | Yes | `F-007-test-plan.md` and `F-007-test-report.md` (test engineer, milestone 1 and 2 acceptance tests). Judge's run on `797a8e1`: 500 tests, 486 passed, 0 failed, 14 skipped. Owner's Windows PC on `797a8e1`: DR-1 to DR-7, 7 of 7. GitHub CI green on `8623f3a` (Linux, macOS, Windows, supply chain, docs) |
| No unexplained skips | Yes | Real-Docker files gated on `FACTORY_DOCKER_TESTS=1` (run on the owner's PC); RW-4 accepted residual until Alpha (v43); FX-7 and one parent-lookup test are OS-specific |
| Coverage at the Rapid prototype bar ("Reported") | Yes | `@vitest/coverage-v8` 5.1.0 over `engine/src/**`: lines 87.1%, branches 78.68% |
| Code Review has no blocking finding | Yes | `F-007-code-review.md`: PASS with conditions, no Critical. H1, H2, M1, M2, L2, L6, L7 fixed; M4 and L3 closed by H-0088; M3 deferred to Alpha (v34) |
| Validation | PASS | `F-007-validation.md` round 2 on `797a8e1`: 0 Not met, 0 Blocking; the one Needs-owner line (AC-13) settled by v44 |
| Contracts compliant | Yes | Engine control channel v1.3 with H-0084, Interview tools v1.0 (H-0082), Role policy v2.5 (H-0083), Project manifest v1.3 and v1.4 (H-0080, H-0087), all owner-approved; no contract changed after validation |

The engine has not yet run a full interview end to end with a real project
config repo; every part of the path is tested, the real-binary and real-Docker
parts included.

Known issues carried forward (count against promotion to Alpha):
- Code Review: H1 residual (an allowed Bash command's path arguments aren't checked; F-007 roles have no commands), M3 (single-user host until Alpha, v34), and L1, L4, L5 still open.
- AC-21: stylesheet-hidden text can reach the web reader (v43). Must be fixed before Alpha.
- AC-13: the "couldn't start" reason reaches the owner only in the transcript and log until the VS Code extension increment adds a channel surface (v44).
- Feature work and `factory/state` live in the config repo, a recorded exception to ADR 0005 and ADR 0009 that increment 4 removes (v41).
- Validation Majors: M5 (`startEngine` is one 820-line closure). M7 is addressed by the orchestrator's addendum to the test report; the test engineer has not yet confirmed the two DR test edits themselves (m11).
- Validation Minors m4, m5 (Code Review to re-review the later commits with the next increment), m7 to m14. m1 to m3 and m6 are done.
- SR-15 cross-user and forced-FFI tests run against the real OS only on Linux (m10).
