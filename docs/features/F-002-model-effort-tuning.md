# Feature: Model and effort tuning per agent

- **Id:** F-002
- **Status:** v12 Approved (owner merged PR #8, 2026-11-10). v13 (calibration on promptfoo, ADR 0023) in review: OQ-1 to OQ-3 and A-7, A-13 await the owner. Implementation waits for the engine
- **Requested by / date:** Alex, 2026-11-10
- **Spec version:** 13 (draft)

## 1. Objective and business purpose
Run each agent on the cheapest model and lowest effort level that still does
its job well, per project. A simple project should not pay for maximum effort
in every agent; a complex one may need more. The level is found by testing,
not guessed, and is tuned from evidence after every feature run. Moving any
agent up to a stronger model or higher effort is always the owner's call.

## 2. Expected behavior
1. **Initial calibration.** When a project's software spec is complete, a
   project evaluator agent reviews it and proposes the complexity preset,
   with its reasons, for the owner to approve (A-11). The engine runs the master calibration tasks for that
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
| FR-1 | Factory config defines a model/effort ladder: a list of rungs, each a model and an effort level. Their order is not configured; it comes from measured cost per task (FR-18, A-1). Config also holds per-token prices only for models that have no other price source (FR-3, A-13). |
| FR-2 | The project manifest can set a rung per agent role (`settings.agents.<role>`). A role with no setting uses the master default. |
| FR-3 | The engine runs each agent with its role's resolved model and effort, and records both in the agent report with token use, cost, and duration. Cost comes from the Agent SDK's own figure for a Claude run (`total_cost_usd`, which the engine already records), from LiteLLM's price table for a run on an F-013 endpoint, and from FR-1's configured prices only where neither has one (A-13). |
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
| FR-19 | Project evaluator: when the project's software spec is complete, and again when the owner asks, an evaluator agent reads it and files a Product decision proposing the complexity preset, with per-role reasons (for example: many interfaces raise the test engineer's tier; untrusted input raises the security reviewer's). It never sets rungs; calibration does. |
| FR-20 | Per-task complexity: before stage 5 of each feature, the project evaluator rates the feature's complexity and predicts the rung each role will need. The prediction and the rung actually needed are recorded in the run review, giving the evaluator's running accuracy. |
| FR-22 | Calibration trials and transcript replays (FR-7, FR-13) run on promptfoo, driven by engine code (ADR 0023, A-7). The engine builds one promptfoo evaluation per role and rung: each task is a test case, the trial count is promptfoo's `repeat` (5, A-2), and each objective check (A-9) is a promptfoo assertion that calls the engine's check code. The analyst's rubric grader is a promptfoo `llm-rubric` assertion whose grading provider is also the engine adapter. The engine reads promptfoo's results and applies the pass bar, floors, ladder order and hygiene items itself. |
| FR-23 | Every model call promptfoo makes goes through one custom provider, the engine adapter, which hands the trial to the engine's session runner, so the trial runs under the role's policy and in its container (SR-1, SR-2). promptfoo's built-in model providers are not used and promptfoo holds no API key or credential. Because the engine makes every call, calibration works on a subscription plan and on F-013 endpoints the same way as real runs. |
| FR-24 | The adapter keeps a running total of a batch's cost. When the next trial would pass the SR-9 cap, it stops the evaluation through promptfoo's `abortSignal` and the engine keeps the results so far. |
| FR-25 | promptfoo's own result files and database live in an engine-owned folder outside Git (`PROMPTFOO_CONFIG_DIR`), with promptfoo's response cache off, so every trial really runs. The Calibration result v1.0 file remains the record; promptfoo's files are working data. What the owner can do with them depends on OQ-3. |
| FR-21 | Once the evaluator meets the reliability bar (A-12), the orchestrator may run a role on the evaluator's predicted rung for that task when it is cheaper than the role's approved rung, never above it. A task that fails on the cheaper rung is retried on the approved rung, and the miss counts against the evaluator. |

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
| AC-18 | Given a completed project spec, when the evaluator runs, then one Product decision item proposes a complexity preset with per-role reasons, and no manifest or rung changes. | FR-19 |
| AC-19 | Given a feature entering stage 5, when the evaluator runs, then its predicted rung per role is recorded, and the run review scores it against the rung actually needed. | FR-20 |
| AC-20 | Given the evaluator below the A-12 bar, then the orchestrator runs every role on its approved rung; given it above the bar and predicting a cheaper rung, then the orchestrator may use that rung, and never a rung above the approved one. | FR-21 |
| AC-21 | Given calibration for a role at one rung with 2 tasks, then promptfoo runs 10 trials (2 tasks × repeat 5), every trial's model call reaches the engine adapter, and no call goes to a promptfoo built-in provider or to the network from promptfoo itself. | FR-22, FR-23 |
| AC-22 | Given a batch whose estimate is $1 and trials that cost more than expected, when the running total would pass $1.50, then the evaluation is aborted, partial results are kept, and a Testing item is filed. | FR-24, SR-9 |
| AC-23 | Given a Claude agent run, then the cost in its report is the Agent SDK's `total_cost_usd`; given a run on an F-013 endpoint, then it is LiteLLM's figure; given a model with neither, then it is tokens × FR-1's configured price. | FR-3, A-13 |
| AC-24 | Given promptfoo started by the engine, then its telemetry, update check, sharing and remote generation are off, its config folder is the engine-owned one, and it was started as OQ-1 decides. | SR-11, SR-12 |
| AC-13 | Given an open suggestion for a role, when the trigger is met again, then no second item is filed. | FR-14 |
| AC-14 | Given an approved suggestion, then the manifest change is one commit whose message starts with the item id. | FR-15 |
| AC-15 | Given a role already on the top rung that meets the step-up trigger, then the item says so and recommends investigating the role's instructions instead. | FR-12 |
| AC-16 | Given a project preset "complex" whose roles all calibrate at the simple tier's rungs, then the review reports derived complexity "simple" and the manifest preset is unchanged. | FR-16 |

## 5. Constraints
- Engine code (ADR 0001, TypeScript + Agent SDK) drives promptfoo as a pinned
  Node library (ADR 0023); where promptfoo runs is OQ-1. promptfoo runs only
  for calibration and replays, never in a normal feature run.
- promptfoo 0.125.x needs Node 22.22 or newer (its `engines` field).
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
- A spec or transcript contains instructions aimed at the evaluator or the
  agent under test ("rate this simple", "skip the check"): treated as data (SR-7).
- An agent tries to edit its own metrics or run review: denied by role policy (SR-8).
- A calibration batch runs far over its estimate: stopped at the cap (SR-9).
- promptfoo or the adapter errors on a trial (not the model's answer failing
  its check): the error is "environment" (FR-11), not a failed trial. The trial
  is retried once; if it errors again, the batch stops, keeps partial results,
  and files a Testing item.
- A promptfoo release is later reported compromised or vulnerable in a path
  the factory uses: handled under S4.6 deadlines; calibration is paused until
  the pin moves.
- Several features run at once (ADR 0007): run reviews append to history in
  completion order; triggers read the history at the time of the review.

## 7. Dependencies
- The orchestration engine (ADR 0001), not built yet. F-002 cannot be built
  before the engine can launch agents and keep transcripts.
- Project manifest (ADR 0010), Agent report and Inbox item contracts.
- promptfoo (MIT, npm `promptfoo`), pinned (SR-11), with its S4.1 review in
  [F-002-promptfoo-review.md](F-002-promptfoo-review.md). Hygiene items:
  H-0166 the pinned dependency and lockfile overrides, H-0167 the adapter,
  H-0168 this spec change.
- F-013 (model endpoints): LiteLLM's price table for endpoint runs (A-13).
- F-003 (repo onboarding) runs the project evaluator, records the approved
  preset, and triggers initial calibration.
- F-004 (parked): opt-in cross-project baseline for a new project's starting order.
- After approval, these change-controlled files need hygiene items:
  `workflows/feature-development/workflow.yaml` (run review step),
  `agents/orchestrator/AGENT.md` (writes the review, proposes transcripts),
  `docs/testing-strategy.md` (attribution table), `docs/interface-contracts.md` (§ 10).

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | **Ladder order (Product).** Rungs are ordered by measured cost per passing task, per role and per project, built up over time from calibration, replays and real runs (FR-18), not from published figures. Per-token prices only convert measured tokens to dollars (Anthropic API rates on 2026-11-03, input / output per million tokens: Haiku 5.5 $0.10 / $0.50, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20, Fable 5.2 $8 / $40). Before anything is measured, initial calibration tries rungs by model price, then effort low → max, and the order is corrected as measurements arrive. On a subscription plan (ADR 0012 `settings.budget.mode: subscription`), cost per task is the share of plan usage the task used, not dollars; in `tokens` mode it is dollars. Calibration and replay spend counts against the project's budget, and ADR 0012's run-cost estimates read the same measurements. | Owner, 2026-11-10; subscription measure by decision card, 2026-11-10 | Approved |
| A-2 | **Calibration pass bar (Product).** Each task runs 5 trials. A rung passes if at least 90% of trials pass, and, for the security reviewer and validation judge, no planted or recorded Critical or High defect is missed in any trial. | Owner, 2026-11-10 | Approved |
| A-3 | **Floors for gate agents (Security).** The security reviewer and validation judge never run below Sonnet/medium, whatever calibration finds. | Owner, 2026-11-10 | Approved |
| A-4 | **Approval for every change (Product).** Spec § 6 stands: step-ups and step-downs are both hygiene items; move-downs are grouped into one low-priority item per review. | Owner, 2026-11-10 | Approved |
| A-5 | **Triggers (Product).** Step up: a role is attributed failures in 3 of its last 5 runs, or causes a Testing inbox escalation in 2 of its last 5. Step down: 10 consecutive runs with no attributed failure and first-try pass, then a passing replay of the project's own transcripts at the cheaper rung (owner, 2026-11-10). | Owner, 2026-11-10 | Approved |
| A-6 | **Complexity (Product).** The manifest's `complexity` is a preset set at onboarding and used only for initial calibration. After the project starts, complexity is derived from the rungs the agents actually need and reported in run reviews. | Owner, 2026-11-10 | Approved |
| A-7 | **Calibration tasks (Architecture).** Master tasks in the master repo at `calibration/<role>/<tier>/`. A project's tests are selected transcripts of its own runs, listed in its config repo at `calibration/transcripts.yaml`; the transcripts themselves stay where transcripts are kept today (outside Git). Results, metrics and history on the project config repo's `factory/state` branch at `.factory/tuning/` (one record per project, per ADR 0009/0010), with each sample tagged with the member repo it ran in. Nothing project-specific is stored in the master factory repo. **v13:** the ladder, pass bar, floors, triggers, transcript selection, run reviews and hygiene items are engine code; running the trials, repeats and checks is promptfoo, pinned, driven by engine code through a custom provider that calls the engine's session runner (ADR 0023). v12 said "Logic is an engine module". | Owner, 2026-11-10; v13 change from ADR 0023 (owner, 2026-11-13, decision card) | v13 change pending owner approval |
| A-8 | **Formats (Interfaces).** Additive: the next Project manifest minor version, Agent report v1.1, new Run review v1.0, Tuning metrics v1.0 and Calibration result v1.0 (§ 10). | Owner, 2026-11-10 | Approved |
| A-9 | **How outputs are compared (Product).** use an objective check wherever the role has one: developer, the feature's final acceptance tests pass on the new code; test engineer, the new suite passes on the accepted code and fails on the bugs found during that run; security reviewer, every finding in the accepted report is found at the same severity; judge, same verdict and every Blocking finding; orchestrator, same root cause and next step. For the analyst, whose output is prose, a grader at a fixed top rung scores the new spec against the accepted one on a rubric (every requirement, criterion and assumption covered); its cost counts toward calibration. | Owner, 2026-11-10 (PR #8 review) | Approved |
| A-10 | **When transcripts replace master tasks (Product).** per role, once at least 5 transcripts are selected, and at least one of them is a run where that role's first attempt failed, so the set tests the hard cases too. Until then, master tasks at the derived tier fill the gap. | Owner, 2026-11-10 (PR #8 review) | Approved |
| A-11 | **Project evaluator agent (Product + Architecture).** A seventh agent role, `project-evaluator`. (a) It reviews the completed project spec and proposes the complexity preset (FR-19). (b) It also rates the complexity of each feature before stage 5 and predicts the rung each role will need (FR-20). Its predictions are scored against the rungs the run review shows were actually needed. (c) Once it proves reliable (A-12), the orchestrator may use its advice per task, but only to run a role on a cheaper rung than the approved one; going above the approved rung still needs the owner. It is advisory throughout and runs on its own rung, calibrated on specs and features of known complexity. Adding a role amends spec § 2 (six agents) and needs `agents/project-evaluator/AGENT.md` and a role policy entry, each through a hygiene item. | Owner, 2026-11-10 (PR #8 review; decision card) | Approved |
| A-12 | **When the evaluator counts as reliable (Product).** Its predicted rung matches the rung actually needed, or errs one rung high, in at least 90% of the last 30 features, and it never predicts lower than needed for the security reviewer or validation judge. Below that bar its advice is recorded but not used; it is re-checked in every run review. | Owner, 2026-11-10 (decision card: stricter bar) | Approved |
| A-13 | **Where cost figures come from (Product).** A Claude run's cost is the Agent SDK's own `total_cost_usd`; a run on an F-013 endpoint uses LiteLLM's price table; FR-1's hand-kept prices only where neither has one. This applies to every agent run (FR-3), not only to calibration trials, so a role's real runs and its calibration trials are measured the same way for the ladder order (FR-18). On a subscription plan A-1's plan-usage measure still applies. ADR 0023 set this for trials; extending it to every run is new in v13. | ADR 0023 (trials) | Pending owner approval |

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
| SR-1 | Calibration answers (hidden checks, accepted outputs of transcripts) are not readable by the agent under test (separate worktree and role policy), so an agent can't pass by reading the answers. | Analyst (S8 least privilege) | Accepted |
| SR-2 | Calibration and replay runs use the same role policy as real runs, never wider. Replay worktrees get no factory token or other credentials beyond the role's own; replays never push, open PRs, or file inbox items. | Analyst (S8); Gate 1 #2 | Accepted |
| SR-3 | Floors for gate agents (A-3). | Owner, 2026-11-10 | Accepted |
| SR-4 | Run reviews and history hold no secrets or prompt contents beyond what agent reports already hold; transcripts stay outside Git. | Analyst (S3) | Accepted |
| SR-5 | Before a transcript is selected, it is scanned for secrets and personal data; a transcript that has any is not selected. | Analyst (S3) | Accepted |
| SR-6 | Transcript lists and master tasks are untrusted input and are validated before use; a replay's initial context is the recorded one, unchanged. | Analyst (S1) | Accepted |
| SR-7 | The evaluator's advice can never move a role below its floor (A-3), and is never used for the security reviewer or validation judge below their approved rung. A spec is untrusted text, so an injected "this is trivial" must not be able to weaken a gate. | Gate 1 #1 (S6.1) | Accepted |
| SR-8 | Only the engine writes `.factory/tuning/**` and run reviews; every agent role is denied write access there, so no agent can edit the metrics that judge it. | Gate 1 #3 (S8.1, S6.2) | Accepted |
| SR-9 | Every calibration or replay batch has a cost cap: 1.5 × its shown estimate. At the cap it stops, keeps partial results, files a Testing item, and proposes nothing. | Gate 1 #4 (S5.1) | Accepted |
| SR-10 | The `project-evaluator` role gets read access to specs and run reviews only, and write access only to its own report; no commands, no network. | Gate 1 #5 (S8.1, S8.5) | Accepted |

| SR-11 | promptfoo conditions (S4.1, S4.3, S4.4, S4.6; the same ones the owner set for LiteLLM in F-013 OQ-9): exact version pin with a lockfile; a new release is adopted no sooner than 14 days after it is published unless it fixes a CVE in a path the factory uses; OSV-Scanner covers it in CI; transitive packages with known advisories are moved to fixed versions with npm `overrides` (four in 0.125.1, see the review); the engine starts it with `PROMPTFOO_DISABLE_TELEMETRY=1`, `PROMPTFOO_DISABLE_UPDATE=1`, `PROMPTFOO_DISABLE_SHARING=1` and `PROMPTFOO_DISABLE_REMOTE_GENERATION=1`; red-team, cloud and share features are never used. | Gate 1 re-review #1 (v13) | Proposed |
| SR-12 | Where promptfoo runs and what it can reach is decided in OQ-1. Whatever the answer, it never gets the factory token, the Claude credential or endpoint keys (FR-23). | Gate 1 re-review #2 (v13) | Proposed, waits on OQ-1 |
| SR-13 | promptfoo's working files (FR-25) hold prompts and outputs like transcripts do, so they get SR-4's treatment: outside Git, in an engine-owned folder, never in a run review or hygiene item. | Gate 1 re-review #3 (v13) | Proposed |

Gate 1: [F-002-security-gate1.md](F-002-security-gate1.md), 2026-11-10. Five findings, all resolved by SR-2 and SR-7 to SR-10. No owner decision needed.

### Open questions for the owner (v13)
| Id | Question | Recommendation | Status |
|---|---|---|---|
| OQ-1 | Where does promptfoo run? (a) In a separate Node child process the engine starts with an empty environment (only the `PROMPTFOO_*` settings above), talking to the engine over a pipe; the engine runs every trial. (b) Inside the engine process. (c) In its own container with no network. | (a). promptfoo brings about 400 npm packages (0.125.1, optional ones left out). In (b), any one of them runs with the engine's environment, which holds the factory token and Claude credential; the September 2025 "Shai-Hulud" npm worm did exactly that, stealing tokens from the environment of whatever process loaded it ([CISA alert, 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)). (a) removes those credentials from its reach at almost no cost to you: nothing to install or start by hand. (c) adds network isolation but means a container image to build and update. Least privilege: security-standards S8. | Pending owner |
| OQ-2 | Do you accept the S4.1 review's result (conditional: SR-11 conditions, residual risk stated in the review)? | Accept | Pending owner |
| OQ-3 | Can you open promptfoo's local web viewer (`promptfoo view`, on 127.0.0.1 only) to look through calibration results, or should the factory only give you its own Calibration result file? | Allow the viewer, on demand, bound to 127.0.0.1, reading only the engine-owned folder. It shows every trial side by side at no build cost. Its web server package (`@hono/node-server` 2.1.5) has two Moderate advisories, fixed by the SR-11 override. | Pending owner |

## 10. Interface requirements
All changes are additive (A-8):
- **Project manifest, next minor version** (v1.2 if the role-policy change in PR #9 takes v1.1 first): optional `complexity` (preset);
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
- [ ] Assumptions explicit and approved (A-1 to A-12 approved; v13 A-7 change and A-13 pending)
- [ ] Blocking decisions resolved (v13: OQ-1 to OQ-3 pending; Gate 1 re-review done)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-10 | Draft | — |
| 2 | 2026-11-10 | Owner answers: ladder ordered by cost, grouped move-downs, complexity preset then derived, project transcripts as tests; A-2, A-3, A-5, A-8 approved as proposed; A-9, A-10 added | Owner, 2026-11-10 (A-1 to A-8) |
| 3 | 2026-11-10 | Move-downs tested only by replaying the project's own transcripts | Owner, 2026-11-10 |
| 4 | 2026-11-10 | Ladder order and effort metrics built from measurement over time, not published data (A-1 approved) | Owner, 2026-11-10 |
| 5 | 2026-11-10 | Clarified: tuning data lives in the project config repo, samples tagged by member repo | Follows ADR 0009/0010 |
| 6 | 2026-11-10 | Project evaluator agent proposes the complexity preset (A-11); F-004 parked | — |
| 7 | 2026-11-10 | A-9 approved | Owner, 2026-11-10 |
| 8 | 2026-11-10 | A-10 approved | Owner, 2026-11-10 |
| 9 | 2026-11-10 | Evaluator extended to per-task complexity advice for the orchestrator once reliable (A-11 b, c; FR-20, FR-21; A-12 added) | — |
| 10 | 2026-11-10 | A-11 approved; A-12 approved with the stricter bar (90% of last 30) | Owner, 2026-11-10 |
| 11 | 2026-11-10 | Gate 1 security review: SR-2 tightened, SR-7 to SR-10 added, abuse cases added; readiness gate passed | Owner, 2026-11-10 (PR #8 merged) |
| 12 | 2026-11-10 | A-1: on a subscription plan, cost is plan usage used; calibration counts against the budget (ADR 0012) | Owner, 2026-11-10 (decision card) |
| 13 | 2026-11-13 | Calibration and replays run on promptfoo (ADR 0023): A-7 revised; FR-1, FR-3 cost sources (A-13 new); FR-22 to FR-25, AC-21 to AC-24; constraints, edge cases, dependencies; Gate 1 re-review adds SR-11 to SR-13; OQ-1 to OQ-3 for the owner | Pending owner |
