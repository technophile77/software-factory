# F-003 Validation report

- **Feature:** F-003 Onboard a repository into the factory, spec v2
- **Judge:** validation-judge
- **Date:** 2026-11-10
- **Commit:** `b77b825` (`claude/project-thread-g2huhl`, diff `origin/main...HEAD`, `origin/main` = `6c3fdca`)
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Blocking finding or a Not met line still fails.
- **Verdict:** **FAIL**
  - B1 is Blocking. `assess` crashes ("duplicate gap ids", exit 2) on any workflow that uses the same unpinned action twice, for example `actions/checkout@v4` in two jobs. Most real repos have such a workflow, so the assessment, which every later step needs, can't be produced for them.
  - FR-2 is Not met because of B1. Gate 2 (`F-003-security-gate2.md`, written while I worked and not yet committed) passes at Rapid prototype, but it did not catch B1.
  - Two lines are Needs owner (FR-6, AC-10), and M8 is another owner question (see M6, M7, M8). FAIL takes precedence, but these can go to the owner now, in parallel with the fixes.
  - 9 Major and 18 Minor findings are logged.

## My own run (evidence source)

On `b77b825`, from the repo root:

| Step | Result |
|---|---|
| `python3 -m unittest discover -s skills/onboard-repo/tests -v` (Python 3.13.18) | **39 run, 39 passed**, 0 failed, 0 skipped. Property-test seeds: 2814879220, 2998976687, 3675645362, 3542187854 (and a second run with 1163855655, 3661845470, 809476035, 4010047781) |
| Same suite on Python 3.11 | 39 of 39 passed |
| `ast.parse(..., feature_version=(3, 10))` on the script | Parses as 3.10 grammar (FR-12, Python 3.10+) |
| `python3 -m trace --count --missing` coverage | 895 lines executed, 107 not executed in `factory_check.py` (about 89% of lines; branch coverage not measured). The unexecuted lines include the duplicate-id `raise` (`:760`), `assess` with GitHub data (`:745-751`), the "since last assessment" Markdown (`:890-893`), and the `plan-items` CLI (`:1220-1223`) |
| Extra fuzzing: 50,000 random inputs (seed 12345) into `parse_yaml` and `scan_workflow` | No exception other than `YamlError` |
| `git status` after all runs | Clean (`__pycache__/` is ignored by the new root `.gitignore` line) |

There is no test engineer run report, no developer completion report, and no orchestrator review note for F-003 in `docs/features/`. The Gate 2 report appeared, untracked, while I was writing this report; I read it and cross-reference its findings below. The tests in `skills/onboard-repo/tests/` were added in the developer's commit (`ec05f44`). So the AC evidence below comes from my own run of the developer's tests and from my probes, not from an independent test engineer run (M5).

### Probes (fixture repos under `/tmp/claude-0/judge/`)

