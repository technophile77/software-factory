# Open design decisions

These are the spec's section 14 items. None may be assumed. Each is decided by
the owner, recorded as an ADR in `docs/adr/`, and then marked here.

Order is the suggested order to decide them in: earlier ones shape later ones.

| # | Decision | Category | Status | ADR |
|---|---|---|---|---|
| 2 | Agent communication and orchestration protocol | Architecture | Proposed, awaiting owner | — |
| 3 | Persistent storage for inbox items and decisions | Architecture | Open | — |
| 1 | VS Code extension architecture and technology stack | Architecture | Open | — |
| 4 | Agent execution isolation and permissions | Security | Open | — |
| 5 | Git branching and commit strategy | Architecture | Open | — |
| 9 | Pull request creation and repository integration | Architecture | Open | — |
| 6 | Test retry limits and escalation thresholds | Product | Open | — |
| 7 | Security severity definitions | Security | Open | — |
| 8 | Validation judge scoring and evidence requirements | Product | Open | — |
| 10 | Multiple features and concurrent workflows | Architecture | Open | — |

Numbers match the spec's section 14 list.

## What is blocked until these are decided

- **The VS Code extension** waits on 1, 2, and 3.
- **Running agents automatically** waits on 2 and 4.
- **Opening PRs automatically** waits on 5 and 9.
- **The security gates' pass/fail rule** waits on 7.
- **The validation judge's PASS rule** waits on 8.

Until then, the agents can be run by hand in Claude Code against the docs in
this repository.
