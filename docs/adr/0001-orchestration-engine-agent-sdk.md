# 0001. Coded workflow engine with Claude Agent SDK sessions per agent

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open decision 2; write-up in `docs/proposals/0002-orchestration-protocol.md`

## Problem
Something must move each feature through the nine stages, launch agents,
enforce gates that can never be skipped, retry and escalate failures, and keep
the developer, test engineer, security reviewer, and judge independent.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Coded engine + Agent SDK | Gates enforced in code; separate context and permissions per agent; parallel work; TypeScript like a VS Code extension | Most to build; SDK dependency |
| Claude Code session + subagents | Little to build | Gates depend on prompt-following; weak isolation; hard for the UI to observe |
| Script calling `claude -p` | Simple, fresh process per agent | Coarse control; text parsing; harder parallelism and streaming |

## Implications
- **Maintenance:** stage changes touch engine code and `workflow.yaml`; the engine follows the factory's own process.
- **Performance:** agents can run in parallel sessions.
- **Security:** permissions are set per agent in code, which decision 4 builds on.
- **Long term:** supports concurrent features (decision 10) and other UIs.

## Decision
Build a TypeScript workflow engine that owns the stage machine and enforces
every gate, retry limit, and the definition of done in code. Each agent runs
as its own Claude Agent SDK session, configured from `agents/<role>/AGENT.md`.
The orchestrator agent is invoked for judgment: classifying and investigating
failures, and drafting inbox items.

## Consequences
- Each agent's result needs a defined format: new Interfaces decisions.
- Where the engine runs (inside the VS Code extension host or as a separate
  local process) is settled under decision 1.
- Option B and C are ruled out as the production design; running agents by
  hand in Claude Code remains fine for experiments.
