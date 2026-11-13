# 0023. F-002 calibration and replays run on promptfoo

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner (decision card, option A)
- **Decision item:** `docs/proposals/0027-tuning-runs-on-promptfoo.md`

## Problem
F-002 asks for a runner that tries graded tasks across model and effort
rungs, repeats them, scores them and reports cost and tokens. Eval tools
already do this, and nothing is built yet.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. promptfoo** (MIT, Node) | Engine's language; matrix, repeats, assertions, cost reports, viewer | Large dependency tree; OpenAI agreed to acquire it (March 2026), stated to stay MIT |
| B. Inspect AI (MIT, Python) | Built for agent evals; strong sandboxing | Python to TypeScript adapter; Python 3.11+ |
| C. Build in the engine | No new component | We write the runner, scoring and reports |

## Implications
- **Security:** promptfoo runs only for calibration and replays, never in
  a normal feature run. Conditions as for LiteLLM (F-013 OQ-9): exact pin
  with lockfile, 14-day quarantine on new versions, telemetry and update
  check off, OSV-Scanner in CI, red-team and cloud features unused. Full
  S4.1 review before build.
- **SR-1/SR-2 unchanged:** each trial runs through an adapter (a promptfoo
  custom provider) that calls the engine's session runner, so it runs
  under the role's real policy, in its container, with answers out of reach.

## Decision
F-002's calibration and transcript replays use promptfoo, pinned, driven
by engine code through a custom provider. The ladder, pass bar, floors,
triggers, transcript selection, run reviews and hygiene items stay engine
code as specified.

## Consequences
- F-002 A-7 changes from "logic is engine code" to "engine code driving
  promptfoo", in a new spec version through the interview.
- Cost per trial: the Agent SDK's figure for Claude, LiteLLM's price table
  for F-013 endpoints; FR-3's hand-kept prices only where neither has one.
