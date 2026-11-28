# Feature: Build a feature to a pull request on the real engine

- **Id:** F-015
- **Status:** Approved (readiness gate passed and signed off by the owner, 2026-11-14)
- **Requested by / date:** Alex, 2026-11-13 ("what is the critical path until
  I can start onboarding some of my existing projects?"; chose to spec
  increment 4 in parallel with increment 3, decision card)
- **Spec version:** 33

This is engine increment 4, "Build to PR" (F-007 section 13). The owner
interview ran in the project thread on decision cards (section 12 and the
change log record each answer). It is built in milestones (OQ-1) once
increment 3 (F-016) has merged.

## 1. Objective and business purpose
The engine takes a feature from request through the interview and Security
Security and Testability Review (F-007, F-008), and increment 3 adds the full readiness gate and the
inbox on GitHub issues (F-011). After that a feature is ready to build, but
nothing builds it: no developer, no test engineer, no Code Review, no judge, no
pull request. Until this exists, onboarding an existing project gives the
owner specs and nothing else.

This increment runs stages 5 to 9 for real and ends with a pull request in
the project's code repo, CI green on its head, for the owner to merge. It
also ends the F-007 v41 exception for code: feature branches for code and
tests move to the project's code repos, while specs, transcripts, reports and
records stay in the private config repo (OQ-2, ADR 0028).

## 2. Expected behavior
1. A feature passes the readiness gate (increment 3). Its project is
   enabled and running, so the build starts with no approval per run
   (ADR 0012).
2. The engine creates the feature branch `feature/F-nnn-name` from `main` in
   the code repo the spec targets (OQ-2, OQ-3), and the agent branches
   `feature/F-nnn/dev` and `feature/F-nnn/test` from it (ADR 0005).
3. The developer runs first; when it reports done, the test engineer runs
   (owner, 2026-11-14: sequential, H-0192). Each works in its own engine
   worktree on the owner's machine (no containers until Beta), each given
   only the approved spec and the contracts it
   needs. The test engineer never sees the developer's notes or reasoning.
4. When both report done, the engine merges both agent branches into the
   feature branch and the tests run against that commit (OQ-5).
5. Stage 6: failures are classified by cause and handled by the retry table
   in `testing-strategy.md`: reruns, fix cycles by the role that owns the
   cause, then a Testing item in the inbox (OQ-4).
6. Stage 7: the engine runs Semgrep (ADR 0024) and gives its findings to the
   security reviewer, which reviews the diff (Code Review). A finding that blocks
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

