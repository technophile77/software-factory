# Feature: Build a feature to a pull request on the real engine

- **Id:** F-015
- **Status:** Draft (in interview)
- **Requested by / date:** Alex, 2026-11-13 ("what is the critical path until
  I can start onboarding some of my existing projects?"; chose to spec
  increment 4 in parallel with increment 3, decision card)
- **Spec version:** 3

This is engine increment 4, "Build to PR" (F-007 section 13). It is a draft
written before the owner interview, from the baseline spec, the ADRs and the
earlier increments. Everything in sections 3 to 10 is a draft to be refined
by the answers to section 12; nothing here is decided until the owner says so.

## 1. Objective and business purpose
The engine takes a feature from request through the interview and Security
Gate 1 (F-007, F-008), and increment 3 adds the full readiness gate and the
inbox on GitHub issues (F-011). After that a feature is ready to build, but
nothing builds it: no developer, no test engineer, no Gate 2, no judge, no
pull request. Until this exists, onboarding an existing project gives the
owner specs and nothing else.

This increment runs stages 5 to 9 for real and ends with a pull request in
the project's code repo, CI green on its head, for the owner to merge. It
also ends the F-007 v41 exception: feature work (branches, and wherever
OQ-2 puts specs, transcripts and agent reports) moves out of the config repo
and into the project's code repos, as ADR 0005 and ADR 0009 intend.

## 2. Expected behavior
1. A feature passes the readiness gate (increment 3). Its project is
   enabled and running, so the build starts with no approval per run
   (ADR 0012).
2. The engine creates the feature branch `feature/F-nnn-name` from `main` in
   the code repo the spec targets (OQ-2, OQ-3), and the agent branches
   `feature/F-nnn/dev` and `feature/F-nnn/test` from it (ADR 0005).
3. The developer and the test engineer run in parallel, each in its own
   container, each given only the approved spec and the contracts it
   needs. The test engineer never sees the developer's notes or reasoning.
4. When both report done, the engine merges both agent branches into the
   feature branch and the tests run against that commit (OQ-5).
5. Stage 6: failures are classified by cause and handled by the retry table
   in `testing-strategy.md`: reruns, fix cycles by the role that owns the
   cause, then a Testing item in the inbox (OQ-4).
6. Stage 7: the engine runs Semgrep (ADR 0024) and gives its findings to the
   security reviewer, which reviews the diff (Gate 2). A finding that blocks
   at the repo's maturity level sends the work back to the developer and
   then to stage 6.
7. Stage 8: the validation judge checks the work against the spec. PASS goes
   on; FAIL goes back to the role the finding names; NEEDS HUMAN REVIEW
   files a Decision item and the feature waits.
8. Stage 9: when items 1 to 11 of `definition-of-done.md` have evidence, the
   engine pushes the feature branch and opens a draft PR with the owner's
   token (ADR 0017). When the required CI checks are green on the PR head,
   it marks the PR ready, updates its title and description, and posts the
   definition-of-done comment (F-011 FR-9). Red CI is a test failure and
   goes back through stage 6.
9. The owner merges in GitHub's PR view. The engine records the merge
   (F-011 FR-9). A `/changes <note>` comment by the owner goes to the
   orchestrator as review feedback.
10. `engine.status` shows each feature's stage throughout; the feature's
    record and the engine log say why a stage didn't run or didn't finish.

## 3. Functional requirements
Draft. Each will be refined by section 12.

