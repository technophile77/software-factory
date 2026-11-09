# Software Factory Inbox (F-001)

A VS Code view of the factory's decision inbox. Spec:
[`docs/features/F-001-decision-inbox.md`](../docs/features/F-001-decision-inbox.md).

## Try it

1. Give the repo its state branch, checked out at `.factory/` (ADR 0009):

   ```sh
   git switch --orphan factory/state && git commit --allow-empty -m "factory/state" && git switch -
   git worktree add .factory factory/state
   echo ".factory/" >> .git/info/exclude
   mkdir -p .factory/inbox/decision
   ```

2. Put an item in `.factory/inbox/decision/D-0001.md` (format: Inbox item
   v1.0 in `docs/interface-contracts.md`).
3. Build and run: `npm ci && npm run build`, then press F5 in VS Code with
   this folder open, or package it with `npx @vscode/vsce package`.

The Factory icon in the activity bar shows the queue. Each action you take
is written to the item file and committed on `factory/state`.

## Development

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript check |
| `npm run build` | Bundle to `dist/extension.js` |
| `npm test` | Unit tests (`test/unit`) and acceptance tests (`test/acceptance`) |

`src/core/` has no VS Code imports, so it is tested in plain Node.
`src/extension.ts` is the VS Code glue.
