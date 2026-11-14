# F-003 Security and Testability Review (requirements review)

- **Feature:** F-003 Onboard a repository into the factory, spec v1
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-10
- **Result:** 7 requirements added to the spec (SR-2 to SR-8). One owner decision needed, already in the spec as A-5 (using the owner's `gh` login for branch protection).

| # | Criterion | Severity if missed | Finding | Resolution |
|---|---|---|---|---|
| 1 | S8.4, S4.5 | Critical | Running an unknown repo's build or tests to gather evidence executes untrusted code with the owner's permissions (install scripts, test hooks). | SR-2: assessment reads files only; evidence comes from CI |
| 2 | S3.1, S3.3 | Critical | A secret scan that quotes what it found copies the secret into reports, items and commits on `factory/state`. | SR-3; AC-4 checks the value never appears |
| 3 | S1.4 | High | Symlinks in the target repo could make the scanner read or report files outside it. | SR-4 |
| 4 | S8.3, S4.3 | High | The generated CI workflow becomes the repo's merge gate; default token permissions or unpinned actions would weaken every later PR. | SR-5; AC-10 |
| 5 | S1.3 | Medium | Branch names, repo names and paths from the repo reach `git` and `gh` calls. | SR-6 |
| 6 | S8.2, S8.5 | High | Branch protection and repo creation need admin rights the factory token must not have (ADR 0006). | SR-7; owner decision A-5 |
| 7 | S5.1 | Medium | A workflow file that fails to parse could be skipped and the repo marked compliant. | SR-8 |

**Abuse cases now covered in edge cases:** repo text addressed to the agent (AC-16), symlinks leaving the repo, malformed workflow files.

**Not applicable:** S2 (no endpoints), S7 (checked at Code Review).

**Dependencies:** none added; the checker is standard-library Python (S4.1 not triggered).
