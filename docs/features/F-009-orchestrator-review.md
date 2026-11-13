# F-009 Orchestrator review (stage 6)

- **Feature:** F-009 Start an interview from an existing document, spec v13
- **Date:** 2026-11-13
- **Commit reviewed:** `17d2459` (judged by validation round 5); later commits change only a comment in `engine/src/interview/document.ts`, one example's wording in the test report, and this note
- **Result:** tests pass and the run is complete. Validation PASS at Rapid prototype (round 5).

| Check | Passed | Evidence |
|---|---|---|
| Spec approved, readiness gate passed | Yes | Readiness passed 2026-11-12 (spec section 11). Every later change (v6 to v13) is in the spec change log with the owner's decision card |
| Assumptions approved | Yes | No assumption taken on the owner's behalf; SR-13 deferred to Alpha by the owner |
| Gate 1 filed | Yes | `F-009-security-gate1.md`: 9 findings, folded into SR-1 to SR-14 (approved 2026-11-12) |
| Developer complete | Yes | `F-009-dev-report.md`, including the Gate 2 fixes, validation rounds 1 to 4 fixes, and test addenda D-1 to D-5 |
| Independent tests pass on the final code | Yes | `F-009-test-plan.md` and `F-009-test-report.md` (Addenda 1 to 4). Judge's run on `17d2459`: engine 779 tests, 765 passed, 0 failed, 14 skipped; spec-interview 428 OK; onboard-repo 318 OK, 1 skipped |
| No unexplained skips | Yes | The 14 skips are the gated real-Docker and real-Claude files and platform gates, as before F-009 |
| Coverage at the Rapid prototype bar ("Reported") | Yes | Engine `src/**`: lines 87.96%, branches 80.07%; `document.ts` lines 98.6% |
| Gate 2 has no blocking finding | Yes | `F-009-security-gate2.md`: H1, H2, M1, L1, L2 fixed; L3 closed by the capability list (v9); M2 by SR-8's extension (v10); M3 by the spec-line lock (v11) |
| Validation | PASS | `F-009-validation.md` round 5 on `17d2459`: 0 Not met, 0 Blocking, 0 Needs owner. Its one Major (M6, docs check failing on a test-report example) is fixed after the verdict |
| Contracts compliant | Yes | Engine control channel v1.4 (H-0105, capability list v9, source rows v11), Interview tools v1.1 (H-0106, v11 rules, H-0109), Role policy v2.6 (H-0107), analyst AGENT.md (H-0108, H-0109), all owner-approved |

Known issues carried forward (count against promotion to Alpha):
- Real-analyst evaluation of AC-4 to AC-8 (owner decision, spec v12). Must run before Alpha.
- SR-13 (budget check at start) deferred to Alpha.
- Gate 2 has not re-reviewed the fixes made after it (validation m5). Before Alpha.
- Existing project manifests, including the e2e trial config repo, need the two Role policy v2.6 write denies or the engine refuses the project.
- `specLine` binds only the first line it finds for a spec ref (m3).
- CI doesn't run the plugin's Python tests; the Windows tests haven't been run (m9).
- SR-2's wording doesn't name the approved exception for quotes (m10).
- The link rules also apply to `text/plain`, and GFM footnotes are refused; SR-8 doesn't settle either (m14). Some visible link text is refused, which fails closed (m15).
- A failed start can leave orphaned git objects.