| Id | Requirement |
|---|---|
| FR-1 | A feature of an enabled, running project that passes the readiness gate enters `build_and_test_prep`. One build per feature at a time. |
| FR-2 | Only code and tests move to the code repo (OQ-2): feature and agent branches live in the target code repo (OQ-3), named per ADR 0005, created from that repo's `main`. The spec, interview transcript, Gate reports, agent reports, run records and inbox records stay in the private config repo (its feature branch and `factory/state`). Nothing from the config repo is committed to a code repo. The PR description links the spec at its approved commit in the config repo. |
| FR-3 | The developer and the test engineer run as Agent SDK sessions in their own containers under the project's role policy and every container rule of the Role policy contract, in parallel. Each gets its `AGENT.md`, the approved spec at the readiness-gate commit (read-only, fixed path), and the contracts. Neither gets the other's branch, report or transcript. |
| FR-4 | Agent edits are committed by the engine after each edit (ADR 0012), with the secrets scan before each commit; the end-of-session write check applies (F-007 FR-9). |
| FR-5 | When both agents report done, the engine merges `dev` and `test` into the feature branch. A merge conflict between them is handled per ADR 0013. |
| FR-6 | Tests run against the merged commit (OQ-5). The run produces a run report per `testing-strategy.md`: commit tested, counts, criteria-to-test map, failures with expected and actual and logs, anything not run and why. Unexplained skips make the run incomplete. |
| FR-7 | Stage 6 applies the failure table in `testing-strategy.md` exactly: rerun counts by cause, at most 3 fix cycles per role, 2 developer/test-engineer disagreements on one test go to the Decision inbox, 4 hours of stage 6 agent time escalates. Every escalation is a Testing item with the fields of spec section 5. (OQ-4 decides who classifies.) |
| FR-8 | Stage 7 runs Semgrep CE from the image pinned in ADR 0024 on the feature diff, then the security reviewer (Gate 2) with the findings as evidence, reusing the F-008 report checks. Blocking per `security-standards.md` at the repo's maturity level. |
| FR-9 | Stage 8 runs the validation judge with the spec, diff, run report and both gate reports. Its verdict is applied per `development-workflow.md` § Going backwards and the allowances in its `AGENT.md`. |
| FR-10 | Stage 9: with items 1 to 11 met, the engine pushes the feature branch and opens a draft PR with the owner's token. It reads the required checks on the PR head; green marks the PR ready with its title and description updated and posts the F-011 FR-9 comment; red is a stage 6 failure. |
| FR-11 | The engine never merges a feature PR (F-011 FR-14). |
| FR-12 | Every run writes an Agent report (contract v1.4) and is resumable and interruptible as earlier runs are, within `MAX_RESUMES`. |
| FR-13 | Models and limits for the new roles come from the master `engine/config/models.yaml` and `limits.yaml` at the pinned factory version (hygiene items in section 10); the engine has no defaults; a project may only lower limits. |
| FR-14 | The PR parts of F-011 are built here, since nothing opens PRs before this increment (agreed with increment 3, F-016): the FR-9 definition-of-done comment, `/changes <note>` on managed PRs, recording `merged_on_github` / `closed_on_github`, and FR-10's hygiene auto-merge with its SR-11 diff check. Inbox issues, inbox records and PR records stay on the config repo's `factory/state` (F-011, Inbox item v3.0). |
| FR-15 | The build starts from the stage `build_and_test_prep`, which increment 3 records when the owner approves the spec sign-off. |

## 4. Acceptance criteria
To be written once section 12 is answered; each FR gets at least one.

## 5. Constraints
- TypeScript on Node (ADR 0001); Windows, macOS and Linux; Docker Desktop.
- Every new tool or image gets an S4.1 review and an Architecture decision,
  is pinned and CVE-checked in CI (S4.1, S4.3, S4.4).
- Reuses the container, proxy, policy, commit, scan and report code of
  F-007 and F-008. No new runtime library unless approved.
- The engine's own repo maturity is Rapid prototype until promoted.
- Change-controlled files change only through hygiene items H-0190 to H-0199.
- Repetitive steps (running tests, reading CI, counting retries, opening the
  PR) are engine code, not agent turns (owner rule, 2026-11-13).

## 6. Edge cases
- The developer finishes long before the test engineer, or the reverse.
- The test engineer believes a test is right and the developer believes the
  code is right (the disagreement rule).
- `main` moves during the build (ADR 0013: merge `main` in, retest).
- CI never reports (no workflow, or the run is stuck).
- The owner closes the PR, pushes to the branch, or comments `/changes`.
- The target repo is public while the config repo is private.
- The engine restarts mid-stage.

