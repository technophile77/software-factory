# Feature: Fewer engine git calls

- **Id:** F-014
- **Status:** Approved; readiness gate passed 2026-11-13; in development
- **Requested by / date:** Alex, 2026-11-13 (chose "Fewer engine git calls"
  from the CI speed thread's options)
- **Spec version:** 5

## 1. Objective and business purpose
The engine starts a new `git` process for almost every read and write it
makes in a repo. Process starts are slow, most of all on Windows, where the
owner runs the engine. In the acceptance suite, starting git is about 90% of
each test's time.

This feature makes the engine start far fewer git processes, without
changing what it does or weakening any of its git safety rules (F-007
SR-11, Gate 2 L7). The owner gets a faster engine on their PC, and the
factory's own CI gets faster tests.

## 2. Expected behavior
Nothing visible changes except speed. The engine reads the same refs and
files, makes the same commits, and refuses the same things, in the same
places, with the same messages.

Where the time goes today (profile of the full acceptance suite on
`main` at 2e77d39, Linux, git 2.43: 551 tests, 51,904 git processes, about
94 per test):

| Source | Processes | Share | What it does |
|---|---|---|---|
| `rev-parse --verify` (mostly `StateRepo.head()`, `readManifest`) | 7,884 | 15% | Resolve one ref |
| `ls-tree` + `cat-file` for single reads | 7,802 | 15% | List, then read, one file at a time |
| State commits (`hash-object`, `read-tree`, `update-index` ×2, `write-tree`, `commit-tree`, `update-ref`) | 12,906 | 25% | One factory/state commit |
| Project path check (`rev-list --max-parents=0`, `remote get-url` on master and project) | 6,140 | 12% | SR-13 clone check |
| Before push/fetch (`config --list`, `remote get-url`) | 4,226 | 8% | Gate 2 L7 config check, origin URL |
| Everything else (`worktree`, `for-each-ref`, push, fetch, `merge-base`, …) | 12,946 | 25% | |

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | **One reader per repo.** Reads of refs, trees and blobs go through one `git cat-file --batch` process per repo, kept open while the engine is busy in that repo and closed after 2 seconds with no read (OQ-1, owner 2026-11-13). Modes come from the tree objects the engine parses itself, so a symbolic link or submodule is still refused where it is today. |
| FR-2 | **Reader failure falls back.** If the reader dies, times out or returns output the engine can't parse, the engine kills it, makes that one read with a separate git process as today, and starts a new reader on the next read. A read never returns a wrong answer because the reader got out of step. |
| FR-3 | **factory/state head held in memory.** The engine keeps the factory/state commit it last wrote or read, and updates it on every commit, fetch and fast-forward it makes (A-1). A commit whose compare-and-swap fails reloads the head and fails as today. |
| FR-4 | **Master repo facts read once.** The master repo's root commits and origin URL, used by the project path check (SR-13), are read once per engine start instead of once per project path check. |
| FR-5 | **One config read before a network step.** `remoteUrl` takes `remote.origin.url` from the same `config --list` the Gate 2 L7 check already runs, instead of a second `remote get-url`. The L7 check itself is unchanged and still runs before every push and fetch. |
| FR-6 | **State commits unchanged.** factory/state commits keep using git's own commands as today; reworking them is a later feature, decided after F-014's results are measured (OQ-2, owner 2026-11-13). |
| FR-7 | **Counted, not guessed.** The `Git` class counts the processes it starts, by subcommand. The acceptance harness reports the total per test, and a test fails if a named hot path (engine start of one project, one state commit, one manifest read) starts more processes than its budget in AC-2. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given the full acceptance suite, when it runs on the F-014 branch, then it starts at least 35% fewer git processes in total than on `main` at 2e77d39 (51,904), and every test that passes on `main` passes. | FR-1–FR-5 |
| AC-2 | Given one project with a valid manifest, when the engine starts, then the count from FR-7 is at or under the budget written in the test (set from the measured value after the build, and reviewed at Gate 2 and validation). | FR-7 |
| AC-3 | Given a reader process that is killed mid-read, or that writes a malformed header, when the engine reads a ref or file, then the read returns the same answer as a plain `git` call and the next read starts a new reader. | FR-2 |
| AC-4 | Given a path in a config repo's `main` that is a symbolic link, a submodule or a tree, when the engine reads it as a file, then it refuses it with the same error as on `main` at 2e77d39. | FR-1, SR-1 |
| AC-5 | Given factory/state moved by something other than the engine, when the engine next commits, then the commit fails its compare-and-swap, the head is reloaded, and nothing is lost. | FR-3, A-1 |
| AC-6 | Given a repo config with a redirecting key (Gate 2 L7), when the engine pushes or fetches, then it refuses exactly as before. | FR-5 |
| AC-7 | Given the engine idle in a repo for longer than the idle time, then no reader process for that repo is running. | FR-1, OQ-1 |
| AC-8 | Wall time of the acceptance suite on the F-014 branch and on `main` is measured on the same machine and recorded in the test report. Reported, not gated (CI timing is noisy). | Objective |

## 5. Constraints
- Git safety overrides (`overrideArgs`, the clean environment) apply to the
  reader process exactly as to every other git process.
- Works with the git versions the engine supports today. Plain `cat-file
  --batch` predates every version in use, so no new minimum.
- No new dependency. No native git library: the engine keeps using the
  owner's own git binary.
- Works on Windows, Linux and macOS.
- Behavior, errors and messages are unchanged; only process counts and
  time change.
- Coordinated with the CI speed thread (H-0151–H-0155), which changes test
  code in parallel: F-014 changes engine source and only the test files it
  needs.

## 6. Edge cases
- A ref moved by the owner's own git while the reader is open: refs are
  read from disk on each request, so the reader sees the move.
- New objects (a fetch, the owner's commit): git looks for new packs when an
  object isn't found, so the reader finds them.
- On Windows, an open pack file can't be deleted, so a long-lived reader
  could make the owner's own `git gc` fail in that repo. The idle close
  (OQ-1) bounds this to while the engine is busy there.
- Paths with spaces or unusual characters: the reader is only ever given
  object ids and ref names the engine already validated, never paths; paths
  are found by walking trees in the engine.
- A huge blob: reads keep today's size limits; the reader reads the header
  first and stops before the body if it is over the limit.

## 7. Dependencies
- F-007 engine (`engine/src/git.ts`, `state/state-repo.ts`,
  `config/*.ts`).
- CI speed thread (H-0151–H-0155) for coordinated merges.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | Only the engine writes `refs/heads/factory/state` while it runs, so it may hold the head in memory. If anything else moves it, the next engine commit fails its compare-and-swap (as today) and the head is reloaded. | Interview, A-1 | Approved (owner, card, 2026-11-13) |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Every check that reads a mode today (regular file only, no symbolic links or submodules) still runs, on modes parsed from tree objects. | Analyst | Approved with the spec |
| SR-2 | The reader runs with the same `overrideArgs` and environment as every engine git process (F-007 SR-11), and is only fed validated object ids and ref names. | Analyst | Approved with the spec |
| SR-3 | The Gate 2 L7 config check still runs before every push and fetch; FR-5 only reuses its output. | Analyst | Approved with the spec |
| SR-4 | Nothing cached outlives the engine process, and no cache crosses repos. | Analyst | Approved with the spec |
| SR-5 | The tree parser refuses a tree with an entry name that is empty, `.`, `..`, or holds `/` or NUL, a duplicate name, an unknown mode, or an id of the wrong length; such a tree reads as unreadable. A test feeds each as a hand-built tree object. | Gate 1 #1 | Approved (owner, card, 2026-11-13) |
| SR-6 | Each reader reply's header must name the object the engine asked for, with an expected type and a size within the read's limit, or the reader is killed and FR-2's fallback runs. Bodies over the limit are never read into memory. | Gate 1 #2 | Approved (owner, card, 2026-11-13) |
| SR-7 | Every reader is registered with the engine's `Children`, each read has the same timeout as a git call today, and a timed-out reader is killed before the fallback runs. | Gate 1 #3 | Approved (owner, card, 2026-11-13) |
| SR-8 | Cached values only feed steps that git then checks: factory/state writes keep their compare-and-swap, and a failed swap clears the cache. | Gate 1 #4 | Approved (owner, card, 2026-11-13) |

## 10. Interface requirements
None. `Git` gains methods internal to the engine; no contract in
`docs/interface-contracts.md` changes.

## 11. Open questions
| Id | Category | Question | Status |
|---|---|---|---|
| OQ-1 | Architecture | Keep one `cat-file --batch` reader per repo, closed when idle (FR-1)? | Answered 2026-11-13: yes, closed after 2 s idle |
| OQ-2 | Product | Rework state commits in this feature (FR-6), or leave them for later? | Answered 2026-11-13: leave for later |

## 12. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit
- [x] Blocking decisions resolved

## 13. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft from the git profile of the acceptance suite | — |
| 2 | 2026-11-13 | OQ-1: one reader per repo, closed after 2 s idle | Alex (card) |
| 3 | 2026-11-13 | OQ-2: state commits left for a later feature (FR-6) | Alex (card) |
| 4 | 2026-11-13 | A-1 approved; Gate 1 proposes SR-5 to SR-8 | Alex (card, A-1) |
| 5 | 2026-11-13 | SR-5 to SR-8 approved; readiness gate passed (six checks) | Alex (card) |
