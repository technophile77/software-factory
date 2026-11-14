# 0028. Code goes to the code repos; requirements and records stay in the config repo

- **Status:** Accepted. Amends ADR 0005 and ADR 0009.
- **Date:** 2026-11-13
- **Decided by:** owner (decision card, F-015 OQ-2)
- **Decision item:** `docs/features/F-015-engine-build-to-pr.md`, OQ-2 and OQ-3

## Problem
ADR 0005 puts feature branches in the code repo, and ADR 0009 gives each
managed repo a `factory/state` branch for reports and records. The first
engine increment kept all feature work in the project's config repo instead,
as a recorded exception until increment 4 (F-007 spec v41). Increment 4
builds code, so code must reach the code repos. Specs, interview transcripts
(the owner's own answers), Gate reports and agent reports would follow it
under ADR 0005 and 0009 as written, and some code repos may be public, while
the owner's rule is that sensitive information never goes into a public repo.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **Code in the code repo; spec, transcript, reports and records stay in the private config repo** | Nothing sensitive reaches a public repo; one place per project for requirements; works when a project has several repos | The code repo doesn't carry its specs; the PR links to a private repo |
| Everything in the code repo, as ADR 0005 and 0009 say | Spec and history travel with the code | Transcripts and reports become public with a public repo, because `factory/state` is pushed |
| Code in the code repo plus a copy of the approved spec in the PR | Spec ships with the code | Specs may still hold sensitive detail; two copies to keep in step |

## Implications
- **Security:** transcripts, Gate reports, agent reports and inbox records
  never leave the private config repo (F-011 FR-15 already requires it to be
  private). A code repo receives only code and tests.
- **Maintenance:** agents in the code repo get the approved spec read-only
  from the config repo at the `spec_signed_off` commit, at a fixed path
  outside their worktree.
- **Scope:** one feature changes one code repo (F-015 OQ-3). A request that
  needs several repos becomes linked features, one per repo.

## Decision
1. Feature branches for code and tests, `feature/F-nnn-name` and the agent
   branches `feature/F-nnn/<agent>` (ADR 0005), live in the feature's one
   target code repo and are created from its `main`.
2. The feature's spec, interview transcript, Gate 1 and Gate 2 reports,
   agent reports, run records and inbox and PR records stay in the project's
   private config repo: the spec on its config-repo feature branch, the rest
   on the config repo's `factory/state` (ADR 0009, 0022).
3. Code repos get no `factory/state` branch, and nothing from the config
   repo is committed to a code repo. The PR description links the spec at
   its approved commit.

## Consequences
- Closes the F-007 v41 exception for code. Requirements work stays where
  increment 1 put it.
- ADR 0009's "each managed repo has a `factory/state` branch" now applies
  only to the config repo. The Agent report contract's location line
  ("committed on the feature branch") is updated through hygiene item H-0194.
- Rules out keeping specs in code repos unless a later ADR changes this.
