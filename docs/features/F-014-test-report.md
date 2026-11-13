# F-014 Test report

- **Feature:** F-014 Fewer engine git calls, spec v7
- **Date:** 2026-11-13 (updated after validation round 1)
- **Final commit tested:** `a2952bd`
- **Environment:** Linux, Node 22, git 2.43.0. Windows: the repo's CI matrix (windows-latest, git 2.56.0.windows.4, six shards).

## Tool choice

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Unit | Vitest, the engine's approved runner; tests call `Git`, `CatFileReader`, `StateRepo` directly against real git repos | `vitest` 5.1.0 | OQ-9 (F-007) |
| Acceptance | Vitest with the F-007 acceptance harness: the engine driven in-process as a black box over its channel | `vitest` 5.1.0 | OQ-9 (F-007) |
| Process counts (FR-7) | The engine's own counter (`Git.processes`) read per test by `test/git-count.ts`, so no outside tool is needed | `vitest` 5.1.0 | Spec FR-7 |
| Stochastic | Not required at Rapid prototype | None | None |

## Runs

| Run | Commit | Result |
|---|---|---|
| Full engine suite (`npx vitest run`, unit + acceptance), Linux | `a2952bd` (final) | 909 passed, 14 skipped, 0 failed (351 s) |
| Acceptance suite with counts on `main` | `8b20e78` (merge base) | 553 passed, 9 skipped, 0 failed |
| CI on the code's final commit (run 43425922979) | `a2952bd` | All 13 jobs green: Linux ×2, macOS ×3, Windows ×6, checks, supply-chain. One green run doesn't prove an intermittent failure gone; the cause and its test are in § Windows channel failures |

Earlier CI rows in this report's first version were wrong: GitHub lists the runs on `14263a4`, `9c7cd50`, `fc418f6`, `c004929`, `ef3bc0c`, `c235fb9` and `fcf8bec` as cancelled (superseded by newer pushes), not green.

## Process counts (AC-1, AC-2, AC-8)

Counted with the committed harness (FR-7): `FACTORY_GIT_COUNTS=<file> npx vitest run`, which appends one line per acceptance test with the git processes the engine started during it (`test/git-count.ts`); the total is the sum of the `git` fields. On `main` the same file was used with a two-line counter added to `Git.run` (`static processes`, incremented on each call), since `main` has no counter. Same Linux machine, 4 workers.

| | `main` 8b20e78 | F-014 `a2952bd` | Change |
|---|---|---|---|
| Git processes started by the engine, acceptance suite (553 tests each) | 51,904 | 35,641 | −31.3% (target 30%, AC-1 v6) |
| One engine start, one project (`engine.test.ts`) | 22 | 13 | −41% |
| Acceptance suite wall time (first measurement, `2e77d39` vs `fcf8bec`) | 357.5 s | 347.0 s | −3% |

The validation judge's independent count, with a wrapper that also counts the test fixtures' own git calls, found the same saving to within 21 processes (60,116 → 43,819).

Wall time on Linux barely moves because a process start there costs a few milliseconds; the saving is meant for Windows, where each start costs far more. AC-8 asks only that it be recorded.

## Windows channel failures

Two Windows CI runs failed one f009 acceptance test each with "connection closed" from the engine's channel (`761239f` shard 5, [SPL-1]; `70af2af` shard 4, [LNK-8]); other shards and `main` were green.

Cause: the channel refuses a client that the engine started, by walking the client's parent pids and checking each against the engine and its live children. Windows records a parent's pid and never clears it, and reuses pids at once. When an ancestor of the client (the test process here; Explorer's exited parent on a desktop) had exited, its pid could be held by one of the engine's git readers, so the walk found "our child" and refused the client. Before F-014 git processes lived for milliseconds, so the overlap was rare; readers live for seconds, so it showed up.

Fix (`a2952bd`, `proc.ts`, `os/ffi.ts`): when the walk matches the engine or one of its children, it compares start times (`GetProcessTimes`); a "parent" started after its child is a reused pid, not the parent, and the client isn't refused for it. A failed lookup keeps the refusal. Test: `units.test.ts` "a recorded parent pid that one of our children took over after the parent exited isn't ancestry", plus a Windows-only check of the real lookup. Acceptance tests now print the engine's channel log lines when a connection closes without an answer, so any refusal names its reason.

## Acceptance criteria

| AC | Test |
|---|---|
| AC-1 | Counts above; full suite passes |
| AC-2 | `engine.test.ts` "git process budgets (F-014 FR-7, AC-2)": first start ≤ 13, second ≤ 9, two manifest reads = 1 process |
| AC-3 | `git-reader.test.ts` "a reader killed between reads is replaced", "a reader that answers out of step is killed and the read falls back", "a reader that dies mid-reply, or answers with a malformed header, gives the plain answer" |
| AC-4 | `git-reader.test.ts` parity test (`link`, `mod`, `dir` refused or listed exactly as plain git) |
| AC-5 | `units.test.ts` "commits with few git processes…" (commit after an outside move lands on it); `remote.test.ts` "sync(): … refuses a local edit to a transcript" |
| AC-6 | `remote.test.ts` "L7: refuses to push or fetch…" |
| AC-7 | `git-reader.test.ts` "closes the reader after its idle time" |
| AC-8 | Wall time above |

## Security requirements

| SR | Test |
|---|---|
| SR-1, SR-5 | `git-reader.test.ts` tree parsing tests (modes, bad entries, git's order (Gate 2 L2), crafted tree), parity test |
| SR-2 | `git-reader.test.ts` "starts the reader with the same overrides and environment", "names the reader isn't given go to plain git" |
| SR-3 | `remote.test.ts` L7 test |
| SR-4 | `git-reader.test.ts` "keeps one reader per repo" |
| SR-6 | `git-reader.test.ts` "a body over the limit is refused before it is read", out-of-step test, "a catBlobs call over the read limit in total fails" (Gate 2 M1), "output a timed-out reader writes later never reaches the next reader" (Gate 2 M2; fails with the guard removed) |
| SR-7 | `git-reader.test.ts` "a reader that hangs times out, is killed" |
| SR-8 | `units.test.ts` commit test after an outside move |

## Gate 2 fixes with tests

| Item | Test |
|---|---|
| L4 (origin from the config listing) | `git-reader.test.ts` "is used only when it is one non-empty value; otherwise git is asked" |
| L5 (failed master read not kept) | `git-reader.test.ts` "a master read that failed isn't kept: a later check still finds a clone" |

## Known issues

Gate 2 L3 (a repo re-cloned at the same path reads as missing until its reader idles out, up to 2 s) and validation m6 (some errors in crafted or corrupt repos are worded differently from `main`) both fail closed. Whether they are logged for Alpha or fixed first is with the owner.
