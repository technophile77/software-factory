# Feature: Build a feature to a pull request on the real engine

- **Id:** F-015
- **Status:** Approved (readiness gate passed and signed off by the owner, 2026-11-14)
- **Requested by / date:** Alex, 2026-11-13 ("what is the critical path until
  I can start onboarding some of my existing projects?"; chose to spec
  increment 4 in parallel with increment 3, decision card)
- **Spec version:** 19

This is engine increment 4, "Build to PR" (F-007 section 13). The owner
interview ran in the project thread on decision cards (section 12 and the
change log record each answer). It is built in milestones (OQ-1) once
increment 3 (F-016) has merged.

## 1. Objective and business purpose
The engine takes a feature from request through the interview and Security
Gate 1 (F-007, F-008), and increment 3 adds the full readiness gate and the
inbox on GitHub issues (F-011). After that a feature is ready to build, but
nothing builds it: no developer, no test engineer, no Gate 2, no judge, no
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

| Id | Requirement |
|---|---|
| FR-1 | A feature of an enabled, running project that passes the readiness gate enters `build_and_test_prep`. One build per feature at a time. |
| FR-2 | Only code and tests move to the code repo (OQ-2): feature and agent branches live in the target code repo (OQ-3), named per ADR 0005, created from that repo's `main`. The spec, interview transcript, Gate reports, agent reports, run records and inbox records stay in the private config repo (its feature branch and `factory/state`). Nothing from the config repo is committed to a code repo. The PR description links the spec at its approved commit in the config repo. |
| FR-3 | The developer and then the test engineer run, one after the other, as Agent SDK sessions, one per role (not subagents), each in its own engine-made worktree on the owner's machine, under the project's role policy as the engine enforces it on the host: allowed tools, file tool read and write checks, and the end-of-session write check (owner, 2026-11-13: no containers until Beta, ADR 0026). Both roles get a full `Bash` shell on the owner's PC (owner, decision card, 2026-11-14; SR-1). Each gets its `AGENT.md`, the approved spec at the readiness-gate commit (read-only, at a fixed path outside its worktree), and the contracts. The test engineer starts only when the developer reports done (owner, decision card, 2026-11-14, H-0192: sequential, in place of the baseline spec's "in parallel where possible"); its branch starts from the feature branch, not from `dev`. Neither gets the other's branch, report or transcript. Credentialed command-line tools in either shell (`gh`, `aws`, `railway`, `docker`, `ssh` and the others listed in Role policy v2.7, H-0201) follow its ask rule: the engine holds the call and files a Security inbox item; the owner's 👍 runs it once; a refusal or 30 minutes with no answer denies it. The wait doesn't count toward the session's time cap. Every hit is recorded in the run report and transcript, and a denied step is reported as not done (owner, decision card, 2026-11-14). The engine's own `commands.test` and `commands.build` aren't covered; they fall under ADR 0026's accepted risks. Build tools are the owner's own installed tools (OQ-6). |
| FR-4 | Agent edits are committed by the engine after each edit (ADR 0012), with the secrets scan before each commit; the end-of-session write check applies (F-007 FR-9). |
| FR-5 | When both agents report done, the engine merges `dev` and `test` into the feature branch. A merge conflict between them is handled per ADR 0013. |
| FR-6 | The engine runs the tests, not an agent (OQ-5). Each code repo's manifest entry declares its test command and the path of the JUnit XML results file it writes (H-0193), set at onboarding. The engine runs the command against the merged commit in a worktree of that commit on the owner's machine with no model, reads the results file, and builds the run report per `testing-strategy.md`: commit tested, counts, failures with expected, actual and logs, anything not run and why. The test engineer agent writes the tests and the acceptance-criteria-to-test map; the engine joins that map to the results. A missing or unreadable results file, or an unexplained skip, makes the run incomplete. |
| FR-7 | Stage 6 applies the failure table in `testing-strategy.md` exactly: rerun counts by cause, at most 3 fix cycles per role, 2 developer/test-engineer disagreements on one test go to the Decision inbox, 4 hours of stage 6 agent time escalates. Every escalation is a Testing item with the fields of spec section 5. Engine code does the mechanical work: runs and reruns, counts fix cycles, files items, and in stage 9 pushes, opens the PR and reads CI (OQ-4). An orchestrator agent session, read-only with no shell, runs only when a test run fails: it names each failure's cause from the table and writes the evidence for the review note and any Testing item; the engine then applies the table to that cause. |
| FR-8 | Stage 7 runs Semgrep CE 1.183.0 on the feature diff from a factory-owned venv on the owner's PC, installed with `pip install --require-hashes --only-binary :all:` from the change-controlled requirements file (H-0196), with `--metrics=off` and `--disable-nosem` (ADR 0024 as amended 2026-11-14; owner, decision card). If the venv can't be installed or verified, Gate 2 fails closed. Then the security reviewer (Gate 2) runs with the findings as evidence, reusing the F-008 report checks. Blocking per `security-standards.md` at the repo's maturity level. |
| FR-9 | Stage 8 runs the validation judge with the spec, diff, run report and both gate reports. Its verdict is applied per `development-workflow.md` § Going backwards and the allowances in its `AGENT.md`. |
| FR-10 | Stage 9: with items 1 to 11 met, the engine pushes the feature branch and opens a draft PR with the owner's token. It reads the required checks on the PR head; green marks the PR ready with its title and description updated and posts the F-011 FR-9 comment; red is a stage 6 failure. |
| FR-11 | The engine never merges a feature PR (F-011 FR-14). |
| FR-12 | Every run writes an Agent report (contract v1.4) and is resumable and interruptible as earlier runs are, within `MAX_RESUMES`. |
| FR-13 | Models and limits for the new roles come from the master `engine/config/models.yaml` and `limits.yaml` at the pinned factory version (hygiene items in section 10); the engine has no defaults; a project may only lower limits. |
| FR-14 | The PR parts of F-011 are built here, since nothing opens PRs before this increment (agreed with increment 3, F-016): the FR-9 definition-of-done comment, `/changes <note>` on managed PRs, recording `merged_on_github` / `closed_on_github`, and FR-10's hygiene auto-merge with its SR-11 diff check. Inbox issues, inbox records and PR records stay on the config repo's `factory/state` (F-011, Inbox item v3.0). The FR-10 merge call lives in `engine/src/inbox/auto-merge.ts`, the only file increment 3's FR-14 CI test (`engine/test/inbox-calls.test.ts`) allows a merge API call in; create-reaction calls stay refused everywhere. |
| FR-15 | The build starts from the stage `build_and_test_prep`, which increment 3 (F-016) records when the owner's confirmed Approve on the feature's Spec sign-off item (kind `spec`, id `S-nnnn`) lands; the transcript then holds a `spec_signed_off` entry with the commit and spec version, and that commit is the approved spec FR-3 gives the agents. |
| FR-16 | Each feature targets exactly one code repo of its project, named in its spec (OQ-3). A request needing several repos becomes linked features, one per repo; a feature that depends on another doesn't start stage 5 until that feature's PR has merged. |
| FR-17 | Commits the engine makes in code repos are authored and committed as the project's owner, whoever that is: nothing about the identity is in the master repo or the engine code (owner, 2026-11-13). The engine derives it per project from the private config repo's pinned `owner.github_id`: the name is that GitHub account's profile name (its login if the name is empty), read from GitHub's API at engine start; the email is the account's noreply address `<id>+<login>@users.noreply.github.com`. An optional `owner.commit_name` in the project manifest overrides the name (H-0193). No trailer or message text names an AI tool. Commits are not signed (residual risk stated to the owner: anyone can write commits with that name and address; GitHub shows them unverified). Engine commits in the config repo keep the engine identity. |

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
| AC-9 | Given a Gate 2 finding that blocks at the repo's maturity level, then the feature returns to the developer and then to stage 6; given none, it moves to validation. | FR-8 |
| AC-10 | Given judge verdict FAIL, then the feature goes to the role the finding names; NEEDS_HUMAN_REVIEW files a Decision item and the feature is `blocked`; PASS moves it to `pull_request`. | FR-9 |
| AC-11 | Given items 1 to 11 met, then the engine pushes the feature branch and opens a draft PR with the owner's token; given required checks green on its head, then the PR is marked ready, its title and description updated, and the definition-of-done comment posted; given a red check, then the failure enters stage 6 and the PR stays draft. | FR-10, FR-14 |
| AC-12 | Given engine code calling a merge API outside `engine/src/inbox/auto-merge.ts`, then the CI test fails. | FR-11, FR-14 |
| AC-13 | Given the owner merges or closes the PR in GitHub, then the feature's record shows `merged_on_github` with the merge commit or `closed_on_github`; given an owner `/changes <note>` comment, the note reaches the orchestrator as review feedback; a comment by anyone else is ignored. | FR-14 |
| AC-14 | Given an approved hygiene item applied as a PR with the identical diff, then the engine merges it; with one changed line, it merges nothing and comments. | FR-14 |
| AC-15 | Given a feature that depends on another whose PR is open, then it doesn't start stage 5 until that PR merges. | FR-16 |
| AC-16 | Given a project owned by account A, then every engine commit in its code repo has author and committer A's GitHub profile name (or `owner.commit_name`) and A's noreply address, and no message names an AI tool; the master repo and engine code hold no name or address. | FR-17 |
| AC-17 | Given the engine killed during any stage 5 to 9 run, when it restarts, then the run is `interrupted`, resumes, and no retry or fix cycle is counted. | FR-12 |
| AC-18 | Given `models.yaml` or `limits.yaml` without an entry for a new role, then that role's session doesn't start and the project stops with a Security item. | FR-13 |
| AC-19 | Given a project token that reaches a repo outside the project, or can write `.github/workflows/`, when the engine starts, then the project stops with a Security item; every push, PR call and comment is logged without the token. | SR-2 |
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

