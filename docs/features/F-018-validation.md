# F-018 Validation report

- **Feature:** F-018 Answer interview questions in a terminal command, spec v10
- **Judge:** validation-judge, run in the same session as the build, so not independent of it; the evidence below is test output anyone can rerun
- **Date:** 2026-11-14
- **Branch:** `claude/project-thread-rnlxi6` (PR #68)
- **Maturity level:** Rapid prototype
- **Verdict:** **PASS** (0 Blocking, 0 Not met). AC-12's evidence is the Windows platform job on the PR's CI run.

| AC | Result | Evidence |
|---|---|---|
| AC-1 | Met | `terminal-f018` "AC-1: an assumption is printed whole before its choices" |
| AC-2 | Met | "AC-2: answer choices are the suggested answer, then the other options" |
| AC-3 | Met | the two AC-3 tests (multi-line Unicode text; a typed number stays text) |
| AC-4 | Met | the two AC-4 tests (nothing without a keystroke; each kind follows its pick) |
| AC-5 | Met | the two AC-5 tests (state checked, same `reply_id`, nothing on "no") |
| AC-6 | Met | "AC-6: GitHub approval is shown exactly and awaited before any reply" |
| AC-7 | Met | "AC-7: ending input closes the session and exits 0" |
| AC-8 | Met | "AC-8: engine text can't reach the terminal raw" (CSI, OSC 52, OSC 8, bidi, zero-width, a fake menu line) |
| AC-9 | Met | "AC-9: without a terminal the command refuses with exit code 2 and sends nothing" (spawns the built command) |
| AC-10 | Met | "AC-10: no running engine gives the engine's reason and exit code 1" |
| AC-11 | Met | the command's AC-11 tests, plus the F-005, F-006 and F-009 suites (`mcp-f005`, `mcp-f006`, `mcp-f009`, `mcp-e2e`, `mcp-tools`), now driving the same operations in-process |
| AC-12 | Met (CI) | `test/terminal-pipe.test.ts` runs the AC-2 scenario against the real engine over its channel; it is in `test:platform`, so the `windows-latest` jobs run it over the named pipe; passes locally on Linux |
| AC-13 | Met | `approval` AP-10b; `units` "sign-in setting … never" |
| AC-14 | Met | the three AC-14 tests; `channel` CH-5b and `units` "engine.status activity codes" for the engine side |
| AC-15 | Met | `approval` AP-10c (engine_start); `units` "sign-in setting" (session, engine_start, hours, failed sign-in) and manifest validation; `pinning` PIN-2 "the interview sign-in setting" |

Security requirements SR-1 to SR-8: see `F-018-code-review.md` (PASS; SR-8 is an accepted risk).

## Minor findings (logged)

- m1: `advisor_working` is contracted but never reported (dev report interpretation 1). The command shows the analyst's status while the advisor runs.
- m2: The onboarding skill's Python tests weren't run in this container (its pinned checker tools aren't installed); CI's `plugin-tests` job runs them.