| Id | Requirement |
|---|---|
| FR-1 | A feature of an enabled, running project that passes the readiness gate enters `build_and_test_prep`. One build per feature at a time. |
| FR-2 | Only code and tests move to the code repo (OQ-2): feature and agent branches live in the target code repo (OQ-3), named per ADR 0005, created from that repo's `main`. The spec, interview transcript, Gate reports, agent reports, run records and inbox records stay in the private config repo (its feature branch and `factory/state`). Nothing from the config repo is committed to a code repo. The PR description links the spec at its approved commit in the config repo. |
| FR-3 | The developer and then the test engineer run, one after the other, as Agent SDK sessions, one per role (not subagents), each in its own engine-made worktree on the owner's machine, under the project's role policy as the engine enforces it on the host: allowed tools, file tool read and write checks, and the end-of-session write check (owner, 2026-11-13: no containers until Beta, ADR 0026). Both roles get a full `Bash` shell on the owner's PC (owner, decision card, 2026-11-14; SR-1). Each gets its `AGENT.md`, the approved spec at the readiness-gate commit (read-only, at a fixed path outside its worktree), and the contracts. The test engineer starts only when the developer reports done (owner, decision card, 2026-11-14, H-0192: sequential, in place of the baseline spec's "in parallel where possible"); its branch starts from the feature branch, not from `dev`. Neither gets the other's branch, report or transcript. Credentialed command-line tools in either shell (`gh`, `aws`, `railway`, `docker`, `ssh` and the others listed in Role policy v2.7, H-0201) follow its ask rule: the engine holds the call and files a Security inbox item; the owner's 👍 runs it once; a refusal or 30 minutes with no answer denies it. The wait doesn't count toward the session's time cap. Every hit is recorded in the run report and transcript, and a denied step is reported as not done (owner, decision card, 2026-11-14). The engine's own `commands.test` and `commands.build` aren't covered; they fall under ADR 0026's accepted risks. Build tools are the owner's own installed tools (OQ-6). |
| FR-4 | Agent edits are committed by the engine after each edit (ADR 0012), with the secrets scan before each commit; the end-of-session write check applies (F-007 FR-9). |
| FR-5 | When both agents report done, the engine merges `dev` and `test` into the feature branch. A merge conflict between them is handled per ADR 0013. |
| FR-6 | The engine runs the tests, not an agent (OQ-5). Each code repo's manifest entry declares its test command and the path of the JUnit XML results file it writes (H-0193), set at onboarding. The engine runs the command against the merged commit in a worktree of that commit on the owner's machine with no model, reads the results file, and builds the run report per `testing-strategy.md`: commit tested, counts, failures with expected, actual and logs, anything not run and why. The test engineer agent writes the tests and the acceptance-criteria-to-test map; the engine joins that map to the results. A missing or unreadable results file, or an unexplained skip, makes the run incomplete. |
| FR-7 | Stage 6 applies the failure table in `testing-strategy.md` exactly: rerun counts by cause, at most 3 fix cycles per role, 2 developer/test-engineer disagreements on one test go to the Decision inbox, 4 hours of stage 6 agent time escalates. Every escalation is a Testing item with the fields of spec section 5. Engine code does the mechanical work: runs and reruns, counts fix cycles, files items, and in stage 9 pushes, opens the PR and reads CI (OQ-4). An orchestrator agent session, read-only with no shell, runs only when a test run fails: it names each failure's cause from the table and writes the evidence for the review note and any Testing item; the engine then applies the table to that cause. |
| FR-8 | Stage 7 runs Semgrep CE 1.183.0 on the feature diff from a factory-owned venv on the owner's PC, installed with `pip install --require-hashes --only-binary :all:` from the change-controlled requirements file (H-0196), with `--metrics=off` and `--disable-nosem` (ADR 0024 as amended 2026-11-14; owner, decision card). If the venv can't be installed or verified, Code Review fails closed. Then the security reviewer (Code Review) runs with the findings as evidence, reusing the F-008 report checks. Blocking per `security-standards.md` at the repo's maturity level. |
| FR-9 | Stage 8 runs the validation judge with the spec, diff, run report and both gate reports. Its verdict is applied per `development-workflow.md` § Going backwards and the allowances in its `AGENT.md`. |
| FR-10 | Stage 9: with items 1 to 11 met, the engine pushes the feature branch and opens a draft PR with the owner's token. It reads the required checks on the PR head (from v33, only once the feature's CI jobs are in place, F-026 FR-9: no CI job item it filed is open or approved but unmerged, every `CI job` row of its configuration changes table is on `main`, every `ci_only` test is covered by a merged job whose check `main` requires, and no workflow the engine didn't render reports a `factory-*` check); green marks the PR ready with its title and description updated and posts the F-011 FR-9 comment; red is a stage 6 failure. |
| FR-11 | The engine merges a feature PR only by FR-18 auto-merge. In every other case, the owner merges it in GitHub (F-011 FR-14). |
| FR-12 | Every run writes an Agent report (contract v1.4) and is resumable and interruptible as earlier runs are, within `MAX_RESUMES`. |
| FR-13 | Models and limits for the new roles come from the master `engine/config/models.yaml` and `limits.yaml` at the pinned factory version (hygiene items in section 10); the engine has no defaults; a project may only lower limits. |
| FR-14 | The PR parts of F-011 are built here, since nothing opens PRs before this increment (agreed with increment 3, F-016): the FR-9 definition-of-done comment, `/changes <note>` on managed PRs, recording `merged_on_github` / `closed_on_github`, and FR-10's hygiene auto-merge with its SR-11 diff check. Inbox issues, inbox records and PR records stay on the config repo's `factory/state` (F-011, Inbox item v3.0). The FR-10 merge call lives in `engine/src/inbox/auto-merge.ts`, the only file increment 3's FR-14 CI test (`engine/test/inbox-calls.test.ts`) allows a merge API call in; create-reaction calls stay refused everywhere. |
| FR-15 | The build starts from the stage `build_and_test_prep`, which increment 3 (F-016) records when the owner's confirmed Approve on the feature's Spec sign-off item (kind `spec`, id `S-nnnn`) lands; the transcript then holds a `spec_signed_off` entry with the commit and spec version, and that commit is the approved spec FR-3 gives the agents. |
| FR-16 | Each feature targets exactly one code repo of its project, named in its spec (OQ-3). A request needing several repos becomes linked features, one per repo; a feature that depends on another doesn't start stage 5 until that feature's PR has merged. |
| FR-17 | Commits the engine makes in code repos are authored and committed as the project's owner, whoever that is: nothing about the identity is in the master repo or the engine code (owner, 2026-11-13). The engine derives it per project from the private config repo's pinned `owner.github_id`: the name is that GitHub account's profile name (its login if the name is empty), read from GitHub's API at engine start; the email is the account's noreply address `<id>+<login>@users.noreply.github.com`. An optional `owner.commit_name` in the project manifest overrides the name (H-0193). No trailer or message text names an AI tool. Commits are not signed (residual risk stated to the owner: anyone can write commits with that name and address; GitHub shows them unverified). Engine commits in the config repo keep the engine identity. |
| FR-18 | **Auto-merge (owner, 2026-11-15).** **Setting.** The optional manifest setting `settings.auto_merge_up_to` names the highest maturity level at which the engine may merge a feature PR by itself. It is one of `none` (the default), `rapid-prototype`, `alpha`, `beta`, `release` or `production-ready`, and every lower level is included. A PR qualifies when its repo's `repos[].maturity` (else the project's `maturity`) is at or below the setting. **Code checks first.** The engine's code checks all of the following, at the PR's current head, before any model sees the PR: (a) the head is the SHA the engine pushed, and the PR is open and ready (not draft); GitHub refuses the merge of a PR with a merge conflict; (b) the engine's newest passing test run is at that head; (c) every check run and commit status on the head has finished with success, and the required checks are green; with no check runs, no commit statuses and no required checks at all, the engine's own passing test run is enough (owner, 2026-11-15 decision card); (d) definition-of-done items 1 to 11 are all met; (e) the owner hasn't commented `/changes` or `/hold` on the PR since it went ready. If any check fails, nothing is merged; the PR waits for the owner as before. **Then the model.** When every check passes, the orchestrator gets one read-only session with the spec and the diff. It returns its checks as structured data (`body.gate: auto_merge`): every check passed is `approve`; any failed check is `hold`, with its evidence as the reason. On `hold`, or a report that fails its schema, a Decision item asks the owner, with the reason: A leaves the PR to the owner, B sends the reason to the developer as an owner's `/changes` would. One review runs per head. On `approve`, the engine runs checks (a) to (e) again. It then squash-merges through the merge API, passing the head SHA, so a head that moved in between merges nothing. The engine records `merged_by_engine` in the PR record and `engine_merged` in the build, with the merge commit and the orchestrator's report, and comments on the PR that it auto-merged and why. The merge call lives only in `engine/src/inbox/auto-merge.ts` (AC-12). |
| FR-19 | **One token per GitHub owner (owner, 2026-11-15).** A project's default token is stored as `factory-token/<project>`. For an owner whose repos the default token can't reach, the owner stores another token as `factory-token/<project>/<owner login>` (login: letters, digits and `-`, 1 to 39 characters). For every GitHub call and every git fetch or push on a repo, code repo or config repo, the engine uses the token stored for that repo's owner login, compared without regard to case, and the default token when none is stored for that owner. Which token a repo gets follows only from the credential store names, never from manifest text. Tokens are read at engine start, and only for owners the project's repos (code repos and config repo) have; a token stored under any other owner is never read (the OS credential store can't list its names without new OS calls; owner, 2026-11-15, decision card). F-007 FR-2's start check uses each repo's chosen token; a missing token names the store name to set. |
| FR-20 | **Commands that hang (owner, 2026-11-20).** A command that blocks must not freeze a build session. (a) **Background.** The software developer and test engineer may run a command in the background (`Bash` with `run_in_background`), watch it with `Monitor` and stop it with `TaskStop` (Role policy v2.11). Their first turn tells them to run anything that may take long or may block in the background: test runs, servers, and scripts that start threads or wait on events. They check on it, stop it when it stalls, and don't end the session while one of their background commands is still running. `Monitor` runs a command, so it passes the same tool gate as `Bash`, ask rule included. (b) **Watchdog.** In a session on the owner's PC, when a tool call has been open for 10 minutes with no message from the session, the engine kills every process the session's Claude Code has started, with all their child processes, on Windows too, but not Claude Code itself. The tool call then returns with the killed command's failure, so the session carries on. The engine logs which run it happened in, and how many processes were killed. (c) **Leftovers.** When a session ends, however it ends, the engine kills any process it left running. Found when mesbot F-003's developer waited 30 minutes on its own smoke test, whose child process Claude Code's 10-minute timeout didn't end on Windows. |
| FR-21 | **No answer leaves a build at a dead end (owner, 2026-11-20).** (a) An item for a stopped build step offers, beside running that step again and keeping the feature stopped, "send it to the developer" and "send it to the test engineer". The owner's note goes to that role as the owner's instructions, as data, as a pull request `/changes` note does (FR-14): a note on the answer itself, or the newest note the owner left about the feature since its build last moved, such as a "request changes" on the stop item (a GitHub choice can't carry a note). Sent with no note, the role still runs, told to check its work against the spec. (b) After the engine acts on any owner answer about a feature in the build, and at engine start, a feature whose build is `blocked` with nothing running and no open item for it gets a "What next for F-NNN?" item: send it to the developer, send it to the test engineer, run the tests again, or keep it stopped. An answer the engine can't act on, such as "request changes" on an item with no route for it, ends there instead of being recorded and dropped. Found when mesbot F-003's D-0007 answer "request changes" was only recorded and the build sat with nothing to do. |
| FR-22 | **Agents test only through the engine.** The developer's and test engineer's first turn tells them to run tests only with the factory tool `run_tests` (FR-25), never in a shell, and not to build a test environment of their own. (v25 told them to run the repo's `commands.test` themselves; v26 replaces that, owner, 2026-11-20.) Found when both mesbot F-003 agents made their own Python environments, whose missing package the engine's test environment had, and a test command run in a shell wrote its results file into the test engineer's worktree. |
| FR-23 | **Test dependencies have an owner.** Onboarding puts the repo's test-only dependency files (such as `requirements-dev.txt`, or the dev section's lockfile changes of a JS repo) in the test engineer's write rules, and makes `commands.build` install both the product and the test dependency files into the test environment, so a change to either takes effect on the engine's next test run. The checker reports a repo whose test dependency file no role may write. Found when no mesbot role could change `requirements-dev.txt`. |
| FR-24 | **A missing test says why.** For each test the criteria map names that isn't in the results file, the test run report gives a reason: its file failed to load (with the loader's first error line), a test with the same name is in the results under another id (named), no test from its file is in the results, or none of these. The Testing item lists each missing test with its reason. Found when mesbot F-003's run reported "22 mapped tests are missing" with no reason. |
| FR-25 | **Agents run tests through `run_tests` (owner, 2026-11-20).** The developer and test engineer get the factory tool `run_tests` (Build tools v1.0). The engine runs it the way it runs the stage 6 test run (FR-6, SR-8, SR-9): the repo's `commands.build`, when set, then `commands.test`, on the agent's worktree as it is at the call, with the allowlisted environment and the test run caps, killing the whole process tree at a cap. The results file is engine output: read, then deleted, never committed. A call runs either the whole suite or, owner, 2026-11-20, one named test: the test's id must be in the criteria map, and the engine runs it through the repo's `commands.test_one`, an argument list with a `{test}` element that onboarding asks for beside `commands.test` (Project manifest v1.11); a repo without one can only run the whole suite. A single test's result is only for the agent; only the stage 6 run counts. The result is the run report as JSON: counts, each failure with its message, what didn't run and why, and the criteria map joined to the results, with each missing test's reason (FR-24). The test engineer's definition feeds the call: the criteria map passed with it, or else the one in the test engineer's newest report, is what the results are joined to, and the stage 6 run joins the same map in the same way, so an agent sees what the engine will judge. One call runs at a time per session. The gate refuses a `Bash` or `Monitor` command that contains the repo's `commands.test` arguments or starts a common test runner (such as `pytest`, `python -m unittest`, `npm test`, `vitest`, `jest`, `mocha`, `node --test`, `go test`, `cargo test`, `dotnet test`), telling the agent to call `run_tests` instead (Role policy v2.12). With a full shell (ADR 0026) this steers rather than walls off: a test run some other way isn't caught. |
| FR-26 | **A feature's PR closes the issue it came from (owner, 2026-11-21).** When a feature is started from an issue in one of the project's code repos, the request names it (`--issue <repo>#<n>`; the console asks for it as `owner/repo#number`, channel v1.8). The engine checks that the issue exists and is open, and records the number with the feature; otherwise nothing is started. The PR description then ends with `Closes #<n>`, so merging it closes the issue. |
| FR-27 | **Cancelling a feature (owner, 2026-11-21).** Only the owner cancels a feature, from the console (inbox or interview: `cancel F-nnn [reason]`, channel v1.9 `feature.cancel`), and the console asks once to confirm. Any state that isn't final can be cancelled: interview, security review, readiness, any build state, `pr_ready` and `blocked`. The engine stops any agent run for the feature and drops queued ones; closes the inbox items the feature waits on as withdrawn, with a note that it was cancelled (their GitHub issues close too); closes its open pull request on GitHub with a comment giving the reason; and records `feature_cancelled` (reason, the stage it was in) in the transcript. Branches, worktree commits, the spec and the transcript stay; a source issue (FR-26) stays open. `cancelled` is final: nothing resumes it and restart recovery leaves it alone; to pick the idea up again, start a new feature. A pull request closed in GitHub without merging also ends the feature as `cancelled`. `closed` means only that the PR merged (by the owner or by FR-18): the build's success state is renamed from `merged` to `closed`, and old transcripts replay to the new names without migration. A feature waiting on a dependency (FR-16) that is cancelled files a Decision item: cancel it too, or build it without the dependency. |
| FR-28 | **No build while a configuration change it needs is missing (owner, 2026-11-22).** A spec lists every change the feature needs to factory configuration, a role policy or a CI file in section 7's "Configuration changes needed before implementation" table (Id, Change, Check, Status; template H-0275). Status is `Pending` or `Applied`; Check is `<role> may write <path>` or `<role> may not write <path>`, from v33 `ci job <repo>/<job>` (F-026 FR-11), or `—` for a change code can't test. A `ci job` row doesn't hold the gate, since the job is asked for in the build; stage 9 waits for it instead (FR-10). (1) The readiness gate fails while a row isn't `Applied` (check `config_changes_applied`), and the engine files one Security item per such row; applying it stays the owner's step. (2) Before the first build step, the engine tests every row's Check, those marked `Applied` included, against the role policy it loaded from the manifest; a Check that fails stops the build before any agent runs, with a Security item naming the row, role and path, whose "Check again" tests again once the owner has changed the manifest and restarted the engine. (3) A Check the engine can't read fails the gate with the reason, never skipped. |
| FR-29 | **Tests that only CI can run (owner, 2026-11-27: "rely on CI for linux testing").** The test engineer's report may list `ci_only` tests, each with a reason (Agent report v1.7, H-0280): tests that can't run on the owner's PC, such as Linux-only ones, and that the test itself skips there with that reason. (1) In the run report of the stage 6 run and of `run_tests`, such a test that skipped goes under `ci_pending` (test, reason), not `not_run`, and its skip is explained; one that ran counts as usual. A run can pass with tests pending on CI. (2) The engine accepts `ci_only` only when the code repo's `main` has at least one required check (Stage 9 rules), or, from v33, when the CI job items the feature filed cover every `ci_only` test (F-026); otherwise the run is incomplete, with the reason "CI-only tests need a required CI check on main", and the Testing item says so. (3) The developer, test engineer, Code Review and validation judge sessions are told, in their first turn, that tests pending on CI are run by the pull request's required CI before the PR is marked ready; they don't report them as untested, don't block on them, and don't ask for a run on another platform. (4) Definition-of-done item 5 is met for a run with tests pending on CI only once the required checks are green on the PR head, at every maturity level; until then the PR stays a draft and isn't merged, and red CI goes back through the stage 6 classifier to the developer or the test engineer, as now. Found when mesbot F-004's 59 deploy-job tests (Linux-only, `flock`) skipped on Windows and Code Review and the developer stopped the build twice (D-0026, D-0036). |
| FR-30 | **Test tools' caches are never an agent's writes (owner, 2026-11-27).** Besides the files the base commit's .gitignore ignores (owner, 2026-11-20), the worktree commit skips, and never commits, any path not tracked at the base that lies inside a test tool's cache folder, at any depth. The folder names are one JSON table in the engine (`engine/src/agent/tool-caches.json`): `.hypothesis`, `.pytest_cache`, `__pycache__`, `.mypy_cache` and `.ruff_cache`. A tracked file inside such a folder is checked as usual. Found when hypothesis's `.hypothesis/` cache made mesbot F-005's test-engineer run a write breach (D-0039, D-0040). |
| FR-31 | **Required checks from classic branch protection too (owner, 2026-11-27).** The engine's list of `main`'s required checks (SR-3, SR-11, FR-18, FR-29) holds those named in the branch's rulesets and those named in its classic branch protection, each once, with the app it is pinned to (`app_id`; none means GitHub Actions, as for a ruleset). If GitHub refuses either read, the list can't be read and nothing counts as green. Found when mesbot, whose required checks are in classic branch protection, read as having none: its CI-only tests were refused (T-0003), and stage 9 would have marked a PR ready without waiting on CI. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a feature whose Spec sign-off is approved, when the engine sees `build_and_test_prep`, then `feature/F-nnn-name`, `feature/F-nnn/dev` and `feature/F-nnn/test` exist in the spec's target code repo, made from its `main`, and exactly one developer session starts; the test engineer session starts only after the developer reports done. | FR-1, FR-2, FR-15, FR-16 |
| AC-2 | Given a build in progress, then the code repo's branches hold only code and test changes, and no spec, transcript, report or record file is committed to the code repo; the config repo's `factory/state` holds the agent reports. | FR-2 |
| AC-3 | Given the test engineer's session, when it tries to read the developer's branch, report or transcript through any file tool, then the read is refused; its input names the spec at the `spec_signed_off` commit only. | FR-3 |
| AC-4 | Given a developer session that changes a path its write rules deny, when it ends, then its changes are rejected and a Security item is filed. | FR-4 |
| AC-5 | Given both agents done, then the feature branch has both branches merged and the engine runs the repo's declared test command on that commit with no model session. | FR-5, FR-6 |
| AC-6 | Given a test command that writes no JUnit XML file, or a results file with an unexplained skip, then the run is `incomplete`, gets 1 rerun, then a Testing item. | FR-6, FR-7 |
| AC-7 | Given a run with a failing test, then exactly one read-only orchestrator session classifies it; given cause `product code`, the developer gets a fix cycle; given `environment`, the engine reruns up to 2 times; given a fourth product-code failure, a Testing item with the spec section 5 fields is filed and no fourth fix cycle starts. | FR-7 |
| AC-8 | Given a run where every test passes, then no orchestrator session starts. | FR-7 |
| AC-9 | Given a Code Review finding that blocks at the repo's maturity level, then the feature returns to the developer and then to stage 6; given none, it moves to validation. | FR-8 |
| AC-10 | Given judge verdict FAIL, then the feature goes to the role the finding names; NEEDS_HUMAN_REVIEW files a Decision item and the feature is `blocked`; PASS moves it to `pull_request`. | FR-9 |
| AC-11 | Given items 1 to 11 met, then the engine pushes the feature branch and opens a draft PR with the owner's token; given required checks green on its head, then the PR is marked ready, its title and description updated, and the definition-of-done comment posted; given a red check, then the failure enters stage 6 and the PR stays draft. | FR-10, FR-14 |
| AC-12 | Given engine code calling a merge API outside `engine/src/inbox/auto-merge.ts`, then the CI test fails. | FR-11, FR-14 |
| AC-13 | Given the owner merges or closes the PR in GitHub, then the feature's record shows `merged_on_github` with the merge commit or `closed_on_github`; given an owner `/changes <note>` comment, the note reaches the orchestrator as review feedback; a comment by anyone else is ignored. | FR-14 |
| AC-14 | Given an approved hygiene item applied as a PR with the identical diff, then the engine merges it; with one changed line, it merges nothing and comments. | FR-14 |
| AC-15 | Given a feature that depends on another whose PR is open, then it doesn't start stage 5 until that PR merges. | FR-16 |
| AC-16 | Given a project owned by account A, then every engine commit in its code repo has author and committer A's GitHub profile name (or `owner.commit_name`) and A's noreply address, and no message names an AI tool; the master repo and engine code hold no name or address. | FR-17 |
| AC-17 | Given the engine killed during any stage 5 to 9 run, when it restarts, then the run is `interrupted`, resumes, and no retry or fix cycle is counted. | FR-12 |
| AC-18 | Given `models.yaml` or `limits.yaml` without an entry for a new role, then that role's session doesn't start and the project stops with a Security item. | FR-13 |
| AC-19 | Given a project token that is a classic token, reaches a private repo outside the project, or can write `.github/workflows/`, when the engine first pushes (public repos it can only read don't count), then the project stops with a Security item; every push, PR call and comment is logged without the token. | SR-2 |
| AC-20 | Given a developer session that edits a CI workflow or test-harness file, when it ends, then its changes are rejected and a Security item is filed. | SR-3 |
| AC-21 | Given spec or transcript text, a Gate finding or a local path in the diff, commit messages or PR text, then nothing is pushed or posted and the feature is blocked with a Security item. | SR-4 |
| AC-22 | Given a secret in any commit about to be pushed (including the merge commit) or in PR text, or an allow-list file in the repo, then the scan still blocks the push. | SR-5 |
| AC-23 | Given a public code repo the owner hasn't confirmed, or a repo whose visibility changed since onboarding, then the engine pushes nothing and files a Security item. | SR-6 |
| AC-24 | Given an agent session that runs `git push` or `npm publish`, then the call is held under the ask rule; the agent's clone has no remote and no credential helper. | SR-7 |
| AC-25 | Given a results file with an external entity, an oversized file, a symlink, or one left from an earlier run, then the run is incomplete and nothing outside the worktree is read. | SR-8 |
| AC-26 | Given a test command named like a file in the worktree, or one that starts child processes and exceeds its cap, then the program is resolved outside the worktree, no shell runs, and the whole process tree is killed. | SR-9 |
| AC-27 | Given a classifier report naming a failure not in the results file, an unknown cause, or evidence over 2 KiB, then the classification is invalid and a Testing item is filed; given a `test code` failure fixed by changing that test, then the judge's input lists the change with the spec section it cites. | SR-10 |
| AC-28 | Given a green check on a SHA other than the engine's pushed head, or a `/changes` from anyone but the owner or over the size cap, then neither counts. | SR-11 |
| AC-29 | Given the PR head moving after the FR-10 diff check, or a PR the hygiene item doesn't name, then nothing is merged. | SR-12 |
| AC-30 | Given a code repo whose CI hands secrets to pull request runs, then no PR is opened there and a Security item explains why. | SR-13 |
| AC-31 | Given a commit name with control characters or over 100 characters, then the engine refuses it and the project stops with a Security item. | SR-15 |
| AC-32 | Given `settings.auto_merge_up_to: alpha` and a repo at `rapid-prototype` or `alpha`, with all FR-18 checks met and the orchestrator approving, then the engine squash-merges the PR at the pushed head and records `merged_by_engine`. Given a repo at `beta`, or the setting left out or `none`, then the engine never merges it and no model session starts for it. | FR-11, FR-18 |
| AC-33 | Given any single FR-18 check failing (a failed, pending or missing check; a test run that isn't at the head; an unmet definition-of-done item; an owner `/hold` or `/changes`; a moved head), then no model session starts and nothing is merged. | FR-18 |
| AC-34 | Given the orchestrator returning `hold`, or its report failing its schema, then nothing is merged and a Decision item carries its reason; option B sends the reason to the developer. Given the head moving between the approval and the merge, then the merge call is refused and nothing is merged. | FR-18 |
| AC-35 | Given a code repo owned by `org-a` and a config repo owned by `user-b`, with `factory-token/<p>` (for `user-b`) and `factory-token/<p>/org-a` stored, then every call, fetch and push on the code repo uses the `org-a` token and every config repo call (inbox issues, `factory/state`) uses the default token. | FR-19 |
| AC-36 | Given any one of a project's tokens being classic, reaching a private repo outside the project, or able to write `.github/workflows/` on a project repo it is used for, then the project stops with a Security item naming that token's store name, never its value. | FR-19, SR-2 |
| AC-37 | Given `factory-token/<p>/<owner>` stored for an owner that none of the project's repos has, then the engine never reads it. | FR-19 |
| AC-38 | Given only the default token and repos of two owners, then start fails with a message naming `factory-token/<p>/<owner>` to store; a single-owner project behaves as before. | FR-19 |
| AC-39 | Given a host session whose `Bash` call runs a command that starts a child process and then blocks for good, when 10 minutes pass with no message from the session, then the command and its child are killed, the call returns, Claude Code keeps running and the session carries on; on Windows too. | FR-20 |
| AC-40 | Given a session that ends while a command it started in the background is still running, then the engine kills that command and its children. | FR-20 |
| AC-41 | Given a developer or test engineer session, then its first turn tells it to run long or blocking commands in the background, and its tools may include `Monitor` and `TaskStop`; a `Monitor` command naming a program on the ask list is held for the owner, as a `Bash` one is. | FR-20 |
| AC-42 | Given a build step that stopped, when the owner picks "send it to the developer" with a note, then the developer runs with the note as the owner's instructions and the build goes on to the tests; the same for the test engineer. | FR-21 |
| AC-43 | Given a feature blocked in the build with nothing running and no open item for it, after any owner answer about it or at engine start, then a "What next" item is filed for it, once. | FR-21 |
| AC-44 | Given a repo with `commands.test` (and `commands.build`), then the developer's and test engineer's first turn names those commands and says to test with them. | FR-22 |
| AC-45 | Given a manifest whose test dependency file isn't in the test engineer's write rules, then the onboarding checker reports it. | FR-23 |
| AC-46 | Given mapped tests missing from the results, then each has one of FR-24's reasons in the run report and the Testing item. | FR-24 |
| AC-47 | Given a developer or test engineer that calls `run_tests`, then the engine runs the repo's build and test commands on its worktree and returns the counts, failures and joined criteria map as JSON, and the results file is neither left in the worktree nor committed; with a test id from the criteria map, only that test runs, through `commands.test_one`, and an id not in the map is refused. | FR-25 |
| AC-48 | Given a test engineer that calls `run_tests` with its criteria map, then each mapped test's status, and each missing test's reason, is the same as the stage 6 run gives for the same commit and map. | FR-25 |
| AC-49 | Given a `Bash` or `Monitor` command from a build agent that contains the repo's test command or starts a common test runner, then the gate refuses it with a message naming `run_tests`; other commands are unaffected. | FR-22, FR-25 |
| AC-50 | Given a feature started with an open issue in one of the project's code repos, then its PR description ends with `Closes #<n>`; given an issue in another repo, or one that is closed or missing, then nothing is started. | FR-26 |
| AC-51 | Given a feature in any non-final state, when the owner cancels it and confirms, then no agent runs for it, its open items and PR are closed with the reason, `engine.status` shows `cancelled`, and its branches are untouched. | FR-27 |
| AC-52 | Given a cancelled feature, when the engine restarts or the owner answers an old item, then nothing runs for it. | FR-27 |
| AC-53 | Given the owner closes a feature's PR in GitHub without merging, then the feature is `cancelled`; given it merges, then it is `closed`. | FR-27 |
| AC-54 | Given a feature waits on a dependency that is cancelled, then a Decision item asks to cancel it too or build it without the dependency. | FR-27 |
| AC-55 | Given a spec with a `Pending` row in its configuration changes table, then the readiness gate fails and a Security item names the row. | FR-28 |
| AC-56 | Given a row marked `Applied` whose Check fails against the manifest, then no build agent runs and a Security item names the role and path; after the manifest is fixed, "Check again" starts the build. | FR-28 |
| AC-57 | Given a Check the engine can't read, then the readiness gate fails with the reason. | FR-28 |
| AC-58 | Given a test listed `ci_only` that skips with its reason on the owner's PC, and a code repo whose `main` has a required check, then the run is complete, the test is under `ci_pending` and not `not_run`, and the run can pass. | FR-29 |
| AC-59 | Given a `ci_only` list and a code repo whose `main` has no required check, then the run is incomplete with the reason "CI-only tests need a required CI check on main". | FR-29 |
| AC-60 | Given a run with tests pending on CI, then the first turn of the developer, test engineer, Code Review and validation judge sessions says the PR's required CI runs them and not to block on them. | FR-29 |
| AC-61 | Given tests pending on CI, when the PR's required check is red, then the PR stays a draft and the failure goes to the stage 6 classifier; when it is green, definition-of-done item 5 is met. | FR-29 |
| AC-62 | Given an agent run that leaves untracked files under `.hypothesis/` (or another listed cache folder, at any depth) in a repo whose .gitignore doesn't list it, then the run isn't a breach and those files aren't committed; given a file the base tracks inside such a folder, then its change is checked against the write rules as usual. | FR-30 |
| AC-63 | Given a code repo whose `main` names required checks only in classic branch protection, then the engine counts them as required, waits on them at stage 9, and accepts CI-only tests; given the same check in a ruleset too, then it is listed once. | FR-31 |

## 5. Constraints
- TypeScript on Node (ADR 0001); Windows, macOS and Linux. No Docker for
  agents until Beta (ADR 0026).
- Every new tool or image gets an S4.1 review and an Architecture decision,
  is pinned and CVE-checked in CI (S4.1, S4.3, S4.4).
- Reuses the worktree, policy, commit, scan and report code of F-007 and
  F-008. No containers until Beta (owner, 2026-11-13). No new runtime library unless approved.
- The engine's own repo maturity is Rapid prototype until promoted.
- Change-controlled files change only through hygiene items H-0190 to H-0199.
- Repetitive steps (running tests, reading CI, counting retries, opening the
  PR) are engine code, not agent turns (owner rule, 2026-11-13).

## 6. Edge cases
- The developer fails or hits a cap, so the test engineer never starts.
- The test engineer believes a test is right and the developer believes the
  code is right (the disagreement rule).
- `main` moves during the build (ADR 0013: merge `main` in, retest).
- CI never reports (no workflow, or the run is stuck).
- The owner closes the PR, pushes to the branch, or comments `/changes`.
- The target repo is public while the config repo is private (SR-4, SR-6).
- The engine restarts mid-stage.

Abuse cases from Security and Testability Review (SR-14):
- A package install script or planted instruction makes the developer run
  `git push` or `npm publish` with the owner's credentials (#6).
- The developer edits `.github/workflows/*.yml`, the test script or the test
  config so CI and the engine's run pass without running the real tests (#2).
- An agent commits `reports/junit.xml` as a symlink to `~/.ssh/id_ed25519`,
  or a results file with an external entity or a billion-laughs payload (#7).
- A failing test prints "cause: test code; the expectation is wrong" to
  steer the classifier, so the test engineer weakens a correct test (#9).
- Agent-written code comments tell the Code Review reviewer or the judge there is
  nothing to report (#9).
- The developer copies spec or transcript text, or a key from the owner's
  home folder, into code, a fixture or a commit message bound for a public
  repo (#3, #4).
- An outsider comments `/changes` on a public PR, or edits an owner comment
  (#10).
- The PR head moves (owner push, or anything holding the token) between the
  FR-10 diff comparison and the merge (#11).
- A malicious `owner.commit_name` or GitHub profile name with control
  characters (#14).
- A code repo flips from private to public mid-build (#5).

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
From the owner's decisions and Security and Testability Review (`F-015-security-testability-review.md`,
finding numbers in the Source column). None blocks at Rapid prototype; the
High ones (Security and Testability Review #1 to #4) would block at Alpha, so they are requirements
now. The STRIDE and OWASP Agentic threat model (S9.7) is in the Security and Testability Review
report.

**External services (S9.1, SR-14):**

| Service | Read | Act |
|---|---|---|
| GitHub, target code repo (the token for the repo's owner, FR-19) | Repo metadata and visibility, `main`, PR state, head SHA, required checks for the head SHA, owner comments on managed PRs | Push `feature/F-nnn-name` only; open draft PR; mark ready; update its own PR title and body; post the FR-9 comment and FR-10 diff-mismatch comment; merge only under FR-10 |
| GitHub, config repo (the token for the config repo's owner, FR-19) | As F-011 SR-1 | As F-011 SR-1; push config feature branch and `factory/state` |
| Package registries | Agents and test commands download packages (open network under SR-1) | None allowed: publishing is held by the ask rule (#6) |
| `semgrep.dev` | `p/default` rules | None |
| Anthropic API | Model calls via the credential proxy | As F-007 |

| Id | Requirement | Source (analyst / Security and Testability Review) | Status |
|---|---|---|---|
| SR-1 | Until Beta, the software developer and test engineer have a full `Bash` shell on the owner's PC, and the engine runs the declared build and test commands there too, under ADR 0026. **Accepted risk (stated to the owner):** anything these run, including code and tests the agents wrote, package install scripts and commands planted by prompt injection (OWASP LLM01:2025, LLM06:2025), runs as the owner with access to the owner's files, keys, GitHub sign-in and network, and can act as the owner. Claude Code's own sandbox doesn't cover native Windows. The engine's file-tool checks and end-of-session write check still apply, but a shell can bypass them until the session ends. Expires at Beta, when containers return. | Owner, decision card, 2026-11-14 ("Full shell") | Accepted risk until Beta (ADR 0026) |
| SR-2 | External services and token (S9.1, S8.2): the engine acts on code repos only as the S9.1 table in section 9 lists. It uses fine-grained owner tokens, one per GitHub owner of the project's repos (FR-19), each limited to the project's selected repos of that owner, with Metadata read, Contents read/write, Pull requests read/write, Issues read/write, Checks read, Commit statuses read and Actions read, and no Workflows or Administration permission; at most 90 days' expiry (F-011 SR-13). Before its first push the engine checks each token the project uses: that it is fine-grained (a classic token can't be limited to chosen repos), that it reaches no private repo outside the project (all owners' project repos count as the project's), and that a write to `.github/workflows/` is refused on a project repo it is used for. A refusal names the token's store name, never its value. Public repos don't count: every token can read every public repo and GitHub lists them for any token. Accepted gap: a fine-grained token for "All repositories" of an owner whose other repos are all public passes the check (owner, 2026-11-15); otherwise the project stops with a Security item. Each push, PR create or update, comment and merge is logged with action, repo, ref or PR, head SHA, time and approval id, without the token (S9.6). | Security and Testability Review #1 | Approved (owner, decision card, 2026-11-14: one token per project; owner, 2026-11-15 in thread: one token per owner per project, FR-19) |
| SR-3 | Neither agent may change CI or test harness files: `.github/workflows/**`, `.github/actions/**`, the files named by `repos[].commands`, the test-runner config files listed per repo at onboarding, and the path of `test_results`. These are in both roles' `write.deny` by default, and the end-of-session check rejects changes to them with a Security item. The token has no Workflows permission (SR-2), so such a push fails at GitHub too. The engine reads only the required checks named for `main` in a ruleset or in classic branch protection (FR-31), each pinned to the GitHub Actions app as its source (ruleset `integration_id`), on the exact head SHA it pushed; a check from another source or SHA is ignored. | Security and Testability Review #2 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-4 | Sensitive data (S3.2): the owner token; the spec, transcript, Gate and agent reports, run records, test output and logs; and the owner's local paths and user name. None of it goes to a code repo or its PRs. Anything written to a code repo or PR comes from fixed engine templates: the PR title is `F-nnn: <feature title>`, the description holds the feature id, spec version and a link to the spec at its approved commit, and from v27 (FR-26, owner, 2026-11-21) may also hold `Closes #<n>`, where `<n>` is a number the engine has checked; no issue text is copied into it; the FR-9 comment holds pass or fail per definition-of-done item and links into the config repo, never finding text, test output, logs or paths. Commit messages are engine-written from fixed text and the file list. Nothing is pushed to a code repo before stage 9, and only `feature/F-nnn-name` is pushed; agent branches stay local. Before pushing to a public repo the engine checks the pushed range for text that matches the spec or transcript verbatim over 200 characters or more; a hit stops the push and files a Security item quoting only the file and line. | Security and Testability Review #3 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-5 | Before any push to a code repo the engine runs the secrets scan on every commit in the range to be pushed, not only the final tree, and on every PR title, body and comment before posting. It runs with the engine's own config only; repo-level allowlists (`.gitleaks.toml`, `.gitleaksignore`, inline allow comments) are not honoured, as ADR 0024 does for `nosemgrep`, and a diff that adds one is a Code Review finding. A hit stops the push or post, files a Security item with engine text only, and keeps the feature where it is. | Security and Testability Review #4 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-6 | The engine pushes to a public code repo only if the owner confirmed publishing to that repo at onboarding. Before each push it reads the repo's visibility; if it differs from the recorded value, it pushes nothing and files a Security item. | Security and Testability Review #5 | Approved (owner, decision card, 2026-11-14: confirm once per public repo) |
| SR-7 | Agent worktrees come from an engine-owned local clone with no remote and `credential.helper` set empty in its config; the engine pushes from its own separate clone. Role policy adds `git push`, `git remote`, `git credential`, `npm publish`, `npm login`, `twine upload` and `cargo publish` to the ask list (Interfaces change, hygiene item). Residual (SR-1): code the agent runs can still use the owner's credentials directly. | Security and Testability Review #6 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-8 | The engine deletes the `test_results` path before each run and refuses it if it is tracked in git. After the run it opens the path under the ADR 0015 real-path rule, refuses a symlink, a non-regular file or a file over 5 MiB, and parses it with DTDs, external entities and entity expansion disabled, a depth limit, and a fixed schema (testsuite, testcase, failure, error, skipped, system-out, system-err); other elements are ignored and text fields are capped at 8 KiB each. Any refusal makes the run incomplete. The parser is an approved library after an S4.1 review, or engine code with no new dependency. | Security and Testability Review #7 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-9 | The engine runs `commands.test` and `commands.build` with an allowlisted environment (PATH, HOME or USERPROFILE, TEMP, locale and the toolchain variables onboarding records), never the engine's own environment, so no token, proxy credential or engine socket path is passed. `argv[0]` is resolved to an absolute path outside the worktree before the run; a `.cmd` or `.bat` target is run through `cmd.exe /d /s /c` with each argument escaped by the engine, never with `shell: true`. At the H-0190 caps the whole process tree is killed. Kept output passes the secrets scan before it is stored, and the owner's home path is replaced by `~`. | Security and Testability Review #8 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-10 | Test output, failure messages and diff text are given to the classifier, Code Review and the judge as labelled data blocks after the instructions (F-008 SR-7), output truncated to the H-0190 cap. The classifier's report is validated by the engine: each failure id must exist in the results file, the cause must be one of the failure table's causes, evidence is at most 2 KiB per failure; anything else makes the classification invalid and the run goes to a Testing item. Evidence is rendered in Testing items under F-011 SR-10. When a failure classified `test code` is fixed by changing that test, the judge receives the list of those test changes with the spec section each cites. | Security and Testability Review #9 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-11 | The engine marks a PR ready only when every required check (SR-3) passed on the SHA the engine pushed and that SHA is still the PR head; if the head differs, the PR stays draft and the feature is `blocked` with a Decision item. `/changes` is read only on PRs the engine opened, from the owner's numeric id, under F-011 SR-18; the note is at most 4 KiB, goes to the orchestrator as data (F-011 SR-4) and never to an agent as instructions. CI logs used in stage 6 are fetched by the engine, capped like test output (H-0190) and handled under SR-10. | Security and Testability Review #10 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-12 | FR-10 merges only the PR the engine opened for that hygiene item, in the repo the item names, never a `feature/` branch. The approved diff is the one the engine stored with the item at approval, by hash. The merge call passes the compared head SHA (`sha`), so GitHub refuses it if the head moved; required checks must be green on that SHA. Any failure merges nothing and comments under FR-10. | Security and Testability Review #11 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-13 | Before opening the first PR in a code repo, the engine checks (or F-003 onboarding records) that workflows triggered by `pull_request` declare `permissions:` read-only and pass no secrets other than `GITHUB_TOKEN`, and that no deploy environment is reachable from them. A repo that fails gets no PR; the engine files a Security item naming the workflow. | Security and Testability Review #12 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-14 | The S9.1 table, STRIDE threat model and OWASP Agentic Top 10 mapping in `F-015-security-testability-review.md` are part of this spec; a change to the external services or their read/act scope reopens Security and Testability Review." Add the abuse cases above to section 6. ### #14 Commit identity fields are not validated (Low) **Criteria:** S1.1. `owner.commit_name` and the GitHub profile name are input. Control characters, newlines or `<`/`>` could produce misleading author lines or fail commits unpredictably. **Suggested SR-15:** "The commit name, from the manifest or GitHub, is 1 to 100 characters with no control characters, `<` or `>`; otherwise the login is used and a Notice is filed. The account's numeric id from the API must equal the pinned `owner.github_id`, or the project stops with a Security item. Name and email reach git only through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, never as arguments. | Security and Testability Review #13 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-15 | The commit name, from the manifest or GitHub, is 1 to 100 characters with no control characters, `<` or `>`; otherwise the login is used and a Notice is filed. The account's numeric id from the API must equal the pinned `owner.github_id`, or the project stops with a Security item. Name and email reach git only through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, never as arguments. | Security and Testability Review #14 | Approved (owner, decision card, 2026-11-14, as worded) |

## 10. Interface requirements
Each is a hygiene item the owner approved on a decision card. Items that need
engine code in step are applied with the build; the rest are applied here.

### H-0190 (approved): limits for the new roles
Approved by the owner 2026-11-14 (decision card, as listed). Applied with
the build's first milestone, together with the engine code that reads them.
New sections in `engine/config/limits.yaml`, same keys as the analyst's
minus the container keys (no containers until Beta, ADR 0026). A project's
`limits:` may only lower them.

| Key | Developer | Test engineer | Orchestrator (classifier) | Validation judge |
|---|---|---|---|---|
| Turns per session | 300 | 200 | 30 | 100 |
| Output tokens per session | 500,000 | 300,000 | 50,000 | 200,000 |
| Dollars per session (API key mode) | 15 | 10 | 2 | 5 |
| Wall time per session | 4 h | 3 h | 20 min | 60 min |

Code Review uses the existing `security_reviewer` limits. New run caps:
`test_run.wall_time_minutes: 30` and `test_run.output_kib: 1024` (the engine
keeps at most this much of the test command's output per run),
`ci_wait_minutes: 60` (stage 9 treats CI that hasn't finished by then as an
incomplete run).

### H-0191 (approved): models for the new roles
Approved by the owner 2026-11-14 (decision card, option 0).
`engine/config/models.yaml` gains `software-developer: claude-opus-5-5`,
`validation-judge: claude-opus-5-5`, `test-engineer: claude-sonnet-5-5` and
`orchestrator: claude-sonnet-5-5`. Applied in the build's first milestone,
together with the engine code that knows these roles: today's engine refuses a
`models.yaml` naming a role it doesn't run (`config/models.ts`), so adding them
earlier would stop every project. F-002 rungs replace these per project later.

### H-0192 (approved): Role policy for code repo worktrees
Approved by the owner 2026-11-14 (decision cards: sequencing, then the rest).
Applied with the build's first milestone, after Role policy v2.7 (H-0201)
lands, since both change the same contract.
- The approved spec and contracts are mounted for reading at a fixed path
  outside the worktree; no role may write there.
- Approved 2026-11-14 (decision card): the test engineer runs after the
  developer (sequential), in its own worktree on a branch from the feature
  branch. Its file-tool `read.deny` covers the developer's branch, report
  and transcript; with a full shell (SR-1) that is a rule, not a boundary,
  and its instructions forbid reading them. The developer's `write.deny`
  keeps the test engineer's test paths (as today's example).
- Credentialed CLIs in the shell follow Role policy v2.7's ask rule
  (H-0201): held, asked in the inbox, denied after 30 minutes (FR-3).
- The orchestrator (classifier) gets `Read`, `Grep`, `Glob` only, reads the
  run report, the spec and the diff, and writes only its report.
- `Bash` for the developer and test engineer as SR-1 accepts.

### H-0197 (approved, applied): stage 6 numbers in limits.yaml
Approved by the owner 2026-11-14 17:44Z (decision card, option B). The
failure table's numbers (reruns by cause, fix cycles per role, flaky count,
disagreements, agent hours) are a `stage6` section of
`engine/config/limits.yaml`, next to the H-0190 `test_run` caps, not a new
file. A project may only lower them.

### H-0198 (approved, applied): target repo and feature dependencies
Approved by the owner 2026-11-14 17:44Z (decision card, option A).
`feature-template.md` gains an optional `- **Repo:** <repos[].name>` header
line; a single-repo project omits it (FR-16). A feature waits before stage 5
on every feature of the same project listed by id in its section 7
Dependencies until that feature's PR merges (AC-15).

### H-0193 (approved, applied): Project manifest v1.7
Approved by the owner 2026-11-14 (decision card, argument lists) and applied
in `interface-contracts.md`.
Optional keys, non-breaking:

```yaml
owner:
  commit_name: <name>            # optional; overrides the GitHub profile name (FR-17)
repos:
  - name: web
    commands:
      test: ["npm", "test", "--", "--reporter=junit", "--outputFile=reports/junit.xml"]
      test_results: reports/junit.xml   # relative to the worktree, inside it
      build: ["npm", "run", "build"]    # optional; run by the developer's tool and before tests
```

Commands are argument arrays, run with no shell. `test_results` must stay
inside the worktree under the ADR 0015 path rule. Onboarding (F-003) asks for
them per repo.

### H-0194 (approved, applied): Agent report location and bodies
Approved by the owner 2026-11-14 (decision card); applied as Agent report v1.5.
- Location: `.factory/runs/<feature>/<stage>/<role>-<n>.json` on the config
  repo's `factory/state` (ADR 0028), not the feature branch.
- Orchestrator body for the classifier: `failures` (test, cause, evidence).
- The test-engineer body's run fields (`tests_run` ... `not_run`) are filled
  by the engine from the JUnit results (FR-6); the agent fills
  `criteria_map`.

### H-0196 (approved, applied): Semgrep venv for Code Review
Approved by the owner 2026-11-14 (decision card: the six advisories accepted
as unreachable for 90 days). Applied: `engine/config/semgrep-requirements.txt`
(74 entries across platforms, resolved with a 14-day cut-off),
`engine/osv-scanner.toml` entries expiring 2027-02-12, and the `engine.yml`
lockfile scan.

`engine/config/semgrep-requirements.txt`: Semgrep 1.183.0 and its 66
dependencies, each with the SHA-256 of every wheel for Windows x64, macOS
arm64 and Linux x86_64. The engine installs it into a venv under the engine
home and checks it before each Code Review. `engine/osv-scanner.toml` gets
entries for the four `mcp` 1.29.0 and two `opentelemetry-api` 1.37.0
advisories, each with the unreachability reason in ADR 0024's recheck and a
90-day expiry. CI scans the requirements file like the lockfiles.

### H-0195 (approved, applied): documents
Approved by the owner 2026-11-14 (decision card); applied in
`development-workflow.md`, `workflow.yaml`, the orchestrator's `AGENT.md` and
F-007's change log (v46).
`development-workflow.md`, `workflows/feature-development/workflow.yaml` and
the orchestrator's `AGENT.md` say which steps are engine code and which run
the orchestrator agent (OQ-4); F-007 v41's exception is marked closed for
code (ADR 0028).

### H-0253 (approved, applied): Project manifest v1.10 and PR record
Approved by the owner 2026-11-15 06:24Z (decision card, with FR-18).
Project manifest v1.10 adds optional `settings.auto_merge_up_to`: `none`
(the default) or a maturity level, the highest whose feature PRs the engine
may merge (FR-18). The engine and `factory_check.py` refuse any other
value. The PR record gains the history entry `merged_by_engine` (merge
commit, the orchestrator's report). `docs/schemas/` is regenerated.

### H-0254 (approved, applied): maturity-levels note
Approved by the owner 2026-11-15 06:24Z (decision card, with FR-18).
`maturity-levels.md`, under the "Who merges a PR" row: the engine merges a
project's feature PRs only when that project's `settings.auto_merge_up_to`
covers the repo's level (F-015 FR-18). The row itself is unchanged.

### H-0255 (approved, applied): orchestrator auto-merge review
Approved by the owner 2026-11-15 06:24Z (decision card, with FR-18).
The orchestrator's `AGENT.md` gains the auto-merge review duty: read the
spec and the diff, return one check per thing looked at with evidence; code
has already checked the tests, checks and definition of done.

## 11. Readiness gate
Run by the orchestrator, 2026-11-14, on spec v19.

- [x] Clear objective: section 1.
- [x] Expected behavior defined: section 2, FR-1 to FR-17.
- [x] Acceptance criteria testable: AC-1 to AC-31, each pass or fail, each
  linked to an FR or SR.
- [x] Constraints documented: section 5.
- [x] Assumptions explicit: none. The interview ran in the project thread on
  decision cards, not through the engine; no assumption was proposed.
- [x] Blocking decisions resolved: OQ-1 to OQ-7 decided (OQ-6 superseded by
  ADR 0026), the shell and Semgrep decisions, H-0190 to H-0196, and Security and Testability Review
  #1 and #5 all decided by the owner on decision cards; SR-2 to SR-15
  approved. None deferred.

## 12. Open questions for the owner
Asked one at a time on decision cards. None is assumed.

| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | One feature for all of stages 5 to 9, built in milestones, or split into two features (build and test first, then gates and PR)? | Product | Decided: one feature, built and merged in milestones (owner, decision card, 2026-11-13) |
| OQ-2 | Where feature work lives once it leaves the config repo: specs, transcripts and agent reports stay in the config repo and only code moves to the code repo; or everything moves to the code repo per ADR 0005/0009 as written; or code moves and a copy of the approved spec goes into the PR. | Architecture | Decided: only code and tests go to the code repo; spec, transcript, reports and records stay in the private config repo; agents get the spec read-only; the PR links it. Amends ADR 0005/0009 (ADR 0028, renumbered: 0026 went to the no-containers decision) (owner, decision card, 2026-11-13) |
| OQ-3 | Can one feature change more than one code repo (one PR per repo), or is it one repo per feature for now? | Product | Decided: one repo per feature; a request needing several repos becomes linked features, one per repo, and a dependent feature waits for the other's PR to merge (owner, decision card, 2026-11-13) |
| OQ-4 | Who runs stages 6 and 9: engine code only, engine code plus an orchestrator agent session just to classify failures, or an orchestrator agent session for the whole stage. | Architecture | Decided: engine code, plus a read-only orchestrator agent session only to classify failures (FR-7) (owner, decision card, 2026-11-13) |
| OQ-5 | Who runs the tests: the engine runs a test command the manifest declares and reads its JUnit XML, or the test engineer agent runs them and reports. | Architecture | Decided: the engine runs each repo's declared test command and reads its JUnit XML; the test engineer writes tests and the criteria map (FR-6) (owner, decision card, 2026-11-13) |
| OQ-6 | Where each project's build toolchain comes from for the agent containers. | Architecture, Security | Superseded: the owner dropped containers until Beta (2026-11-13), so build and test tools are the ones installed on the owner's machine. The question returns with containers at Beta |
| OQ-7 | Who commits appear to come from in code repos: the engine's own identity (today) or the owner's name with his GitHub noreply address. | Product | Decided: the owner's name and GitHub noreply address, unsigned, risk stated on the card (FR-17) (owner, decision card, 2026-11-13) |

## 13. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft from the baseline spec, ADRs and increments 1 to 3, before the owner interview | — |
| 2 | 2026-11-13 | OQ-1: one feature for stages 5 to 9 and the move to code repos, built and merged in milestones (code-repo move with developer and test engineer; stage 6 review; Code Review and judge; PR and CI) | Owner, 2026-11-13 (decision card) |
| 3 | 2026-11-13 | OQ-2: only code and tests go to code repos; spec, transcript, reports and records stay in the private config repo (FR-2); an ADR to record the amendment to ADR 0005 and 0009 (now ADR 0028) | Owner, 2026-11-13 (decision card) |
| 4 | 2026-11-13 | OQ-3: one code repo per feature; multi-repo requests become linked features (FR-16) | Owner, 2026-11-13 (decision card) |
| 5 | 2026-11-13 | OQ-4: stages 6 and 9 are engine code; a read-only orchestrator agent session runs only to classify test failures (FR-7) | Owner, 2026-11-13 (decision card) |
| 6 | 2026-11-13 | OQ-5: the engine runs each repo's declared test command and reads JUnit XML results; the test engineer writes tests and the criteria map (FR-6, H-0193) | Owner, 2026-11-13 (decision card) |
| 7 | 2026-11-13 | OQ-7: code repo commits authored as the owner with the GitHub noreply address, unsigned (FR-17). OQ-6 on hold while the owner revisits containers versus worktrees | Owner, 2026-11-13 (decision card) |
| 8 | 2026-11-13 | FR-17: the commit identity is whoever owns the project, derived from the config repo's pinned owner id and that GitHub account, with an optional manifest `owner.commit_name` override; nothing owner-specific in the master repo | Owner, 2026-11-13 (thread) |
| 9 | 2026-11-13 | No containers until Beta: agents run as one SDK session per role in engine worktrees on the owner's machine; build tools are the owner's installed ones; OQ-6 superseded (FR-3, FR-6) | Owner, 2026-11-13 (thread) |
| 10 | 2026-11-14 | Developer and test engineer get a full shell on the owner's PC until Beta, accepted risk under ADR 0026 (FR-3, SR-1). The ADR for OQ-2 is renumbered to 0028 because 0026 went to the no-containers decision | Owner, 2026-11-14 (decision card) |
| 11 | 2026-11-14 | Code Review runs Semgrep from a hash-pinned PyPI venv on the owner's PC, not Docker (FR-8, H-0196); ADR 0024 amended with the S4.1 recheck. Also: acceptance criteria AC-1 to AC-18, ADR 0028, hygiene drafts H-0190 to H-0196 | Owner, 2026-11-14 (decision card, Semgrep); rest drafts |
| 12 | 2026-11-14 | H-0196 approved and applied: the six Semgrep dependency advisories accepted as unreachable until 2027-02-12 | Owner, 2026-11-14 (decision card) |
| 13 | 2026-11-14 | H-0191 approved: developer and judge on Opus 5.5, test engineer and failure classifier on Sonnet 5.5; applied with the build | Owner, 2026-11-14 (decision card) |
| 14 | 2026-11-14 | H-0190 approved: session limits for developer, test engineer, failure classifier and judge, test-run and CI-wait caps; applied with the build | Owner, 2026-11-14 (decision card) |
| 15 | 2026-11-14 | H-0193 approved and applied: Project manifest v1.7, `repos[].commands` as argument lists and `owner.commit_name` | Owner, 2026-11-14 (decision card) |
| 16 | 2026-11-14 | Stage 5 is sequential: the test engineer runs after the developer, on its own branch from the feature branch (FR-3, H-0192); credentialed CLIs follow the role policy's ask rule | Owner, 2026-11-14 (decision card) |
| 17 | 2026-11-14 | FR-3: credentialed CLIs in the developer's and test engineer's shells follow H-0201's ask rule (held, Security item, 👍 runs once, denied after 30 minutes, wait off the time cap) | Owner, 2026-11-14 (decision card, H-0201) |
| 18 | 2026-11-14 | H-0192 rest, H-0194 and H-0195 approved; H-0194 (Agent report v1.5) and H-0195 (workflow, orchestrator AGENT.md, F-007 v46) applied | Owner, 2026-11-14 (decision card) |
| 19 | 2026-11-14 | Security and Testability Review folded in: SR-2 (token per project) and SR-6 (confirm once per public repo) chosen, SR-3 to SR-15 approved as worded; S9.1 service table, abuse cases, AC-19 to AC-31. Readiness gate passed | Owner, 2026-11-14 (decision cards); orchestrator (gate) |
| 19 (sign-off) | 2026-11-14 | Signed off: status Approved; the build waits on increment 3 (F-016) | Owner, 2026-11-14 (decision card) |
| 20 | 2026-11-14 | Build decisions: H-0197 (stage 6 numbers in `limits.yaml`) and H-0198 (Repo header line; dependencies listed in section 7 wait for their PR to merge) | Owner, 2026-11-14 17:44Z (decision cards) |
| 21 | 2026-11-15 | SR-2 and AC-19: the token check counts only private repos outside the project and refuses classic tokens; found in the live trial, where public repos every token can read failed every token. Accepted gap recorded in SR-2 | Owner, 2026-11-15 05:04Z (decision card) |
| 22 | 2026-11-15 | FR-11 and FR-18: configurable auto-merge up to a maturity level (`settings.auto_merge_up_to`), code checks before the orchestrator's review; AC-32 to AC-34; H-0253 to H-0255 | Owner, 2026-11-15 06:24Z (decision card: "Approve; no CI counts as green") |
| 23 | 2026-11-15 | FR-19 and SR-2: one token per GitHub owner per project (`factory-token/<project>/<owner login>`), so a project whose config repo and code repo have different owners works with fine-grained tokens; AC-35 to AC-38 (AC-37 reworded: tokens for other owners are never read, owner, decision card 07:46Z); H-0256 (onboard-repo skill and engine README token steps). Found onboarding MindsEyeSociety/mesbot with its config repo in the owner's account | Owner, 2026-11-15 07:45Z (in thread: "approve per-owner tokens") |
| 24 | 2026-11-20 | FR-20: commands that hang. Build agents may run commands in the background with `Monitor` and `TaskStop` (Role policy v2.11); an engine watchdog kills a session's commands after 10 silent minutes; leftovers are killed when a session ends. AC-39 to AC-41. Found when mesbot F-003's developer hung on its own smoke test | Owner, 2026-11-20 (decision card "Background tools + watchdog"; wording approved in thread 20:12Z, "go ahead and ship the fix") |
| 25 | 2026-11-20 | FR-21 to FR-24: no answer leaves a build at a dead end (send-to-role options and a "What next" item); agents test with the repo's commands; the test engineer owns test dependency files; missing tests come with a reason. AC-42 to AC-46. Found in mesbot F-003 | Owner (approved as drafted on a card, 2026-11-20 20:53Z) |
| 26 | 2026-11-20 | FR-22 reworded and FR-25 added: agents run tests only through the factory tool `run_tests`, which the engine runs as it runs the stage 6 run, joined to the test engineer's criteria map; the gate refuses test runs in `Bash` or `Monitor` (Role policy v2.12, Build tools v1.0); one named test can run through the new `commands.test_one` (Project manifest v1.11). AC-47 to AC-49. Owner chose "Yes, and forbid Bash test runs" on a card; found in mesbot F-003 (D-0010) | Owner (approved as drafted on a card, 2026-11-21 00:26Z) |
| 27 | 2026-11-21 | FR-26 and AC-50 added: a feature started from a code repo issue records it (checked open), and its PR description ends with `Closes #<n>`; SR-4 allows that line (channel v1.8, `feature.start` `issue`). Found when mesbot#25 stayed open after F-003's PR merged | Owner (approved as drafted on a card, 2026-11-21 17:49Z) |
| 28 | 2026-11-21 | FR-27 and AC-51 to AC-54 added: the owner can cancel a feature from any state that isn't final; `cancelled` is a final state of its own, and `closed` now means only that the PR merged (the build's `merged` state renamed; a PR closed without merging ends as `cancelled`); channel v1.9 `feature.cancel`. Found when the trial project's F-001 sat in its interview after its analyst run failed on 2026-11-12 | Owner (approved as drafted on a card, 2026-11-21 23:32Z) |
| 29 | 2026-11-22 | FR-28 and AC-55 to AC-57 added: configuration changes a feature needs go in a section 7 table that the readiness gate checks for status and the engine tests against the manifest before the build; template H-0275 and requirements analyst H-0276. Found when mesbot F-004's spec needed the developer's write rules widened, nobody raised it, and the build stopped (D-0015) | Owner (approved as drafted on a card, 2026-11-22 07:04Z) |
| 30 | 2026-11-27 | FR-29 and AC-58 to AC-61 added: the test engineer can list tests only CI can run (`ci_only`, Agent report v1.7, H-0280); they are pending on CI in the run report, agents don't block on them, and the PR isn't ready until its required CI is green; definition of done item 5 and testing-strategy.md's run report say so (H-0281). Owner: "rely on CI for linux testing"; found in mesbot F-004 (D-0026, D-0036) | Owner (approved as drafted on a card, 2026-11-27 07:06Z) |
| 31 | 2026-11-27 | FR-30 and AC-62 added: test tools' cache folders (`.hypothesis`, `.pytest_cache`, `__pycache__`, `.mypy_cache`, `.ruff_cache`) are skipped by the worktree commit like base-ignored files. Owner chose "Both: .gitignore now + engine fix" on a card; found in mesbot F-005 (D-0039, D-0040) | Owner (approved as drafted on a card, 2026-11-27 07:18Z) |
| 32 | 2026-11-27 | FR-31 and AC-63 added, SR-3 reworded: `main`'s required checks come from its rulesets and its classic branch protection. Found when mesbot's checks (classic protection) read as none (T-0003) | Owner (approved as drafted on a card, 2026-11-27 20:07Z) |
| 33 | 2026-11-28 | F-026 (H-0290): FR-28 rows may name a CI job (`ci job <repo>/<job>`), which stage 9 waits for instead of the gate; FR-10 waits on the feature's CI jobs before reading required checks; FR-29 (2) accepts `ci_only` tests that a requested CI job covers | Owner (approved as drafted on a card, 2026-11-28 07:07Z) |