| Probe | Result |
|---|---|
| p2: `ci.yml` with `actions/checkout@v4` in two jobs | `error: duplicate gap ids`, exit 2, no assessment (B1) |
| p1: the CI template exactly as the skill generates it (`ci-workflow.yml`, placeholders filled, SHAs pinned, audit step left as `echo`), target level Alpha | No `cve-audit-*` gap and no `ci-job:` gap for acceptance tests, secret scan, contract, integration, regression or performance. All of them pass on the commented-out lines `# secret-scan:`, `# acceptance-tests:` and the audit hint comment (M1) |
| p3: AWS-style key in tracked `build/deploy.sh` | Not reported, and not counted in `files_skipped` (M2) |
| p3: `docs/spec/design.md` with no tests | No `tests:unit` and no `tool:test-framework` gap (M3) |
| p3: `src/features/cart.js` | No `tests:acceptance` gap (M3) |
| p4: a workflow with only job-level `permissions` | S8.3 gap anyway, with detail "jobs without permissions: (no jobs found)" (m4) |
| p4: `permissions: write-all` at the top | No gap (m4) |
| p4: no README, no `factory/state` | `docs:purpose` and `factory:state-branch` gaps have `evidence: []` (M4) |

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met (see M3, m7) | Code: `factory_check.py:371-376,436-455` (stacks, locks), `:595-598` (tests), `:384-385` (coverage), `:601` (workflows). Protection is read by `gh api` GET (`SKILL.md:40-42`). Unknown stack is reported: `:578-581`. Tests: `Detection.test_ac1_stacks_locks_and_tests`, `Detection.test_ac1_unknown_stack`, `Detection.test_monorepo_with_two_stacks`, `Detection.test_pinned_requirements_count_as_lock` |
| FR-2 | **Not met** (B1; also M1, M2, M4) | Code: `factory_check.py:563-786`. Every listed check exists: lock files `:582-587`, permissions `:612-617`, pinning `:618-626`, secrets `:628-647`, CVE audit `:653-672`, CI jobs `:674-685`, test types `:707-722`, coverage `:693`, `.factory/` ignored `:729-732`, CLAUDE.md `:733-736`, protection `:743-755`. Tests: `SecurityChecks.*`, `CiAndTests.test_ac6_alpha_jobs_missing`. But the check crashes on common workflows (B1), passes on comment text (M1), and silently skips tracked files in some folders (M2) |
| FR-3 | Met (by inspection; blocked in practice by B1) | `assess --out-json/--out-md` (`:1205-1208`); committed as `.factory/onboarding/<date>-assessment.*` on `factory/state` (`SKILL.md:96-99`). See m11 for re-runs |
| FR-4 | Met (see m10) | Code: `:829-857`; `criteria_status: "draft"` (`:853`); Product item `:1057-1069`. Test: `CiAndTests.test_ac8_no_tests_recommends_rapid_prototype` |
| FR-5 | Met (by inspection; see m17) | `SKILL.md:71-92`; templates `claude-md-section.md`, `ci-workflow.yml`. "Extend, never replace" is a rule for the whole run (`SKILL.md:27-28`) |
| FR-6 | **Needs owner** (M6) | `SKILL.md:94-105`, `templates/maturity.yaml`, `templates/roles.yaml`. The spec says to copy roles.yaml "from the master default", but no master default exists. The template is new security policy content. `maturity.yaml` uses a new format, `repo-maturity/1.0`, which the template itself calls "pending an Interfaces decision", and no item is filed for it |
| FR-7 | Met (see M8) | Code: `validate_manifest` `:938-1026`. Tests: `Manifest.test_ac11_valid_manifest`, `Manifest.test_ac11_rules` (9 rules), `Manifest.test_protected_override_with_decision_is_allowed`, `Manifest.test_override_and_exclude_same_name`, `Manifest.test_cli_rejects_invalid_manifest`, `Properties.test_generated_manifests_round_trip`. Steps: `SKILL.md:123-134` |
| FR-8 | Met (see m1) | Code: `planned_items` `:1082-1117`. Tests: `CiAndTests.test_ac12_tool_decision_has_s41_headings`, `SecurityChecks.test_ac4_secret_reported_without_value` (Security item filed) |
| FR-9 | Met | Code: `recommended_work` `:868-877`, Markdown `:910-916`. Test: `CiAndTests.test_recommended_work_lists_feature_requests`. The "no application code changes" rule is at `SKILL.md:25-26` |
| FR-10 | Met (by inspection; see m12, m13) | `SKILL.md:136-145`. Protection is applied only after a yes. Token: link only, never created or stored (`SKILL.md:23-24`) |
| FR-11 | Met | Code: `:779-785`, `existing_items` `:1037-1050`, skip `:1156-1158`. Tests: `Idempotence.test_ac13_rerun_files_nothing_new`, `Idempotence.test_ac13_fixed_gap_is_closed`, `Idempotence.test_item_ids_continue_numbering`. PR reuse by inspection (`SKILL.md:92,153-157`) |
| FR-12 | Met (see m14) | Imports are standard library only (`:14-23`). Test: `Portability.test_ac15_runs_isolated_with_stdlib_only` (`-I -S`). Passes on 3.11 and 3.13 and parses as 3.10 |
| FR-13 | Met (by inspection) | Item `:1070-1081` (`--complexity`); `SKILL.md:65-69,133-134`. The template keeps `complexity` commented out until F-002 is merged (`factory-project.yaml:14-15`). The validator accepts `complexity` values (`:976-977`; `Manifest.test_ac11_rules` "complexity must be") |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | `Detection.test_ac1_stacks_locks_and_tests` (npm, python, go, rust subtests); `Detection.test_ac1_unknown_stack` |
| AC-2 | Met | `SecurityChecks.test_ac2_workflow_without_permissions`, `SecurityChecks.test_ac2_permissions_present`. The evidence line is always 1 (m4) |
| AC-3 | Met as written (see B1) | `SecurityChecks.test_ac3_action_pinning`. Each action appears once in the fixture. The same action twice crashes (B1) |
| AC-4 | Met | `SecurityChecks.test_ac4_secret_reported_without_value` (JSON, Markdown and the filed item); `Properties.test_secret_value_never_in_output` (50 random keys) |
| AC-5 | Met | `SecurityChecks.test_ac5_lock_and_audit`; `SecurityChecks.test_audit_skipping_dev_dependencies` |
| AC-6 | Met (see M1) | `CiAndTests.test_ac6_alpha_jobs_missing` |
| AC-7 | Met, with a finding (M4) | `Files.test_ac7_assessment_shape` checks the required keys and the `blocks_level` enum, not the full schema, because there is no standard-library validator. Two gap types carry an empty `evidence` list |
| AC-8 | Met (see M3) | `CiAndTests.test_ac8_no_tests_recommends_rapid_prototype` |
| AC-9 | Met (by inspection) | `SKILL.md:27-28,75-78`. `Files.test_ac9_claude_md_section_is_marked` only checks the markers and that an existing section isn't flagged. The append is done by the agent, not the script |
| AC-10 | **Needs owner** for Python, Go and Rust (M7); Met by inspection for npm | Template: `permissions: contents: read` at the top, weekly cron, `<SHA>` pins (`ci-workflow.yml:9-13,18,26,32`). `Files.test_ac10_ci_template`. SHA resolution and filling are instructions (`SKILL.md:79-88`). For stacks without a built-in audit, the skill leaves the audit step commented out, so the generated workflow doesn't audit |
| AC-11 | Met | `Manifest.test_ac11_valid_manifest`, `Manifest.test_ac11_rules`, `Manifest.test_ac11_template_parses`, `Manifest.test_cli_rejects_invalid_manifest`, `Properties.test_generated_manifests_round_trip` |
| AC-12 | Met | `CiAndTests.test_ac12_tool_decision_has_s41_headings` (S4.1 headings and the five contract body sections) |
| AC-13 | Met | `Idempotence.test_ac13_rerun_files_nothing_new`, `Idempotence.test_ac13_fixed_gap_is_closed`. No new branch or PR on a re-run: by inspection (`SKILL.md:92,153-157`) |
| AC-14 | Met (by inspection; see m12) | `SKILL.md:23-24,138-142`: nothing is applied without the owner's yes. Open owner steps are reported at `:149-151` |
| AC-15 | Met | `Portability.test_ac15_runs_isolated_with_stdlib_only` |
| AC-16 | Met (test and inspection) | `Portability.test_ac16_instructions_in_repo_are_data` (the text doesn't reach the output; the rule is in SKILL.md). No push or settings change: `SKILL.md:15-17,23-24`; the script never touches the network (`:4-7`) |
| AC-17 | Met (by inspection) | `SKILL.md:65-69,133-134`; template `factory-project.yaml:14-15`. Nothing enforces "no `rung` keys". It is an instruction only |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met (test and inspection) | `SKILL.md:15-17`; `Portability.test_ac16_instructions_in_repo_are_data` |
| SR-2 | Met (see m16) | The script runs only `git ls-files` and `git rev-parse` (`:300-305,317,737-738,766`), and no repo code. `SKILL.md:18-19` |
| SR-3 | Met (see M2 for detection gaps) | `:628-647` (kind only); AC-4 tests |
| SR-4 | Met | `:316-348`; `SecurityChecks.test_symlink_outside_repo_is_reported_not_followed` |
| SR-5 | Met (by inspection) | `ci-workflow.yml:12-13`, no `secrets.` (`Files.test_ac10_ci_template`), `SKILL.md:79-85` |
| SR-6 | Met | `subprocess.run(["git", "-C", root, *args])` with no shell (`:302`); `SKILL.md:21-22` |
| SR-7 | Met (by inspection) | `SKILL.md:23-24,127-129,138-142` |
| SR-8 | Met as written (see M1) | Workflows that can't be read are a gap: `:605-609`, `SecurityChecks.test_unreadable_workflow_fails_closed`. YAML fails closed: `Manifest.test_unsupported_yaml_fails_closed`, `Properties.test_yaml_reader_only_fails_with_yaml_error`. M1 is another kind of fail-open: comment text counts as a pass |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Repo with no commits | Script: yes (`commit: null`; every test fixture is a `git init` with no commits). SKILL: no guidance on opening a PR from an empty repo (M9) |
| No `main` / default branch with another name | Partly. SKILL says "default branch", but the CI template hardcodes `push: branches: [main]` (`ci-workflow.yml:7-8`) and the gap title says `main` (`:748,753`) (M9) |
| Monorepo with several stacks | Yes: `Detection.test_monorepo_with_two_stacks` |
| `.factory/` already exists (partly onboarded) | Not addressed. SKILL step 5 assumes it can create a worktree at `.factory/` (M9) |
| `factory/state` on the remote only | Script detects it (`:737-738`, untested). SKILL step 5 says "if the branch doesn't exist, create it as an orphan", which could create a second, divergent root (M9) |
| Repo already in another project's manifest | Not addressed (M9) |
| `gh` missing or signed out | Yes: `branch_protection: "unknown"` plus an owner step (`:752-755`) |
| Huge repos and binaries | Yes for files over 1 MB and binaries (`SecurityChecks.test_binary_and_large_files_skipped`). But tracked files under `build/`, `dist/`, `vendor/` and `target/` are skipped silently (M2) |
| Abuse: instructions in files | Yes (AC-16) |
| Abuse: symlinks out of the repo | Yes (SR-4 test) |
| Abuse: crafted workflow YAML | No crashes (property test plus my 50,000-case fuzz). But B1 is a crash from an ordinary workflow, and M1 is a pass from comments |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD 1, 2) | Met | `F-003-repo-onboarding.md:4` Approved (owner, 2026-11-10). Change log v2 approved by the owner (`:139`). A-1 to A-6 Approved (`:110-115`) |
| Architecture / ADRs | Met, with findings | ADR 0009 is followed (`factory/state` worktree at `.factory/`, never merged), except for the commit-message prefix (m3). ADR 0008 jobs per level match `maturity-levels.md` (`:547-560`). ADR 0006: owner-only merge via protection, and the token is never handled (m13). ADR 0010: config repo, `<project>-factory`. SKILL step 7 opens a PR on an existing config repo, while A-2 says to commit directly (M8) |
| Interface contracts | Met | No diff to `interface-contracts.md`. Items rendered by `render_item` (`:1123-1135`) have every Inbox item v1.0 field and the five fixed decision body sections. Manifest rules match `proposals/0013-project-manifest.md:82-93`. The roles template has all six core roles in Role policy v1.0 shape. The assessment JSON is internal, as spec §10 says. New formats needing an owner decision: M6 |
| Code quality, readability, maintainability | Met, with findings | The script is one 1,231-line file, readable and sectioned. Detection is keyword-based and fails open in several places (M1, M3). The duplicate-id guard turns a naming bug into a crash (B1). Minor findings: m4, m5, m6, m7, m8 |
| Comments | Met (see m9) | Comments explain why: `:4-7`, `:54-56`, `:270`, `:296-297`, `:628`, `:674-675`, `:743`, `:844`, `:853`; tests `:24`, `:492`. One misleading comment: `:467-468` says line-by-line reading means anything unreadable is a gap, but it is also why comment text counts as evidence (M1, m9) |
| Documentation | Met | The spec names no required docs. `SKILL.md` is the user doc. The schema states it is internal (`assessment.schema.json:4`) |
| Security | Met | Gate 1 (`F-003-security-gate1.md`) and Gate 2 (`F-003-security-gate2.md`, untracked, so it needs committing) are both present. Gate 2 result: PASS, no Critical findings; 1 High, 11 Medium and 12 Low are known issues. Its High #1 (the branch protection the skill applies still lets the factory token merge after an approval) is the most important thing to fix before a real onboarding. Overlaps with this report: Gate 2 #2 = M2, #3 = M1 and M7, #5 = m4, #10 = M6(b), #12 and #19 = m13, #15 = m16, #23 = m15. Gate 2 did not find B1 |

