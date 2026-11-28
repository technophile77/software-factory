# F-026 Security and Testability Review (requirements review)

- **Feature:** F-026 The factory proposes CI jobs, spec v1 with OQ-1 to OQ-4
  answered (owner, decision cards, 2026-11-28 01:01Z to 01:09Z)
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-28
- **Maturity level:** Rapid prototype. Only Critical findings block there
  (`security-blocking.json`); Beta needs no open Critical or High.
- **Result:** 8 findings: 0 Critical, 1 High, 3 Medium, 4 Low. Nothing
  blocks at Rapid prototype. The High is a risk to state and accept, not a
  design gap: until Beta any code an agent runs can read the new CI token
  (ADR 0026). The owner's answers to OQ-1 to OQ-4 are not re-opened.
  Recommendations are proposed as SR-5 to SR-12 in the spec.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S8.2, S8.3, S8.5 | High | No | The CI token (OQ-1 A) adds a power no factory credential has today: it can push a workflow file to **any** branch of a project repo, not only `hygiene/<item>`. A workflow pushed on a new branch with `on: push` runs at once, before any review, with every repository and organization secret that isn't behind a protected environment. The engine only ever pushes approved files (SR-2), but until Beta code an agent runs can read the token from the owner's credential store (ADR 0026 accepted risk 1), so prompt injection in a build could use it. GitHub's [hardening guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) recommends keeping secrets in environments with required reviewers for this reason. | SR-5: state this risk in ADR 0037 and have the owner accept it until Beta, as for ADR 0026. The CI token is created with at most 30 days' expiry (renewal is a Security item 7 days ahead). Onboarding and the token check tell the owner, per repo, that secrets used by CI should live in an environment with a required reviewer; the factory can't list secrets itself (its tokens have no Secrets permission), so this is advice shown once per repo, not a check. At Beta, with containers back, agents can't reach the token. |
| 2 | S1.1, S6.1 | Medium | No | `test-command` and `coverage` take the install and run commands from the test engineer. They run in CI with a read-only token and no secrets, but on a private repo they can still send the code to any host. The same is true of the test code CI already runs, so the new exposure is small, but the owner should see exactly what runs. | SR-6: the hygiene item shows each command as an argument list in a fenced block, flags any argument that names a URL, `curl`, `wget`, `nc` or a package index other than the ecosystem default, and the recommendation is "Reject" when one is flagged (code decides, from a JSON list in the catalog). |
| 3 | S4.4, S8.3 | Medium | No | Templates that set up Node or Python commonly turn on the Actions cache. A cache written by a `pull_request` run can be restored by a later run on `main`, which is a known poisoning route ([zizmor: cache-poisoning](https://docs.zizmor.sh/audits/#cache-poisoning)). | SR-7: v1 templates use no cache (`cache:` off on setup actions, no `actions/cache`). zizmor's `cache-poisoning` audit runs on every template in the factory's CI (AC-4). A cache can be added later as a catalog change. |
| 4 | S6.3, S8.3 | Medium | No | FR-6 compares the new check name only with checks already reported on `main`. A required check that hasn't run yet, or a non-factory workflow added later with a `factory-` job name, could still collide. | SR-8: FR-6 also compares with `main`'s required checks (rulesets and classic protection, F-015 FR-31), and the stage 9 check refuses any `factory-*` check that doesn't come from a `factory-*.yml` file. |
| 5 | S8.2 | Low | No | SR-3 says the engine checks the CI token has no Administration permission, but a fine-grained token's grants can't be listed through the API. | SR-9: the check is a probe: `GET /repos/{repo}/branches/main/protection` (needs Administration read) must be refused, and a write to `.github/workflows/` on a `hygiene/probe-*` branch must succeed and is deleted at once. The main token's existing probe (F-015 SR-2) stays. |
| 6 | Testability | Low | No | FR-9's "the feature has `ci_only` tests that depend on it" has no rule for what "depend" means. | SR-10: a job covers a `ci_only` test when the test id is in the request's `covers`. Code joins the two lists; the agent never states the dependency in prose. |
| 7 | Testability | Low | No | AC-4 needs actionlint and zizmor in the factory's own CI. Today the factory CI runs zizmor on its own workflows (H-0147) but not on templates. | SR-11: a factory CI job renders every template with its fixture params and runs pinned actionlint and zizmor on the output. That is a change to `.github/workflows/`, so it needs its own hygiene item (H-0291). |
| 8 | S5.1, cost | Low | No | A weekly `schedule` keeps running after the feature is done and uses Actions minutes on private repos, which are billed. | SR-12: the hygiene item says which jobs run on a schedule and their timeout. `remove` is offered on the item when the feature that asked for the job is cancelled (F-015 cancel). |

## Threat model (S9.7)

STRIDE over the parts this feature adds: the test engineer's request, the
engine's renderer, the hygiene item, the CI token and the rendered workflow.

| Threat | Where | Covered by |
|---|---|---|
| Spoofing a required check | Rendered workflow posts a check under an existing name | FR-6, SR-8 |
| Tampering with what was approved | PR content differs from the item | FR-7 diff hash, `autoMergeHygiene` |
| Tampering through template input | Agent text reaching YAML | FR-3, OQ-2 A (templates only) |
| Information disclosure | Workflow reads secrets; code sent out from CI | FR-4 (no secrets, read-only token), SR-6 |
| Elevation through the CI token | Token read by agent code until Beta | SR-2, SR-5 (accepted risk, short expiry) |
| Denial of service / cost | Scheduled jobs, long runs | FR-4 timeouts, SR-12 |
| Repudiation | Who pushed and merged | FR-12 logs |
