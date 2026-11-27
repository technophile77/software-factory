# Feature: The factory proposes CI jobs

- **Id:** F-026
- **Status:** Draft (v1, waiting on the owner's answers to OQ-1 to OQ-3, then Security and Testability Review)
- **Requested by / date:** Alex, 2026-11-27 ("how is the test engineer
  supposed to add test to CI today?"; "Spec it"; "f5 should use the new
  ability to propose CI jobs")
- **Spec version:** 1
- **Depends on:** F-011 (one inbox, hygiene items and their auto-merge),
  F-015 (build to PR: SR-2 token, SR-3 CI files denied, FR-28 configuration
  changes table, FR-29 CI-only tests, FR-31 required checks), F-020 (JSON
  agent data)

## 1. Objective and business purpose

Today no part of the factory can add a test to a code repo's CI. Both build
agents have `.github/workflows/**` and `.github/actions/**` in their
`write.deny` (F-015 SR-3), and the engine's fine-grained token has no
Workflows permission (F-015 SR-2), so GitHub refuses any push that changes a
workflow. Both rules are deliberate: a workflow an agent writes runs with the
repo's CI secrets and can post a check under the same name as a required
check, so it could leak secrets or fake a green build.

The cost is that every new kind of CI job has to be written by hand, outside
the factory. The first case is mesbot F-005, which needs contract,
integration, coverage, gitleaks, semgrep and fuzz jobs that mesbot's CI
doesn't have. Owner, 2026-11-27: F-005 should use this feature.

This feature lets the test engineer ask for a CI job as structured data.
Engine code turns the request into a workflow file from a fixed, reviewed
template, the owner approves the exact file in the one inbox, and the engine
lands it through the existing hygiene-item pull request. Agents still never
write a workflow file, and nothing lands without the owner's approval.

## 2. Expected behavior

1. While writing tests in stage 6, the test engineer decides which test
   types must run in CI (for example tests it lists as `ci_only`, or a
   coverage gate the spec asks for). For each it adds a CI job request to
   its report's new `ci_jobs` field: which template, its parameters, and
   which tests or criteria it covers. It does not write YAML.
2. Engine code checks each request against the template catalog and its
   rules, and renders the workflow file `.github/workflows/factory-<job>.yml`.
   A request the catalog can't express is sent back to the test engineer
   with the reason; if it still can't be expressed, the engine files a
   Testing item for the owner (no dead end, F-019 FR-21).
3. The engine files one Hygiene item per repo, holding every rendered file
   with the eight hygiene fields (file, reason, current content, proposed
   content, diff, benefit, risks, recommendation). Code fills the risks and
   recommendation from the template's fixed text; the reason is the test
   engineer's, shown as quoted data.
4. The owner approves, rejects, requests changes or defers the item in the
   console or on GitHub, as for any hygiene item. Approve needs the usual
   confirmation step.
5. On approval the engine pushes the files on `hygiene/<item>` (OQ-1 says
   with which token), opens the PR, and merges it when the diff is exactly
   the approved one and the required checks are green
   (`autoMergeHygiene`). Then it merges `main` into the feature branch so
   the new jobs run on the feature's PR.
6. A new job becomes a required check on `main` only when the owner makes it
   one (OQ-3). The engine reads required checks from rulesets and classic
   branch protection (F-015 FR-31), so once the owner does, FR-29's
   CI-only gating counts it.
7. The build goes on while the item waits. The feature's PR isn't marked
   ready while a CI job item it filed is open (FR-9).

## 3. Functional requirements

| Id | Requirement |
|---|---|
| FR-1 | Agent report v1.8 (H-0282) adds optional `ci_jobs` to the test engineer's body: a list of CI job requests, each `{ repo, job, action, template, params, covers, reason }`. `job` matches `^[a-z][a-z0-9-]{0,31}$` and is unique per repo; `action` is `add`, `update` or `remove`; `covers` lists test ids and AC ids; `reason` is at most 1,000 characters. Only the test engineer may set it (OQ-4 recommendation). |
| FR-2 | The template catalog (H-0284) is factory code, change-controlled: one template per kind, each with a JSON Schema for its `params`, the workflow text with placeholders, the fixed risks text and the job's check name. v1 kinds: `test-command` (set up a runtime, install, run an argument list; covers unit, contract, integration and fuzz tests), `coverage` (as `test-command`, then fail under a minimum percent read from the report file of the approved coverage tool), `gitleaks`, `semgrep` (a pinned ruleset config path in the repo) and `osv-scanner`. Every action a template uses is pinned to a full commit SHA in one pin table, `ci-actions.json` (OQ-2). |
| FR-3 | Engine code renders every file; no agent text reaches the workflow except `params` values that pass the template's schema. Argument lists are rendered as YAML lists or with shell quoting done by code; paths must be relative, inside the repo, and contain no `..`. |
| FR-4 | Every rendered workflow: triggers only on `pull_request` to `main`, `push` to `main`, `workflow_dispatch` and, when the template allows it, a weekly `schedule`; never `pull_request_target`, `workflow_run` or `issue_comment`. Top-level `permissions: contents: read` and nothing else; no `secrets.*` reference; `actions/checkout` with `persist-credentials: false`; a `timeout-minutes`; a `concurrency` group that cancels older runs of the same ref. |
| FR-5 | The engine owns only `.github/workflows/factory-*.yml`. It never changes another workflow file. `update` and `remove` apply only to a `factory-*` file whose header records it was rendered by the engine (template kind and catalog version). |
| FR-6 | A job's check name is `factory-<job>`. Code refuses a job whose check name equals one already reported on `main` by another workflow or app, so a factory job can't stand in for an existing required check. |
| FR-7 | The engine files one Hygiene item per repo per test engineer report, with every rendered file, the request JSON, and the eight hygiene fields. Its diff hash (`diffHash`) is the approval's identity: what lands must be byte for byte what the owner saw. |
| FR-8 | On approval the engine pushes `hygiene/<item>` with the CI change token (OQ-1), opens the PR (draft off, title "CI: <jobs> for <feature>"), and merges it through `autoMergeHygiene`. A token refusal stops with a Security item naming the token's store name, never its value. After the merge the engine merges `main` into the feature branch. |
| FR-9 | Stage 9 doesn't mark the feature's PR ready while any CI job item the feature filed is open, rejected without a resolution, or merged but not yet a required check when the feature has `ci_only` tests that depend on it (FR-29). Each case is shown in the feature's status with the item id. |
| FR-10 | Reject or Request changes goes back to the test engineer with the owner's note as data; the test engineer may change or withdraw the request. Withdrawing leaves the tests that needed it as `not_run` with the reason, and the Testing item the run already files applies. |
| FR-11 | A configuration changes table row (F-015 FR-28) may name a CI job (`CI job <repo>/<job>`); such a row becomes `Applied` when the hygiene item for that job has merged. This lets a spec such as mesbot F-005 list its CI jobs and have the gate check them. |
| FR-12 | Every push, PR and merge made for a CI job item is logged as F-015 SR-2 requires (action, repo, ref, PR, head SHA, time, item id), without the token. |

## 4. Acceptance criteria

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a test engineer report with a valid `test-command` request, when the engine reads it, then it renders `.github/workflows/factory-<job>.yml` and files one Hygiene item whose proposed content is that file. | FR-1, FR-3, FR-7 |
| AC-2 | Given a request with an unknown template or params that fail its schema, then no item is filed and the test engineer gets the schema error. | FR-2, FR-3 |
| AC-3 | Given a request whose path param contains `..` or is absolute, then it is refused. | FR-3 |
| AC-4 | Given any template rendered with the fixture params, then the file has only the allowed triggers, `permissions: contents: read`, no secrets, pinned actions and `persist-credentials: false`; and actionlint and zizmor pass on it in the factory's CI. | FR-4, FR-2 |
| AC-5 | Given a request to `update` a workflow file not named `factory-*` or without the engine's header, then it is refused. | FR-5 |
| AC-6 | Given `main` already reports a check named `factory-contract` from another workflow, when a `contract` job is requested, then it is refused with that reason. | FR-6 |
| AC-7 | Given an approved item, when the PR's files differ from the approved diff, then nothing is merged and the PR says so. | FR-7, FR-8 |
| AC-8 | Given an approved item and a CI change token without Workflows write, when the engine pushes, then the push fails and a Security item names the token's store name. | FR-8 |
| AC-9 | Given a feature with an open CI job item, when stage 9 runs, then the PR stays draft and the status names the item. | FR-9 |
| AC-10 | Given a rejected item with a note, then the test engineer's next session gets the note as data and can withdraw the request. | FR-10 |
| AC-11 | Given a spec with a `CI job mesbot/contract` row in its configuration changes table, when that job's item merges, then the row reads `Applied` and the readiness check passes for it. | FR-11 |
| AC-12 | Given an agent report from any role other than the test engineer with `ci_jobs`, then the report is refused (F-020 SR-7). | FR-1 |

## 5. Constraints

- No agent gains write access to `.github/**`; F-015 SR-3 stays as it is.
- The main per-owner token keeps no Workflows permission (F-015 SR-2), unless
  the owner picks OQ-1 option B.
- Templates run on GitHub-hosted `ubuntu-latest` only in v1 (owner,
  2026-11-27: mesbot Linux testing relies on GitHub CI).
- Templates take what runtime and version to set up from params, checked
  against the versions the repo's ADRs or manifest name where they exist.
- Nothing new is installed on the owner's PC: rendering and the rule checks
  are engine code; actionlint and zizmor run on the templates in the
  factory's own CI (prefer existing tools, owner 2026-11-13).

## 6. Edge cases

- The test engineer asks for a job that already exists in a non-factory
  workflow: FR-6 refuses a clashing check name; otherwise the item's
  recommendation notes the likely duplicate (by matching tool names in other
  workflow files), and the owner decides.
- Two features ask for the same job: the second request against an open
  item for the same `<repo>/<job>` joins that item instead of filing another.
- `main` moves while the item waits: the engine rebuilds the branch from
  the new `main`; if the rendered files are unchanged the approval stands
  (same diff hash), otherwise it files a new item.
- The CI change token expires: Security item to renew it, the feature stays
  blocked at stage 9, no dead end.
- Abuse: a test engineer prompted by repo content to add a job that sends
  data out. The job has no secrets, a read-only token and only the
  template's steps; the run command is the repo's own test code, which CI
  already runs on every PR. Its reason text is quoted, never rendered into
  YAML.

## 7. Dependencies

F-011, F-015, F-020 (merged). mesbot F-005 depends on this feature (owner,
2026-11-27).

### Configuration changes needed before implementation

| Id | Change | Check | Status |
|---|---|---|---|
| C-1 | The owner creates the CI change token for each GitHub owner of a project (per OQ-1) and stores it with `factory-engine secret set ci-token/<owner>` | — | Pending |

## 8. Assumptions

| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | Merging, through the API, a PR that changes a workflow file needs the Workflows permission too. Checked with a test repo at build before FR-8 relies on it; under OQ-1 A or B the token has it either way. | — | Pending |
| A-2 | The five v1 templates cover mesbot F-005's six jobs (contract, integration and fuzz as `test-command`, coverage, gitleaks, semgrep). | OQ-2 | Pending |

## 9. Security considerations

| Id | Requirement | Source (analyst / Security and Testability Review) | Status |
|---|---|---|---|
| SR-1 | Workflows follow GitHub's Actions hardening guide: least-privilege `GITHUB_TOKEN`, actions pinned to full-length commit SHAs, no `pull_request_target` with untrusted code ([GitHub: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)); and pass OpenSSF Scorecard's Token-Permissions, Pinned-Dependencies and Dangerous-Workflow checks ([Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md)). FR-4 and AC-4 enforce it; S8.3. | Analyst | Draft |
| SR-2 | The token that can write workflows is used by one engine module only, for `hygiene/<item>` branches whose diff matches the approved hash and that touch only `.github/workflows/factory-*.yml`; a code test fails if it is read anywhere else (as for the merge call). S8.1, S8.2, S8.5: this widens a permission, so it is the owner's Security decision (OQ-1). | Analyst | Pending OQ-1 |
| SR-3 | The engine checks the CI change token as it checks the main token (fine-grained, selected repos inside the project only, at most 90 days) and that it has no Administration permission. | Analyst | Draft |
| SR-4 | A factory job can't take an existing check's name (FR-6), so it can't stand in for a required check. | Analyst | Draft |

## 10. Interface requirements

- Agent report v1.8: `ci_jobs` on the test engineer's body (H-0282).
- CI job request schema `ci-job-request/1.0` and the catalog's params
  schemas, in `docs/schemas/` (H-0283).
- Project manifest: `ci-token/<owner>` credential store name and the token
  check (H-0289).

### Hygiene items this feature needs (owner approval each)

| Id | File(s) | Change |
|---|---|---|
| H-0282 | `docs/interface-contracts.md`, `docs/schemas/agent-report-1*.json` | Agent report v1.8, `ci_jobs` |
| H-0283 | `docs/schemas/ci-job-request-1.schema.json` (new) | Request schema |
| H-0284 | `engine/ci/` catalog and `ci-actions.json`, `CLAUDE.md` rule 3 | Make the template catalog and pin table change-controlled |
| H-0285 | `agents/test-engineer/AGENT.md` | May request CI jobs through `ci_jobs`; never writes workflow files |
| H-0286 | `docs/testing-strategy.md` | How CI jobs are requested and when a test needs one |
| H-0287 | `docs/decision-management.md` | CI job items are Hygiene items; what the owner sees |
| H-0288 | `docs/adr/0037-…` (new), `docs/adr/README.md` | Record OQ-1's answer |
| H-0289 | `docs/interface-contracts.md`, `plugins/software-factory/skills/onboard-repo/` | CI change token: store name, check, onboarding step |
| H-0290 | `docs/features/F-015-engine-build-to-pr.md` | FR-28 rows may name a CI job (FR-11); stage 9 waits on open CI job items (FR-9) |

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [ ] Assumptions explicit (A-1, A-2 pending)
- [ ] Blocking decisions resolved (OQ-1 to OQ-4)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-27 | First draft | Pending |

## 13. Open questions for the owner

| Id | Question | Options | Recommendation |
|---|---|---|---|
| OQ-1 (Security) | Which credential pushes an approved CI change? | A: a second fine-grained token per owner, Contents, Pull requests and Workflows write only, used by one module for approved CI items. B: add Workflows write to the existing token. C: the console pushes with the owner's own Git login on PC and the owner merges on GitHub. | A. B is simplest but removes GitHub's own refusal that backs SR-3 on every agent build push: if the end-of-session check ever misses a workflow edit, an agent's workflow would run with the repo's secrets and could fake a required check. C needs no new token but uses the owner's broad login and makes the owner merge each change. Until Beta (ADR 0026 accepted risk 1) code an agent runs can read any of these credentials from the owner's credential store, so A guards against engine mistakes now and against agents again from Beta. |
| OQ-2 (Architecture) | May the test engineer write its own workflow YAML when no template fits? | A: templates only; a missing kind becomes a Testing item and a catalog change. B: templates plus free-form YAML checked by actionlint, zizmor and the security reviewer. | A. Agents report facts and code builds the file (owner, 2026-11-14); free-form YAML is where the Actions attacks live. |
| OQ-3 (Security) | How does a new job become a required check on `main`? | A: the owner sets it in GitHub; the item links the exact settings page and the engine re-reads required checks. B: give the CI token Administration write so the engine adds it. C: factory jobs stay advisory. | A. Administration write could also delete branch protection or rulesets. |
| OQ-4 (Product) | Who may request CI jobs? | Test engineer only (v1), or also the security reviewer for scan jobs. | Test engineer only; it already owns test types and tools. |
