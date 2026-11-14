# Proposal 0020: Keep open PRs mergeable with CI, not agents

- **Raised:** 2026-11-13, by the owner ("repetitive tasks should rely on
  tools not tokens"; "yes build it" for this case)
- **Category:** none needed. This is a Configuration hygiene item: it adds
  change-controlled files and makes no Product, Architecture, Interfaces,
  Assumptions or Security decision. It applies ADR 0013's "merge `main` into
  every active branch, never rebase" to this repo with a tool.
- **Status:** Open. Approved by merging the PR that carries it.
- **Hygiene item:** H-0115. H-0116 to H-0119 are reserved for follow-ups.

## Problem

The project's standing rule is that after any change lands on `main`, an
agent checks every open PR, merges `main` into any that are behind, and fixes
conflicts. Most of that is mechanical: the merge is clean and nobody needs to
think. Doing it with an agent spends tokens on the same work after every
merge, and it only happens when an agent session is awake.

## Proposed change (H-0115)

1. **Files:** new `.github/workflows/keep-prs-mergeable.yml`, new
   `scripts/update_open_prs.py`, new `scripts/tests/test_update_open_prs.py`
   (run by the existing `docs-checks` job), and this proposal.
2. **Reason:** the owner's rule above.
3. **Current content:** none; the work is done by hand.
4. **Proposed content:** after each push to `main` (and on manual dispatch),
   the workflow runs the script, which for each open PR into `main`:
   - skips PRs from forks;
   - leaves PRs that already contain `main` alone;
   - otherwise asks GitHub to merge `main` into the branch (the update-branch
     API, merge not rebase), pinned to the head SHA it saw, so a push made
     meanwhile is never overwritten;
   - on a conflict, adds the `merge-conflict` label and, the first time only,
     a comment saying what to do. It pushes nothing. An agent or the owner
     resolves it as ADR 0013 describes;
   - removes the label on the first run that finds the PR current or updates
     it cleanly;
   - logs one line per PR and fails the job if any PR hit an unexpected
     error, after trying all of them.
5. **Full diff:** the PR that adds this file.
6. **Expected benefit:** clean merges happen within a minute of each merge
   to `main`, with no tokens spent. Agents only see PRs that really
   conflict, and the label makes those easy to find.
7. **Risks and side effects:**
   - **Checks on the updated head.** A commit made with the workflow's own
     `GITHUB_TOKEN` starts no workflows, so the PR's checks would not run on
     the merged head until the next push. The workflow therefore uses an
     optional repo secret, `FACTORY_UPDATE_TOKEN`, for the update itself.
     It should be the factory machine account's fine-grained token (ADR
     0006, onboarding step 8), limited to this repo with Contents and Pull
     requests read and write. The owner adds it in the repo's Actions
     secrets; it is never committed (owner rule, 2026-11-11). Until it
     exists, branches are still updated and conflicts still flagged, the
     job warns that checks did not run, and a PR's checks run again on its
     next push. Using the owner's own token instead would make the factory's
     commits look like the owner's (ADR 0006, F-003 Code Review #12), so it is
     not recommended.
   - **Permissions.** The job has `contents: write`, `pull-requests: write`
     and `issues: write`. It runs only on pushes to `main` and manual
     dispatch, never on `pull_request` or `pull_request_target`, so no PR
     author can run code with these permissions. It checks out `main` only
     and never checks out or runs PR code; GitHub does the merge
     server-side. The one action used is pinned by SHA, as H-0088 requires.
   - **Agents mid-change.** An agent working on a branch that just got
     updated has its next push rejected as non-fast-forward and must pull
     first. ADR 0013 already merges into active branches, so agents
     already have to handle this.
   - **Merge commits.** Each update adds a merge commit to the PR branch.
     Squash merge (ADR 0005) keeps `main` linear, as ADR 0013 notes.
   - **Stale label.** If someone resolves a conflict by hand, the label
     stays until the next push to `main` (or a manual run). Harmless.
   - **Not covered:** failing checks. Fixing those still needs an agent.
8. **Recommendation:** approve, and add `FACTORY_UPDATE_TOKEN` once the
   factory machine account exists. Once merged, the project's standing rule
   can shrink to "resolve PRs labelled `merge-conflict`, and fix failing
   checks".

## Possible follow-ups (not part of this change)

- Offer the same workflow to managed repos through the onboarding CI
  template. That is a change to the engine's design (ADR 0013 gives this job
  to the orchestrator) and would need its own decision.
