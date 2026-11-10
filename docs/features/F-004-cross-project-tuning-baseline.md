# Feature: Opt-in cross-project tuning baseline

- **Id:** F-004
- **Status:** Parked (owner, 2026-11-10: come back and develop fully later)
- **Requested by / date:** Alex, 2026-11-10
- **Spec version:** 0 (placeholder; not yet through the requirements interview)

## 1. Objective and business purpose
Give a new project a better starting ladder order than "cheapest first" by
learning from projects that already ran. Today each project's tuning data
stays in its own config repo (F-002), so a new project starts with nothing.

## 2. Idea as raised
- A project opts in through its manifest; nothing is shared otherwise.
- Opted-in projects contribute a summary only: per role, per rung, per
  complexity tier, sample counts, pass rates, and median tokens and cost per
  task. No transcripts, prompts, code, or project names.
- The summary lives in the master factory repo and is updated through the
  Configuration hygiene inbox like any other master change.
- A new project's initial calibration uses the summary to choose which rung
  to try first; it still has to pass calibration on its own tasks.

## 3. Questions for the requirements interview
- What exactly may leave a project, and who approves each contribution.
- Whether summaries are weighted by complexity tier, recency, or sample size.
- How a stale summary (old models, changed prices) is retired.
- Security review of what the summary could reveal about a project (S2).

## Dependencies
F-002 (tuning metrics format and per-project storage).