## 7. Dependencies
- Increment 3: full readiness gate, engine reads inbox actions, F-011 filing
  of Testing and Decision items. This feature can be specified in parallel;
  its build needs those parts.
- F-003 onboarding: the code repo's CI workflow, `main` ruleset and required
  checks (F-011 FR-19).
- ADRs 0005, 0007, 0008, 0009, 0010, 0012, 0013, 0015, 0017, 0022, 0024.
- Contracts: Role policy, Project manifest, Agent report, Inbox item.

## 8. Assumptions
None. Any the interview raises are approved or rejected by the owner, never
recorded otherwise.

| Id | Assumption | Decision link | Status |
|---|---|---|---|

## 9. Security considerations
To be drafted with the analyst's draft requirements and then Security Gate 1.
Known topics: the owner token's scope on code repos (contents, pull requests,
checks), pushing to a code repo that may be public, agents running the repo's
own build and test code inside containers, package registry egress for the
developer and test engineer, and the spec and transcript reaching a public
repo (OQ-2).

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|

## 10. Interface requirements
Drafted after section 12 is answered. Expected hygiene items:
- H-0190: limits for the developer, test engineer, Gate 2 reviewer, judge
  (and orchestrator, if OQ-4 gives it a session).
- H-0191: `models.yaml` entries for the same roles.
- H-0192: Role policy changes for code repo worktrees (spec mounted
  read-only; test engineer cannot read the dev branch).
- H-0193: Project manifest additions, if OQ-5 or OQ-6 need them (test
  command, toolchain).
- H-0194: Agent report bodies for the orchestrator review and the run
  report, if they change.
- H-0195: ADR 0005 and ADR 0009 wording, and F-007 v41's exception closed.

## 11. Readiness gate
Not run.

## 12. Open questions for the owner
Asked one at a time on decision cards. None is assumed.

| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | One feature for all of stages 5 to 9, built in milestones, or split into two features (build and test first, then gates and PR)? | Product | Decided: one feature, built and merged in milestones (owner, decision card, 2026-11-13) |
| OQ-2 | Where feature work lives once it leaves the config repo: specs, transcripts and agent reports stay in the config repo and only code moves to the code repo; or everything moves to the code repo per ADR 0005/0009 as written; or code moves and a copy of the approved spec goes into the PR. | Architecture | Decided: only code and tests go to the code repo; spec, transcript, reports and records stay in the private config repo; agents get the spec read-only; the PR links it. Amends ADR 0005/0009 (ADR 0026) (owner, decision card, 2026-11-13) |
| OQ-3 | Can one feature change more than one code repo (one PR per repo), or is it one repo per feature for now? | Product | Open |
| OQ-4 | Who runs stages 6 and 9: engine code only, engine code plus an orchestrator agent session just to classify failures, or an orchestrator agent session for the whole stage. | Architecture | Open |
| OQ-5 | Who runs the tests: the engine runs a test command the manifest declares and reads its JUnit XML, or the test engineer agent runs them and reports. | Architecture | Open |
| OQ-6 | Where each project's build toolchain comes from for the agent containers: a Dockerfile in the config repo built on the factory image, the code repo's dev container definition, or a fixed set of factory toolchain images. | Architecture, Security | Open |
| OQ-7 | Who commits appear to come from in code repos: the engine's own identity (today) or the owner's name with his GitHub noreply address. | Product | Open |

## 13. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft from the baseline spec, ADRs and increments 1 to 3, before the owner interview | — |
| 2 | 2026-11-13 | OQ-1: one feature for stages 5 to 9 and the move to code repos, built and merged in milestones (code-repo move with developer and test engineer; stage 6 review; Gate 2 and judge; PR and CI) | Owner, 2026-11-13 (decision card) |
| 3 | 2026-11-13 | OQ-2: only code and tests go to code repos; spec, transcript, reports and records stay in the private config repo (FR-2); ADR 0026 to record the amendment to ADR 0005 and 0009 | Owner, 2026-11-13 (decision card) |
