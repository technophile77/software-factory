# Proposal 0025: Clear the merge-conflict label when the conflict is fixed

- **Raised:** 2026-11-13, by the owner ("Fix it" on the decision card "Clear
  the merge-conflict label as soon as a PR's conflict is fixed?")
- **Category:** none needed. A Configuration hygiene item on the H-0115
  workflow (proposal 0020); no Product, Architecture, Interfaces,
  Assumptions or Security decision.
- **Status:** Open. Approved by merging the PR that carries it.
- **Hygiene item:** H-0150.

## Proposed change (H-0150)

1. **Files:** `.github/workflows/keep-prs-mergeable.yml`,
   `scripts/update_open_prs.py` (comment text only), and this proposal.
2. **Reason:** the `merge-conflict` label only comes off on the next push to
   `main`. After someone fixes a conflict by hand the label stays, so the PR
   still looks blocked (proposal 0020, risk "Stale label").
3. **Current content:** the workflow runs on pushes to `main` and manual
   dispatch only.
4. **Proposed content:**
   - The workflow also runs on `pull_request: synchronize` (a push to a PR
     branch). A new job, `clear-conflict-label`, runs only when that PR is
     from this repo and carries the label. It waits for GitHub to work out
     whether the PR merges (up to about 30 seconds) and, if it does, removes
     the label. If it still conflicts, or GitHub has not decided, it leaves
     the label; the next push to `main` checks again.
   - The existing `update-prs` job is skipped on `pull_request` events, so a
     PR push never merges `main` into other PRs. Its concurrency group moves
     from the workflow to the job, unchanged.
   - The conflict comment now says the label comes off once a fix is pushed.
5. **Full diff:** the PR that adds this file.
6. **Expected benefit:** the label is accurate within a minute of the fix,
   so the owner and agents can trust it to find PRs that really need work.
7. **Risks and side effects:**
   - **Permissions.** The new job has `pull-requests: write` only, to read
     `mergeable` and remove the label. It has no checkout and runs no code
     from the PR: one inline `gh api` script with the PR number and repo
     passed through `env`, not interpolated (no template injection).
   - **Who can trigger it.** `pull_request`, not `pull_request_target`. A
     push to a branch in this repo already needs write access. Fork PRs get
     a read-only token and no secrets from GitHub, and the job skips them.
   - **Runs.** Every push to a PR starts the workflow, but the job is skipped
     in a second unless the PR is labelled; skipped jobs use no runner time.
   - Checked with actionlint 1.7.7 and zizmor 1.32.0 (offline, default and
     pedantic personas): no findings above informational.
8. **Recommendation:** approve.
