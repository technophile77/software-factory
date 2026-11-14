# Proposal 0033: A state machine library for the feature lifecycle

- **Raised:** 2026-11-14, by the owner ("is there a use case for a state
  machine in this project? like jssm?"), after the increment 3 trial hit
  stuck states
- **Category:** Architecture (a new runtime library in the engine, S4.1)
- **Status:** Decided: option C, jssm (ADR 0031), by the owner on 2026-11-14 (decision card)
- **Scope:** the feature lifecycle in the engine (stages and the waiting
  conditions inside them). Interview item states and inbox items are not
  changed.

## Problem

Each feature's state is an event log in the `factory/state` branch, folded
by `engine/src/interview/model.ts`. The `stage` event sets the stage to
any value, so nothing stops an illegal move. What runs next is decided by
if-chains spread across `engine/src/engine.ts` (startup recovery, the end
of each Gate 1, readiness and analyst run). Each stuck state in the trial
was a combination of stage, run status and waiting item that no branch
handled: the analyst idle in the interview, Gate 1 parked with no item, a
delivered reply not acted on after a restart. FR-13 and F-016 FR-7 each
patched one such combination.

The bug class is "a reachable state where nobody acts". A model of the
lifecycle that includes the waiting conditions lets a test list every
reachable state and fail when one names no actor (the engine, an agent, or
the owner with an inbox item). F-018's `activity` code can then be derived
from the same state.

## Options

Facts checked on 2026-11-14 against the npm registry, a scratch install
with `npm audit`, the packages' own typings, and GitHub search.

### A. XState 5.33.4 (recommended in the evaluation)

| | |
|---|---|
| Pros | No dependencies, 2.7 MB. Pure `transition()` / `initialTransition()`, so the event log stays the source of truth. `xstate/graph` enumerates reachable states. Typed states and events through `setup({ types })`. Active team (213 commits in the last three months, 30k stars) |
| Cons | Verbose object definitions; a larger API than the engine needs |

### B. A typed table of our own

| | |
|---|---|
| Pros | No dependency; fully typed |
| Cons | We write and maintain the reachability check ourselves, against the prefer-existing-tools rule |

### C. jssm 5.164.1

| | |
|---|---|
| Pros | A machine is a short line of text (`a 'next' -> b;`) that also renders as a diagram the owner can review. Introspection enough for the liveness test: `states()`, `list_exits()`, `has_unenterables()`, `is_terminal()`. `serialize()` / `deserialize()`. Two small runtime dependencies; core bundle about 480 KB. 10,148 tests at 100% line coverage (its README). MIT |
| Cons | Its typings declare `type StateType = string`, so a misspelled state or action in engine code compiles. One author (11 commits in the last three months, 374 stars). The visualiser dependencies (@viz-js/viz, @resvg/resvg-wasm) are optional but install by default |

### D. Not now

Keep fixing stuck states one at a time as trials find them.

## Outcome

The owner chose C, and then widened the scope to every stateful part of
the engine (agent runs, interview items, inbox items), so that none can
reach a dead end. ADR 0031 records it with the S4.1 review and the
mitigations for its two cons. The models and dead-end checks are feature F-019,
which goes through the interview and readiness gate before any code.
