# F-021 Developer completion report

- **Feature:** F-021 Answer factory decisions in the console, spec v6
- **Role:** software-developer
- **Date:** 2026-11-14
- **Branch:** `claude/project-thread-0jzeqb` (PR #82)
- **Contracts used:** Engine control channel v1.6 (H-0245), Inbox item console answers (H-0246)
- **New dependencies:** none (`zod` was already a dependency).

## What changed

- `engine/src/interview/activity.ts`, `engine.ts`: `engine.status` reports `waiting_for_decision` when the feature waits on inbox items and no agent runs; a stage the engine is about to work on reports that work, so `idle` means nothing pending and nothing queued (FR-12).
- `engine/src/inbox/local.ts` (new): the engine-folder store for private detail (`inbox-private/1.0`) and console answer proofs (`console-answer/1.0`): owner-only folders, atomic writes, size limit, zod schemas; a file that fails counts as missing (FR-4, FR-10, SR-6).
- `engine/src/inbox/store.ts`: one lock per project for the poll, console answers, revise, reopen and withdraw (FR-7); `consoleList`, `consoleShow`, `consoleAnswer`, `consoleConfirm` (FR-2 to FR-8); private detail kept on the PC and the fixed "More detail" line in the issue's Context (FR-4); the poll closes the issue of an item answered in the console, once, with `Recorded from the console: …` (FR-8); console answers proven by their local file (FR-10). The action-to-record table is shared by both paths.
- `engine/src/inbox/model.ts`, `render.ts`: `source: console`, `signed_in`, `console_answer`, `confirmed_by: {source: console}`, `ItemInput.private`; the new engine comment; `bodySections`.
- `engine/src/channel/methods.ts`, `sessions.ts`, `constants.ts`: `inbox.open`, `inbox.list`, `inbox.show`, `inbox.answer` (with `reply_id` replay), `inbox.confirm`, closing through `interview.close`/`inbox.close`; console sessions follow `settings.interview_sign_in` and record whether they signed in; capability `inbox` in `engine.json` (H-0245).
- `engine/src/engine.ts`: console answers carried out at once by the same effect code, with the poll and the console taking turns (FR-9); private detail scrubbed by the secrets scan line by line, all of it if the scan still flags it (SR-5); private detail on the Gate 1 run-limit item (engine log lines for the feature), the Gate 1 secret refusal (files and rule ids) and the "couldn't be carried out" notice (log lines for the item) (FR-4).
- `engine/src/mcp/operations.ts`: `inbox_open`, `inbox_list`, `inbox_show`, `inbox_answer`, `inbox_confirm`; every item text fenced so the terminal marks it; engine values checked before display; refused before connecting when the engine lacks the `inbox` capability.
- `engine/src/terminal/interview.ts`, `cli.ts`: `factory-engine inbox [<item id>] [--project <path>]` (FR-2, FR-3, FR-5, FR-6, FR-14); the interview command offers the feature's waiting decisions in its own session, with "Not now" (FR-11), and shows "Waiting for your decision on …".
- Doc edits H-0245 to H-0248 as approved: interface contracts, ADR 0033 (and its index line and the note in ADR 0022), README and engine README.

## Interpretations

1. **`<project>` in the engine-folder paths** is the first 16 hex characters of the sha256 of the project's config repo path, as the channel socket name already is: the project's name isn't known when the inbox is built, and a path key can't hold a path separator.
2. **Log lines for private detail (FR-4 b)** are the engine's own log lines from today's and yesterday's log that name the feature (run limit) or the item (failed effect), at most 200. The log has no run id on every line, so "lines for that run" is read as "lines for that feature".
3. **Withdrawn versus answered.** An owner answer never leaves an item `closed`; only the engine's withdrawal does, so a console answer on a `closed` item reports "Withdrawn by the engine".
4. **Console confirms** are kept in the engine's memory, not the record: a restart within the 15 minutes asks again, which errs towards asking.
5. **A wrong or malformed code** ends the attempt at the engine (SR-2); the command then asks the owner to pick the action again for a new code.
6. **Interview sessions answer inbox items** (FR-11, FR-13): any approved session of the project may call `inbox.*`, so the interview command doesn't open a second session.

## Tests run locally (affected suites only, owner's rule 2026-11-14)

- `test/f021-inbox.test.ts` (13, new): AC-1 to AC-9 at the store, including the 100-run race of AC-4 and the secrets scrub.
- `test/f016-acceptance.test.ts` F-021 block (2, new): the channel end to end, from `inbox.open` to the effect, the issue closed and a later 👍 ignored; session and input checks.
- `test/acceptance/terminal-f021.test.ts` (8, new): the command and the interview command's offer (AC-1, AC-3 to AC-5, AC-10, AC-12, FR-4).
- Regression: `test/inbox.test.ts`, `inbox-calls.test.ts`, `f016-acceptance.test.ts`, `units.test.ts`, `engine.test.ts` AC-1, `acceptance/terminal-f018`, `mcp-f005`, `mcp-f006`, `mcp-f009`: all pass.
- After merging `main` (F-020 #79, #84): the above plus `test/f020-inbox-json.test.ts` and `acceptance/mcp-tools.test.ts` (its operation list now includes the five `inbox_*` operations): 167 pass. The engine-folder reader now checks and reads one open file, not a path twice (CodeQL file-system race alert).
- `npm run typecheck`, `python3 scripts/check_docs.py`: pass.
- Not run here: Windows (AC-14). The console methods use the same pipe code the interview already uses on Windows CI (`terminal-pipe.test.ts`); CI runs the platform suite.
