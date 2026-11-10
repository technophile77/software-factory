# Feature: Model and effort tuning per agent

- **Id:** F-002
- **Status:** Draft (requirements interview; assumptions A-1 to A-8 await the owner)
- **Requested by / date:** Alex, 2026-11-10
- **Spec version:** 1

## 1. Objective and business purpose
Run each agent on the cheapest model and lowest effort level that still does
its job well, per project. A simple project should not pay for maximum effort
in every agent; a complex one may need more. The level is found by testing,
not guessed, and is tuned from evidence after every feature run. Moving any
agent up to a stronger model or higher effort is always the owner's call.

## 2. Expected behavior
1. **Calibration.** When a project is onboarded, and whenever the owner asks,
   the engine runs a calibration suite for each agent role. It starts each
   role on the lowest rung of the model/effort ladder and climbs one rung at
   a time until the role passes its calibration tasks. The lowest passing
   rung becomes that role's starting setting for the project, proposed to the
   owner as one Configuration hygiene item.
2. **Every agent run** uses the role's setting from the project manifest. The
   agent report records the model, effort, tokens, cost, and time used.
3. **Run review.** After every feature run (PR opened, or the run escalated
   to an inbox and stopped), the orchestrator writes a run review: for each
   role, which rung it ran on, whether its work passed first time, how many
   fix cycles or reruns it caused, and the failures attributed to it.
4. **Suggestions.** The run review compares each role's recent history with
   the triggers in A-5. If a role keeps failing, it files a Configuration
   hygiene item proposing one rung up, with the evidence. If a role has
   passed cleanly for a long stretch, it proposes trying one rung down,
   after a calibration check at the lower rung. Nothing changes until the
   owner approves (A-4).

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Factory config defines a model/effort ladder: an ordered list of rungs, cheapest first, each a model and an effort level. |
| FR-2 | The project manifest can set a rung per agent role (`settings.agents.<role>`). A role with no setting uses the master default. |
| FR-3 | The engine runs each agent with its role's resolved model and effort, and records both in the agent report with token use, cost, and duration. |
| FR-4 | The master factory ships a calibration suite per role: graded tasks at three complexity tiers (simple, moderate, complex), each with an automatic pass/fail check. |
| FR-5 | A project may add its own calibration tasks in its config repo; they run alongside the master tasks for its tier. |
| FR-6 | Calibration runs each role from the lowest rung upward, stopping at the first rung that meets the pass bar (A-2), and never below the role's floor (A-3). |
| FR-7 | Calibration shows its estimated cost before it starts and reports actual cost when done. |
| FR-8 | Calibration results are filed as one Configuration hygiene item proposing the per-role settings, with the scores for every rung tried. |
| FR-9 | After every feature run the orchestrator writes a run review (`.factory/runs/<feature>/review.json`) with per-role results and attributed failures. |
| FR-10 | Failures are attributed to a role by the orchestrator's existing root-cause classes (§ attribution table). Environment, infrastructure, and dependency failures are attributed to no role. |
| FR-11 | When a role meets the step-up trigger (A-5), the run review files a hygiene item proposing exactly one rung up, with the run ids and failures as evidence. |
| FR-12 | When a role meets the step-down trigger (A-5), the engine first re-runs that role's calibration tasks at the lower rung; only if they pass does it file a hygiene item proposing one rung down. |
| FR-13 | No suggestion is filed while an earlier one for the same role is still open. |
| FR-14 | Every applied change to a role's rung is a commit with the hygiene item id, so it can be traced and rolled back. |
| FR-15 | The run review and per-role history (last 20 runs) are readable by the owner as plain files on `factory/state`. |

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
| AC-3 | Given a stub agent that passes calibration only from rung 3, when calibration runs, then rungs 1, 2, 3 are tried in order, rung 4 is not, and the hygiene item proposes rung 3 with scores for 1 to 3. | FR-6, FR-8 |
| AC-4 | Given a role whose floor is rung 4, when calibration runs, then rungs below 4 are not tried. | FR-6, A-3 |
| AC-5 | Given calibration is requested, then the estimated cost is shown before any agent starts, and the actual cost is in the result. | FR-7 |
| AC-6 | Given a project calibration task in the config repo, when calibration runs for that project's tier, then the task is included and scored. | FR-5 |
| AC-7 | Given a finished feature run, then `review.json` exists with one entry per role that ran, matching the Run review v1.0 contract. | FR-9 |
| AC-8 | Given a failure classified "product code", then the review attributes it to software-developer; given "environment", then to no role. | FR-10 |
| AC-9 | Given a role meeting the step-up trigger, then exactly one hygiene item is filed proposing one rung up, linking the runs that triggered it; no setting changes. | FR-11, A-4 |
| AC-10 | Given a role meeting the step-down trigger, when the lower rung fails its calibration check, then no item is filed and the review records why. | FR-12 |
| AC-11 | Given an open suggestion for a role, when the trigger is met again, then no second item is filed. | FR-13 |
| AC-12 | Given an approved suggestion, then the manifest change is one commit whose message starts with the item id. | FR-14 |
| AC-13 | Given a role already on the top rung that meets the step-up trigger, then the item says so and recommends investigating the role's instructions instead. | FR-11 |

## 5. Constraints
- Runs inside the engine (ADR 0001, TypeScript + Agent SDK); no new process.
- Must work with the model families and effort levels the Agent SDK accepts;
  the ladder lists them so a new model is a config change, not a code change.
- Calibration and run reviews never edit change-controlled files; every
  setting change goes through the Configuration hygiene inbox.
- New and changed formats are Interfaces decisions (§ 10).
- History and reviews live on `factory/state` (ADR 0009).

