# F-021 Validation report

- **Feature:** F-021 Answer factory decisions in the console, spec v6
- **Judge:** validation-judge, run in the same session as the build, so not independent of it; the evidence below is test output anyone can rerun
- **Date:** 2026-11-14
- **Branch:** `claude/project-thread-0jzeqb` (PR #82)
- **Maturity level:** Rapid prototype
- **Verdict:** **PASS** (0 Blocking, 0 Not met). AC-14's evidence is the Windows platform job on the PR's CI run.

| AC | Result | Evidence |
|---|---|---|
| AC-1 | Met | `f021-inbox` "AC-1, FR-2, FR-3"; `terminal-f021` "AC-1, AC-12"; `f016-acceptance` F-021 "AC-2, AC-3, FR-9" (list and show over the channel) |
| AC-2 | Met | `f021-inbox` "AC-2, FR-8"; `f016-acceptance` F-021 end-to-end test (effect before the call returns, issue closed, one comment) |
| AC-3 | Met | `f021-inbox` "AC-3, FR-6, SR-2"; `terminal-f021` "AC-3, FR-6"; `f016-acceptance` F-021 end-to-end test |
| AC-4 | Met | `f021-inbox` "GitHub first wins; console first wins" and the 100-run race; `f016-acceptance` (a later 👍 changes nothing) |
| AC-5 | Met | `f021-inbox` "AC-5"; `terminal-f021` "AC-4, AC-5" (new revision printed whole and answered) |
| AC-6 | Met | `f021-inbox` "AC-6, FR-4, SR-5" |
| AC-7 | Met | The console list shows `record.title`, which is the item's own title; the issue's title stays SR-19's fixed one (`renderTitle`, unchanged; F-011 tests) |
| AC-8 | Met | `f021-inbox` "AC-8" (two tests) |
| AC-9 | Met | `f021-inbox` "AC-9, FR-8" |
| AC-10 | Met | `terminal-f021` "AC-10" and "Not now sends nothing" |
| AC-11 | Met | `units` "says a decision is pending"; `terminal-f018` "F-021 AC-11" |
| AC-12 | Met | `terminal-f021` "AC-1, AC-12" (CSI, OSC 52, BEL, a fake menu line) |
| AC-13 | Met | `terminal-f021` "AC-13, SR-3" (spawns the built command with piped input) |
| AC-14 | Met (CI) | The console methods use the channel and pipe code the interview uses; `engine.test.ts` (platform suite) checks the `inbox` capability in `engine.json`, and the Windows jobs run the platform suite over the named pipe |
