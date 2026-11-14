# F-021 Code Review (implementation review)

- **Feature:** F-021 Answer factory decisions in the console, spec v6
- **Gate:** 2, implementation review against `docs/security-standards.md`, SR-1 to SR-7 and the notes for Code Review in `F-021-security-testability-review.md`
- **Code reviewed:** `engine/src/inbox/{store,local,model,render}.ts`, `engine/src/channel/{methods,sessions}.ts`, `engine/src/mcp/operations.ts` (inbox operations), `engine/src/terminal/interview.ts` (inbox flow, FR-11 offer), `engine/src/cli.ts` (`inbox`), `engine/src/interview/activity.ts`, and the `scrubPrivate`, `logLines`, `answeredInConsole` and `applyAnswers` parts of `engine/src/engine.ts`
- **Reviewer role:** security-reviewer
- **Date:** 2026-11-14
- **Maturity level:** Rapid prototype (only Critical blocks)
- **Result:** PASS. 0 Critical, 0 High, 1 Medium, 2 Low. Nothing blocks. The Medium is the owner's accepted SR-4 risk.

## Security and Testability Review notes, checked

| Note | Result | Evidence |
|---|---|---|
| No GitHub request, `factory/state` commit or model prompt holds private detail | Met | Private detail goes only to `InboxLocal.writePrivate`; `fileNow` and `reviseNow` copy named fields into the record, never `private`; the rendered body gets only the fixed line. `f021-inbox.test.ts` AC-6 searches every dispatch, every issue and the whole `factory/state` history over two revisions. No model reads inbox items |
| The lock covers both the poll and the console answer, with the race test | Met | `poll`, `consoleAnswer`, `consoleConfirm`, `revise`, `reopen` and `withdraw` all run through `Inbox.exclusive`; the AC-4 test starts a poll and a console answer together 100 times and finds exactly one owner entry each time |
| The confirm path: wrong code, expired code, changed revision, answered on GitHub in between | Met | AC-3 test: wrong code then right code (refused: one try), another session's code, 15 minutes and 1 ms, then in time; `consoleConfirm` re-reads the record under the lock and gates it like an answer (AC-4, AC-5 paths) |
| `clean()` runs on private detail and labels before the margin marker | Met | `inboxShow` cleans every section, private section, label and title before fencing; the terminal's `render()` cleans each line again before adding the marker. `terminal-f021` AC-12 feeds CSI, OSC 52 and a fake "1. Approve" line |

## Findings

| # | Criterion | Severity | Blocks? | Location | Finding | Status |
|---|---|---|---|---|---|---|
| M1 | S2.1, S6.2, S8.5 (SR-4) | Medium | No | `engine/src/channel/methods.ts` (`inbox.*`), `sessions.ts` (`openConsole`) | Under `settings.interview_sign_in` values that open sessions without sign-in, any process running as the owner that reaches the socket or pipe can answer inbox items, Security decisions and spec sign-off included. Each answer records `source: console` and `signed_in`, so the record never claims a sign-in. The engine still refuses connections from agent processes it started. | Accepted risk (SR-4, owner, 2026-11-14 10:28Z) |
| L1 | S3.1 (SR-5) | Low | No | `engine/src/engine.ts` (`scrubPrivate`) | gitleaks reports a finding's start line only, so a multi-line secret could leave lines after the first. The scrub scans its own result again and replaces all of the detail if anything is still flagged, so the console never shows what the scan finds. A secret the scan doesn't know stays, as anywhere else in the factory. | Logged, no change |
| L2 | S1.1 (SR-6) | Low | No | `engine/src/inbox/local.ts` | An answer file left by a record write that then failed (for example a secret refused in a `/changes` note) sits at the history index the next entry takes; that entry's own write replaces it, and until then its hash can't match any other entry. | Info, no change |

## Other checks

- **Forged console answers.** A console entry on `factory/state` that this run didn't record is carried out only if `<engine home>/answers/<project>/<id>.<n>.json` exists, passes its schema and holds the entry's canonical hash, action, revision and time (`verifyConsole`). AC-8 covers an edited proof, a missing proof and a forged entry with a self-consistent hash.
- **Effects run once.** `applyAnswers` is serialized per project, so a console answer carried out at once and the poll's pass can't both run one effect; the end-to-end test checks a single `effect_done`.
- **Replays.** `inbox.answer` keeps each result by session and `reply_id` for 30 minutes, so a resend after a lost reply returns the first result and never a second code or answer.
- **Input checks.** Item ids, revisions, actions, notes (4,000 characters) and codes are checked at the channel and again in the client before anything is sent; a console session can't act as an interview session (its key can't pass the feature id check).
- **Notes stay off GitHub (SR-7).** A typed `/changes` note is recorded on `factory/state` (secrets-scanned there) and the issue gets only the fixed comment.
