# 0029. The spec interview runs in a terminal command, with no model relay

- **Status:** Accepted
- **Date:** 2026-11-14
- **Decided by:** owner
- **Decision item:** decision cards, 2026-11-14: option B ("a no-model
  terminal command") over moving questions into the GitHub inbox or keeping
  the skill; F-018 OQ-1 (a), retire the skill and the MCP mode. Spec:
  [F-018](../features/F-018-terminal-interview.md). Hygiene H-0215 to H-0218.
- **Supersedes:** [0025](0025-interview-tools-over-mcp.md)

## Problem
Under ADR 0025 the owner answers the analyst through the `spec-interview`
skill: Claude, in the owner's Claude Code, relays each item from the
engine's MCP tools. The relay depends on a model following prose rules, and
in the 2026-11-14 F-002 trial it asked the owner to approve or reject
without showing the text (issue #66). The owner can't decide on words he
wasn't shown.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A. Interview items in the GitHub inbox | Phone support; one place for every approval | Needs a new inbox item type, posting and polling for every question; slower turn-around |
| **B. Terminal command `factory-engine interview`** | Item text printed by code, never skipped; no model, no MCP server, no MCP SDK; reuses the tested `Interview` operations | PC terminal only, no phone |
| C. Keep the skill, tighten its rules | Nothing new to build | The failure is a model skipping prose rules; a stricter rule can be skipped too |

## Implications
- **Security:** no model sits between engine text and the owner, so F-005
  SR-3 and SR-10 (the relay never answers or rewrites) become properties of
  code. New terminal risks are covered by F-018 SR-1 to SR-7: escapes
  cleaned, engine text marked, terminal-only input. The plugin's MCP server
  and `@modelcontextprotocol/sdk` are removed, one external component fewer
  (S4, S9.5).
- **Usability:** the owner answers in a terminal on the PC; phone answers
  are not supported (owner's choice).
- **Maintenance:** `engine/src/mcp/server.ts`, the plugin's `.mcp.json` and
  `engine_path` setting, and the `spec-interview` skill go. The operations
  code (`engine/src/mcp/operations.ts` and its helpers) stays as the
  command's engine client.

## Decision
The engine gets an `interview` subcommand that runs the spec interview in
the owner's terminal over the Engine control channel (unchanged). The
skill, the plugin's interview MCP server and the engine's `mcp` mode are
retired in the same build, after PR #60 (F-016) merges.

## Consequences
- F-005 FR-1 and its front-end requirements, F-006's and F-009's skill
  steps, now read against the command; each spec gets a note pointing to
  F-018.
- The plugin keeps `onboard-repo` only; its version goes up.
