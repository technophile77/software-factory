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

- None. The AC-10 deviation (non-npm audit waiting for a reviewed tool) was withdrawn in spec v5.

## Not done (needs the owner)

- ~~The default `policy:` section in `templates/factory-project.yaml` becomes the default role policy for new projects (Security).~~ Approved as drafted by the owner (decision card, 2026-11-10).
- ~~The CLAUDE.md section names which files are change-controlled in a managed repo (Product).~~ Approved by the owner in a PR #9 review comment, 2026-11-10.

## Spec v3 changes (owner decisions, 2026-11-10)

- **Plugin.** The skill moved from `skills/onboard-repo/` to `plugins/software-factory/skills/onboard-repo/`; the factory repo is now a plugin marketplace (`.claude-plugin/marketplace.json`). `claude plugin validate` passes for both, and an install into a scratch home made the plugin available. SKILL.md finds its script through `${CLAUDE_SKILL_DIR}` and no longer trusts copies inside the onboarded repo. Report paths above refer to the old location.
- **Test adoption.** The assessment has `test_inventory` (each test file and its type) and `baseline_request`; SKILL.md step 4 wires existing test commands into CI without editing tests, and new step 9 starts the baseline feature (engine `feature.start` after the owner's yes, else an open step). Tests: class `TestAdoption`.
- **Re-runs.** A re-run reads the level from `maturity.yaml`, never regenerates `factory-ci.yml`, and only adds missing branch protection settings, never removing any.
- The test engineer's `test_acceptance.py` located the master checkout by a fixed relative path; after the move it now walks up to the folder with `agents/` and `skills/`. No assertion changed.

## Spec v4 changes (owner decision, 2026-11-10)

- **One project file.** `templates/maturity.yaml` and `templates/roles.yaml` are gone. The level is recorded only in `factory-project.yaml`, and the role policy is its `policy:` section, with per-repo overrides in `repos[].policy` (Role policy v2.0, Project manifest v1.1, hygiene H-0008).
- **Checker.** `validate-manifest` now also checks the policy: every core role present, only known roles, a repo override can't add a role, and every role that writes outside `.factory/` denies the change-controlled paths. `effective_policy` merges a repo's overrides (allow replaces, deny adds). Tests: class `ManifestPolicy`; the test engineer's FR-6 test now checks the manifest policy.
- **SKILL.md.** Step 5 no longer writes level or policy files to `factory/state`; step 7 fills the policy placeholders; re-runs leave the manifest's level and policy alone.

## Spec v5 changes (owner decision, 2026-11-10)

- **Audit tools.** The CI template's `dependency-audit` job runs OSV-Scanner v2.7.1 for Python, Go and Rust, downloaded and checked against a pinned SHA-256 before it runs. From Beta, `go-vulncheck` (govulncheck v1.9.0) and `rust-audit` (cargo-audit v0.22.2, pinned SHA-256) jobs are added. S4.1 reviews in `F-003-audit-tool-review.md`.
- **Checker.** New `stack-audit:go` and `stack-audit:rust` gaps block Beta when a Go or Rust repo's CI doesn't run its scanner (cargo-deny counts for Rust). Tests: class `StackAudits`.
- **Test engineer's tests.** AC-10's template test now checks the filled audit steps instead of the placeholder, and counts `persist-credentials` on uncommented lines only, since the template now has commented Beta jobs. The deviation test became `test_ac10_python_repo_audited_by_template`.

## Spec v6 changes (owner decision, 2026-11-10)

- **Read and tool rules.** Each role in the manifest template now has `tools` (built-in agent tools) and `read` (allow the worktree, deny secret files). Reviewers get no Edit; the security reviewer and the requirements analyst get no shell. Role policy v2.1 in `docs/interface-contracts.md` (H-0008, amended).
- **Checker.** `validate-manifest` requires every role to list tools, allow some reads and deny the secret-file globs, and rejects unknown tools. A repo override can't drop the secret denies (deny lists only add up). Tests: four new in `ManifestPolicy`.

## Fixes after re-validation 2

| Finding | Fix | Test |
|---|---|---|
| M11: README install command used a nonexistent option | README now matches SKILL.md: `/plugin marketplace add`, then `/plugin install software-factory@software-factory` | inspection |
| M13: `..` and absolute paths in policy globs | Read and write globs that leave the worktree (absolute, `~`, drive letter, `..`, `\`) are rejected | `ManifestPolicy.test_globs_cannot_leave_the_worktree` |

## Fixes after Gate 2 re-review 2

Tests in class `SecondGateRegressions` unless noted.

| Finding | Fix |
|---|---|
| R2-1 (High): any role with Bash can bypass its rules through a shell, interpreter or git | Interim: commands may not name a shell or interpreter. The rest (git's own escape hatches, OS sandbox) is an owner Security decision. |
| R2-2: globs like `.factory/[.][.]/x` | A segment that can match `..` counts as leaving the worktree. Path normalization, case folding and symlink resolution at enforcement time are engine requirements, for the owner. |
| R2-3, R2-12: change-controlled and secret lists incomplete | Both lists extended (nested and local CLAUDE.md, `.mcp.json`, hook configs, `.gitignore`, `.gitattributes`, `osv-scanner.toml`, `plugins/**`; `.npmrc`, `.netrc`, `.git-credentials`, keystores and more); template and contract match |
| R2-5: tracked `.factory/` content trusted | Tracked files there are scanned and raise a High `factory:dir-in-repo` gap; `plan-items --write` refuses a symlinked inbox; SKILL.md uses `engine.json` only from the `factory/state` worktree |
| R2-6: OSV-Scanner resolved manifests and ran Go call analysis | `--no-resolve --no-call-analysis=go`; S4.1 review corrected |
| R2-7: `npm audit --audit-level=high` | Any advisory fails |
| R2-9: unquoted `${CLAUDE_SKILL_DIR}` | Quoted (inspection) |
| R2-11: repo override could add tools | Rejected |
| R2-13: setup-go cache | `cache: false` (inspection) |

Left for the owner: R2-1 (sandbox and git), R2-2 (enforcement-time normalization), R2-4 (owner approvals the orchestrator could forge on `factory/state`), R2-8 (plugin version not checked against `factory.version`), R2-10 (machine account can approve the owner's PRs; CODEOWNERS).

## Fix after the test engineer's final run

| Finding | Fix | Test |
|---|---|---|
| F3: the Markdown assessment had no test inventory or baseline request (FR-14, FR-15) | New "Existing tests (adopted in place)" section with each file's type and the baseline request | `AC18TestInventory.test_fr14_inventory_in_markdown_assessment` (test engineer) |

## Fixes after re-validation 3

| Finding | Fix | Test |
|---|---|---|
| B4: backslash in an f-string expression broke the checker on Python 3.10 and 3.11 | Escaping moved out of the expression | `SecondGateRegressions.test_b4_checker_compiles_on_python_3_10` (also compiles with any 3.10/3.11 found); suite passes on 3.11, 3.12 and 3.13 |
| M15: test file names could break out of the Markdown table | One cell sanitizer for every table: line breaks become spaces, `\|` escaped, backticks in paths replaced | `test_m15_test_file_names_cannot_break_out_of_the_table` |
| m26: symlinked system folders (macOS `/tmp`) refused | Only folders from the working folder down count | `test_m26_symlinked_folders_above_the_working_folder_are_fine` |

