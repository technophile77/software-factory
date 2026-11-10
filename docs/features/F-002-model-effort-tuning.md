# Feature: Model and effort tuning per agent

- **Id:** F-002
- **Status:** Draft (requirements interview; A-9 and A-10 await the owner)
- **Requested by / date:** Alex, 2026-11-10
- **Spec version:** 5

## 1. Objective and business purpose
Run each agent on the cheapest model and lowest effort level that still does
its job well, per project. A simple project should not pay for maximum effort
in every agent; a complex one may need more. The level is found by testing,
not guessed, and is tuned from evidence after every feature run. Moving any
agent up to a stronger model or higher effort is always the owner's call.

## 2. Expected behavior
1. **Initial calibration.** When a project is onboarded, the owner sets a
   complexity preset. The engine runs the master calibration tasks for that
   tier for each agent role, starting on the cheapest rung of the ladder and
   climbing one rung at a time until the role passes. The cheapest passing
   rung becomes the role's starting setting, proposed to the owner as one
   Configuration hygiene item.
2. **Every agent run** uses the role's setting from the project manifest. The
   agent report records the model, effort, tokens, cost, and time used.
3. **Run review.** After every feature run (PR opened, or the run escalated
   to an inbox and stopped), the orchestrator writes a run review: for each
   role, which rung it ran on, whether its work passed first time, how many
   fix cycles or reruns it caused, and the failures attributed to it.
4. **Project transcripts become the tests.** Once a project is running,
   selected transcripts of its own agent runs are its calibration tasks. The
   initial context the agent was given is replayed to the model under test,
   and its output is compared with the recorded, accepted output.
5. **Suggestions.** The run review compares each role's recent history with
   the triggers in A-5. If a role keeps failing, it files a hygiene item
   proposing one rung up, with the evidence. If a role has passed cleanly for
   a long stretch, it first tests the cheaper rung by replaying the project's
   own selected transcripts for that role, and proposes the move only if they
   pass. Move-down proposals from one review are
   grouped into one item. Nothing changes until the owner approves.
6. **Complexity follows the evidence.** After the project starts, its
   complexity is no longer the preset: it is derived from the rungs the
   agents actually need, and reported in each run review.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Factory config defines a model/effort ladder: a list of rungs, each a model and an effort level. Their order is not configured; it comes from measured cost per task (FR-18, A-1). Config also holds each model's per-token prices, used only to turn measured tokens into dollars. |
