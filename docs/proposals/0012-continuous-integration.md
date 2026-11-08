# Proposal: continuous integration (new item 12)

- **Raised:** 2026-11-08, from the owner's question "where does CI come into play?"
- **Category:** Architecture
- **Status:** Awaiting owner

## Problem
All testing today happens inside the factory: the test engineer runs tests in
its own worktree (stage 6). Nothing independently re-checks the exact commit
that will be merged, on a clean machine. The spec and ADRs don't mention CI.

## Where CI fits
1. **Pre-merge gate.** After stage 9 opens the PR, CI runs on the PR head.
   The orchestrator only marks the PR ready for the owner when CI is green.
   Branch protection (ADR 0006) makes the required checks a merge condition.
2. **Failures.** A red CI run is handled like any other test failure, using
   the retry-by-cause policy in `testing-strategy.md`, then the Testing inbox.
3. **Maturity.** CI history on `main` is evidence for promotion and a trigger
   for proposing a demotion (a sustained red `main`).
4. **The factory's own repo.** Docs checks now (links, YAML validity,
   frontmatter); engine and extension tests once that code exists.

## Options

### A. CI is a required gate, scaled by maturity (recommended)
GitHub Actions runs on every PR and on `main`. Required jobs grow with the
repo's maturity level:

| Level | Required CI jobs |
|---|---|
| Rapid prototype | Build, smoke test |
| Alpha | + unit tests, acceptance tests, secret scan |
| Beta | + contract tests, integration tests, dependency audit |
| Release / Production ready | + full regression, performance tests, coverage report |

Workflow files in `.github/workflows/` are change-controlled (hygiene process).

| | |
|---|---|
| Pros | An independent check of the exact merge commit on a clean machine; GitHub enforces it; evidence for the judge and for promotions |
| Cons | Actions minutes and setup per repo; one more place for a failure |

### B. CI runs but is advisory
| | |
|---|---|
| Pros | Visibility without blocking |
| Cons | A red check can be merged past; weakens the "done means evidence" rule |

### C. No CI; the factory's own runs are the authority
| | |
|---|---|
| Pros | Nothing extra to run or pay for |
| Cons | No clean-environment check; results depend on the agent's worktree |

## Recommendation
**A**, with GitHub Actions because the repos are on GitHub. If approved, this
also adds "CI green on the PR head" to the definition of done.
