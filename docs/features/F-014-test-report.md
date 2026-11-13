# F-014 Test report

- **Feature:** F-014 Fewer engine git calls, spec v7
- **Date:** 2026-11-13
- **Environment:** Linux, Node 22, git 2.43.0. Windows: the repo's CI matrix (windows-latest, git 2.56.0.windows.4, six shards).

## Runs

| Run | Commit | Result |
|---|---|---|
| Full engine suite (`npx vitest run`, unit + acceptance) | `bd3e4b5` | 898 passed, 14 skipped, 0 failed |
| Acceptance suite after merging `main` (PR #46 fixtures) | `ef3bc0c` | 553 passed, 9 skipped, 0 failed |
| `git-reader`, `units`, `remote`, `engine` test files | `fcf8bec` | all passed (`git-reader.test.ts` 14 of 14) |
| CI (Linux, macOS, Windows ×6) | `14263a4` | green |
| CI | `9c7cd50`/`fc418f6` | Windows red: EBUSY removing test folders while readers were open; fixed in `bd3e4b5` (readers exit on end of input; tests close them before cleanup) |

## Process counts (AC-1, AC-2, AC-8)

Counted with a temporary hook in `Git.run` and the reader start (not committed), over the acceptance suite on Linux:

| | `main` 2e77d39 | F-014 | Change |
|---|---|---|---|
| Git processes, acceptance suite | 51,904 | 35,628 | −31.4% (target 30%, AC-1 v6) |
| One engine start, one project (`engine.test.ts`) | 22 | 13 | −41% |
| Acceptance suite wall time (same machine, 4 workers) | 357.5 s | 347.0 s | −3% |

Wall time on Linux barely moves because a process start there costs a few milliseconds; the saving is meant for Windows, where each start costs far more. AC-8 asks only that it be recorded.

## Acceptance criteria

| AC | Test |
|---|---|
| AC-1 | Counts above; full suite passes |
| AC-2 | `engine.test.ts` "git process budgets (F-014 FR-7, AC-2)": first start ≤ 13, second ≤ 9, two manifest reads = 1 process |
| AC-3 | `git-reader.test.ts` "a reader killed between reads is replaced", "a reader that answers out of step is killed and the read falls back" |
| AC-4 | `git-reader.test.ts` parity test (`link`, `mod`, `dir` refused or listed exactly as plain git) |
| AC-5 | `units.test.ts` "commits with few git processes…" (commit after an outside move lands on it); `remote.test.ts` "sync(): … refuses a local edit to a transcript" |
| AC-6 | `remote.test.ts` "L7: refuses to push or fetch…" |
| AC-7 | `git-reader.test.ts` "closes the reader after its idle time" |
| AC-8 | Wall time above |

## Security requirements

| SR | Test |
|---|---|
| SR-1, SR-5 | `git-reader.test.ts` "F-014 tree parsing (SR-5)" (4 tests), parity test |
| SR-2 | `git-reader.test.ts` "starts the reader with the same overrides and environment", "names the reader isn't given go to plain git" |
| SR-3 | `remote.test.ts` L7 test |
| SR-4 | `git-reader.test.ts` "keeps one reader per repo" |
| SR-6 | `git-reader.test.ts` "a body over the limit is refused before it is read", out-of-step test |
| SR-7 | `git-reader.test.ts` "a reader that hangs times out, is killed" |
| SR-8 | `units.test.ts` commit test after an outside move |
