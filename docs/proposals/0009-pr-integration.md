# Proposal: pull request creation and repository integration (open decision 9)

- **Category:** Architecture (with Security implications)
- **Blocks:** stage 9, config hygiene PRs
- **Status:** Decided: option A (ADR 0006)

## Problem
The orchestrator opens PRs (ADR 0005) on GitHub. The spec says only the owner
merges. That should be guaranteed, not just instructed.

## Options

### A. Dedicated factory token + branch protection (recommended)
The engine uses its own fine-grained GitHub token, limited to the repos the
factory manages, with only the permissions needed to push branches and open
PRs. `main` is protected: PRs need the owner's approving review, so the
factory cannot merge even by mistake. PRs carry the definition-of-done
evidence checklist, the maturity level, and the owner as reviewer.

| | |
|---|---|
| Pros | Merge control enforced by GitHub, not by prompt; factory actions show up separately from yours; token can be revoked alone |
| Cons | One-time setup per repo (token, branch protection) |

### B. Use your own GitHub login via the `gh` CLI
| | |
|---|---|
| Pros | No setup |
| Cons | The factory can do anything you can, including merging; its actions look like yours |

### C. No automatic PRs
The orchestrator prepares the branch and PR text; you open it.
| | |
|---|---|
| Pros | Nothing to set up; total control |
| Cons | A manual step on every feature, against the spec's "agents do the work" |

## Recommendation
**A.** The factory does the work, and GitHub itself makes sure only you can
merge. Support for hosts other than GitHub can be added later behind the
same interface.
