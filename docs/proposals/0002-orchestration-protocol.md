# Proposal: agent communication and orchestration protocol (open decision 2)

- **Category:** Architecture
- **Blocks:** running agents automatically, the VS Code extension, interface contracts for agent results
- **Cost of delay:** agents can only be run by hand; extension work cannot start
- **Status:** Decided: option A (ADR 0001)

## Problem
Something has to move a feature through nine stages, launch agents, collect
their results, enforce the gates, retry and escalate, and keep the agents
independent of each other. The spec requires gates that are never skipped and
agents that do not share each other's reasoning.

## Options

### A. Coded workflow engine + Claude Agent SDK (recommended)
A TypeScript engine owns the stage machine. Gates, retry limits, and "no PR
until done" are checks in code. Each agent runs as its own Agent SDK session
with its own context, tools and permissions, loaded from `agents/<role>/AGENT.md`.
The orchestrator agent is called for judgment: classifying failures,
investigating, writing inbox items.

| | |
|---|---|
| Pros | Gates enforced deterministically; true context isolation between agents; per-agent permissions (helps decision 4); parallel developer + tester; same language as a VS Code extension, so it can live inside it or beside it |
| Cons | Most to build; an SDK dependency to track; engine code is itself subject to the factory's own process |
| Maintenance | Moderate. Stage changes are code + `workflow.yaml` changes |
| Performance | Good; parallel sessions; no extra process per stage |
| Security | Best of the three: permissions set per agent in code, not by prompt |
| Long term | Scales to concurrent features (decision 10) and alternative UIs |

### B. Claude Code session as orchestrator, other agents as subagents
The orchestrator prompt drives everything; agents are `.claude/agents/` subagents.

| | |
|---|---|
| Pros | Almost nothing to build; works today |
| Cons | Gates depend on the model following instructions; long-running state lives in one session; weaker isolation; hard for an extension to observe and control |
| Security | Permissions are session-wide, not per agent |
| Long term | Likely rewritten once the inboxes need live state |

### C. Script that runs `claude -p` per agent
A small script (shell or Node) calls headless Claude Code once per stage.

| | |
|---|---|
| Pros | Simple, transparent, each agent in a fresh process |
| Cons | Coarse control (one shot per call, limited mid-run interaction); parsing results from text; harder parallelism and streaming to the UI |
| Long term | Fine as a prototype, likely outgrown |

## Recommendation
**A.** It is the only option where "no feature proceeds with unapproved
assumptions" and "critical findings block the PR" are guaranteed by code. A
sensible path is to start with the engine running the agents one at a time,
then add parallelism.

## Follow-on decisions this creates
- Interfaces: the result format each agent returns (e.g. a JSON report per role).
- Architecture: whether the engine runs inside the extension host or as a separate local process (part of decision 1).
