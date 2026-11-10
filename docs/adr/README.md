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
| [0004](0004-agent-isolation-worktrees-permissions.md) | Agent isolation: worktree per agent plus per-role permissions | Accepted; amended by 0015 |
| [0005](0005-branching-feature-agent-branches-squash.md) | Feature branches with agent sub-branches, squash-merged | Accepted |
| [0006](0006-pr-factory-token-protected-main.md) | PRs via a dedicated factory token, main protected | Accepted |
| [0007](0007-unlimited-feature-concurrency.md) | Unlimited feature concurrency | Accepted |
| [0008](0008-ci-required-gate-by-maturity.md) | CI is a required merge gate, scaled by maturity | Accepted |
| [0009](0009-factory-state-branch.md) | Inbox items live on a dedicated factory/state branch | Accepted |
| [0010](0010-project-config-repo.md) | One config repo per project, layered on the master factory | Accepted |
| [0011](0011-inbox-extension-libraries.md) | Libraries for the VS Code inbox extension | Accepted |
| [0012](0012-project-control-resumable-runs-budgets.md) | Project control, resumable runs, and token budgets | Accepted |
| [0013](0013-merge-conflict-resolution.md) | Merge conflict resolution | Accepted |
| [0014](0014-owner-approval-github-device-flow.md) | Owner approval of interview sessions through GitHub on the owner's phone | Accepted |
| [0015](0015-agent-containers-signed-owner-actions.md) | Container per agent session, path matching, signed owner actions | Accepted |
| [0016](0016-python-coverage-tool.md) | coverage.py measures coverage for the factory's Python code | Accepted |
