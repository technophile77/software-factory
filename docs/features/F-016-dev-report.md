# F-016 Developer completion report

- **Feature:** F-016 Engine acts on inbox answers and runs the full readiness gate, spec v11. The engine side of F-011 (one inbox on GitHub issues, spec v29) is built in the same branch.
- **Role:** software-developer
- **Date:** 2026-11-14
- **Branch:** `claude/project-thread-mszazz` (PR #60)
- **Contracts used:** Inbox item v3.1 (H-0180, applied in `d15e0ed`), Engine control channel v1.5 (H-0183, `79478bb`), Agent report v1.4 and Role policy v2.6 as they are.
- **Hygiene items applied:** H-0161 (engine inbox code and the one-time migration script), H-0162 (config repo workflow template), H-0163 (VS Code query block), H-0180, H-0183, H-0184 (orchestrator model and limits, `af92dec`). H-0185 (the onboarding checker's limit keys; owner approved 2026-11-14 02:26Z by decision card; applied in `6627209`).
- **New dependencies:** none.

## What changed

### Inbox on GitHub issues (F-011 engine side)
- `engine/src/inbox/`:
  - `model.ts`, `render.ts`, `commands.ts`, `github-issues.ts`, `store.ts` (new).
  - Records live at `inbox/<id>.yaml` on the config repo's `factory/state`, with each rendered body at `inbox/<id>.rev<n>.md`.
  - Issues are opened by the config repo workflow through `repository_dispatch`.
  - The engine reads the pinned owner's 👍 reactions and command comments. Risky actions need 🚀 or `/confirm CODE` within 15 minutes.
  - Outside text is fenced (SR-10), and the engine's own comments are never read as commands (SR-17).
  - `Inbox.waitingOn` keeps the open items per feature for `engine.status`.
- `engine/src/state/inbox.ts`: `fileSecurityItem` and `fileDecisionItem` file through the inbox store. Each carries an `effect` that code sets, so item text never decides what an answer does (SR-4).
- `engine/src/os/notify.ts` (new): OS notifications on Windows, macOS and Linux. They are best effort, run as fixed argv with no shell, and text reaches them only as variables or arguments.
- `engine/src/engine.ts`:
  - Each running project gets an `Inbox`, connected with the factory token as the pinned owner.
  - The engine polls every 60 s and stops polling on `stop()`.
  - A project stopped only by changed pinned keys still connects and polls, so the owner can approve the change in the inbox (OQ-3). The token is looked up under the pinned name, never the changed manifest's.
  - At start, the engine applies answers recorded before a crash once (FR-2, AC-7).
- `engine/src/state/state-repo.ts`: `commit` can remove paths in the same commit. Only the migration uses it.
- `engine/scripts/migrate-inbox-once.ts` (new) and `npm run migrate-inbox` (FR-16, SR-20):
  - Moves each open item file to a record and body, removing the old file in the same commit.
  - Owner actions in the old files are dropped and noted.
  - Engine Gate 1 and pins items keep their effect.
  - The script is to be deleted after the owner's projects are migrated (H-0164).

### Effects of answers (F-016 FR-1 to FR-6, H-0182)
- `onAnswer` in `engine.ts`:
  - Gate 1 choice: `gate1_decided`, then back to the interview with the choice as data.
  - Gate 1 risk: Accept records `accepted_risk`; any other action re-asks.
  - pins: re-pin, and the owner is told to restart.
  - chain: the transcript is read again and reopened if intact.
  - breach: restart within the run caps.
  - gate1cap: one more Gate 1 run.
  - spec_signoff: Approve on the same commit moves the feature to `build_and_test_prep`; changes go back to the interview.
  - Everything else, and every option B, is record only.
  - The feature's entries and the record's `effect_done` land in one commit (SR-7).
- `engine/src/interview/model.ts`:
  - New transcript entries: `gate1_decided`, `gate1_risk_accepted`, `gate1_reask`, `gate1_extra_run`, `returned`, `readiness_run`, `readiness_result`, `readiness_session`, `signoff_filed`, `spec_signed_off`, `signoff_withdrawn`.
  - A re-asked choice finding is then settled by an interview question.
- `engine/src/gate1/flow.ts`: `gate1Resolution` checks accepted risks and decided choices against section 9 (SR-6). `analystReturnTurn` gives the analyst what came back, as JSON data after the instructions.

### Readiness gate (F-016 FR-7, FR-8, FR-11, OQ-1 (c))
- `engine/src/readiness/checks.ts` (new): the structural code checks. Sections 1 to 5 must be present and filled. FR rows must be in section 3, and AC rows in Given/When/Then form. Every Covers cell must name existing FRs, and every FR must be covered.
- `engine/src/readiness/report.ts` (new): the orchestrator's turn, report shape, validation and one correction.
- `engine.ts` `runReadiness`:
  - Runs the interview checks, Gate 1 resolution and the structural checks. Only if all pass does one orchestrator session run, read-only, writing only its report (SR-11 v11).
  - A pass files the Spec sign-off item. A failed check returns the feature to the interview with the evidence as data.
  - An invalid report, or a write outside the report, fails closed.
- `engine/src/agent/reviewer.ts`: `orchestratorPolicy`. `engine/src/config/limits.ts`, `models.ts`: the `orchestrator` and `readiness_gate` sections, optional, so a factory version without them runs no session.

## Tests

- New tests:
  - `test/inbox.test.ts`: 14 tests for F-011 AC-1 to AC-7, AC-12, SR-10, SR-17 and SR-18.
  - `test/f016-run.test.ts`: 19 tests for F-016 AC-1 to AC-10 and AC-12 to AC-14, Gate 2 M1, SR-8, SR-9, OQ-3, and the `chain` and `gate1cap` effects.
  - `test/migrate-inbox.test.ts`: 3 tests for F-011 AC-13 and SR-20.
  - `test/inbox-calls.test.ts`: 3 tests for F-011 FR-14 and AC-10.
  - `test/notify.test.ts`: 1 test.
  - `test/limits.test.ts`: H-0184.
- `test/agents-harness.ts` now holds the fake Docker and scripted SDK shared by the Gate 1 and F-016 engine tests.
- Existing tests now read the new records through `test/inbox-items.ts`.
- The test engineer added `test/f016-acceptance.test.ts` (30 tests); see `F-016-test-report.md`.
- Full suite on Linux at `6246b09`: 1,578 passed, 20 skipped, 0 failed (validation judge's run). CI on `6246b09`: every job green.
- F-016 AC-11 (F-002 in the trial project) is a live check. It needs the workflow installed in `factory-e2e-trial` (A-1), so it is left for validation on the owner's PC.

## Known gaps

- Agents still run in containers through the current runner. Moving to host sessions (ADR 0026) belongs to the worktree thread. The readiness session follows the Gate 1 reviewer's runner, so it moves with it.
- Gate 2 M1 is fixed: an answer the engine didn't read from GitHub in the same run is checked on GitHub before its effect, and remote changes under `inbox/` are refused. See the fixes table in `F-016-security-gate2.md`.
