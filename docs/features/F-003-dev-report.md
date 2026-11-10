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

## Fixes after the Gate 2 re-review and the test engineer's run

Tests in class `SecondReviewRegressions`; the test engineer's two failing acceptance tests now pass.

| Finding | Fix |
|---|---|
| Test run F1: every job declaring permissions still flagged | S8.3 is met when the workflow, or every job in it, declares permissions |
| Test run F2: weekly audit hidden by a second audit workflow | Any audit workflow with an at-least-weekly cron satisfies the schedule rule |
| Gate 2 re #1 and #12 (High): token on the owner's admin account bypasses protection | Step 8 now puts the token on a separate machine account with the Write role; using the owner's own account needs a Security decision first. Admins stay exempt so the owner can merge their own PRs |
| Gate 2 re #4: one-line flow or JSON workflow | `uses`, `cron` and `write-all` are read on every line, including top-level ones |
| Gate 2 re #3: apostrophe stopped comment stripping | A quote only opens a string at the start of a value |
| Gate 2 re #17: indented `ref:` in an item body; symlinked items | Filed markers are read from frontmatter only; symlinked item files are skipped |
| Gate 2 re #16: malformed `--previous` crashed | Fails closed with a message |
| Gate 2 re #13: secret in a `uses` ref copied to the report | Every gap is passed through the secret rules and redacted before output |
| Gate 2 re #19: Contents write wider than ADR 0009 | Step 8 tells the owner, and why branch protection covers it |
| Gate 2 re #24, test run O1: skipped files and found tests not named | `skipped_files` and `test_files_found` added to the assessment |
| Test run O2: tool decisions for every level | `plan-items --level` files tool decisions up to the chosen level only |
| Test run O5: lowercase README missed | Case-insensitive |
| Test run AC-14 note | Step 8 says a declined step changes nothing and stays open |

**SR-1 and SR-7 by inspection.** Both govern what the agent running the skill does (treat repo text as data; ask before changing GitHub). The checker can't enforce them because it never acts on GitHub or follows text; its side is tested (`test_ac16_instructions_in_repo_are_data`, no network, no `gh`). The agent side is verified by reading SKILL.md's rules and steps 4, 7 and 8.

**Not changed, by design.** The recommended starting level rarely rises above Rapid prototype, because higher levels need records only the factory produces (Gate 2 reports, CI history); the assessment says so. Job-level write grants and `workflow_run` triggers aren't flagged, since jobs may legitimately need them; they are Low. A generic password rule runs only in `.env` files to keep false positives down.

**Change control.** `skills/onboard-repo/` is change-controlled. Its location was approved as A-1, and PR #9 is its review; merging it is the approval.

## Spec deviations

- AC-10 says the generated workflow audits all dependencies. For Python, Go and Rust the audit tool is an external component, so S4.1 requires a review before it is used: the step stays commented and a tool decision is filed. The `cve-audit-missing` gap stays open until it is approved. npm repos get `npm audit` straight away.

## Not done (needs the owner)

- `templates/maturity.yaml` proposes a new file format (`repo-maturity/1.0`); no contract defines `.factory/maturity.yaml` yet (Interfaces).
- `templates/roles.yaml` becomes the default role policy for onboarded repos; the master has no default file (Security).
- The CLAUDE.md section names which files are change-controlled in a managed repo (Product).

## Spec v3 changes (owner decisions, 2026-11-10)

- **Plugin.** The skill moved from `skills/onboard-repo/` to `plugins/software-factory/skills/onboard-repo/`; the factory repo is now a plugin marketplace (`.claude-plugin/marketplace.json`). `claude plugin validate` passes for both, and an install into a scratch home made the plugin available. SKILL.md finds its script through `${CLAUDE_SKILL_DIR}` and no longer trusts copies inside the onboarded repo. Report paths above refer to the old location.
- **Test adoption.** The assessment has `test_inventory` (each test file and its type) and `baseline_request`; SKILL.md step 4 wires existing test commands into CI without editing tests, and new step 9 starts the baseline feature (engine `feature.start` after the owner's yes, else an open step). Tests: class `TestAdoption`.
- **Re-runs.** A re-run reads the level from `maturity.yaml`, never regenerates `factory-ci.yml`, and only adds missing branch protection settings, never removing any.
- The test engineer's `test_acceptance.py` located the master checkout by a fixed relative path; after the move it now walks up to the folder with `agents/` and `skills/`. No assertion changed.