## Findings

### Blocking

| # | Location | Finding |
|---|---|---|
| B1 | `skills/onboard-repo/scripts/factory_check.py:623` (gap id), `:757-760` (raise) | The unpinned-action gap id is `action-unpinned:<workflow>:<action>`, without the line. When the same action appears twice in one workflow without a SHA pin, both gaps get the same id, `assess` raises `CheckError("duplicate gap ids")`, and the CLI exits 2 with no output (probe p2). This is the normal case: `actions/checkout@v4` once per job. FR-2, FR-3 and every later skill step depend on the assessment, so the skill can't onboard most real repos. The `raise` line is never run by the tests, and `test_ac3_action_pinning` uses each action only once. Fix: add the line (or a per-key counter, as for secrets) to the id, and add a test with two jobs using the same unpinned action. |

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `factory_check.py:656-657` (audit), `:676-685` (CI jobs); `templates/ci-workflow.yml:33-41` | CI checks search the raw workflow text, comments included. The skill's own template contains `# secret-scan:`, `# acceptance-tests:`, `# contract-tests:`, `# integration-tests:`, `# full-regression:`, `# performance-tests:` and an audit hint comment (`npm audit … pip-audit …`). A repo whose only CI is the generated workflow therefore passes all those job checks and the S4.4 audit check (probe p1). A re-run after onboarding would list those gaps as **closed**. This fails open, against S5.1 and the intent of SR-8. Fix: strip comments before matching (`_strip_comment` already exists), and match job keys or `run:` lines rather than any text. |
| M2 | `factory_check.py:37`, `:332-333`, `:630-637`, `:768-769` | `SKIP_DIRS` (`build`, `dist`, `vendor`, `target`, `venv` and others) is applied to git-tracked files too. Tracked files there are left out of the file list, so the S3.1 secret scan never sees them. They are also not counted in `files_skipped`, so the report doesn't say so (probe p3: a key in tracked `build/deploy.sh` was not reported). The spec allows skipping only files over 1 MB and binaries, and only if the report says so. Fix: apply `SKIP_DIRS` only in the `os.walk` fallback, or count and list skipped folders. |
| M3 | `factory_check.py:595-596`, `:689`, `:713` | Tests are detected by folder name, and the patterns include `spec/` and `features/`. A repo with `docs/spec/` and no tests gets no `tests:unit` or `tool:test-framework` gap. A repo with `src/features/` gets no `tests:acceptance` gap (probe p3). Both are false passes that feed the starting-level evidence (FR-4, AC-8). Fix: require test-file naming inside those folders, or test-framework evidence, before counting them. |
| M4 | `factory_check.py:727-728`, `:740-741`; test `tests/test_factory_check.py:262-265` | `docs:purpose` and `factory:state-branch` gaps have `evidence: []`. FR-2 and AC-7 need evidence on every gap ("file and line, or the check that found it"). The test checks only that the key exists. Fix: add an evidence entry naming the check, and assert non-empty evidence in `test_ac7_assessment_shape`. |
| M5 | `docs/features/` | There is no test engineer run report, no developer completion report and no orchestrator review note (DoD 4 to 6). All tests came with the developer's commit, so no independent test exists for any AC, and the AC evidence rests on my run of the developer's tests. The Gate 2 report exists but is untracked; commit it with the feature. |
| M6 | `templates/maturity.yaml:1-3`; `templates/roles.yaml`; `templates/claude-md-section.md:13-15` | The skill makes three choices that need an owner decision, and files none of them. (a) `maturity.yaml` is a new format, `repo-maturity/1.0`. The template says it is "pending an Interfaces decision", but nothing raises one, and step 5 writes it to every repo. (b) FR-6 says to copy roles.yaml "from the master default", but the master has none. The template becomes the default role policy for every managed repo. That is security policy (ADR 0004; CLAUDE.md rule 2) and needs a Security decision, or approval as the master default. (c) The CLAUDE.md section defines which files are change-controlled in managed repos. It names "this section", while the roles template denies writes to all of `CLAUDE.md`. That is factory configuration. |
| M7 | `SKILL.md:86-88`; `templates/ci-workflow.yml:29-33` | AC-10 needs the generated workflow to audit all dependencies. For Python, Go and Rust, the audit tool is an external component, and S4.1 needs a review before it is used. The skill resolves this by leaving the step commented out, so AC-10 isn't met for those stacks until a tool decision is made. Together with M1, the commented-out step even counts as an audit. This trade-off between AC-10 and S4.1 is the owner's call. `plan-items` also files no audit-tool item; the SKILL leaves that to the agent. |
| M8 | `SKILL.md:123-132` | (a) "Fix every error before committing" means that adding a Rapid prototype repo to an existing Alpha project makes the agent lower the project's `maturity` to pass the rule. That is a Product decision taken silently. (b) For an existing project, step 7 opens a PR on the config repo, while approved assumption A-2 says the config repo is committed to directly. The PR is the safer choice, but it differs from the approved spec, so ask the owner. |
| M9 | `SKILL.md:94-105`; `templates/ci-workflow.yml:7-8`; `factory_check.py:748,753` | Several spec §6 edge cases have no handling in the instructions: a repo already listed in another project's manifest; `factory/state` that exists only on the remote (step 5 could create a second orphan root); a partly onboarded `.factory/` directory; a repo with no commits (no base for the PR); and a default branch not named `main` (the template's `push: branches: [main]` and the gap titles). |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `factory_check.py:1082-1100` | `plan-items` files a tool decision for every missing tool, whatever the chosen level, including mutation testing (Production ready) and fuzzing (Beta). FR-8 asks for tools "the testing bar for the chosen level needs" and doesn't list mutation. This adds items to the owner's inbox that aren't needed yet. |
| m2 | `factory_check.py:1048,1119` | The item link ref `onboarding/<date>-assessment.json#onboard:<key>` doubles as the dedupe key. The F-001 extension resolves refs from the repo root, and the file lives under `.factory/`, so the link points to a missing file (`extension/src/core/links.ts:21-33`). The `#…` fragment also becomes part of the file name. |
| m3 | `SKILL.md:105,118` | Commit messages start with `onboarding:`. ADR 0009 says each `factory/state` commit message starts with the item or feature id. |
| m4 | `factory_check.py:612-617` | The S8.3 check looks only at top-level `permissions`. A workflow whose jobs all declare permissions still gets a gap, with the misleading detail "(no jobs found)". `permissions: write-all` passes. The evidence line is always 1 (probe p4). |
| m5 | `factory_check.py:789-804,748` | Protection is "ok" with any one review and any required check. It doesn't check that the checks match the level's jobs (FR-2, ADR 0008). The gap title always says `main`. The `assess` path with GitHub data is untested. |
| m6 | `factory_check.py:317,644` | `ls-files --others` also scans untracked files that aren't ignored, but the gap title says "committed". |
| m7 | `factory_check.py:374` | A Go module with no dependencies has no `go.sum`, yet it gets a `lock-missing:go` gap. |
| m8 | `factory_check.py:1126,1131` | Items say `created_by: orchestrator`, but the onboarding skill files them in the owner's session. |
| m9 | `factory_check.py:467-468` | Misleading comment: it presents line-by-line reading as the SR-8 safeguard, but that reading is what lets comments count as evidence (M1). Update it when M1 is fixed. |
| m10 | `factory_check.py:807-857` | `gate2` and `known-issues` are always unmet, so the recommendation is always Rapid prototype. That is stated honestly in the note, but FR-4 is effectively constant. The Rapid prototype evidence leaves out "builds and a smoke test runs". |
| m11 | `SKILL.md:94-105,153-157` | Step 5 describes only first-time setup. It doesn't say to commit the new assessment on a re-run. Two runs on the same date overwrite `<date>-assessment.*`. |
| m12 | `SKILL.md:136-145` | AC-14: step 8 doesn't say in so many words "if declined, change nothing and list the step as open". Steps 8 and 9 together imply it. |
| m13 | `SKILL.md:142-145` | The token link says "access to this repo only". For a second repo, ADR 0006 talks about extending the existing token. |
| m14 | `SKILL.md:30` | `python3 -I` is often not on PATH on Windows (`py -3`). The spec requires Windows support. |
| m15 | `skills/onboard-repo/`; `.gitignore` | `skills/` is change-controlled under CLAUDE.md rule 3. A-1 (approved) puts the skill there, so I don't count this as an unapproved edit. The PR should name it, along with the new root `.gitignore` line `__pycache__/`. Later fixes inside this folder are edits to change-controlled files. |
| m16 | `factory_check.py:300-305,317` | `git ls-files` runs in the target repo and honours its local config (for example `core.fsmonitor`). A clone can't carry that config, so the risk is low. Gate 2 #15 reproduced it. |
| m17 | `templates/claude-md-section.md:16-17` | FR-5 asks for links to the pinned version's rules. The section names the docs but gives no URLs at `<FACTORY_VERSION>`. |
| m18 | `tests/test_factory_check.py` | About 89% of lines are covered, with no branch measure. That is fine at Rapid prototype ("Reported"). The untested paths include the B1 `raise`, `assess` with GitHub data, the "since last assessment" Markdown, the `plan-items` CLI, and most manifest error messages. |

## Counts

- Blocking: 1 (B1).
- Major: 9 (M1 to M9).
- Minor: 18 (m1 to m18).
- Lines: 1 Not met (FR-2). 2 lines Needs owner (FR-6, AC-10), plus M8, which is also an owner question.

## To reach PASS at Rapid prototype

1. Fix B1 and add a regression test with the same unpinned action in two jobs.
2. Commit the Gate 2 report, and have the test engineer run against the final commit (M5, DoD 5). Fix Gate 2 High #1 before any repo is onboarded for real.
3. Raise these with the owner: the `maturity.yaml` format (Interfaces), the default `roles.yaml` and change-controlled set (Security), AC-10 versus S4.1 for non-npm audit tools, and the two step-7 questions in M8.

Before Alpha, at most 3 Major findings are allowed. M1 to M4 and M9 are detection and robustness fixes that should come first.
