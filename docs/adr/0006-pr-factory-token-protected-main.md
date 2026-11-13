# 0006. Pull requests via a dedicated factory token, with main protected

- **Status:** Superseded by 0017 (kept as the optional `machine_account` mode)
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open decision 9; write-up in `docs/proposals/0009-pr-integration.md`

## Problem
The orchestrator opens PRs on GitHub; only the owner may merge, and that
should be enforced, not just instructed.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Factory token + protected main | GitHub enforces owner-only merge; factory actions are distinct; revocable | One-time setup per repo |
| Owner's own `gh` login | No setup | Factory could merge; actions look like the owner's |
| No automatic PRs | Total control | Manual step every feature |

## Decision
- The engine uses its own fine-grained GitHub token, limited to the repos the
  factory manages, with permissions to push branches and open PRs only.
- `main` in each managed repo is protected and requires the owner's approving
  review, so the factory can't merge.
- Each PR body carries the definition-of-done evidence checklist, the
  feature spec link, the repo's maturity level, and requests the owner's review.
- Hosts other than GitHub can be added later behind the same interface.

## Consequences
- Onboarding a repo includes creating or extending the token and setting
  branch protection; the factory will prepare these steps for the owner.
- The token is a secret: stored outside Git, never in logs or inbox items (S3.1).
