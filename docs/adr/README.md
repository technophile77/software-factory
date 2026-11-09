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
| [0004](0004-agent-isolation-worktrees-permissions.md) | Agent isolation: worktree per agent plus per-role permissions | Accepted |
| [0005](0005-branching-feature-agent-branches-squash.md) | Feature branches with agent sub-branches, squash-merged | Accepted |
| [0006](0006-pr-factory-token-protected-main.md) | PRs via a dedicated factory token, main protected | Accepted |
| [0007](0007-unlimited-feature-concurrency.md) | Unlimited feature concurrency | Accepted |
| [0008](0008-ci-required-gate-by-maturity.md) | CI is a required merge gate, scaled by maturity | Accepted |
| [0010](0010-project-config-repo.md) | One config repo per project, layered on the master factory | Accepted |
