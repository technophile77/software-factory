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
| 6 | Test retry limits and escalation thresholds | Product | Decided (in [testing-strategy.md](testing-strategy.md)) | — |
| 7 | Security severity definitions | Security | Decided (in [security-standards.md](security-standards.md)) | — |
| 8 | Validation judge scoring and evidence requirements | Product | Decided (in [validation-judge](../agents/validation-judge/AGENT.md)) | — |
| 10 | Multiple features and concurrent workflows | Architecture | Decided | [0007](adr/0007-unlimited-feature-concurrency.md) |
| 11 | Software maturity levels per repo and project (new requirement) | Product | Spec section 16 approved; criteria tables still draft ([maturity-levels.md](maturity-levels.md)) | — |
| 13 | Project boundaries and manifest (new item) | Architecture | Decided | [0010](adr/0010-project-config-repo.md) |
| 12 | Continuous integration (new item) | Architecture | Decided | [0008](adr/0008-ci-required-gate-by-maturity.md) |
| 14 | Project pause, resumable runs, token budgets (new item) | Architecture | Open ([proposal 0014](proposals/0014-run-control-and-token-budgets.md)) | — |

Numbers 1 to 10 match the spec's section 14 list. Later numbers are items added since.

## Still open

All ten section 14 items were decided on 2026-11-08. Still pending owner
review:

- Security criteria S1 to S7 in `security-standards.md` (draft).
- The promotion criteria table and the requirements/test engineer rows of the
  gate bar in `maturity-levels.md` (draft).

Follow-on Interfaces decisions raised by the ADRs, approved 2026-11-08
(PR #2) and recorded in `interface-contracts.md`:

- Agent report format for each role (ADR 0001).
- Inbox item file format (ADR 0002).
- Engine control channel (ADR 0003).
- Role policy file format (ADR 0004).
