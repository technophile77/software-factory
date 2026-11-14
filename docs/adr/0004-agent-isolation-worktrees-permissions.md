# 0004. Agent isolation: a Git worktree per agent plus per-role permissions

- **Status:** Accepted; amended by [0015](0015-agent-containers-signed-owner-actions.md) (container per agent session) and [0026](0026-agents-on-host-until-beta.md) (no containers until Beta)
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open decision 4 (Security); write-up in `docs/proposals/0004-agent-isolation-permissions.md`

## Problem
Agents run code, edit files, and read untrusted content. The developer and
the independent reviewers must stay separate, and change-controlled files
must be protected from every agent.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Worktree per agent + engine-enforced permissions | File-level separation; no extra software; works on Windows; fast | Not an OS sandbox |
| Container per agent | Strongest isolation | Needs Docker Desktop; slower; more upkeep |
| Shared copy + tool allowlists | Simplest | No separation of work in progress |

## Implications
- **Security:** agent-run code still has the user's OS permissions; role
  policies and command allowlists limit what agents do, not what the code they
  run can do.
- **Maintenance:** the role policy table is change-controlled.
- **Long term:** containers can be added later (for example from Beta up)
  without changing the role model.

## Decision
Each agent session works in its own Git worktree on its own branch. The engine
gives each session an explicit tool allowlist and checks every file write,
command, and network use against the role policy in the proposal (writes
limited to the role's own outputs; no agent writes change-controlled files).

## Consequences
- The role policy becomes a change-controlled config file in the engine.
- Branch naming for agent worktrees is part of decision 5.
