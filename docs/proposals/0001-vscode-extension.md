# Proposal: VS Code extension architecture and stack (open decision 1)

- **Category:** Architecture
- **Blocks:** all UI work; where the engine (ADR 0001) runs
- **Cost of delay:** the inboxes can't be built
- **Status:** Decided: option A (ADR 0003)

## Fixed by earlier decisions
- TypeScript (ADR 0001: engine uses the Agent SDK in TypeScript).
- The extension reads and writes `.factory/inbox/` files (ADR 0002).

## Question 1: where does the engine run?

| Option | Pros | Cons |
|---|---|---|
| **A. Separate local process (recommended)** | Agents keep working when VS Code is closed or reloaded, as the spec's "continue while awaiting decisions" needs; a crash in one doesn't take down the other; the UI is a thin view over `.factory/` files | One more thing to start (the extension can launch it); needs a small control channel (start, stop, status) |
| B. Inside the extension host | Simplest; one install | Work stops whenever VS Code closes or reloads; long agent runs compete with the editor |

## Question 2: UI building blocks (recommendation, decided with Q1 unless the owner objects)
- **Tree views** in a Factory sidebar for the three queues: native look,
  priority sorting, blocking badges, counts in the activity bar.
- **One webview** for the item detail card (context, options, pros/cons,
  recommendation, diff) with the five action buttons. Plain HTML/TS first;
  add a framework only if the card outgrows it.
- **Native diff editor** for configuration hygiene diffs.
- Tests: `@vscode/test-electron` for integration, plus unit tests on the
  item model.
