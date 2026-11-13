# Proposal 0027: F-002 calibration and replays run on an eval tool

- **Raised:** 2026-11-13, by the owner ("Do #3", review "Where the factory
  rebuilds existing tools", item 3)
- **Category:** Architecture (a new external component, S4.1 notes below;
  F-002 A-7 says the tuning logic is engine code)
- **Status:** Open
- **Scope:** F-002 model and effort tuning, which is approved but not built.
  The ladder policy, triggers and hygiene items are not changed.

## Problem

F-002 asks the engine to run graded tasks across a ladder of model and
effort rungs, five trials each (A-2), check each output (A-9), and record
pass rate, tokens, cost and time per rung (FR-4, FR-5, FR-7, FR-8, FR-13,
FR-18). That is what eval tools do: run a task set across a matrix of
models, repeat it, score it with code or a model judge, and report cost
and latency. Nothing is built yet, so there is no sunk cost.

## What stays ours

The ladder and its order from measured cost (A-1), the pass bar and floors
(A-2, A-3), the step-up and step-down triggers (A-5), which transcripts
become tests (FR-6, SR-5), the run review, the hygiene items, and the role
policy and container each trial runs in. SR-1 and SR-2 require a trial to
run under the role's real policy, in its container, with the answers out
of reach. Neither tool does that by itself, so in both options a small
adapter hands each trial to the engine's existing session runner, and the
tool does the rest.

## Options

### A. promptfoo (recommended)

MIT, Node, the engine's language. Config lists tasks, the rungs as
providers, assertions (JavaScript, Python, or a model-graded rubric) and a
repeat count; it reports pass rate, tokens, cost and latency per provider,
with a local web viewer. It has a built-in Claude Agent SDK provider
(`anthropic:claude-agent-sdk`), and a custom provider (a JavaScript file)
is how our adapter plugs in.

| | |
|---|---|
| Pros | Same language as the engine, so the adapter calls the session runner in process. Matrix, repeats, assertions, cost report and viewer for free. Widely used |
| Cons | Large dependency tree (76 direct dependencies, 24 optional, in 0.125.1). OpenAI agreed to acquire it in March 2026 and said it stays open source under MIT; that is a statement, not a guarantee |

### B. Inspect AI

MIT, Python, from the UK AI Security Institute. Tasks, solvers and scorers
in Python, Docker sandboxes, multi-model runs and a log viewer.

| | |
|---|---|
| Pros | Built for agent evals by a public body; strong sandboxing and logs |
| Cons | Python, so the adapter crosses from Python to the TypeScript engine. 40 direct dependencies in 0.3.289 (including boto3, numpy, fastapi). Needs Python 3.11+ on the owner's machine for calibration |

### C. Build it in the engine, as F-002 specifies

| | |
|---|---|
| Pros | No new component; exactly what the spec says |
| Cons | We write and test the matrix runner, repeats, scoring and reports ourselves |

## Security notes (S4.1, preliminary)

Checked 2026-11-13 from the npm and PyPI registries; a full review is
recorded before build. promptfoo runs only during calibration and replays,
never in a normal feature run. Proposed conditions, the same ones you set
for LiteLLM (F-013 OQ-9): pinned exact version with a lockfile, a 14-day
quarantine on new versions, its telemetry and update check turned off,
OSV-Scanner in CI. promptfoo's red-team and cloud features are not used.

## What changes if A is approved

1. A new ADR records it; F-002 A-7 changes from "logic is engine code" to
   "engine code driving promptfoo", spec v-next through the interview.
2. Hygiene items (from H-0161): the pinned dependency, the adapter, and
   the S4.1 review.
3. Cost per trial: Claude runs keep the Agent SDK's own cost figure; runs
   on F-013 endpoints use LiteLLM's price table, so FR-3's hand-kept
   prices are needed only where neither has one.

## Recommendation

Option A. It removes the most code we would otherwise write, and it fits
the engine's language. If its dependency tree is too much, B is the
lighter-governance alternative.

## Cost of delay

Low. F-002's build waits for the engine either way; deciding first avoids
building the runner by hand.
