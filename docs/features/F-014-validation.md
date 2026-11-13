# F-014 Validation report

- **Feature:** F-014 Fewer engine git calls, spec v8
- **Judge:** validation-judge
- **Date:** 2026-11-13
- **Round:** 1
- **Commit:** `761239f` (`claude/project-thread-wx3ju7`). The engine code is unchanged since `fcf8bec`; `c235fb9` and `761239f` change only `docs/features/F-014-*`. The diff is `git diff origin/main...HEAD -- engine/` against the merge base `8b20e78`: 12 files, +954 / -44.
- **Contracts:** none changed (spec §10). `docs/interface-contracts.md` has no diff.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Not met line or a Blocking finding still fails.
- **Verdict:** **FAIL**
  - **Not met: 3 lines** (FR-7, AC-3, Test tools). **Needs owner: none.** The git-minimum item is decided (spec v8, §5 and FR-1 name `cat-file --batch-command`, git 2.36+) and the code matches it.
  - Blocking: 1 (B1). Major: 4 (M1 to M4). Minor: 8 (m1 to m8).
  - The code itself is in good shape: every test passes in my run, including the full acceptance suite, and my probes confirm the Gate 2 M1 and M2 fixes, the v8 fallback on old git, and the reader-death cases. What fails is one unbuilt part of FR-7 (the harness never reports counts, so AC-1 can't be reproduced from the repo) and missing test evidence.

## My own run (evidence source)

On `761239f` (engine code as at `fcf8bec`), Linux container, Node 22, git 2.43.0, running as root. `engine/node_modules` was already present. Logs and probes are in the judge's scratch folder only; nothing in the repo was changed except this report.

| Step | Result |
|---|---|
| `npm run -s typecheck` | **Clean, exit 0** |
| `npx vitest run test/git-reader.test.ts test/units.test.ts test/remote.test.ts test/engine.test.ts` | **4 files passed. 113 tests: 112 passed, 1 skipped, 0 failed** (15 s). The skip is `units.test.ts:539` (symbolic-link paths file, `canSymlink()` false here), not an F-014 test. `git-reader.test.ts` 14 of 14 |
| `npx vitest run --config test/acceptance/vitest.config.mts` | **18 files passed, 1 skipped. 562 tests: 553 passed, 9 skipped, 0 failed** (375 s). Matches the test report's 553 / 9 at `ef3bc0c`, now on the final code |
| Process count, acceptance suite, every git process (engine and fixtures) counted by a wrapper set through `FACTORY_TEST_GIT`, same machine, `main` at the merge base `8b20e78` and the branch at `761239f` | **`main` 60,116, branch 43,819: 16,297 fewer (−27.1% of everything, fixtures included).** Run from `git archive` copies, so ST-3 (which runs `check-ignore` on the master repo) failed in both copies alike; 552 of 553 passed in each. The fixtures' own git calls are the same in both, since the acceptance test files are identical. The saving matches the test engineer's (51,904 − 35,628 = 16,276) to within 21 processes, which puts the fixtures at about 8,200 and the engine alone at about 51,900 → 35,600 (−31%). Wall time with the wrapper: 392 s on `main`, 372 s on the branch |
| Probes (a scratch copy of the branch; a throwaway test file run with the repo's Vitest; stand-in `git` scripts) | All as expected: (1) Gate 2 M2: a reader that answers for the wrong object, then writes a planted `1111… commit` header 20 ms later and stays alive; five reads after it (one by id, four `revParse(…, "HEAD")` 30 ms apart) all return the real head. (2) AC-3: a reader that reads one request and exits (dies mid-read) and a reader that writes a garbage header; reads return the plain-git answer and each next read starts a new reader. (3) Spec v8: a `git` whose `cat-file --batch-command` prints usage and exits 129; five `revParse` and a `readBlob` all answer right, and exactly 3 readers are started for the repo. (4) Gate 2 M1: three 30 MiB blobs; `catBlobs` fails with "output over the limit" through the reader and through plain git, and two of them (60 MiB) read fine |
| CI | GitHub shows no completed `engine` run on any F-014 code commit. The runs on `9c7cd50`, `fc418f6`, `c004929`, `ef3bc0c`, `14263a4` and `c235fb9` are **cancelled** (superseded); `fcf8bec` is cancelled too. **The run on `761239f` (43419482964) failed**: 12 of 13 test jobs passed (Linux ×2, macOS ×3, Windows ×5), and `test (windows-latest, 5/6)` failed one test, `f009-document.test.ts` [SPL-1] "a quote of 5 words in under 25 characters … is accepted", with `{"code":0,"message":"connection closed"}`. The log shows no reader or git error around it; cause not determined. `docs-checks` is green on `761239f` |

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `git-reader.ts:49-238` (`CatFileReader`, `cat-file --batch-command`, idle close `:113`), `git.ts:179-200` (one reader per `cwd`), `:204-216` (`read`). Modes from `parseTree` (`git-reader.ts:273-299`), checked unchanged in `readBlob` (`git.ts:236-243`) and `TreeSnapshot`. Tests: `git-reader.test.ts` "gives the same refs, listings and blobs as plain git calls" (one reader serves every read), "sees a ref moved and objects written after it started", "closes the reader after its idle time" |
| FR-2 | Met | `git.ts:204-216` falls back on `ReaderBroken`; `git-reader.ts:177-191` (`breakOff`) kills the reader and ignores its later output (`:139`). Tests: "a reader killed between reads is replaced", "a reader that answers out of step is killed and the read falls back to plain git", "a reader that hangs times out". The mid-read case has no test (M1), but my probe shows it works |
| FR-3 | Met | `state-repo.ts:137-149` (`headCache`, `forgetHead`), `:185-196` (one retry on a moved head), `:233`/`:237` (cleared on failure, set on success), `:360-362` (fast-forward), `engine.ts:1351` (`sync()` forgets the head). Tests: `units.test.ts:443` "commits with few git processes…" (no `rev-parse` on the second commit; the commit after an outside move lands on it); `remote.test.ts:181` |
| FR-4 | Met | `paths-file.ts:67`, `:111-121` (one promise per `Git` and master path). Exercised by every acceptance start; the `engine.test.ts:154` budget would catch a regression. No direct test that a second path check reads nothing (L5's retry is reasoned only, M2) |
| FR-5 | Met | `state-repo.ts:305-324` returns `remote.origin.url` from the L7 listing; `:281-283`, `:328`, `:335` use it. Test: `remote.test.ts:106` (the returned URL equals `git remote get-url origin`; L7 still refuses). Differs from `get-url` on git 2.46+ in one edge case (m3) |
| FR-6 | Met | State commits keep `hash-object`, `read-tree`, `update-index`, `write-tree`, `commit-tree`, `update-ref` (`state-repo.ts:198-237`); `units.test.ts:443` asserts the exact list |
| FR-7 | **Not met** | Built: `Git.spawns`, `spawnCount()`, `Git.processes` (`git.ts:79`, `:145-161`), counted per subcommand, with the reader counted on start (`:191`); budgets for one engine start (13), a second start (9) and two manifest reads (1) in `engine.test.ts:154-177`; one state commit in `units.test.ts:443` (exact process list). **Not built: "The acceptance harness reports the total per test."** Nothing in `test/acceptance/` reads the counts (the only F-014 change there is `world.ts:680-682`, closing readers). The test report says its AC-1 numbers came from "a temporary hook … (not committed)". See B1 |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met on my measurement; the test engineer's number can't be reproduced from the repo (B1) | Every test passes on the branch (553 / 9 skipped, same as `main`'s suite). Process count: the test engineer's 51,904 → 35,628 (−31.4%) counts the engine's git processes, the same basis as the spec's 51,904 baseline. My wrapper count (all processes, engine and fixtures) gives the same saving, 16,297 against their 16,276, so the engine-only cut is about 31%, over the 30% target. Counted with everything, fixtures included, it is 27.1%; the baseline and the owner's v6 target were both set on the engine-only basis, so I judge against that |
| AC-2 | Met | `engine.test.ts:154` "git process budgets (F-014 FR-7, AC-2)": first start ≤ 13 (22 on `main`), second start ≤ 9, two manifest reads = 1. Passes in my run. Reviewed: the budgets equal the measured values, so any extra process on these paths fails the test, which is what AC-2 asks |
| AC-3 | **Not met (evidence)** | "Writes a malformed header": covered in spirit by `git-reader.test.ts:93` (a well-formed header for the wrong object); no test sends an unparseable header. **"Killed mid-read": no test.** `git-reader.test.ts:81` kills the reader *between* reads and waits 100 ms, so the reader is already gone and the next read just starts a new one; the fallback path for a reader dying with a request pending is never run. My probes show both cases answer correctly (see above), so this is missing evidence, not a defect. See M1 |
| AC-4 | Met | `git-reader.test.ts:39` parity test: `link`, `mod`, `dir`, `link/x`, `a.txt/x` give the same `lsTreeEntry` as plain git; `readBlob` of `link` and `mod` refuses with "not a regular file", the message on `main` (`git.ts:240` unchanged) |
| AC-5 | Met | `units.test.ts:443` (outside commit moves the branch; the held head's swap fails, `read-tree` runs again, the commit lands on top keeping `b.jsonl`); `remote.test.ts:181` "sync(): … refuses a local edit to a transcript" |
| AC-6 | Met | `remote.test.ts:106` "L7: refuses to push or fetch…", unchanged refusals plus the returned URL |
| AC-7 | Met | `git-reader.test.ts:183` "closes the reader after its idle time…": pid leaves `Children` and the process is gone |
| AC-8 | Met | Test report: 357.5 s on `main`, 347.0 s on F-014 (Linux, same machine). My runs (same machine, counting wrapper): 392 s on `main`, 372 s on the branch (−5%); without the wrapper, 375 s on the branch |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met | `canonMode` (`git-reader.ts:307-322`); mode checks unchanged in `readBlob` and `TreeSnapshot`. Parity test |
| SR-2 | Met | `git.ts:182-192` (`this.args(cwd, [])`, `this.env()`); `checkName` (`git-reader.ts:260-263`). `git-reader.test.ts:145` (argv and environment equal every engine git call, no token), `:134` (names go to plain git) |
| SR-3 | Met | `push`/`fetch` call `refuseRedirectingConfig` first (`state-repo.ts:328`, `:335`). `remote.test.ts:106` |
| SR-4 | Met | Readers per `Git` and `cwd`, closed at stop (`engine.ts:1345`, `:1383`); master facts in a `WeakMap` per `Git`; held head per `StateRepo`. `git-reader.test.ts:164` "keeps one reader per repo". Gate 2 L3 (a reader outliving a re-clone at the same path) is still open (m4) |
| SR-5 | Met | `parseTree` (`git-reader.ts:273-299`) refuses every listed case including sort order (v7). `git-reader.test.ts:211`, `:223`, `:229` |
| SR-6 | Met | `ask` (`git-reader.ts:194-204`), `contents` (`:67-79`), `ReaderLimit`. `git-reader.test.ts:93`, `:125`. The Gate 2 M2 bypass is fixed (`:139`, `:180`, `:184`); confirmed by my probe, no test (M2) |
| SR-7 | Met | `Children.add`/`remove` (`git-reader.ts:136`, `:147`); per-read timeout (`:106`); `breakOff` kills before the read rejects (`:181-189`). `git-reader.test.ts:113`, `:183`. The test doesn't assert the pid is gone after a timeout (Gate 2 L6 asked for it); the code sends `SIGKILL` synchronously before rejecting |
| SR-8 | Met | `update-ref` with the old value kept (`state-repo.ts:231`); `headCache = null` on failure (`:233`), before `worktree add` (`:103`) and in `fastForward` (`:360`). `units.test.ts:443` |

### Constraints and edge cases (spec §5, §6)

| Item | Status | Evidence |
|---|---|---|
| Overrides and environment on the reader | Met | SR-2 |
| Git 2.36+ for fast reads; older git takes the plain path after three tries per repo (v8) | Met | `git.ts:180`, `:209-213`. `git-reader.test.ts:93` (three broken readers, then plain git only). My probe with a `git` that rejects `--batch-command`: correct answers, 3 readers started |
| No new dependency, no native git library | Met | `package.json` unchanged; the reader spawns the owner's git |
| Windows, Linux, macOS | Met on Linux and macOS; Windows has one unexplained failure (M4) | Linux: my runs and CI. macOS: CI 3 of 3 on `761239f`. Windows: CI 5 of 6 shards on `761239f`; shard 5 failed one test (M4). `bd3e4b5` handles Git for Windows launchers by closing input (reasoned in Gate 2) |
| Behavior, errors and messages unchanged | Met with exceptions logged | m3 (`remote.origin.url` on git 2.46+), m6 (some corrupt-repo messages) |
| Edge cases: moved refs, new objects | Met | `git-reader.test.ts:65`; Gate 2 probes (repack, gc) |
| Edge case: `git gc` on Windows bounded by idle close | Met | AC-7 |
| Edge case: paths never sent to the reader | Met | `NAME_RE` (`git-reader.ts:40`), trees walked in the engine (`git.ts:331-346`) |
| Edge case: huge blob, header first | Met | `git-reader.ts:69-72`; `git-reader.test.ts:125`; batch cap `git.ts:276-278` (my probe) |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval | Met | Spec v8, owner approved each change (§13). The code matches v8: `--batch-command` (FR-1), three tries per repo (§5) |
| Architecture / ADRs | Met | No conflict. ADR 0009 (factory/state branch) keeps its compare-and-swap; ADR 0003 (engine as a separate process) unaffected. No new component or dependency |
| Interface contracts | Met | No diff to `docs/interface-contracts.md`. The new `Git` methods and `refuseRedirectingConfig`'s return value are engine-internal (spec §10). Contract tests in the acceptance suite pass |
| Change-controlled files | Met | The branch changes only `engine/` and `docs/features/F-014-*`, which the feature owns |
| Code quality, readability, maintainability | Met, with findings | The reader is small and strict: one request at a time, every header checked, any surprise breaks the reader and falls back. Plain paths are kept beside the reader paths and compared in tests (`readers: false`), which makes the parity easy to see. Findings: m2, m4, m5, m6 |
| Comments | Met, with findings | New comments say why (`git-reader.ts:81-87`, `:138`, `:182-183`, `:290`; `git.ts:276-277`; `state-repo.ts:130-135`, `:190-191`; `paths-file.ts:117`). One existing comment is now out of date (m1), one new one is inaccurate (m2), and one claims parity that holds only before git 2.46 (m3) |
| Test tools | **Not met** | `F-014-test-report.md` has no tool choice table (`testing-strategy.md` § Run report and § Test tools; this checklist line). The tools used are Vitest 5.1.0 with the F-007 harness, the approved choice, so the fix is the table only. See M3 |
| Documentation | Met, with findings | Spec v8, both gate reports, test report. Findings: m7, m8 |
| Security | Met | Gate 1 and Gate 2 present; Gate 2 PASS with no Critical or High finding. The developer's fixes after Gate 2 were not re-reviewed by the gate (m8); my probes confirm M1 and M2 |

## Findings

### Blocking

| # | Location | Finding |
|---|---|---|
| B1 | `engine/test/acceptance/support/world.ts`; `engine/src/git.ts:145-161`; `F-014-test-report.md` § Process counts | **FR-7's acceptance-harness report is not built.** FR-7 requires that "the acceptance harness reports the total per test". The `Git` counters exist, but nothing in the acceptance harness reads or reports them, and the test report says its counts (51,904 → 35,628, the basis of AC-1 and of the owner's v6 change to the AC-1 target) came from a temporary hook that was not committed. So the AC-1 figure can't be reproduced from the repo, and future features have no per-test count to watch. Fix (developer): have the harness report each test's git process total (engine and fixtures, or say which), for example by counting through the `GitWrapper` / `FACTORY_TEST_GIT` path the harness already has, and have the test engineer re-measure AC-1 with it on the final commit. |

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `engine/test/git-reader.test.ts:81`, `:93` | **AC-3 has no test for a reader killed mid-read, nor for a malformed header.** The "killed between reads" test waits 100 ms after the kill, so the engine sees the exit before the next read and just starts a new reader; the path where a request is pending when the reader dies (`gone()` waking the waiting read, then the fallback) is never run. The out-of-step test sends a well-formed header for the wrong object, not a malformed one. My probes show both cases behave correctly. Fix (test engineer): a stand-in `git` that reads one request and exits, and one that writes an unparseable header; assert the plain-git answer and a new reader on the next read. |
| M2 | `engine/test/git-reader.test.ts`; `F-014-security-gate2.md` § Developer fixes | **No regression test for the Gate 2 M1, M2 and L5 fixes.** The Prototype bar in `testing-strategy.md` is "a test for each fixed bug". M1 is "reasoned; a 64 MiB fixture was judged too slow"; M2 cites existing tests that passed before the fix too, so they don't catch the bug (Gate 2 asked for "a reader that breaks and keeps writing, followed by reads by ref"); L5 is reasoned. My probes confirm M1 and M2 are fixed; the M1 probe (three 30 MiB blobs) takes a few seconds. Fix (test engineer): the M2 probe as a test; for M1, a test with blobs over the cap (or a cap the test can lower); for L5, a master read that fails once, then succeeds. |
| M3 | `docs/features/F-014-test-report.md` | **No tool choice table.** Required in every run report (`testing-strategy.md` § Run report) and by this checklist. The required types at Rapid prototype are unit and acceptance; the tool is Vitest 5.1.0 with the F-007 harness. Fix (test engineer): add the table. |
| M4 | `F-014-test-report.md` § Runs ("CI … `14263a4` … green"); GitHub Actions run 43419482964 | **CI is red on the final commit, and the test report's CI row isn't borne out.** GitHub lists the `engine` run on `14263a4` as cancelled, as are those on `9c7cd50`, `fc418f6`, `c004929`, `ef3bc0c`, `c235fb9` and `fcf8bec`, so no F-014 code commit had a completed run before `761239f`. On `761239f`, one Windows shard (5/6) failed `f009-document.test.ts` [SPL-1] with "connection closed" from the engine's channel; the other 12 test jobs passed. I couldn't tell from the log whether it is F-014 (a Windows reader problem would look like this) or a flake; `main`'s runs on `8b20e78` and `2e77d39` are green. Windows is where the owner runs the engine, and the M2 fix changed how a reader ends (`git-reader.ts:184-186`: input destroyed and `SIGKILL` at once, instead of `bd3e4b5`'s 200 ms grace). Fix (orchestrator): classify the failure per `testing-strategy.md` (rerun if flaky, developer if product code), get CI green on the final commit, and correct the test report's row. |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `engine/src/git.ts:11-17` | Out-of-date comment. The `overrideArgs` doc explains why no filter or textconv runs: the engine "reads with `cat-file blob` and `ls-tree`". Reads now go through `cat-file --batch-command` first. Still true that it applies no filters (`git-reader.ts:46`), but the security reasoning should name the reader. |
| m2 | `engine/src/git.ts:77` | "Readers that broke without ever answering" isn't what is counted: any broken read adds one, and any successful read resets the count (`:209`, `:213`), so it is consecutive failed reads. Same outcome on old git, which is the v8 case, but say what it counts. |
| m3 | `engine/src/state/state-repo.ts:301-303`, `:312` | Gate 2 L4, still open. The first `remote.origin.url` in the listing is what `get-url` prints only up to git 2.45; from 2.46 an empty value resets the list. The CI Windows runner has git 2.56, so the owner likely does too. No new reach (both values pass `remoteUrl`'s check, and only someone who can write the config can set them), but §5 says behavior is unchanged, and the doc comment states the parity without the limit. |
| m4 | `engine/src/git.ts:179-200` | Gate 2 L3, still open. A repo deleted and cloned again at the same path while its reader is open answers "missing" until the reader idles out (fails closed). |
| m5 | `engine/src/config/paths-file.ts:115-118` | Gate 2 L5 is fixed only for the root commits. A failed `origin(master)` read is still cached as `null` for the engine's life, turning off the same-remote half of the SR-13 clone check after one transient failure. Gate 2 suggested caching only when both reads succeed. |
| m6 | `engine/src/git.ts:319`, `:325`, `:337`, `:368`, `:402` | Some failures in corrupt or crafted repos read differently from `main` ("<commit> isn't a commit", "a tree in git couldn't be read (…)") where git's own error used to show; §5 says messages are unchanged. Fixed text, no internals (Gate 2 Info); not reachable in a sound repo. Worth a line in the spec's §5 or the dev notes. |
| m7 | `docs/features/F-014-test-report.md` | The full acceptance run is on `ef3bc0c`, before the M1, M2 and L2 fixes; the counts don't name a commit; "Counted with a temporary hook" leaves AC-1 unverifiable (B1). My run on the final code covers the pass/fail part. |
| m8 | `docs/features/F-014-security-gate2.md` § Developer fixes | Gate 2 reviewed `ef3bc0c`; the fixes for M1, M2, L5, L6 and L2 were added afterwards by the developer and not re-reviewed by the security reviewer. Not required at Rapid prototype; should be confirmed before Alpha. |

Known issues carried, not graded:
- Gate 2 Info: trees git reads but SR-5 refuses (a zero-padded mode, a non-UTF-8 name) make the whole tree unreadable through the reader, including for `populateWorktree`. SR-5 working as approved.
- Gate 2 owner item 3 (record M1, M2, L2 to L6 as known issues counting against Alpha) has no recorded answer. Not mine to decide; listed for the orchestrator.

## Counts

- Blocking: 1 (B1).
- Major: 4 (M1, M2, M3, M4).
- Minor: 8 (m1 to m8).
- Lines: 3 Not met (FR-7, AC-3, Test tools). Needs owner: none.

## To pass round 2

1. **Developer (B1):** the acceptance harness reports git processes per test (FR-7).
2. **Test engineer (B1, M1, M2, M3, m7):** re-measure AC-1 with the harness report on the final commit; add the AC-3 mid-read and malformed-header tests and the regression tests for Gate 2 M1, M2 and L5; add the tool choice table; record the full run on the final commit.
3. **Orchestrator (M4):** classify the Windows SPL-1 failure, get CI green on the final commit, and have the test report's CI row corrected.
4. **Optional (m1 to m6):** small comment and code fixes; any code change needs the suites re-run.
