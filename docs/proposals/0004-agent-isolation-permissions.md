# Proposal: agent execution isolation and permissions (open decision 4)

- **Category:** Security
- **Blocks:** running agents automatically
- **Cost of delay:** the engine can't launch agents safely
- **Status:** Decided: option A (ADR 0004)

## Problem
Agents run code, edit files, and read untrusted content. The spec needs the
test engineer, security reviewer, and judge to be independent of the
developer, and needs change-controlled files protected from every agent.

## Options

### A. Separate Git worktree per agent + per-agent permissions in the engine (recommended)
Each agent works in its own worktree on its own branch. The engine (ADR 0001)
gives each Agent SDK session an explicit tool allowlist and checks every file
write and command against a per-role policy.

| Role | Write | Run commands | Network |
|---|---|---|---|
| Requirements analyst | Its feature spec only | No | No |
| Developer | Product code, its docs | Build/test commands on an allowlist | Package registries only |
| Test engineer | Test code only | Test commands | Package registries only |
| Security reviewer | Its report only | Read-only analysis tools | No |
| Validation judge | Its report only | Read-only, may run tests | No |
| Orchestrator | Inbox items, run notes | Git, PR tools | Git host only |

No role may write change-controlled files; only an approved hygiene item does.

| | |
|---|---|
| Pros | Real file-level separation between developer and tester; no extra software; works on Windows; fast |
| Cons | Not a security sandbox: code an agent runs has the user's OS permissions |

### B. Container per agent (Docker / dev containers)
| | |
|---|---|
| Pros | Strongest isolation; agent-run code can't touch the host |
| Cons | Needs Docker Desktop on Windows; slower; more setup and maintenance |

### C. One working copy, tool allowlists only
| | |
|---|---|
| Pros | Simplest |
| Cons | Developer and tester see each other's work in progress; weakest protection |

## Recommendation
**A** now, with containers (B) added later for running untrusted code or
when a repo reaches Beta or above, if the owner wants it.
