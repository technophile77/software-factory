# Proposal 0029: The spec interview's tools over MCP

- **Raised:** 2026-11-13, by the owner ("Do #6", review "Where the factory
  rebuilds existing tools", item 6)
- **Category:** Architecture (how the plugin reaches the engine, F-005
  FR-1: "uses only the language's standard library")
- **Status:** Decided: option A (ADR 0025), by the owner on 2026-11-13 (decision card)
- **Scope:** the `spec-interview` skill's client. Engine control channel
  v1.1, its framing and its peer checks are not changed.

## Problem

The skill calls `interview_client.py` (about 1,480 lines) through the
shell: Claude builds a command line, passes JSON on stdin, and reads exit
codes. The Model Context Protocol (MCP) is how Claude Code calls tools
natively, with typed arguments. A plugin can ship an MCP server in its
`.mcp.json`, so `interview_list`, `interview_next`, `interview_reply` and
the others would become tools Claude calls directly.

What this gains: no shell command to build for each reply, so the owner's
text never passes through a shell; typed arguments instead of a stdin
format; one permission rule per tool instead of a shell allow rule.
What it doesn't remove: the channel code (finding the engine through the
`factory/state` worktree, framing, peer and owner checks), which is most
of the 1,480 lines. So the code saved is the CLI layer only.

## Options

### A. The engine ships an MCP mode (recommended)

An `mcp` subcommand of the engine runs as a stdio MCP server that Claude Code starts
from the plugin's `.mcp.json`, and talks to the running engine over the
existing channel using the engine's own framing and peer-check code
(TypeScript). The Python client is retired.

| | |
|---|---|
| Pros | Channel code lives once, in the engine, not in two languages. Nothing new on the owner's machine beyond the engine, which the interview needs anyway |
| Cons | One new component: the official MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2, MIT, 17 dependencies, mostly for its HTTP transports we don't use). The plugin must find the engine's command (open detail: PATH or a path in `.factory/engine.json`) |

### B. A Python MCP server in the plugin

The current client becomes an MCP server using the official Python SDK,
installed in a pinned environment the way ADR 0020 does for the
onboarding tools.

| | |
|---|---|
| Pros | Smallest change to the existing client |
| Cons | `mcp` 2.3.0 pulls in 15 direct dependencies, including pydantic, starlette, uvicorn and pyjwt, for a stdio server. Channel code stays in two languages |

### C. Keep the CLI

| | |
|---|---|
| Pros | No new dependency, nothing to rebuild |
| Cons | Shell commands per reply; channel code in two languages |

## What changes if A is approved

1. A new ADR records it; F-005 FR-1 and its constraint line change from
   "a standard-library client script" to "the engine's MCP mode"; spec
   v-next through the interview.
2. Hygiene items (H-0174 to H-0177): the pinned SDK and its S4.1 review, the
   MCP mode, the plugin's `.mcp.json`, the skill rewrite, and the F-005
   acceptance tests moved to the new tools.

## Recommendation

Option A, as a medium-payoff change: the gain is mainly how Claude calls
the interview and having the channel client once, not lines removed. If
you'd rather not add the SDK for that, C is a reasonable choice.

## Cost of delay

Low. The current client works.

## Outcome (2026-11-13)

The owner chose option A. Recorded as ADR 0025. Hygiene items H-0174 to H-0177 cover the pinned MCP SDK with its S4.1 review, the engine's `mcp` subcommand, the plugin's `.mcp.json` and skill rewrite, and moving the F-005 acceptance tests. Spec changes go through the requirements interview before anything is built.