## 6. Edge cases
- A rung's model is retired or unavailable: calibration skips it and says so;
  an agent run on it fails as "environment" and files a Testing item.
- No rung passes calibration: file a Testing item for the role with every
  score, and propose no setting.
- A feature run with no attributed failures still counts as a clean run.
- Calibration scores are noisy: each task runs several trials (A-2), and the
  seed and transcript of every trial are kept.
- The owner rejects a step-up: the same trigger does not refile it until 5
  more runs of that role have finished.
- A project changes its complexity tier: the owner can re-run calibration;
  current settings stay until a new item is approved.
- Several features run at once (ADR 0007): run reviews append to history in
  completion order; triggers read the history at the time of the review.

## 7. Dependencies
- The orchestration engine (ADR 0001), not built yet. F-002 cannot be built
  before the engine can launch agents; it can be built as the engine's first
  add-on.
- Project manifest (ADR 0010), Agent report and Inbox item contracts.
- The Configuration hygiene inbox (items can be filed as files before the
  extension shows them).
- After approval, these change-controlled files need hygiene items:
  `workflows/feature-development/workflow.yaml` (run review step),
  `agents/orchestrator/AGENT.md` (writes the review), `docs/testing-strategy.md`
  (attribution table), `docs/interface-contracts.md` (§ 10).

## 8. Assumptions
Each needs the owner's approval before the readiness gate. Recommendations
are marked ★.

| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | **Ladder (Product).** Default ladder, cheapest first: 1 Haiku/low, 2 Haiku/medium, 3 Sonnet/low, 4 Sonnet/medium, 5 Sonnet/high, 6 Opus/medium, 7 Opus/high, 8 Opus/max. ★ This order. Alternative: climb all effort levels on a model before changing model. | Owner | Pending |
| A-2 | **Calibration pass bar (Product).** Each task runs 5 trials. A rung passes if at least 90% of trials pass, and, for the security reviewer and validation judge, no planted Critical or High defect is missed in any trial. ★ This bar. | Owner | Pending |
| A-3 | **Floors for gate agents (Security).** The security reviewer and validation judge never run below rung 4 (Sonnet/medium), whatever calibration finds, so cost cutting can't weaken a gate. ★ Floors for these two only. | Owner | Pending |
| A-4 | **Who approves step-downs (Product).** Spec § 6 requires owner approval for every factory config change. ★ Keep it: step-ups and step-downs are both hygiene items; step-downs are filed low priority, grouped per run. Alternative: step-downs apply automatically and are reported, which needs a spec § 6 amendment. | Owner | Pending |
| A-5 | **Triggers (Product).** ★ Step up: a role is attributed failures in 3 of its last 5 runs, or causes a Testing inbox escalation in 2 of its last 5. Step down: 10 consecutive runs with no attributed failure and first-try pass, then a calibration check at the lower rung. | Owner | Pending |
| A-6 | **Project complexity (Product).** The manifest gains `complexity: simple \| moderate \| complex`, set by the owner at onboarding (the onboarding skill can propose it). It chooses which calibration tasks are used; calibration still starts at the lowest rung. ★ This. | Owner | Pending |
| A-7 | **Where it lives (Architecture).** Calibration suite in the master repo at `calibration/<role>/<tier>/`; project tasks in the config repo at `calibration/`; results and history on `factory/state` at `.factory/tuning/`. Logic is an engine module. ★ This. | Owner | Pending |
| A-8 | **Formats (Interfaces).** Additive changes: Project manifest v1.1 adds optional `complexity` and `settings.agents.<role>.rung`; Agent report v1.1 adds optional `model`, `effort`, `usage` (input/output tokens, cost, duration); new Run review v1.0 and Calibration result v1.0 contracts. ★ This. | Owner | Pending |

### Calibration tasks per role (shape, not content)
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
| SR-1 | Calibration tasks and their hidden checks are not readable by the agent under test (separate worktree and role policy), so an agent can't pass by reading the answers. | Analyst (S8 least privilege) | Proposed |
| SR-2 | Calibration agents run with the same role policy as real runs, never wider. | Analyst (S8) | Proposed |
| SR-3 | Floors for gate agents (A-3). | Analyst | Proposed |
| SR-4 | Run reviews and history contain no secrets or prompt contents beyond what agent reports already hold; transcripts stay outside Git as today. | Analyst (S2) | Proposed |
| SR-5 | Project calibration tasks are untrusted input (they come from the config repo) and are validated before use. | Analyst (S1) | Proposed |

Gate 1 security review follows once A-1 to A-8 are decided.

## 10. Interface requirements
All changes are additive and need an Interfaces decision (A-8):
- **Project manifest v1.0 → v1.1:** optional `complexity`; optional
  `settings.agents.<role>: { rung: <n> }`. Validation: rung exists in the
  pinned factory's ladder and is not below the role's floor.
- **Agent report v1.0 → v1.1:** optional envelope fields `model`, `effort`,
  `usage: { input_tokens, output_tokens, cost_usd, duration_s }`.
- **Run review v1.0 (new):** `.factory/runs/<feature>/review.json` with
  `feature`, `outcome`, and per role: `rung`, `runs`, `first_try_pass`,
  `fix_cycles`, `reruns`, `attributed_failures` (cause, stage, report ref),
  `usage`, and `suggestions_filed` (item ids).
- **Calibration result v1.0 (new):** `.factory/tuning/calibration/<date>.json`
  with tier, ladder version, and per role per rung: trials, passes, score,
  cost, and the proposed rung.

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [ ] Assumptions explicit and approved (A-1 to A-8 pending)
- [ ] Blocking decisions resolved (A-1 to A-8; Gate 1 not yet run)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-10 | Draft | — |
