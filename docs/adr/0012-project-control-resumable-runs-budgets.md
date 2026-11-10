# 0012. Project control, resumable runs, and token budgets

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decided by:** owner
- **Decision item:** item 14; write-up and per-question decisions in
  `docs/proposals/0014-run-control-and-token-budgets.md`

## Problem
The factory had no per-project on/off switch, no defined behavior when the
token budget runs out, no check that it works only on authorized repos, and
no way to plan work against a budget or a target maturity level.

## Decision
- **On/off:** `factory-project.yaml` gets `enabled: true | false`. A newly
  onboarded project starts with `enabled: false`. The engine adds
  `project.pause`, `project.resume` and `project.list` for an instant,
  temporary pause, shown in the extension's Factory view. A project runs only
  when it is enabled and not paused. Activation is the on switch: queued work
  then runs to completion with no approval per run.
- **Authorization:** before each session the engine checks that the repo is
  in an enabled project's manifest, reachable with the factory token, and
  owned by an account on the owner's allow list. A mismatch stops the project
  and files a Security item. New features enter the queue only from the
  owner's request or the owner's approval of a suggestion. Agents file
  suggestions as Product items in the Decision inbox; approving one queues
  the feature.
- **Resumable runs:** a post-edit hook in each agent session makes the engine
  commit the agent's worktree change to its branch, so the agent never has to.
  An interrupted run has status `interrupted` and doesn't use a retry. On
  resume the engine resumes the session; if it can't, it starts a new session
  from the last commit with a summary of the old transcript.
- **Budgets:** `settings.budget.mode` is `subscription` (the budget is the
  plan's usage windows) or `tokens` (owner-set dollar caps). Before a launch
  the engine estimates the run's cost from past runs (90th percentile per
  agent, stage and maturity level) and launches only if the remaining budget
  covers it plus a reserve for the gates, in-progress features first. Fixed
  starting defaults, calibrated per Claude plan level when data exists, are
  replaced by measured values. Overflow into purchased credits or an API key
  is opt-in, capped by `max_usd`. "Use before reset" is opt-in, off by
  default, for already-approved work only, and turns itself off when usage
  data is missing.
- **Target maturity:** optional `target_maturity` per repo. Gates and CI
  always use the current `maturity`. The target only steers planning and
  promotion proposals.

## Consequences
- Interface changes, each through the hygiene process: Project manifest
  (`enabled`, `target_maturity`, `settings.budget`) and Engine control
  channel (`project.*` methods). Adding keys and methods is non-breaking.
- F-003 onboarding writes `enabled: false` once the manifest change is
  approved.
- Usage data on subscription plans comes partly from experimental Agent SDK
  fields, which may change.
- The engine must refuse to start when its credentials don't match the
  project's billing mode (an `ANTHROPIC_API_KEY` overrides a subscription
  login).
- Implementation is a feature spec once the engine exists (ADR 0001).
