# 0030. At Rapid prototype, CI is advisory and Claude merges PRs once local tests pass

- **Status:** Accepted
- **Date:** 2026-11-14
- **Decided by:** owner
- **Decision item:** owner's request in the project thread "Speed up
  prototyping: non-blocking CI, auto-merge PRs" (2026-11-14); hygiene H-0220

## Problem
Prototyping the factory is slower than the owner wants. Two things wait on
others: work waits for CI to go green before a PR counts as ready (ADR 0008,
definition of done item 12), and every PR waits for the owner to merge it
(ADR 0017, `development-workflow.md`). The owner has reviewed every PR so far
and found nothing to send back, and anything merged can be reverted.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Keep CI required and owner merges | Independent clean-machine check before every merge; owner sees every change | Each PR waits on CI minutes and on the owner's attention |
| **CI advisory and Claude merges at Rapid prototype (chosen)** | No waiting on CI or on the owner for a PR whose content he already approved; CI still runs on every PR and after merge | A change that only fails on a clean machine reaches `main` and is fixed after; the owner sees PRs after they land |
| Drop CI at Rapid prototype | Saves Actions minutes | Loses the clean-machine evidence that promotion to Alpha needs |

## Implications
- **Testing is not dropped.** The tests that cover a change must pass
  locally before its PR is opened, and CI keeps running on every PR and every
  push to `main`. A red run is still a test failure (`testing-strategy.md`);
  it just no longer holds a merge.
- **Security:** merging is an action with real effect (OWASP LLM Top 10 2025,
  LLM06 excessive agency). The owner's approval moves from each merge to the
  content: Claude may merge only a PR whose change-controlled edits,
  decisions and specs the owner has already approved. Rollback is a revert
  PR.
- **GitHub:** neither `technophile77/software-factory` nor
  `factory-e2e-trial` requires a status check today (checked 2026-11-14), so
  no setting changes. `software-factory`'s `main` requires a pull request
  and one code-owner approval, with admins allowed to bypass. GitHub never
  lets a PR's author approve it, and PRs are opened with the owner's
  account, so Claude's approval is its review note on the PR and the merge
  goes through the owner's admin bypass.
- **Maintenance:** required checks come back when a repo is promoted to
  Alpha, from the CI row of `maturity-levels.md`.

## Decision
At Rapid prototype, for every repo the factory manages and for the factory
itself:

1. **No CI check is required.** Every workflow still runs on each PR and
   each push to `main`, as information. Branch protection lists no required
   status checks at this level. From Alpha, the CI row of
   `maturity-levels.md` applies again and the level's jobs become required.
2. **Local tests first.** Before opening a PR, the author runs the tests
   that cover the change (the affected suites at least) and they pass. The
   PR description says what was run.
3. **Claude may approve and merge a PR** when all of these hold:
   - the local test run of rule 2 passed on the PR head;
   - the PR is out of draft, with its title and description up to date;
   - every change-controlled edit, decision, assumption and spec status in
     it has the owner's recorded approval;
   - the owner has not asked to hold it.
   Claude records its review on the PR (as a comment, since GitHub won't
   accept an approving review from the PR's author) and squash-merges.
4. **Red CI after a merge** is fixed forward or reverted at once by the
   thread that merged it, without waiting for the owner.
5. Everything else that needs the owner still goes to him: decisions,
   assumptions, specs, change-controlled edits, credentials, security risk
   acceptance, releases and tags.

## Consequences
- ADR 0008 keeps CI on every PR and push and its maturity scaling, but at
  Rapid prototype no job is required. Definition of done item 12 is met at
  this level by the local test run.
- ADR 0017's "the owner merges" does not apply at Rapid prototype; the
  inbox's Approve and merge stays available to the owner.
- The engine's own merge path is unchanged: today it merges only hygiene PRs
  (F-011 FR-10, OQ-9 test). Letting the engine merge feature PRs needs its
  own feature spec.
- At each promotion proposal the orchestrator asks the owner whether Claude
  keeps merging at the new level.
- The onboarding skill and checker still treat missing required checks as a
  gap at every level; aligning them with this ADR is follow-up hygiene item
  H-0221.
