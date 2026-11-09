# 0010. One config repo per project, layered on the master factory

- **Status:** Accepted
- **Date:** 2026-11-09
- **Decided by:** owner
- **Decision item:** item 13; write-up in `docs/proposals/0013-project-manifest.md`

## Problem
A project can span several repos and needs its own agents, skills, and
standards, while the master factory stays generic in its own repo.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Config repo per project | Clear, versioned boundary; master stays generic; per-project upgrade schedule | One extra small repo per project |
| Inside a primary code repo | No extra repo | One repo is special; boundary blurred |
| Inside the master repo | One place | Every project change is a master change |

## Decision
- Each project has its own config repo holding `factory-project.yaml` and
  the custom skill, agent, and standards files it points to.
- The manifest pins a master factory version; upgrading is a config hygiene item.
- Effective config = master defaults with the project manifest applied on top,
  resolved by the engine at each agent run and recorded in the agent report.
- Cross-repo inbox items and the project maturity record live on the project
  config repo's `factory/state` branch (ADR 0009).

## Consequences
- The manifest format becomes an interface contract (Project manifest v1.0).
- Which defaults are protected from override or exclusion is a separate decision.
