# 0003. Engine runs as a separate local process; VS Code extension is the UI

- **Status:** Accepted; amended by 0022: the VS Code UI for the inbox is Microsoft's GitHub Pull Requests extension; the engine stays a separate process
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open decision 1; write-up in `docs/proposals/0001-vscode-extension.md`

## Problem
Where the workflow engine (ADR 0001) runs, and what the VS Code extension is
built from.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Separate local process | Work continues when VS Code closes or reloads; crashes are isolated; thin UI over `.factory/` files | One more process; needs a small control channel |
| Inside the extension host | Simplest; one install | Work stops with the editor; long runs compete with the editor |

## Implications
- **Maintenance:** two packages (engine, extension) in TypeScript, sharing the item model.
- **Performance:** agent work doesn't slow the editor.
- **Security:** the engine holds agent credentials and permissions; the extension doesn't need them.
- **Long term:** other front ends could use the same engine and files.

## Decision
The engine is a separate local Node process. The VS Code extension starts and
stops it, shows status, and presents the three inboxes by reading and writing
`.factory/inbox/` files (ADR 0002).

UI building blocks (proposed alongside; the owner can revisit before UI work
starts): tree views for the three queues, one webview for the item detail
card and its five actions, the native diff editor for hygiene diffs, and
`@vscode/test-electron` for integration tests.

## Consequences
- The extension-to-engine control channel (start, stop, status) is a new
  **Interfaces** decision.
- Agent permissions and isolation (decision 4) are enforced in the engine.
