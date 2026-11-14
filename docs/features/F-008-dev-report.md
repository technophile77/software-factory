# F-008 Developer completion report

- **Feature:** F-008 Run Security and Testability Review on the engine, spec v12
- **Role:** software-developer
- **Date:** 2026-11-12
- **Branch:** `claude/project-thread-nty8f8` (draft PR #30), at `8ee8825`
- **Deliverable:** the `security_testability_review` stage in `engine/`. A feature whose interview checks pass gets a security-reviewer session at once; its report is validated, rendered, committed and acted on.
- **Dependencies:** none added. The lockfile is unchanged.
- **Contracts used:** Agent report v1.3 (H-0096, security-reviewer body), Inbox item v1.1 (Security items), Interview tools v1.0, Role policy v2.5, manifest `standards.security` (OQ-4).
- **Configuration:** H-0095 values in `engine/config/models.yaml` (`security-reviewer: claude-sonnet-5-5`) and `engine/config/limits.yaml` (`security_reviewer`, `security_testability_review`).

## What changed

| File | What it does |
|---|---|
| `src/st-review/standards.ts` | Reads criterion ids, the Security and Testability Review checklist and severities from `docs/security-standards.md` at the pinned master commit, and the project's additions (P ids only) from the config repo's `main` (FR-3, SR-10) |
| `src/st-review/report.ts` | Reads the report file without following links and within its cap; validates envelope, body, criteria, severities, caps, nesting, options, checklist, and the SR-7 rule for empty reports (FR-5, SR-7, SR-8) |
| `src/st-review/render.ts` | Renders `docs/features/<f>-security-testability-review.md`; every reviewer string is escaped as plain text (FR-6, SR-4) |
| `src/st-review/flow.ts` | The reviewer's first turn (engine text and standards first, untrusted text after, as JSON strings), the correction turn, the analyst's Security and Testability Review turn, and the FR-9 / FR-13 resolution check |
| `src/agent/reviewer.ts` | Narrows the role policy to the Security and Testability Review's tools and the run's one report path; runs at most two sessions (one correction), checks the worktree after each with the container gone (FR-2, FR-5, SR-1, SR-12) |
| `src/agent/sandbox.ts` | A writable report folder mount, for read-only roles only |
| `src/agent/runtime.ts` | `prepareWorktree` can detach at a commit, because the analyst's worktree keeps the feature branch |
| `src/interview/model.ts` | Security and Testability Review state on the transcript chain: runs, findings, pending, blocked, risk items filed |
| `src/state/inbox.ts` | `fileDecisionItem` for Security items with 2 to 4 options |
| `src/engine.ts` | The stage: start, resume after restart, run cap, report acceptance, findings to the interview or the inbox, the return check |
| `src/config/limits.ts`, `models.ts` | The new sections, optional so an older factory version still loads (AC-10) |

## Tests

`npx tsc --noEmit` (engine and `test/acceptance`) is clean. `npx vitest run`: 35 files (33 passed, 2 skipped for real Docker), 546 tests: 532 passed, 14 skipped, 0 failed.

- `test/st-review.test.ts` (unit): standards parsing, AC-16, report reading (links, size), validation, AC-12, SR-7, rendering (AC-14), policy narrowing, turn layout, FR-9, AC-18, FR-13, restart state.
- `test/st-review-run.test.ts` (engine, fake Docker and SDK): AC-1/3/6, AC-7 with FR-8 and FR-9, AC-8, AC-5, AC-4, AC-10.

Not covered by my tests: AC-2 and AC-9 (restart), AC-13 end to end, AC-15 (secret in a finding), AC-17 (run cap, return without a new run), AC-18 end to end, and AC-11 (needs the real trial project).

## Interpretations and limits

1. **Choice findings wait.** The engine can't read inbox decisions yet; that is the next feature (spec section 7). A `needs_owner` finding keeps the feature blocked until then, and the FR-9 evidence says so.
2. **Matching a question to its finding.** The analyst is told to start each Security and Testability Review question with "Security and Testability Review #n:"; the FR-9 check finds the question by that prefix.
3. **A rejection** is an answered question with no section 9 row citing the finding. That files the FR-13 risk item.
4. **AC-11 needs a release.** The trial project pins a factory version, which must hold the reviewer's model, limits, `AGENT.md` and the standards, and the project's manifest needs a `security-reviewer` role with `Write` and the report path.

## Change-controlled files

`docs/interface-contracts.md` (H-0096, approved) and the two engine config files (H-0095, approved). No others.

## After Code Review and the independent tests

| Item | Change | Commit |
|---|---|---|
| Code Review M1 | A finding's question must be asked after the report with the finding's requirement as its suggestion; an answer other than that requirement counts only once the owner approves the wording as a "Security and Testability Review #n" assumption (owner decision, spec v13) | `8f3a566`, `d04da2f` |
| Code Review M2 | The reviewer's raw strings are scanned before anything is rendered, committed or filed | `8f3a566` |
| Code Review L1 | Depth check is a loop (no stack overflow on a wide array) | `8f3a566` |
| Code Review L2 | An S id leading any Markdown line refuses the additions file | `8f3a566` |
| Code Review L3 | The reviewer's caps cover the whole run, kept in the run record (owner decision, spec v14) | `4777282` |
| Code Review L4 | The spec committed on the branch must still pass the interview checks before Security and Testability Review or the FR-9 check | `8f3a566` |
| Code Review L5 | A run that hits the resume limit gets its agent report and transcript note; a worktree over its limit files a Security item | `8f3a566` |
| Tests: G1-28 (SR-12) | Any file in the report folder besides the named report rejects the session | `0618d9f` |
| Tests: G1-36 (FR-1, SR-11) | A Security and Testability Review worktree left by an earlier run is removed before git prunes, so later runs start | `0618d9f` |
| Windows CI | A failed run is marked ended only after its report and note; test-side waits for slow Windows runners | `4e30661` to `2649568` |
