# 0008. CI is a required merge gate, with jobs scaled by maturity

- **Status:** Accepted
- **Date:** 2026-11-08
- **Decided by:** owner
- **Decision item:** open item 12; write-up in `docs/proposals/0012-continuous-integration.md`

## Problem
All testing happened inside the factory's own worktrees. Nothing independently
checked the exact commit to be merged on a clean machine.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Required gate, scaled by maturity | Independent clean-machine check; enforced by GitHub; evidence for judge and promotions | Actions minutes; per-repo setup |
| Advisory only | Visibility without blocking | Red checks can be merged past |
| No CI | Nothing extra | No clean-environment evidence |

## Decision
- GitHub Actions runs on every PR and on every push to `main` in each managed repo.
- Required jobs grow with the repo's maturity level (table in
  `docs/maturity-levels.md`). Branch protection lists them as required checks.
- The orchestrator marks a PR ready for the owner only when CI is green on the
  PR head. Red CI is handled by the retry-by-cause policy, then the Testing inbox.
- CI history on `main` is evidence for promotion; a sustained red `main`
  triggers a demotion proposal.
- `.github/workflows/` files are change-controlled.
- The factory repo has its own CI, starting with docs checks.

## Consequences
- Definition of done gains "CI green on the PR head".
- Onboarding a repo includes adding its CI workflow and required checks.
