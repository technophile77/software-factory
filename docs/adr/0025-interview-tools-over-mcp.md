# 0025. The spec interview's tools come from an MCP mode of the engine

- **Status:** Superseded by [0029](0029-interview-in-a-terminal-command.md) (2026-11-14)
- **Date:** 2026-11-13
- **Decided by:** owner (decision card, option A)
- **Decision item:** `docs/proposals/0029-interview-tools-over-mcp.md`

## Problem
The `spec-interview` skill calls a Python client through the shell, with
JSON on stdin and exit codes, and the channel client code exists in Python
beside the engine's TypeScript. MCP is how Claude Code calls tools natively.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. Engine MCP mode** | Typed tools; owner's text never passes through a shell; channel code once, in TypeScript | Adds the MCP TypeScript SDK; plugin must find the engine's command |
| B. Python MCP server | Smallest change | Heavy Python SDK dependencies; channel code in two languages |
| C. Keep the CLI | Nothing new | Shell command per reply |

## Implications
- **Security:** the MCP mode connects to the running engine over Engine
  control channel v1.1 with the engine's own framing and peer checks; the
  channel contract is unchanged. `@modelcontextprotocol/sdk` (MIT) gets a
  full S4.1 review and an exact pin; only its stdio transport is used.
- **Maintenance:** `interview_client.py` is retired once the MCP mode passes
  F-005's acceptance tests.

## Decision
The engine gets an `mcp` subcommand: a stdio MCP server, started by Claude
Code from the plugin's `.mcp.json`, exposing the interview methods as typed
tools and forwarding them over the existing channel.

## Consequences
- F-005 FR-1 and its constraint line change from "a standard-library
  client script" to "the engine's MCP mode", in a new spec version through
  the interview. How the plugin locates the engine's command is decided
  there.
