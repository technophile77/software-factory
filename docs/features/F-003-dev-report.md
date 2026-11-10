# F-003 Developer completion report

- **Feature:** F-003 Onboard a repository into the factory, spec v2
- **Role:** software-developer
- **Date:** 2026-11-10
- **Deliverable:** `skills/onboard-repo/` (SKILL.md, `scripts/factory_check.py`, templates, assessment schema, tests)

## Fixes after Gate 2 and first validation

Each fix has a regression test in `tests/test_factory_check.py` (class `ReviewRegressions` unless noted).

| Finding | Fix | Test |
|---|---|---|
| Validation B1: duplicate gap ids crash `assess` | One unpinned-action gap per workflow and action, every use listed as evidence | `test_b1_same_action_in_two_jobs` |
| Gate 2 #3, validation M1: commented text and any cron counted as present | CI and audit checks read workflows with comments stripped; only a cron that runs at least weekly counts | `test_m1_commented_jobs_do_not_count`, `test_m1_monthly_cron_is_not_weekly` |
| Gate 2 #4: flow-style and quoted `uses`, `write-all`, `pull_request_target` | Detected; new `workflow-write-all` (Medium) and `workflow-pr-target` (High) gaps | `test_gate2_hidden_uses_and_risky_triggers` |
| Gate 2 #1 (High): protection let the token merge after approval | Step 8 applies an explicit payload with stale-review dismissal, last-push approval and strict checks; the checker calls anything weaker incomplete. Admins stay exempt so the owner can merge PRs they authored | `Protection.test_states` |
| Gate 2 #5, validation M2: vendored and build folders not scanned | Every tracked file is scanned; vendored folders are only left out of stack and test detection | `test_m2_secrets_in_vendored_folders_are_scanned` |
| Gate 2 #6: missing secret types | npm, GitLab and AI API keys; secret assignments in `.env` files (not `.example`) | `test_gate2_more_secret_types` |
| Validation M3: docs and feature folders counted as tests | Only code files outside `docs/` count; acceptance needs `acceptance/`, `e2e/` or `.feature` | `test_m3_docs_and_feature_folders_are_not_tests` |
| Validation M4: gaps without evidence | Evidence added to `docs:purpose` and `factory:state-branch` | `test_m4_every_gap_has_evidence` |
| Gate 2 Low: `git ls-files` runs a repo's `core.fsmonitor` | Checker's git calls switch off fsmonitor and hooks; SKILL.md requires the same for every git command | `test_sr2_repo_git_config_cannot_run_commands` |
| Gate 2 Low: docker actions always pinned | Need an `@sha256:` digest | `test_docker_actions_need_a_digest` |
| Gate 2 Low: item body could suppress filing | Only `links` refs mark an item as filed | `test_item_body_cannot_suppress_filing` |
| Gate 2 Low: non-UTF-8 or deep manifests crash | Fail closed with a message | `test_bad_manifest_encoding_fails_closed` |
| Gate 2 Low: SR-6 untested | Test that the checker has no shell call | `test_sr6_no_shell_in_checker` |
| Gate 2 #7: roles.yaml deny lists | Deny `.claude/**`, `.github/**`, `.gitignore`, `agents/**`, `skills/**`, `workflows/**` too | inspection |
| Gate 2 Low: CI template | `persist-credentials: false`, fixed `ubuntu-24.04` runner | `test_ac10_ci_template` (pins), inspection |
| Gate 2 #5 instruction gaps; validation M8, M9 | SKILL.md: hooks off for all git commands; secrets never opened; security gaps removed only with the owner; run from the master checkout; one owner yes before pushing; strict patterns for command values; owner values never changed to pass; existing config repo committed directly (A-2); edge cases: other project's manifest, remote-only `factory/state`, partly onboarded `.factory/`, empty repo, default branch not `main`; token expiry | inspection |

## Spec deviations

- AC-10 says the generated workflow audits all dependencies. For Python, Go and Rust the audit tool is an external component, so S4.1 requires a review before it is used: the step stays commented and a tool decision is filed. The `cve-audit-missing` gap stays open until it is approved. npm repos get `npm audit` straight away.

## Not done (needs the owner)

- `templates/maturity.yaml` proposes a new file format (`repo-maturity/1.0`); no contract defines `.factory/maturity.yaml` yet (Interfaces).
- `templates/roles.yaml` becomes the default role policy for onboarded repos; the master has no default file (Security).
- The CLAUDE.md section names which files are change-controlled in a managed repo (Product).