| FR-2 | The project manifest can set a rung per agent role (`settings.agents.<role>`). A role with no setting uses the master default. |
| FR-3 | The engine runs each agent with its role's resolved model and effort, and records both in the agent report with token use, cost (tokens × the configured prices), and duration. |
| FR-4 | The master factory ships a calibration suite per role: graded tasks at three complexity tiers (simple, moderate, complex), each with a pass/fail check. These are used for initial calibration and while a project has too few transcripts (A-10). |
| FR-5 | Transcript tasks: a selected transcript records the agent's initial context (system prompt, inputs, repo commit) and its accepted output. Replaying it starts the model under test in a fresh worktree at that commit with the same initial context, and compares the new output with the accepted one (A-9). |
| FR-6 | The orchestrator proposes transcripts to add to or drop from a project's calibration set in its run review; the set lives in the project config repo and changes through hygiene items. |
| FR-7 | Calibration runs each role from the cheapest rung upward, stopping at the first rung that meets the pass bar (A-2), and never below the role's floor (A-3). |
| FR-8 | Calibration shows its estimated cost before it starts and reports actual cost when done. |
| FR-9 | Calibration results are filed as one hygiene item proposing the per-role settings, with the score and cost for every rung tried. |
| FR-10 | After every feature run the orchestrator writes a run review (`.factory/runs/<feature>/review.json`) with per-role results, attributed failures, and the project's derived complexity. |
| FR-11 | Failures are attributed to a role by the orchestrator's existing root-cause classes (attribution table below). Environment, infrastructure, and dependency failures are attributed to no role. |
| FR-12 | When a role meets the step-up trigger (A-5), the run review files a hygiene item proposing exactly one rung up, with the run ids and failures as evidence. |
| FR-13 | When a role meets the step-down trigger (A-5), the engine first replays the project's selected transcripts for that role at the next cheaper rung, against the A-2 pass bar; only if they pass is a move down proposed, with the replay results attached. Master tasks are never used for this test; a role with no selected transcripts gets no move-down proposal, and the review says so. All move-downs from one review go in one grouped hygiene item, low priority. |
| FR-14 | No suggestion is filed while an earlier one for the same role is still open. |
| FR-15 | Every applied change to a role's rung is a commit with the hygiene item id, so it can be traced and rolled back. |
| FR-16 | Derived complexity: the tier whose master calibration tasks best match the rungs the roles currently need (median role rung mapped to a tier), recorded in each run review and in history. It does not edit the manifest preset. |
| FR-17 | Run reviews and per-role history (last 20 runs) are readable by the owner as plain files on `factory/state`. |
| FR-18 | Effort metrics are built from measurement: every calibration trial, replay, and real agent run adds its tokens, cost, duration, pass/fail and member repo to a per-project record for its role and rung (`.factory/tuning/metrics.json` on the project config repo's `factory/state`). The ladder order for a role is recomputed from these as median cost per passing task. A rung with no measurements is marked unmeasured, and the review shows how many samples each figure rests on. |

### Failure attribution
| Root cause (testing-strategy.md) or event | Attributed to |
|---|---|
| Product code | software-developer |
| Test code | test-engineer |
| Spec found wrong or incomplete; readiness gate sent back | requirements-analyst |
| A security finding at Gate 2, in CI, or after merge that Gate 1 should have required | security-reviewer |
| Judge verdict overturned by the owner, or a defect found after a PASS that the checklist covers | validation-judge |
| Misclassified root cause, or an incomplete run accepted | orchestrator |
| Environment, infrastructure, dependency, flaky | none |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a manifest setting `software-developer` to rung 3, when the engine starts that agent, then the session uses rung 3's model and effort and the agent report records them with tokens, cost, and duration. | FR-2, FR-3 |
| AC-2 | Given a role with no manifest setting, then the master default rung is used and recorded. | FR-2 |
| AC-3 | Given a stub agent that passes calibration only from rung 3, when calibration runs, then rungs 1, 2, 3 are tried in order, rung 4 is not, and the hygiene item proposes rung 3 with score and cost for 1 to 3. | FR-7, FR-9 |
| AC-4 | Given a role whose floor is rung 4, when calibration runs, then rungs below 4 are not tried. | FR-7, A-3 |
| AC-5 | Given calibration is requested, then the estimated cost is shown before any agent starts, and the actual cost is in the result. | FR-8 |
| AC-6 | Given a selected transcript, when it is replayed at a rung, then the model under test gets the recorded initial context in a worktree at the recorded commit, and the result records pass/fail from the comparison. | FR-5 |
| AC-7 | Given a project with enough transcripts for a role (A-10), when calibration runs for that role, then transcript tasks are used instead of master tasks. | FR-4, FR-5 |
| AC-8 | Given a finished feature run, then `review.json` exists with one entry per role that ran and the derived complexity, matching the Run review v1.0 contract. | FR-10, FR-16 |
| AC-9 | Given a failure classified "product code", then the review attributes it to software-developer; given "environment", then to no role. | FR-11 |
| AC-10 | Given a role meeting the step-up trigger, then exactly one hygiene item is filed proposing one rung up, linking the runs that triggered it; no setting changes. | FR-12 |
| AC-11 | Given two roles meeting the step-down trigger in one review, and both pass at the cheaper rung, then one grouped hygiene item proposes both moves. | FR-13 |
| AC-12 | Given a role meeting the step-down trigger whose cheaper rung fails the transcript replay, then no move is proposed for it and the review records why. | FR-13 |
| AC-17 | Given a role meeting the step-down trigger with no selected transcripts, then no move is proposed, no master task is run for it, and the review says a transcript is needed. | FR-13 |
| AC-13 | Given an open suggestion for a role, when the trigger is met again, then no second item is filed. | FR-14 |
| AC-14 | Given an approved suggestion, then the manifest change is one commit whose message starts with the item id. | FR-15 |
| AC-15 | Given a role already on the top rung that meets the step-up trigger, then the item says so and recommends investigating the role's instructions instead. | FR-12 |
| AC-16 | Given a project preset "complex" whose roles all calibrate at the simple tier's rungs, then the review reports derived complexity "simple" and the manifest preset is unchanged. | FR-16 |

## 5. Constraints
- Runs inside the engine (ADR 0001, TypeScript + Agent SDK); no new process.
- The ladder and prices are config, so a new model or price change is a
  config change, not a code change.
- Calibration and run reviews never edit change-controlled files; every
  setting change goes through the Configuration hygiene inbox.
- New and changed formats are Interfaces decisions (§ 10).
- History and reviews live on `factory/state` (ADR 0009).

## 6. Edge cases
- A rung's model is retired or unavailable: calibration skips it and says so;
  an agent run on it fails as "environment" and files a Testing item.
- No rung passes calibration: file a Testing item for the role with every
  score, and propose no setting.
- Prices change: past dollar figures are recomputed from the stored token
  counts; the ladder may re-order, but current settings stay until an item is approved.
- Measured order disagrees with model price (a stronger model at low effort
  is cheaper per task than a weaker one at high effort): the measured order wins.
- A selected transcript's commit no longer exists or its dependencies can't
  install: the task is skipped, reported, and proposed for removal.
- A feature run with no attributed failures still counts as a clean run.
- Calibration scores are noisy: each task runs several trials (A-2), and the
  seed and transcript of every trial are kept.
- The owner rejects a step-up: the same trigger does not refile it until 5
  more runs of that role have finished.
- Several features run at once (ADR 0007): run reviews append to history in
  completion order; triggers read the history at the time of the review.

## 7. Dependencies
- The orchestration engine (ADR 0001), not built yet. F-002 cannot be built
  before the engine can launch agents and keep transcripts.
- Project manifest (ADR 0010), Agent report and Inbox item contracts.
- F-003 (repo onboarding) sets the complexity preset and triggers initial
  calibration.
- After approval, these change-controlled files need hygiene items:
  `workflows/feature-development/workflow.yaml` (run review step),
  `agents/orchestrator/AGENT.md` (writes the review, proposes transcripts),
  `docs/testing-strategy.md` (attribution table), `docs/interface-contracts.md` (§ 10).

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | **Ladder order (Product).** Rungs are ordered by measured cost per passing task, per role and per project, built up over time from calibration, replays and real runs (FR-18), not from published figures. Per-token prices only convert measured tokens to dollars (Anthropic API rates on 2026-11-03, input / output per million tokens: Haiku 5.5 $0.10 / $0.50, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20, Fable 5.2 $8 / $40). Before anything is measured, initial calibration tries rungs by model price, then effort low → max, and the order is corrected as measurements arrive. | Owner, 2026-11-10 | Approved |
| A-2 | **Calibration pass bar (Product).** Each task runs 5 trials. A rung passes if at least 90% of trials pass, and, for the security reviewer and validation judge, no planted or recorded Critical or High defect is missed in any trial. | Owner, 2026-11-10 | Approved |
| A-3 | **Floors for gate agents (Security).** The security reviewer and validation judge never run below Sonnet/medium, whatever calibration finds. | Owner, 2026-11-10 | Approved |
| A-4 | **Approval for every change (Product).** Spec § 6 stands: step-ups and step-downs are both hygiene items; move-downs are grouped into one low-priority item per review. | Owner, 2026-11-10 | Approved |
| A-5 | **Triggers (Product).** Step up: a role is attributed failures in 3 of its last 5 runs, or causes a Testing inbox escalation in 2 of its last 5. Step down: 10 consecutive runs with no attributed failure and first-try pass, then a passing replay of the project's own transcripts at the cheaper rung (owner, 2026-11-10). | Owner, 2026-11-10 | Approved |
| A-6 | **Complexity (Product).** The manifest's `complexity` is a preset set at onboarding and used only for initial calibration. After the project starts, complexity is derived from the rungs the agents actually need and reported in run reviews. | Owner, 2026-11-10 | Approved |
| A-7 | **Calibration tasks (Architecture).** Master tasks in the master repo at `calibration/<role>/<tier>/`. A project's tests are selected transcripts of its own runs, listed in its config repo at `calibration/transcripts.yaml`; the transcripts themselves stay where transcripts are kept today (outside Git). Results, metrics and history on the project config repo's `factory/state` branch at `.factory/tuning/` (one record per project, per ADR 0009/0010), with each sample tagged with the member repo it ran in. Nothing project-specific is stored in the master factory repo. Logic is an engine module. | Owner, 2026-11-10 | Approved |
| A-8 | **Formats (Interfaces).** Additive: Project manifest v1.1, Agent report v1.1, new Run review v1.0, Tuning metrics v1.0 and Calibration result v1.0 (§ 10). | Owner, 2026-11-10 | Approved |
| A-9 | **How outputs are compared (Product).** ★ Recommended: use an objective check wherever the role has one: developer, the feature's final acceptance tests pass on the new code; test engineer, the new suite passes on the accepted code and fails on the bugs found during that run; security reviewer, every finding in the accepted report is found at the same severity; judge, same verdict and every Blocking finding; orchestrator, same root cause and next step. For the analyst, whose output is prose, a grader at a fixed top rung scores the new spec against the accepted one on a rubric (every requirement, criterion and assumption covered); its cost counts toward calibration. | Owner | Pending |
| A-10 | **When transcripts replace master tasks (Product).** ★ Recommended: per role, once at least 5 transcripts are selected, and at least one of them is a run where that role's first attempt failed, so the set tests the hard cases too. Until then, master tasks at the derived tier fill the gap. | Owner | Pending |

### Master calibration tasks per role (shape, not content)
| Role | Task | Automatic check |
|---|---|---|
| requirements-analyst | Vague feature request with known gaps | Spec from template; every planted gap raised as an assumption or question |
| software-developer | Small spec plus hidden acceptance tests | Hidden tests pass; no files outside allowed paths |
| test-engineer | Spec plus a correct and several planted-bug implementations | Suite passes on correct code, catches every planted bug |
| security-reviewer | Spec or diff with planted findings at known severities | Every planted Critical/High found at the right severity; no blocking false positive |
| validation-judge | Finished features with known verdicts | Verdict matches; every planted Blocking finding reported |
| orchestrator | Recorded failure logs with known root cause | Root cause classified correctly; right next step chosen |

## 9. Security considerations
| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | Calibration answers (hidden checks, accepted outputs of transcripts) are not readable by the agent under test (separate worktree and role policy), so an agent can't pass by reading the answers. | Analyst (S8 least privilege) | Proposed |
| SR-2 | Calibration and replay runs use the same role policy as real runs, never wider, and replays never push, open PRs, or file inbox items. | Analyst (S8) | Proposed |
| SR-3 | Floors for gate agents (A-3). | Owner, 2026-11-10 | Approved |
| SR-4 | Run reviews and history hold no secrets or prompt contents beyond what agent reports already hold; transcripts stay outside Git. | Analyst (S2) | Proposed |
| SR-5 | Before a transcript is selected, it is scanned for secrets and personal data; a transcript that has any is not selected. | Analyst (S2) | Proposed |
| SR-6 | Transcript lists and master tasks are untrusted input and are validated before use; a replay's initial context is the recorded one, unchanged. | Analyst (S1) | Proposed |

Gate 1 security review follows once A-9 and A-10 are decided.

## 10. Interface requirements
All changes are additive (A-8):
- **Project manifest v1.0 → v1.1:** optional `complexity` (preset);
  optional `settings.agents.<role>: { rung: <n> }`. Validation: rung exists in
  the pinned factory's ladder and is not below the role's floor.
- **Agent report v1.0 → v1.1:** optional envelope fields `model`, `effort`,
  `usage: { input_tokens, output_tokens, cost_usd, duration_s }`, and
  `transcript_ref` so a run can be selected for calibration.
- **Run review v1.0 (new):** `.factory/runs/<feature>/review.json` with
  `feature`, `outcome`, `derived_complexity`, `transcripts_proposed`, and per
  role: `rung`, `runs`, `first_try_pass`, `fix_cycles`, `reruns`,
  `attributed_failures` (cause, stage, report ref), `usage`, and
  `suggestions_filed` (item ids).
- **Tuning metrics v1.0 (new):** `.factory/tuning/metrics.json`, per role
  per rung: samples, passes, median and p90 tokens, cost and duration per
  task, last updated, and the resulting ladder order.
- **Calibration result v1.0 (new):** `.factory/tuning/calibration/<date>.json`
  with source (master tier or transcripts), ladder and price versions, and per
  role per rung: trials, passes, score, tokens, cost, and the proposed rung.

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [ ] Assumptions explicit and approved (A-9, A-10 pending)
- [ ] Blocking decisions resolved (those two; Gate 1 not yet run)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-10 | Draft | — |
| 2 | 2026-11-10 | Owner answers: ladder ordered by cost, grouped move-downs, complexity preset then derived, project transcripts as tests; A-2, A-3, A-5, A-8 approved as proposed; A-9, A-10 added | Owner, 2026-11-10 (A-1 to A-8) |
| 3 | 2026-11-10 | Move-downs tested only by replaying the project's own transcripts | Owner, 2026-11-10 |
| 4 | 2026-11-10 | Ladder order and effort metrics built from measurement over time, not published data (A-1 approved) | Owner, 2026-11-10 |
| 5 | 2026-11-10 | Clarified: tuning data lives in the project config repo, samples tagged by member repo | Follows ADR 0009/0010 |
