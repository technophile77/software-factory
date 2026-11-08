# Open design decisions

These are the spec's section 14 items. None may be assumed. Each is decided by
the owner, recorded as an ADR in `docs/adr/`, and then marked here.

Order is the suggested order to decide them in: earlier ones shape later ones.

| # | Decision | Category | Status | ADR |
|---|---|---|---|---|
| 2 | Agent communication and orchestration protocol | Architecture | Decided | [0001](adr/0001-orchestration-engine-agent-sdk.md) |
| 3 | Persistent storage for inbox items and decisions | Architecture | Decided | [0002](adr/0002-inbox-storage-files-in-repo.md) |
| 1 | VS Code extension architecture and technology stack | Architecture | Decided | [0003](adr/0003-engine-separate-process-vscode-ui.md) |
| 4 | Agent execution isolation and permissions | Security | Decided | [0004](adr/0004-agent-isolation-worktrees-permissions.md) |
| 5 | Git branching and commit strategy | Architecture | Decided | [0005](adr/0005-branching-feature-agent-branches-squash.md) |
| 9 | Pull request creation and repository integration | Architecture | Decided | [0006](adr/0006-pr-factory-token-protected-main.md) |
| 6 | Test retry limits and escalation thresholds | Product | Open | — |
| 7 | Security severity definitions | Security | Proposed, awaiting owner ([proposal](proposals/0007-security-severity.md)) | — |
| 8 | Validation judge scoring and evidence requirements | Product | Open | — |
| 10 | Multiple features and concurrent workflows | Architecture | Open | — |
| 11 | Software maturity levels per repo and project (new requirement) | Product | Spec section 16 approved; criteria tables still draft ([maturity-levels.md](maturity-levels.md)) | — |

Numbers 1 to 10 match the spec's section 14 list. Later numbers are items added since.

## What is blocked until these are decided

- **The VS Code extension** waits on 1, 2, and 3.
- **Running agents automatically** waits on 2 and 4.
- **Opening PRs automatically** waits on 5 and 9.
- **The security gates' pass/fail rule** waits on 7.
- **The validation judge's PASS rule** waits on 8.

Until then, the agents can be run by hand in Claude Code against the docs in
this repository.
