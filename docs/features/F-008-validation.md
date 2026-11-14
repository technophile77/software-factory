# F-008 Validation report

- **Feature:** F-008 Run Security and Testability Review on the real engine, spec v14
- **Judge:** validation-judge
- **Date:** 2026-11-12
- **Round:** 1
- **Commit:** `dced5c3` (`claude/project-thread-nty8f8`, draft PR #30). The diff is `git diff origin/main...HEAD` after `git fetch origin main`: 27 commits, 31 files, +4,311 / −34. Engine code: `src/st-review/{flow,render,report,standards}.ts` (new), `src/agent/reviewer.ts` (new), and changes to `engine.ts`, `agent/runtime.ts`, `agent/sandbox.ts`, `config/limits.ts`, `config/models.ts`, `interview/model.ts`, `interview/readiness.ts`, `state/inbox.ts`, `state/record.ts`, `state/runs.ts`. Change-controlled: `engine/config/limits.yaml`, `engine/config/models.yaml`, `docs/interface-contracts.md`. Tests: `test/st-review.test.ts`, `test/st-review-run.test.ts` (developer's), `test/acceptance/st-review.test.ts` with `support/st-review.ts` (test engineer's), small edits to `support/agents.ts`, `engine.test.ts`, `limits.test.ts`. Documents: the six `docs/features/F-008-*` files.
- **Contracts:** Agent report v1.3 (H-0096), Inbox item v1.1, Interview tools v1.0, Role policy v2.5. Engine control channel v1.3 unchanged.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Not met line or a Blocking finding still fails.
- **Verdict:** **NEEDS HUMAN REVIEW**
  - **0 lines are Not met.**
  - **2 lines are Needs owner:**
    - **FR-3**, the `security-review` skill. Role policy v2.5's `security-reviewer` entry, which OQ-2 says is used as it stands, has no `Skill` tool. So under the factory's own template the reviewer never gets the skill FR-3 promises (M3).
    - **AC-11**, the real trial on the owner's F-002. It can't run here and hasn't run anywhere. It needs a factory release and a run on the owner's PC (see "AC-11: what it needs").
  - Blocking: 0. Major: 4. Minor: 13.
  - Every AC that can run here has a passing test on `dced5c3` in my run (602 passed, 0 failed). That includes the three the test engineer's report shows failing (AC-7 via G1-15, AC-13 via G1-28, AC-17 via G1-36).

## My own run (evidence source)

On `dced5c3`, Linux container, Node 22, running as root, no Docker. The working tree was clean before this report.

| Step | Result |
|---|---|
| `cd engine && npm ci --ignore-scripts` | `node_modules` already present from the lockfile; not reinstalled |
| `npx tsc --noEmit` and `npx tsc --noEmit -p test/acceptance` | Both clean, exit 0 |
| `npx vitest run --coverage --coverage.reportsDirectory=/tmp/claude-0/f008-cov` (outside the repo) | **36 files: 34 passed, 2 skipped. 616 tests: 602 passed, 14 skipped, 0 failed.** 366 s. The skipped files are `test/docker-real.test.ts` and `test/acceptance/containers-real.test.ts` (4 + 7 tests), gated on `FACTORY_DOCKER_TESTS=1`. The other three skips are the same as in F-007: RW-4 (accepted residual, F-007 v43), FX-7 (Windows only) and the macOS/Windows parent lookup in `units.test.ts` |
| `npx vitest run stReview --reporter=json` (Security and Testability Review files only, to get per-test ids) | **110 / 110 passed.** `test/acceptance/st-review.test.ts`: 67 of 67 (G1-1 to G1-40, with the `.each` cases and G1-15b). `test/st-review.test.ts`: 37 of 37. `test/st-review-run.test.ts`: 6 of 6 |
| Coverage, whole suite, over `engine/src/**` | Lines 88.22% (4,167 / 4,723), branches 79.66%, statements 84.01%, functions 84.4%. `src/st-review/`: lines 97.93%, branches 86.19%. `agent/reviewer.ts`: lines 96.55%. `engine.ts`: lines 94.54%, branches 81.34% |
| `python3 scripts/check_docs.py`, `scripts/check_placeholders.py` | Pass |

Compared with the test engineer's run on `8f3a566` (614 tests, 595 passed, 5 failed), my run has 2 more tests, G1-15b and one developer test. All 5 earlier failures now pass:
- G1-28 ×3 and G1-36 were fixed in `0618d9f`.
- G1-15 was rewritten to spec v13 in `d04da2f`.

### Is the test engineer's run enough for `dced5c3`?

**Not as a record (M1). As evidence, yes, through my re-run.**

The test engineer's work is independent and sound:
- The plan says the developer's tests and report weren't read.
- The tests drive the whole engine through the channel, with fakes only at the `docker` command line and the SDK seam.
- The assertions check outcomes in git (local and remote), in the log and in what each agent received.
- Each AC group has controls (G1-2, G1-26's exactly-256 KiB file, G1-32).

After their report, though, these commits changed their files or the product under them:
- `0618d9f`: the G1-28 and G1-36 product fixes.
- `4e30661`: endStReview ordering.
- `4777282`: whole-run caps, SR-11 v14.
- `d04da2f`: G1-15 rewritten and G1-15b added for v13; `playAnalyst` gained `assume`.
- `ef8c761`, `623337f`, `ce34d63`, `2649568`: test-side waits for Windows CI.

I read each test edit. None weakens an assertion. G1-20 and G1-7 now wait for the same text instead of reading it after a fixed pause. G1-15 now tests the v13 rule, and G1-15b tests the rejection side. The run report still shows Fail for AC-7, AC-13, AC-17, SR-11 and SR-12, and lists the own-wording case as waiting on the owner. That is out of date.

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `engine.ts` `afterInterview` (one job per feature in `jobs`), the start loop at the end of `startEngine`, `nextStReviewReport`. G1-1, G1-4, G1-5, G1-12 (a returning feature gets the FR-9 check, not a run). `runtime.ts` `prepareWorktree` removes the folder before `git worktree prune`, so a second run starts (G1-36) |
| FR-2 | Met | `reviewer.ts reviewerPolicy` (write rule narrowed to the one path). `sandbox.ts startAgent` (read-only worktree; the report folder is allowed only for a read-only role under `/workspace/.factory/`). `verify` with an empty write allow list, and any extra entry in the report folder is rejected. The agent report goes to `factory/state` (`acceptStReview`). Tests: G1-6, G1-8, G1-9 ×4, G1-28 ×3 |
| FR-3 | **Needs owner** (M3) | AGENT.md from `factory.version` (G1-21). Standards from the master commit and additions from the config repo's `main` (`standards.ts loadStandards`; G1-31, G1-32). Spec path and version, and the transcript as data (`flow.ts reviewerTurn`, `stReview.test.ts` "prompts"). **The `security-review` skill:** `sessionOptions` loads the skills plugin only when the role's tools include `Skill` (`session.ts:182,197`). The Role policy v2.5 reviewer entry (`interface-contracts.md:631-642`) and the onboarding template (`factory-project.yaml:117-128`) don't include it. So no test shows the skill reaching the reviewer, and under the factory's own policy it doesn't. The engine does load it for a project whose policy adds `Skill`, and `REVIEWER_TOOLS` permits that |
| FR-4 | Met | `report.ts validateReport`: envelope, body fields, `needs_owner`, `options`, `recommendation`, `checklist`, `permissions_added`, `abuse_cases`, `not_applicable`. Engine-filled fields come from `agentReport`. G1-3, G1-10, G1-16 |
| FR-5 | Met | `report.ts readReportFile` and `validateReport`. `reviewer.ts runReviewerSessions` gives one correction turn on the same session. G1-10 ×10, G1-11 ×4 |
| FR-6 | Met | `render.ts renderReport`. In `acceptStReview`, the raw strings are scanned first, then the rendering is committed on the branch through `commitWorktree` (which scans again). G1-3, G1-29 |
| FR-7 | Met | `acceptStReview` (`next = READINESS_STAGE` only when there are no findings, after the SR-7 rule). G1-3 |
| FR-8 | Met | `flow.ts analystStReviewTurn` (JSON data block, `interview_ask` with `suggested`). `fileDecisionItem` for `needs_owner` findings, plus `st_review_blocked`. G1-12, G1-16, G1-17 |
| FR-9 | Met | `flow.ts stReviewResolution` follows the v13 rule: the question must be asked after the report, with the finding's requirement as `suggested`. A word-for-word answer, or an approved "Security and Testability Review #n:" assumption, is required, and the SR text must match the approved requirement. The spec on the branch must still pass the interview checks (`branchSpec`). G1-12 to G1-15b, G1-38. Unit tests in `stReview.test.ts` "FR-9" |
| FR-10 | Met | Run book resume for `REVIEWER_ROLE` at start. When a plan fails, `endStReview` writes the agent report, the transcript note and the log. G1-18, G1-19, G1-11 |
| FR-11 | Met | `stReviewLimits`, `OPTIONAL_SECTIONS`, `OPTIONAL_MODEL_ROLES`. `mergeLimits` can only lower a value. G1-6 (Sonnet 5.5, 100 turns), G1-20 ×3, G1-22, G1-40 |
| FR-12 | Met | Stage entries are on the transcript chain, and `engine.status` reads them. G1-1, G1-3 and every `waitStage` |
| FR-13 | Met | `resolveStReview` files the "accept the risk or send it back" item, quoting the finding through `plain()`, and records `st_review_blocked`. A deferred question stays unresolved. G1-37, G1-39, G1-15b |

### Acceptance criteria

| Id | Status | Evidence (all passed in my run on `dced5c3`) |
|---|---|---|
| AC-1 | Met | G1-1, G1-2 (control) |
| AC-2 | Met | G1-4, G1-5 |
| AC-3 | Met (fakes) | G1-6 checks the tools, no factory tools, `--internal` network only, a proxy grant with no host, a read-only worktree, the report folder as the only writable mount, and no credential in the environment. G1-7 ×4 refuses wider policies. Not run on real Docker; F-007 DR-3 covers the same `SessionGroup` network and proxy for the analyst (m4) |
| AC-4 | Met | G1-8 (in-container write hits the read-only mount). G1-9 ×4 (new, changed, deleted file and symlink: rejected, nothing committed, the Security item names the path) |
| AC-5 | Met | G1-10 ×10, G1-11 ×4 |
| AC-6 | Met | G1-3. The agent report is on `factory/state` per FR-2 v12, and the rendering is on the feature branch. AC-6 still says both go on the branch (m1) |
| AC-7 | Met | G1-12, G1-13, G1-14, G1-15 (v13) |
| AC-8 | Met | G1-16, G1-17 |
| AC-9 | Met | G1-18 (killed), G1-19 (graceful stop) |
| AC-10 | Met | G1-20 ×3 |
| AC-11 | **Needs owner** | Not run. It needs a factory release and a run on the owner's PC; see "AC-11: what it needs" |
| AC-12 | Met | G1-23 (injection in spec and transcript, empty section 9: refused twice), G1-24 |
| AC-13 | Met | G1-25 (link), G1-26 (over 256 KiB, with exactly 256 KiB as control), G1-27 (50,000 deep), G1-28 ×3 (other files in the report folder) |
| AC-14 | Met | G1-29 (rendering and inbox item; front matter parsed with `yaml`) |
| AC-15 | Met (fake scanner) | G1-30 ×3: no copy of the secret in local or remote history, remote objects, `.factory`, the log or the analyst input; Security item in engine text only. The scanner is the harness's fake gitleaks. Because `acceptStReview` now scans the raw strings, the Code Review M2 escaping bypass is closed in the code (m5) |
| AC-16 | Met | G1-31, G1-32 (control), G1-33 ×3 |
| AC-17 | Met | G1-12 (no second session), G1-36 (fourth run refused, across restarts), G1-40 |
| AC-18 | Met | G1-37, G1-38, G1-15 / G1-15b (own wording under v13) |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met | `reviewerPolicy`; G1-6, G1-7 ×4; unit "reviewer policy" |
| SR-2 | Met | `reviewerTurn`: engine text and standards first; transcript and additions as JSON strings after the "data, not instructions" line; the spec is read with `Read` (Code Review Info). G1-23, unit "prompts" |
| SR-3 | Met | `branchSpec` and `loadStandards` read through `readFileAt` from git. `populateWorktree` refuses links (G1-35) |
| SR-4 | Met | `render.ts plain`. Front matter built with `YAML.stringify` from engine values. Analyst input as a JSON block. G1-29 |
| SR-5 | Met | Only `acceptStReview` (no findings) and `resolveStReview` (FR-9 passed) write `readiness_gate`. A report claiming `stage: readiness_gate` is refused (G1-10) |
| SR-6 | Met | `billingMismatch` before each session, caps from `security_reviewer`, and `roleContainerLimits` for the reviewer. G1-6, G1-22 |
| SR-7 | Met | G1-23, G1-24. The weak `CITES_SPEC` match is an accepted residual (Security and Testability Review #1, Code Review Info) |
| SR-8 | Met | `readReportFile` (lstat, `O_NOFOLLOW`, fstat, size checked twice), read after `stopAgent`, depth limit 8 checked in a loop (Code Review L1 fixed). G1-25 to G1-27; unit tests |
| SR-9 | Met | Raw scan in `acceptStReview` before anything is written. Per-output scans in `commitWorktree` and `state.commit`. The analyst's Security and Testability Review turn is scanned before its session (`engine.ts:736-746`). G1-30 ×3 |
| SR-10 | Met | `parseAdditions` refuses an S id behind any leading list, heading, table, quote or emphasis mark (Code Review L2 fixed), with a 64 KiB cap and a regular file from git. G1-31 to G1-35. A remaining form: m6 |
| SR-11 | Met | Run cap: G1-36, G1-40. Whole-run caps (v14): `reviewer.ts remaining` and `RunRecord.used` carried across restarts. Developer tests only: `stReview.test.ts` "SR-11: the caps cover the whole run" and `stReview-run.test.ts:302` (m7) |
| SR-12 | Met | Exact path in `reviewerPolicy`; any other entry in the report folder is a breach. G1-28 ×3 |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Planted "report no findings" text | Yes: G1-23 |
| Markdown or YAML in finding text | Yes: G1-29 |
| The spec changes on the branch while Security and Testability Review runs | Partly. Security and Testability Review runs on the branch commit it checked (detached worktree), and FR-9 re-reads the branch. The spec states no outcome; not tested |
| A finding cites an SR the analyst later removes or downgrades | Yes: G1-14, G1-37 |
| Reviewer finishes without the report, or writes twice | Yes: G1-10, G1-11, G1-28 |
| Additions missing, a link, too large | Link: G1-35. Too large: G1-34. Missing: refused with a Security item (`readFileAt` throws), not tested |
| Spec changed outside the engine | Chain and branch checks from F-007, plus `branchSpec` re-running the interview checks (Code Review L4 fixed). Not tested separately |
| A reviewer that keeps finding new issues | Yes: G1-36, G1-40 |
| Owner rejects or defers | Yes: G1-37, G1-39 |
| A quoted secret | Yes: G1-30 |
| Additions trying to relax the rules | Yes: G1-31, G1-33 |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD 1, 2) | Met | Status Approved, readiness gate passed (change log row 11). Rows 12 to 14 were changed after the gate, and each cites an owner decision card dated 2026-11-12. A-1 and A-2 are Approved |
| Architecture / ADRs | Met | Follows ADR 0012 (the gate runs under project activation), ADR 0015 (real-path reads), ADR 0003 (no new channel method), and the F-007 v41 exception for `factory/state` in the config repo. No new ADR conflict |
| Interface contracts | Met | The only contract diff is Agent report v1.3 (H-0096): optional fields only, as approved. The code matches it: `validateReport` accepts the v1.3 fields and the `agent-report/1.0` schema string the contract's envelope still shows. Inbox items use the v1.1 front matter and fixed headings (G1-29). Interview tools are used unchanged. Role policy v2.5 is unchanged, but see M3. Findings: m1 (agent report location), m8 (item options carry no pros and cons) |
| Change-controlled files | Met | Two edits, both with recorded approval. (1) `docs/interface-contracts.md`, H-0096 (spec rows 10 and 11; commit `a384e5d` names H-0096). (2) `engine/config/models.yaml` and `limits.yaml`: the values match H-0095 as approved, with Sonnet 5.5 (row 9). But they were committed inside the 1,266-line code commit `7b24475`, and its message doesn't name H-0095. `decision-management.md` § 3 asks for a separate commit naming the item (m2). Nothing else change-controlled is in the diff; `bb00255` is a merge of main |
| Code quality, readability, maintainability | Met, with findings | The Security and Testability Review modules are small, fail closed, and their errors name fields, never reviewer text. Findings: M2 (`startEngine` size), m9, m10, m11 |
| Comments | Met, with findings | Most say why: `report.ts:55`, `runtime.ts` (why the folder goes before prune), `reviewer.ts:117`, `engine.ts` (why the transcript records the block before the owner is told), `flow.ts:151-152`. Outdated or misplaced: m10 |
| Test tools | Met | The plan's tool table names Vitest 5.1.0 (OQ-9), the milestone 2 fakes at the process and SDK boundaries, `yaml` 2.9.1 (an existing engine dependency) and `@vitest/coverage-v8` 5.1.0. No real-Docker test for F-008, with the reason given. No new component, so no new OK is needed. Coverage is reported (88.22% lines in my run) |
| Documentation | Met, with findings | The documents the spec and DoD need exist: spec, Security and Testability Review, Code Review, dev report, test plan and run report. Out of date: the run report (M1), the dev report header and the engine README (m12). No orchestrator review note yet (m13) |
| Security | Met | Both gate reports are present. Code Review is PASS with conditions, with 0 Critical and 0 High. All seven Code Review findings are fixed in code (`8f3a566`, `4777282`); M1 and L3 also went through owner decisions (v13, v14). Each fix is tested: M1 by G1-15b and the FR-9 units, M2 by G1-30, L1 and L2 by units and G1-33, L3 by the developer tests, L4 by `branchSpec`, L5 by `engine.ts:1350-1358`. Code Review hasn't re-reviewed the fixes (m3) |

## AC-11: what it needs

AC-11 is the real trial: F-002 in the end-to-end trial project, parked at `security_testability_review`, gets a Security and Testability Review report and moves on as AC-6 to AC-8 say. To run it:

1. **A factory release** that the trial project's `factory.version` pins, holding:
   - `engine/config/models.yaml` with `security-reviewer`, and `limits.yaml` with `security_reviewer` and `security_testability_review`. Without them, AC-10's path applies and no session starts.
   - `agents/security-reviewer/AGENT.md`, `skills/security-review/`, and a `docs/security-standards.md` that `parseStandards` can read (S ids, the "Security and Testability Review (requirements) checklist" heading, the Severity table). Today's file parses.
2. **The trial project's manifest:**
   - A `security-reviewer` role within SR-1. The template's role (`Read, Grep, Glob, Write`, write glob `.factory/runs/**/security-reviewer-*.json`) is accepted.
   - Add `Skill` if the owner wants the skill delivered (M3).
   - Optionally `standards.security`.
3. **On the owner's PC:** an engine built from this branch (or its merge), Docker running, and a model credential. F-002's `spec_ready` entry already carries `spec_path` and `spec_version`, since the F-007 tools wrote them. Its committed spec must still pass the current interview checks, or `branchSpec` refuses the gate and the transcript says why.
4. **What to record:**
   - The Security and Testability Review run id.
   - The agent report on `factory/state`, the rendered `docs/features/F-002-security-testability-review.md` on the branch, and any inbox items.
   - The stage that `engine.status` shows afterwards.
   - The engine log.
   - A check that only the report folder was written.
   - Ideally, a reviewer variant of DR-3 (no route but the proxy), which would also close m4.

## Findings

### Blocking

None.

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `docs/features/F-008-test-report.md` | **The run report doesn't describe the final commit (DoD 5 record).** It tested `8f3a566` and reports 5 failures (AC-7, AC-13, AC-17, SR-11, SR-12). It describes the own-wording case as waiting on the owner. Since then: product fixes (`0618d9f`, `4e30661`, `4777282`), the v13 and v14 decisions, and seven test-file edits not made by the test engineer (G1-15 rewritten, G1-15b added, `playAnalyst.assume`, Windows waits). My re-run on `dced5c3` passes all 67 acceptance tests, and I found no weakened assertion. But the factory's record is out of date, and the test engineer hasn't confirmed the edits to their own tests. **To fix:** the test engineer adds an addendum. It should name `dced5c3`, give the counts, move AC-7, AC-13, AC-17, SR-11 and SR-12 to Pass, confirm the G1-15, G1-15b and wait edits, and add a test for v14's whole-run caps (m7). |
| M2 | `engine/src/engine.ts` (1,390 lines; `startEngine` grew by about 400 lines with the Security and Testability Review block, `:854-1177`) | **Maintainability (F-007 M5, still open and larger).** Security and Testability Review is added as more nested closures over the same shared maps (`jobs`, `runArtifacts`, `images`). `runStReview` alone is about 160 lines with three nested callbacks. The pure parts were rightly put in `src/st-review/` and `agent/reviewer.ts`, but the orchestration can only be tested through the whole engine. Split `startEngine` per stage, with a context object, before the next feature adds the readiness gate and inbox reading. |
| M3 | FR-3; `interface-contracts.md:631-642`; `plugins/software-factory/skills/onboard-repo/templates/factory-project.yaml:117-128`; `engine/src/agent/session.ts:182,197` | **Needs owner (Interfaces).** FR-3 says the reviewer gets the `security-review` skill "as the analyst gets its own". The analyst gets its skill because its role lists `Skill`. The reviewer's Role policy v2.5 entry and the template don't list it, and OQ-2 says Role policy v2.5 is used as it stands. So with the factory's own policy the skill never loads, and no test shows it does. The engine itself is right: it can't add a tool the policy lacks. The skill's content is a pointer to `docs/security-standards.md`, which the engine already puts in the reviewer's first turn. Inside the container, `/workspace/docs/security-standards.md` would be the project's file, not the factory's. **Options:** (A) For this increment, accept the standards in the input as delivering what the skill carries, and reword FR-3 (spec change). No code change. (B) Role policy v2.6 adds `Skill` to the reviewer, through a hygiene item for the contract and the template, and AC-11's project adds it too, with a test that the plugin loads. (C) Leave FR-3 as written and require each project to add `Skill`. **I recommend A.** The skill adds nothing the input lacks, and could point the reviewer at the wrong file. Revisit with B when the skill holds Gate-specific guidance. |
| M4 | AC-11 | **Needs owner.** The real trial hasn't run. At Rapid prototype, F-007 accepted owner-PC evidence as reported. Here there is none yet. See "AC-11: what it needs". |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | Spec FR-6, AC-6; `interface-contracts.md` Agent report "Location" | FR-2 (v12, owner) puts the agent report on `factory/state`, which the engine does. FR-6 and AC-6 still say both the report and the rendering go on the feature branch, and the contract's Location line says "committed on the feature branch" (F-007 already deviates under v41). The test plan raised this as gap 1, and it wasn't answered. Reword FR-6 and AC-6 at the next spec change, and carry the location in the increment 4 contract update. |
| m2 | `7b24475` | H-0095's two config files were committed inside the first-cut code commit, whose message doesn't name H-0095. `decision-management.md` § 3 asks for its own commit naming the item. The values match the approval and the yaml comments cite H-0095, so this is only a traceability gap. |
| m3 | Code Review | Code Review reviewed `af464db`. Its fixes (`8f3a566`, `4777282`) and the G1-28 and G1-36 fixes (`0618d9f`) haven't had a second Code Review look. They all tighten, and each has a test. Code Review should confirm them with the next increment. |
| m4 | AC-3 | "No network route other than the proxy" is shown with the fake Docker only. It relies on the same `SessionGroup` as F-007 DR-3. Add a reviewer case to `containers-real.test.ts` or the AC-11 run. |
| m5 | AC-15 | Tested with the harness's fake scanner marker. The real gitleaks 8.30.1 patterns now see raw text, so `ghp_…` and PEM headers should match, but no test runs the real binary on reviewer text. |
| m6 | `src/st-review/standards.ts:59` | The S-id refusal still misses an ordered-list item (`1. S1.1 …`) and a bracketed id (`[S1.1] …`). Effect is small: the reviewer's instruction says additions only add. |
| m7 | SR-11 v14 | Whole-run caps are tested only by the developer (`stReview.test.ts` `remaining`, `stReview-run.test.ts:302`). The test plan predates v14. |
| m8 | `src/state/inbox.ts fileDecisionItem`; `engine.ts:1131-1143` | Inbox item v1.1 asks for Options "with pros and cons per option". FR-8 items carry the reviewer's labels only. `links` is empty, though the rendered report and agent report paths are known. The owner reads the finding without the rendered table to hand. |
| m9 | `engine.ts:1094-1098` | The catch-all in `runStReview` logs "no Security and Testability Review session started" and notes "the run resumes at the next engine start" even when the failure came after the session, for example the rendering commit in `acceptStReview`. The log is misleading, and a run that already filed items will file them again on retry (Code Review Info). |
| m10 | `src/st-review/report.ts:71-73`; `engine.ts:856`; `src/st-review/flow.ts:122-124` | Comments. `readReportFile` says it "returns null when it is missing", but it returns `{ missing: true }`. The "One Security and Testability Review job per feature…" doc sits on `stReviewWords`, not on the job logic. The `stReviewResolution` doc has a stray mid-sentence line break. |
| m11 | `src/st-review/flow.ts:95`, `src/engine.ts:919,1138` and others | Very long lines (900+ characters for the analyst's Security and Testability Review instruction). Build them from named parts, as F-007 m8 noted. |
| m12 | `F-008-dev-report.md` header; `engine/README.md:3-4` | The dev report header still says spec v12 at `8ee8825`; only its last table is current. The README still says "This package is F-007" and doesn't list `src/st-review/` or the reviewer. |
| m13 | `docs/features/` | No `F-008-orchestrator-review.md` (DoD 6). Needed before the PR is marked ready. |

## Counts

- Blocking: 0.
- Major: 4 (M1 to M4). M3 and M4 need the owner.
- Minor: 13 (m1 to m13).
- Lines: **0 Not met**. **2 Needs owner** (FR-3, AC-11).
- My run on `dced5c3`: 36 files (34 passed, 2 skipped), 616 tests (602 passed, 14 skipped, 0 failed). Security and Testability Review files: 110 / 110. Coverage 88.22% lines, 79.66% branches.

## To reach PASS at Rapid prototype

1. **Owner, one card (M3):** how FR-3's skill clause is met. I recommend option A: the standards in the reviewer's input stand in for the skill this increment, and FR-3 is reworded.
2. **Owner (M4):** run AC-11 on the PC as set out above, or decide that the trial follows the merge as F-002's next step. Either way, record the result in the run report.
3. **Test engineer (M1, m7):** a run report addendum on `dced5c3`, confirming the later edits to G1-15, G1-15b and the waits, plus a test for the whole-run caps.
4. Before the PR: the orchestrator review note (m13), and the README and dev report updates (m12).

## After validation

- **M3:** the owner chose option A (decision card, 2026-11-12). Spec v15 rewords FR-3: the Security and Testability Review checklist and standards in the reviewer's first turn stand in for the `security-review` skill. No code change.
- **M1:** the test engineer's addendum for `db1d01d` is in `F-008-test-report.md`: 616 tests, 602 passed, 14 skipped, 0 failed. G1-15b now uses a real alternative wording and checks for the FR-13 risk item itself.
- **M4:** the AC-11 trial on F-002 still waits for a factory release.
