# Architecture decision records

One file per approved Architecture decision: `NNNN-short-title.md`, numbered
in order, using `template.md`.

- An ADR is written only after the owner approves the decision.
- Accepted ADRs are not edited. To change a decision, write a new ADR that
  supersedes it and mark the old one `Superseded by NNNN`.

| # | Title | Status |
|---|---|---|
| [0001](0001-orchestration-engine-agent-sdk.md) | Coded workflow engine with Agent SDK sessions per agent | Accepted |
| [0002](0002-inbox-storage-files-in-repo.md) | Inbox items stored as one file per item in the repo | Accepted |
| [0003](0003-engine-separate-process-vscode-ui.md) | Engine as a separate local process; VS Code extension is the UI | Accepted |
