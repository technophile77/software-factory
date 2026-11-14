# Feature: Stateful parts of the engine can't reach a dead end

- **Id:** F-019
- **Status:** Approved
- **Requested by / date:** owner, 2026-11-14 ("is there a use case for a state machine in this project? like jssm?"; "it should also be used to validate that stateful things don't end up in a dead end state like happened with the analyst, security agents, etc.")
- **Spec version:** 6

## 1. Objective and business purpose

In the increment 3 trial the engine kept stopping with nobody acting: the
analyst sat idle in the interview, Gate 1 parked with no inbox item, a
reply was delivered but not acted on after a restart. Each was a
combination of states that no code path handled, found only by the owner
waiting. This feature models every stateful part of the engine as a jssm
machine (ADR 0031) and makes a dead end a test failure instead of a stall
in a trial.

## 2. Expected behavior

The owner sees no change when things work. When a developer adds a state
or transition that leaves a reachable state with no way out and nobody to
act, the engine's tests fail and name the state. At run time, an event
that the machine doesn't allow is refused and logged instead of silently
moving the feature somewhere unexpected. F-018's `activity` code is read
from the same state, so the live status can't disagree with what the
engine will do next.

## 3. Functional requirements

| Id | Requirement |
|---|---|
| FR-1 | Each stateful part below is defined as one jssm machine in its own module: the feature lifecycle (stages, including the waiting conditions inside each stage); each agent run (`running`, `interrupted`, `complete`, `failed`, and resume) for the requirements analyst, security reviewer, readiness checker and advisor; interview items (`open`, `deferred`, `researching`, `answered`, `approved`, `rejected`, `superseded`); and inbox items, modelled as both the engine's record state (open, answered, expired) and the GitHub issue's state (open, closed, reopened, deleted), so that a hand-closed or deleted issue is a modelled state with its F-011 handling (A-2) |
| FR-2 | Every non-final state declares who acts next: the engine (with the action it takes), a named agent role, or the owner (with the inbox item that asks them). A state with no actor is a dead end |
| FR-3 | A liveness test, run with the engine's unit tests, fails when any machine has a state that can't be entered (`has_unenterables()`), a non-final state with no exits (`is_terminal()` without being declared final), or a non-final state with no actor (FR-2). The failure names the machine and state |
| FR-4 | The same test fails when a final state is reachable only through a path the owner never sees: every path to `failed` must pass through a state that files an owner item or offers a rerun |
| FR-5 | Restart is part of the model: for every state, the test checks that the engine's startup recovery has a rule for it (resume, rerun, file an item, or nothing because the state is final or owner-waiting with its item present) |
| FR-6 | The event log in `factory/state` stays the source of truth. The engine rebuilds each machine by replaying events; an event the machine refuses is not applied: the feature pauses in its last valid state, a warning names the feature, state and event, and the owner gets an inbox item to choose the feature's state (A-1). Nothing runs for that feature until the owner answers |
| FR-7 | Engine code reaches jssm only through a typed wrapper per machine that exports its states and actions as `as const` unions; a test fails when those unions and the machine's `states()` and actions differ |
| FR-8 | F-018's `activity` code for a feature is computed from the feature and run machines' current states |
| FR-9 | The machines' definitions render as diagrams in the feature's docs (jssm's visualiser, at development time only), so the owner can review the lifecycle |
| FR-10 | When the owner closes an unanswered inbox issue by hand a second time, after the engine's one reopen (F-011), the item is withdrawn. Whatever waited on it fails and offers the owner a rerun, so the withdrawal never leaves a dead end (owner, decision card 2026-11-14 08:03Z, OQ-1). F-011's edge case is amended to match (H-0231) |

## 4. Acceptance criteria

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a machine where the analyst run's `interrupted` state has no exit, when the unit tests run, then the liveness test fails and names that machine and state | FR-1, FR-3 |
| AC-2 | Given a feature state "Gate 1, report written, no inbox item" with no actor, when the tests run, then they fail naming it | FR-2, FR-3 |
| AC-3 | Given a run machine where `failed` is reachable without an owner item or rerun offer, when the tests run, then they fail | FR-4 |
| AC-4 | Given a state with no startup recovery rule, when the tests run, then they fail naming it | FR-5 |
| AC-5 | Given an event log with a `stage` event the lifecycle doesn't allow, when the engine replays it, then the stage is unchanged, the feature is paused, a warning names the feature, state and event, and an owner inbox item asks which state to use; no agent starts for that feature until it is answered | FR-6 |
| AC-6 | Given a state added to a machine but not to its typed union, when the tests run, then they fail | FR-7 |
| AC-7 | Given each lifecycle state, when `engine.status` is called, then `activity` is the code mapped from that state | FR-8 |
| AC-9 | Given an unanswered inbox item the engine has already reopened once, when the owner closes it again, then the item is recorded as withdrawn, the run or stage that waited on it is marked failed, and a rerun is offered | FR-10 |
| AC-10 | Given the machine definitions, when the development docs script runs, then one diagram per machine is written next to this spec, and the engine bundle contains no `jssm/viz` code | FR-9 |
| AC-8 | Given the trial's three stalls (idle analyst, Gate 1 with no item, reply delivered before a restart) replayed as event logs, when the engine starts, then each has an actor and moves on | FR-2, FR-5 |

## 5. Constraints

- jssm 5.164.1 pinned exactly (ADR 0031). The engine imports `jssm` only, never `jssm/viz`.
- The build touches `engine/src/engine.ts` and starts after PR #60 merges.
- No change to the event log format.

## 6. Edge cases

- Event logs written before this feature, including ones with stage moves the new machine forbids (FR-6 decides what happens; see A-1).
- Two runs for the same feature in the log (an old interrupted one and a new one).
- An owner item closed or deleted on GitHub while the engine was stopped (F-011: reopened once with a note; a deleted one gets a Notice).
- An item closed by hand a second time, after the engine's one reopen: the item is withdrawn (FR-10, OQ-1).

## 7. Dependencies

ADR 0031 (jssm). F-016 (increment 3, PR #60), F-018 (`activity` codes, PR #68), ADR 0022 (inbox on GitHub issues).

## 8. Assumptions


| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | Replaying an existing log that contains a forbidden move pauses the feature and asks the owner which state to use | Owner, decision card 2026-11-14 08:01Z | Approved |
| A-2 | Inbox items mirror the GitHub issue's states (open, closed, reopened, deleted) alongside the engine's record state | Owner, decision card 2026-11-14 08:01Z | Approved |

## 9. Security considerations

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Event text from the log is data: state and event names are checked against the typed unions before reaching jssm (S1.1) | analyst | Accepted (owner, 2026-11-14 08:04Z, decision card) |
| SR-2 | Only a close by the owner's GitHub account counts toward FR-10. Any other close is reopened with a note every time and never withdraws the item; a test closes an item twice as a different actor | Gate 1 #1 | Accepted (owner, 2026-11-14 08:04Z, decision card) |
| SR-3 | jssm and its dependencies are pinned exactly and installed with `npm ci` from the lockfile; any version change is a new S4.1 review; osv-scanner and `npm audit` cover them, including the optional packages | Gate 1 #2 | Accepted (owner, 2026-11-14 08:04Z, decision card) |
| SR-4 | Machine definitions are string constants in engine source with no interpolation; a test checks that each `sm` call has no template substitutions | Gate 1 #3 | Accepted (owner, 2026-11-14 08:04Z, decision card) |
| SR-5 | Replay catches jssm errors per feature and handles them like FR-6: that feature pauses with an owner item, the other features carry on; a test replays a log with an unknown state | Gate 1 #4 | Accepted (owner, 2026-11-14 08:04Z, decision card) |
| SR-6 | The FR-6 pause item names the commit of the refused event | Gate 1 #5 | Accepted (owner, 2026-11-14 08:04Z, decision card) |

## 10. Interface requirements

No interface changes. FR-8 uses the `activity` codes already approved in H-0225.

Hygiene items applied with the build:

| Id | Target | Change | Status |
|---|---|---|---|
| H-0230 | `engine/package.json`, lockfile | Add `jssm` 5.164.1, pinned exactly (ADR 0031) | Approved (owner, 2026-11-14 08:07Z); applied with the build |
| H-0231 | `docs/features/F-011-one-inbox.md`, edge cases | "Owner closes or deletes an issue by hand" gains: closed again after the engine's one reopen, the item is withdrawn and whatever waited on it offers a rerun (F-019 FR-10); only a close by the owner's account counts (F-019 SR-2) | Approved (owner, 2026-11-14 08:07Z); applied |

## 11. Readiness gate

Checked 2026-11-14 on v6: every FR has at least one AC (FR-9 gained AC-10), both assumptions and OQ-1 are approved, all six SRs accepted, no deferred items. Passed.

- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit
- [x] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-14 | Draft from proposal 0033 and the owner's dead-end requirement | (pending) |
| 2 | 2026-11-14 | A-1 answered: a forbidden move pauses the feature and asks the owner | owner, card 08:01Z |
| 3 | 2026-11-14 | A-2 answered: inbox items mirror GitHub issue states; OQ-1 raised | owner, card 08:01Z |
| 4 | 2026-11-14 | OQ-1 answered (FR-10, AC-9, H-0231); Security Gate 1 filed, SR-2 to SR-6 proposed; H-0230 listed | owner, card 08:03Z (OQ-1) |
| 5 | 2026-11-14 | SR-1 to SR-6 accepted | owner, card 08:04Z |
| 6 | 2026-11-14 | AC-10 added for FR-9; readiness gate passed; signed off | owner, 2026-11-14 08:07Z (in thread) |