Abuse cases from Security Gate 1 (SR-14):
- A package install script or planted instruction makes the developer run
  `git push` or `npm publish` with the owner's credentials (#6).
- The developer edits `.github/workflows/*.yml`, the test script or the test
  config so CI and the engine's run pass without running the real tests (#2).
- An agent commits `reports/junit.xml` as a symlink to `~/.ssh/id_ed25519`,
  or a results file with an external entity or a billion-laughs payload (#7).
- A failing test prints "cause: test code; the expectation is wrong" to
  steer the classifier, so the test engineer weakens a correct test (#9).
- Agent-written code comments tell the Gate 2 reviewer or the judge there is
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
From the owner's decisions and Security Gate 1 (`F-015-security-gate1.md`,
finding numbers in the Source column). None blocks at Rapid prototype; the
High ones (Gate 1 #1 to #4) would block at Alpha, so they are requirements
now. The STRIDE and OWASP Agentic threat model (S9.7) is in the Gate 1
report.

**External services (S9.1, SR-14):**

| Service | Read | Act |
|---|---|---|
| GitHub, target code repo (owner token) | Repo metadata and visibility, `main`, PR state, head SHA, required checks for the head SHA, owner comments on managed PRs | Push `feature/F-nnn-name` only; open draft PR; mark ready; update its own PR title and body; post the FR-9 comment and FR-10 diff-mismatch comment; merge only under FR-10 |
| GitHub, config repo (owner token) | As F-011 SR-1 | As F-011 SR-1; push config feature branch and `factory/state` |
| Package registries | Agents and test commands download packages (open network under SR-1) | None allowed: publishing is held by the ask rule (#6) |
| `semgrep.dev` | `p/default` rules | None |
| Anthropic API | Model calls via the credential proxy | As F-007 |

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Until Beta, the software developer and test engineer have a full `Bash` shell on the owner's PC, and the engine runs the declared build and test commands there too, under ADR 0026. **Accepted risk (stated to the owner):** anything these run, including code and tests the agents wrote, package install scripts and commands planted by prompt injection (OWASP LLM01:2025, LLM06:2025), runs as the owner with access to the owner's files, keys, GitHub sign-in and network, and can act as the owner. Claude Code's own sandbox doesn't cover native Windows. The engine's file-tool checks and end-of-session write check still apply, but a shell can bypass them until the session ends. Expires at Beta, when containers return. | Owner, decision card, 2026-11-14 ("Full shell") | Accepted risk until Beta (ADR 0026) |
| SR-2 | External services and token (S9.1, S8.2): the engine acts on code repos only as the S9.1 table in section 9 lists. It uses a fine-grained owner token limited to the project's selected repos, with Metadata read, Contents read/write, Pull requests read/write, Issues read/write, Checks read, Commit statuses read and Actions read, and no Workflows or Administration permission; at most 90 days' expiry (F-011 SR-13). At start the engine checks that the token reaches no repo outside the project and that a write to `.github/workflows/` is refused; otherwise the project stops with a Security item. Each push, PR create or update, comment and merge is logged with action, repo, ref or PR, head SHA, time and approval id, without the token (S9.6). | Gate 1 #1 | Approved (owner, decision card, 2026-11-14: one token per project) |
| SR-3 | Neither agent may change CI or test harness files: `.github/workflows/**`, `.github/actions/**`, the files named by `repos[].commands`, the test-runner config files listed per repo at onboarding, and the path of `test_results`. These are in both roles' `write.deny` by default, and the end-of-session check rejects changes to them with a Security item. The token has no Workflows permission (SR-2), so such a push fails at GitHub too. The engine reads only the required checks named in the `main` ruleset, each pinned to the GitHub Actions app as its source (ruleset `integration_id`), on the exact head SHA it pushed; a check from another source or SHA is ignored. | Gate 1 #2 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-4 | Sensitive data (S3.2): the owner token; the spec, transcript, Gate and agent reports, run records, test output and logs; and the owner's local paths and user name. None of it goes to a code repo or its PRs. Anything written to a code repo or PR comes from fixed engine templates: the PR title is `F-nnn: <feature title>`, the description holds the feature id, spec version and a link to the spec at its approved commit; the FR-9 comment holds pass or fail per definition-of-done item and links into the config repo, never finding text, test output, logs or paths. Commit messages are engine-written from fixed text and the file list. Nothing is pushed to a code repo before stage 9, and only `feature/F-nnn-name` is pushed; agent branches stay local. Before pushing to a public repo the engine checks the pushed range for text that matches the spec or transcript verbatim over 200 characters or more; a hit stops the push and files a Security item quoting only the file and line. | Gate 1 #3 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-5 | Before any push to a code repo the engine runs the secrets scan on every commit in the range to be pushed, not only the final tree, and on every PR title, body and comment before posting. It runs with the engine's own config only; repo-level allowlists (`.gitleaks.toml`, `.gitleaksignore`, inline allow comments) are not honoured, as ADR 0024 does for `nosemgrep`, and a diff that adds one is a Gate 2 finding. A hit stops the push or post, files a Security item with engine text only, and keeps the feature where it is. | Gate 1 #4 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-6 | The engine pushes to a public code repo only if the owner confirmed publishing to that repo at onboarding. Before each push it reads the repo's visibility; if it differs from the recorded value, it pushes nothing and files a Security item. | Gate 1 #5 | Approved (owner, decision card, 2026-11-14: confirm once per public repo) |
| SR-7 | Agent worktrees come from an engine-owned local clone with no remote and `credential.helper` set empty in its config; the engine pushes from its own separate clone. Role policy adds `git push`, `git remote`, `git credential`, `npm publish`, `npm login`, `twine upload` and `cargo publish` to the ask list (Interfaces change, hygiene item). Residual (SR-1): code the agent runs can still use the owner's credentials directly. | Gate 1 #6 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-8 | The engine deletes the `test_results` path before each run and refuses it if it is tracked in git. After the run it opens the path under the ADR 0015 real-path rule, refuses a symlink, a non-regular file or a file over 5 MiB, and parses it with DTDs, external entities and entity expansion disabled, a depth limit, and a fixed schema (testsuite, testcase, failure, error, skipped, system-out, system-err); other elements are ignored and text fields are capped at 8 KiB each. Any refusal makes the run incomplete. The parser is an approved library after an S4.1 review, or engine code with no new dependency. | Gate 1 #7 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-9 | The engine runs `commands.test` and `commands.build` with an allowlisted environment (PATH, HOME or USERPROFILE, TEMP, locale and the toolchain variables onboarding records), never the engine's own environment, so no token, proxy credential or engine socket path is passed. `argv[0]` is resolved to an absolute path outside the worktree before the run; a `.cmd` or `.bat` target is run through `cmd.exe /d /s /c` with each argument escaped by the engine, never with `shell: true`. At the H-0190 caps the whole process tree is killed. Kept output passes the secrets scan before it is stored, and the owner's home path is replaced by `~`. | Gate 1 #8 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-10 | Test output, failure messages and diff text are given to the classifier, Gate 2 and the judge as labelled data blocks after the instructions (F-008 SR-7), output truncated to the H-0190 cap. The classifier's report is validated by the engine: each failure id must exist in the results file, the cause must be one of the failure table's causes, evidence is at most 2 KiB per failure; anything else makes the classification invalid and the run goes to a Testing item. Evidence is rendered in Testing items under F-011 SR-10. When a failure classified `test code` is fixed by changing that test, the judge receives the list of those test changes with the spec section each cites. | Gate 1 #9 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-11 | The engine marks a PR ready only when every required check (SR-3) passed on the SHA the engine pushed and that SHA is still the PR head; if the head differs, the PR stays draft and the feature is `blocked` with a Decision item. `/changes` is read only on PRs the engine opened, from the owner's numeric id, under F-011 SR-18; the note is at most 4 KiB, goes to the orchestrator as data (F-011 SR-4) and never to an agent as instructions. CI logs used in stage 6 are fetched by the engine, capped like test output (H-0190) and handled under SR-10. | Gate 1 #10 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-12 | FR-10 merges only the PR the engine opened for that hygiene item, in the repo the item names, never a `feature/` branch. The approved diff is the one the engine stored with the item at approval, by hash. The merge call passes the compared head SHA (`sha`), so GitHub refuses it if the head moved; required checks must be green on that SHA. Any failure merges nothing and comments under FR-10. | Gate 1 #11 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-13 | Before opening the first PR in a code repo, the engine checks (or F-003 onboarding records) that workflows triggered by `pull_request` declare `permissions:` read-only and pass no secrets other than `GITHUB_TOKEN`, and that no deploy environment is reachable from them. A repo that fails gets no PR; the engine files a Security item naming the workflow. | Gate 1 #12 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-14 | The S9.1 table, STRIDE threat model and OWASP Agentic Top 10 mapping in `F-015-security-gate1.md` are part of this spec; a change to the external services or their read/act scope reopens Gate 1." Add the abuse cases above to section 6. ### #14 Commit identity fields are not validated (Low) **Criteria:** S1.1. `owner.commit_name` and the GitHub profile name are input. Control characters, newlines or `<`/`>` could produce misleading author lines or fail commits unpredictably. **Suggested SR-15:** "The commit name, from the manifest or GitHub, is 1 to 100 characters with no control characters, `<` or `>`; otherwise the login is used and a Notice is filed. The account's numeric id from the API must equal the pinned `owner.github_id`, or the project stops with a Security item. Name and email reach git only through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, never as arguments. | Gate 1 #13 | Approved (owner, decision card, 2026-11-14, as worded) |
| SR-15 | The commit name, from the manifest or GitHub, is 1 to 100 characters with no control characters, `<` or `>`; otherwise the login is used and a Notice is filed. The account's numeric id from the API must equal the pinned `owner.github_id`, or the project stops with a Security item. Name and email reach git only through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, never as arguments. | Gate 1 #14 | Approved (owner, decision card, 2026-11-14, as worded) |

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

Gate 2 uses the existing `security_reviewer` limits. New run caps:
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

### H-0196 (approved, applied): Semgrep venv for Gate 2
Approved by the owner 2026-11-14 (decision card: the six advisories accepted
as unreachable for 90 days). Applied: `engine/config/semgrep-requirements.txt`
(74 entries across platforms, resolved with a 14-day cut-off),
`engine/osv-scanner.toml` entries expiring 2027-02-12, and the `engine.yml`
lockfile scan.

`engine/config/semgrep-requirements.txt`: Semgrep 1.183.0 and its 66
dependencies, each with the SHA-256 of every wheel for Windows x64, macOS
arm64 and Linux x86_64. The engine installs it into a venv under the engine
home and checks it before each Gate 2. `engine/osv-scanner.toml` gets
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
  ADR 0026), the shell and Semgrep decisions, H-0190 to H-0196, and Gate 1
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
| 2 | 2026-11-13 | OQ-1: one feature for stages 5 to 9 and the move to code repos, built and merged in milestones (code-repo move with developer and test engineer; stage 6 review; Gate 2 and judge; PR and CI) | Owner, 2026-11-13 (decision card) |
| 3 | 2026-11-13 | OQ-2: only code and tests go to code repos; spec, transcript, reports and records stay in the private config repo (FR-2); an ADR to record the amendment to ADR 0005 and 0009 (now ADR 0028) | Owner, 2026-11-13 (decision card) |
| 4 | 2026-11-13 | OQ-3: one code repo per feature; multi-repo requests become linked features (FR-16) | Owner, 2026-11-13 (decision card) |
| 5 | 2026-11-13 | OQ-4: stages 6 and 9 are engine code; a read-only orchestrator agent session runs only to classify test failures (FR-7) | Owner, 2026-11-13 (decision card) |
| 6 | 2026-11-13 | OQ-5: the engine runs each repo's declared test command and reads JUnit XML results; the test engineer writes tests and the criteria map (FR-6, H-0193) | Owner, 2026-11-13 (decision card) |
| 7 | 2026-11-13 | OQ-7: code repo commits authored as the owner with the GitHub noreply address, unsigned (FR-17). OQ-6 on hold while the owner revisits containers versus worktrees | Owner, 2026-11-13 (decision card) |
| 8 | 2026-11-13 | FR-17: the commit identity is whoever owns the project, derived from the config repo's pinned owner id and that GitHub account, with an optional manifest `owner.commit_name` override; nothing owner-specific in the master repo | Owner, 2026-11-13 (thread) |
| 9 | 2026-11-13 | No containers until Beta: agents run as one SDK session per role in engine worktrees on the owner's machine; build tools are the owner's installed ones; OQ-6 superseded (FR-3, FR-6) | Owner, 2026-11-13 (thread) |
| 10 | 2026-11-14 | Developer and test engineer get a full shell on the owner's PC until Beta, accepted risk under ADR 0026 (FR-3, SR-1). The ADR for OQ-2 is renumbered to 0028 because 0026 went to the no-containers decision | Owner, 2026-11-14 (decision card) |
| 11 | 2026-11-14 | Gate 2 runs Semgrep from a hash-pinned PyPI venv on the owner's PC, not Docker (FR-8, H-0196); ADR 0024 amended with the S4.1 recheck. Also: acceptance criteria AC-1 to AC-18, ADR 0028, hygiene drafts H-0190 to H-0196 | Owner, 2026-11-14 (decision card, Semgrep); rest drafts |
| 12 | 2026-11-14 | H-0196 approved and applied: the six Semgrep dependency advisories accepted as unreachable until 2027-02-12 | Owner, 2026-11-14 (decision card) |
| 13 | 2026-11-14 | H-0191 approved: developer and judge on Opus 5.5, test engineer and failure classifier on Sonnet 5.5; applied with the build | Owner, 2026-11-14 (decision card) |
| 14 | 2026-11-14 | H-0190 approved: session limits for developer, test engineer, failure classifier and judge, test-run and CI-wait caps; applied with the build | Owner, 2026-11-14 (decision card) |
| 15 | 2026-11-14 | H-0193 approved and applied: Project manifest v1.7, `repos[].commands` as argument lists and `owner.commit_name` | Owner, 2026-11-14 (decision card) |
| 16 | 2026-11-14 | Stage 5 is sequential: the test engineer runs after the developer, on its own branch from the feature branch (FR-3, H-0192); credentialed CLIs follow the role policy's ask rule | Owner, 2026-11-14 (decision card) |
| 17 | 2026-11-14 | FR-3: credentialed CLIs in the developer's and test engineer's shells follow H-0201's ask rule (held, Security item, 👍 runs once, denied after 30 minutes, wait off the time cap) | Owner, 2026-11-14 (decision card, H-0201) |
| 18 | 2026-11-14 | H-0192 rest, H-0194 and H-0195 approved; H-0194 (Agent report v1.5) and H-0195 (workflow, orchestrator AGENT.md, F-007 v46) applied | Owner, 2026-11-14 (decision card) |
| 19 | 2026-11-14 | Security Gate 1 folded in: SR-2 (token per project) and SR-6 (confirm once per public repo) chosen, SR-3 to SR-15 approved as worded; S9.1 service table, abuse cases, AC-19 to AC-31. Readiness gate passed | Owner, 2026-11-14 (decision cards); orchestrator (gate) |
| 19 (sign-off) | 2026-11-14 | Signed off: status Approved; the build waits on increment 3 (F-016) | Owner, 2026-11-14 (decision card) |
