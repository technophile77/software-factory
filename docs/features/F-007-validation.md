# F-007 Validation report

- **Feature:** F-007 Run spec interviews on the real engine, spec v43
- **Judge:** validation-judge
- **Date:** 2026-11-12
- **Round:** 2. Round 1 judged `4504497` and returned FAIL.
- **Commit:** `797a8e1` (`claude/project-thread-xnrw8z`). The diff is `git diff origin/main...HEAD`: 92 commits, 146 files. Most of it is the new `engine/` package. The rest is `.github/workflows/` (engine.yml, docs-checks.yml, extension.yml), `scripts/` (`check_placeholders.py`, `osv_fixable.py` and their tests), `docs/interface-contracts.md`, `agents/web-reader/AGENT.md`, `.gitignore`, the onboarding checker and template, and the F-007 documents. Since round 1 the change is the milestone 2 acceptance tests, the test plan and report, five spec change-log rows (v39 to v43), and one engine change (`22482e2`, the web reader's search through the gateway).
- **Contracts:** Engine control channel v1.3 with H-0084 (served as 1.2, FR-4 v22). Interview tools v1.0 (H-0082). Role policy v2.5 (H-0083). Project manifest v1.3 and v1.4 (H-0080, H-0087). Agent report v1.1. Inbox item v1.1. No contract changed since round 1.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Not met line or a Blocking finding still fails.
- **Verdict:** **NEEDS HUMAN REVIEW**
  - **0 lines are Not met.** The test engineer's milestone 2 tests cover AC-8, AC-9, AC-13 to AC-17 and AC-21. All of them pass in my run on `797a8e1`, apart from the gated real-Docker tests. Those (DR-1 to DR-7) passed on the owner's PC on `797a8e1` (reported). Coverage is reported.
  - **1 line is Needs owner:** AC-13, "the owner is told why". When Docker is stopped the engine tells the owner only in the feature's transcript and in its log. No channel method carries the reason, so the owner in the skill sees no message (M8).
  - The four owner items from round 1 are settled by v39 to v42 (search, ratification, config-repo placement, `DOCKER_CONFIG`), and the AC-21 residual by v43.
  - Blocking: 0. Major: 3. Minor: 14.
  - Once the owner answers AC-13, this is a PASS at Rapid prototype unless the answer needs a code change.

## Changes since round 1

| Round 1 item | Now | Evidence |
|---|---|---|
| M1: no independent tests for milestone 2; no run report for the final commit | **Resolved, with a follow-up (M7)** | Milestone 2 section in `F-007-test-plan.md`. New `engine/test/acceptance/{agents,reader,settings-isolation,containers-real}.test.ts` with `support/fake-docker.ts` and `support/agents.ts` (`b9d97c9`). Run report rewritten (`eff197f`), with coverage and the tool table. The report is on `4b21531`, not the final commit: see below and M7 |
| M2: the gateway's server-tool block also blocked `WebSearch` | **Resolved** (owner, v39) | `22482e2`: the grant carries `webSearch` only for `web-reader` with `WebSearch` in its tools (`sandbox.ts:277`), and `refusedBody` then passes `^web_search_\d{8}$` and nothing else (`proxy/server.ts:137-161`). `proxy.test.ts` "web search passes only for a grant that allows it" and `claude-real.test.ts` "the web reader's search reaches the gateway as web_search…" pass in my run |
| M3: `a010208` and `e8a6c0a` without recorded approval | **Resolved** (owner, v40) | Spec change log row 40 |
| M4: feature work and `factory/state` in the config repo | **Resolved** (owner, v41) | Recorded exception to ADR 0009 and ADR 0005 for increment 1; increment 4 moves it (row 41). See m14 |
| M5: `startEngine` is one 820-line closure | **Open** | `src/engine.ts` unchanged since round 1 |
| M6(a): SR-14 `DOCKER_CONFIG` | **Resolved** (owner, v42) | SR-14 text now says an empty engine-owned folder |
| M6(b): stylesheet-hidden text (AC-21) | **Resolved as accepted residual** (owner, v43) | Must be fixed before Alpha. RW-4 is skipped with that reason (`reader.test.ts:117`) |
| m4: developer's AC-8 test asserts nothing about the home folder | Still true of the developer's test, but AC-8 is now covered by DR-2 | `containers-real.test.ts:207` |
| m1 to m3, m5 to m10 | Open | See Minor findings. m5 now also covers `22482e2` |

**Does it matter that the test report is on `4b21531`?** A little. `4b21531` is not an ancestor of `797a8e1`. Its tests were rebased as `b9d97c9` onto `22482e2`, `a8450b9` and `4e4d937`. `git diff 4b21531 797a8e1` shows these changes:
- An engine source change: `sandbox.ts`, `proxy/main.ts` and `proxy/server.ts` (`22482e2`).
- The developer's tests for that change (`proxy.test.ts`, `claude-real.test.ts`, `agent.test.ts`).
- The spec rows.
- Two test-only edits to the test engineer's DR file: the teardown, and DR-5's control now also accepts example.com's new wording.
- RW-4's skip reason.

The source change touches the gateway, which the test engineer's suite doesn't test outside Docker. So the test engineer's report doesn't speak for the final code. I re-ran the whole suite on `797a8e1`. It shows 2 more tests than the test engineer's run (498 to 500), both the developer's new web-search tests. Every test-engineer test passes. The owner-side session reports DR-1 to DR-7 passing on `797a8e1`. I accept this as evidence, as round 1 accepted a re-run for milestone 1 (F-006 m4). The report still needs a short addendum naming the final commit and the PC results (M7).

## My own run (evidence source)

On `797a8e1`, Linux container, Node 22, running as root. The working tree was clean before this report.

| Step | Result |
|---|---|
| `cd engine && npm ci --ignore-scripts` | OK |
| `npm run typecheck` (engine and `test/acceptance`) | Clean, exit 0 |
| `npx vitest run --coverage --coverage.reportsDirectory=<my scratch folder>` (no coverage output in the repo) | **33 files: 31 passed, 2 skipped. 500 tests: 486 passed, 14 skipped, 0 failed.** The skipped files are `test/docker-real.test.ts` and `test/acceptance/containers-real.test.ts`: 4 + 7 tests, gated on `FACTORY_DOCKER_TESTS=1`, no Docker here. The other three skips: RW-4 (accepted residual, v43), FX-7 (Windows), and the macOS/Windows parent lookup in `units.test.ts` |
| Coverage, whole suite, over `engine/src/**` | Lines 87.1% (3,626 / 4,163), branches 78.68%, statements 83.01%, functions 83.48%. This matches the test engineer's 87.06% / 78.55% on `4b21531` |
| Verbose re-run of the real-binary and milestone 2 files | CS-1 and CS-2 (`settings-isolation.test.ts`, the real Claude Code 2.1.311), both `claude-real.test.ts` tests, AG-1 to AG-7 (AG-5 ×5), RW-1 to RW-3: all **ran and passed**. RW-4 skipped |
| `python3 -m unittest discover -s scripts/tests` | OK. `scripts/` is unchanged since round 1. I didn't re-run the onboarding tests, because `plugins/` is unchanged too |
| `python3 scripts/check_placeholders.py`, `python3 scripts/check_docs.py` | Both pass |
| Search for real owner values: `Iv1.`+16 hex, `Ov23li`+14, numeric `github_id`, `oauth_client_id` values, and credential prefixes in the round 2 diff | **None found in tracked files.** The only matches are the placeholder script's own bad-value test (`scripts/tests/test_check_placeholders.py:21`, unchanged since `77bdff2`) and placeholder fixtures (12345, `Iv1.example` and those listed in round 1). The round 2 diff adds no id or credential. The real-binary tests use `sk-ant-placeholder-not-a-key` |

Evidence I didn't produce, as reported by the owner-side session (I record it, I didn't reproduce it):
- On the owner's Windows 11 PC, at `797a8e1`, `containers-real.test.ts` passed DR-1 to DR-7, 7 of 7, in 15.6 s. Teardown left no `factory-r-*-session` volume, container or network, and removed the DR-2 home marker.
- Earlier runs on the PC: DR-1 to DR-7 7/7 on `af63474`; developer `docker-real.test.ts` 4/4 on `2218fd2`. From those commits to `797a8e1` only test files changed.
- GitHub CI on `4504497` was green on all three OSes. CI for later commits wasn't complete when I judged, and I don't rely on it.

### Is the test engineer's run enough for `797a8e1`?

**Yes, with a records gap (M7).**
- The plan's milestone 2 section is written from the spec, contracts and Role policy. It says the developer's tests weren't read, apart from `claude-real.test.ts` for wiring, as the orchestrator allowed, and that its assertions weren't used.
- The acceptance tests drive the whole engine through the harness. The fakes sit at the `docker` command line (OQ-5) and at the SDK seam.
- AC-17 uses the real binary, with a control run (CS-2) that shows the planted files do load when allowed.
- The real-Docker tests probe the containers from inside.
- I read the tests themselves (AG-1 to AG-7, CS-1, CS-2, the RW and DR headers). They check outcomes and include controls, and I found no weakened assertion. The one loosening is DR-5's control regex (m11).

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `engine/` package; `src/cli.ts start`; `startEngine` in `src/engine.ts`. ST-1, CH-16; one engine across projects in FS-5, FS-6 |
| FR-2 | Met | `src/config/manifest.ts` (read from `refs/heads/main`), `authorize.ts`, `paths-file.ts`; refusal files a Security item and stops only that project. ST-4 to ST-7, ST-20 |
| FR-3 | Met | `config/authorize.ts` `billingMismatch`. ST-10, ST-11 |
| FR-4 | Met | `channel/*`, `constants.ts` (served 1.2, per spec v22), -32008 (H-0084), advisor kinds `kind_not_allowed`. ST-1, CH-1 to CH-16 |
| FR-5 | Met | `engine.ts` `feature.start`. FS-1 to FS-5. In the config repo by the v41 exception |
| FR-6 | Met | `channel/methods.ts`, `sessions.ts`, `interview/feature.ts`. SE-1 to SE-18, AP-10 |
| FR-7 | Met | `github.ts`, `sessions.ts`. AP-1 to AP-16 |
| FR-8 | Met | `src/agent/sandbox.ts`, `docker/plan.ts` (post-start inspect), `docker/image.ts`, `agent.Dockerfile`. DR-1 to DR-3 (real Docker, PC, reported); AG-1 to AG-3 ("no container, no session") |
| FR-9 | Met | `agent/session.ts` `toolGate` (PreToolUse hook and `canUseTool`), `write-check.ts`, `worktree-commit.ts`. AG-4 to AG-7; `claude-real.test.ts` (real binary) |
| FR-10 | Met | `interview/tools.ts`, `agent/factory-tools.ts`, `interview/frame.ts`. IT-1 to IT-14 |
| FR-11 | Met | `state/state-repo.ts` (scan before commit), `agent/worktree-commit.ts`. TR-1, TR-3, TR-4, TR-9, TR-12; AG-4 |
| FR-12 | Met | `interview/readiness.ts`. RD-1 to RD-8. Assumption matching by normalized text, as in round 1 |
| FR-13 | Met | `state/runs.ts agentReport`, engine-filled model, usage and artifacts. `readiness.test.ts:59`, `analyst-run.test.ts:93` (developer's; the test plan lists FR-13 fields as not in scope) |
| FR-14 | Met | `state/runs.ts RunBook`, `engine.ts` resume. RS-1, AG-1, AG-3 |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | ST-1, ST-2, CH-16 |
| AC-2 | Met | ST-4 to ST-7 |
| AC-3 | Met | ST-10, ST-11 |
| AC-4 | Met | CH-1, CH-3 (ran as root), CH-4 |
| AC-5 | Met | FS-1 to FS-4 |
| AC-6 | Met | AP-1 to AP-4, AP-6 to AP-8 |
| AC-7 | Met | IT-1 to IT-3, SE-8 |
| AC-8 | Met | DR-1 (non-root, read-only root, no Docker socket), DR-2 (no home marker, no `engine.json`, no engine socket, `/workspace` the only host folder), DR-3 (host outside policy refused). Passed on the PC on `797a8e1` (reported) |
| AC-9 | Met | AG-4 (control), AG-5 ×5, AG-6, AG-7, passed in my run. "Its commits are rejected" is read as "nothing the session changed is committed" (test report gap 2). I accept that reading without the owner. FR-9 says the engine "rejects the session's commits", and the engine makes the session's one commit itself at the end (`engine.ts:736`, `commitWorktree`). Rejecting it means it never lands, locally or on the remote. AG-5 checks both |
| AC-10 | Met | RD-1 to RD-8 |
| AC-11 | Met | TR-4, TR-9, GS-4 |
| AC-12 | Met | RS-1 |
| AC-13 | **Needs owner** (M8) | "No session starts": Met by AG-1 (no Docker command succeeds, no SDK session, run `interrupted`, no resume counted), AG-2 (control) and AG-3. "The owner is told why": the engine writes an `analyst_session` entry ("No analyst session started: … The run resumes at the next engine start.", `engine.ts:784`) to the transcript, and a log warning. AG-1 checks the transcript. No channel method carries it: `engine.status` gives `{ id, stage, active_agents }` only (`interface-contracts.md:239`), and `interview.next` returns `null`. So an owner in `/software-factory:spec-interview` sees no message unless they open the transcript or the log. Whether that counts as "told" is the owner's call (test report gap 1) |
| AC-14 | Met | DR-3, DR-6 (PC, `797a8e1`, reported) |
| AC-15 | Met | DR-4, DR-5 (control), DR-6 (PC, `797a8e1`, reported) |
| AC-16 | Met | DR-2, DR-7: the credential is in no file, no `/proc` environment and not in `docker inspect`, in both containers (PC, `797a8e1`, reported) |
| AC-17 | Met | CS-1 (with the engine's session options, no planted hook from project, local or user settings runs, the `.mcp.json` server doesn't start, and no `CLAUDE.md` text reaches the model), CS-2 (control: all of them load when the sources are on). Real Claude Code 2.1.311, passed in my run |
| AC-18 | Met | GS-1 to GS-3 |
| AC-19 | Met | RD-11 to RD-15 (ran here as root) |
| AC-20 | Met | PIN-1 to PIN-3, PIN-5 |
| AC-21 | Met (accepted residual, v43) | RW-1 (comments, scripts, styles, `hidden`, inline `display:none`/`visibility:hidden`, `<template>`, 5 zero-width and 11 bidi characters), RW-2 (plain text). Text hidden only by stylesheet rules can still reach the reader. The owner accepted that until Alpha (v43); RW-4 holds the test, skipped with that reason |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met | SC-1, SC-2, GS-4, ST-10 |
| SR-2 | Met | ST-7, ST-8, AP-8, AP-12, TR-5, TR-6, SC-5, PIN-3; SDDL anchored (`os/sddl.ts`) |
| SR-3 | Met | IT-6, IT-7, IT-13, IT-14 |
| SR-4 | Met | `log.ts` action log; Gate 2 confirmed. No direct test (deferred by the test plan) |
| SR-5 | Met | PIN-1 to PIN-5, ST-20 |
| SR-6, SR-7 | Met | DR-3, DR-6 (PC, reported); `proxy.test.ts`. L1 (the web reader's `*` grant) is still open with the owner |
| SR-8 | Met | DR-4, DR-6 (PC, reported); `proxy/rules.ts`, `proxy.test.ts` address table |
| SR-9 | Met | DR-2, DR-7 (dummy key only, PC, reported); gateway key swap, own-credential drop, body and beta filtering (`proxy/server.ts`); the v39 exception is limited to the reader's grant (`proxy.test.ts` web-search test: 403 on the analyst's and an unknown credential, and for `web_fetch_*`, `code_execution_*` and `web_search_latest` even on the reader's) |
| SR-10 | Met | CS-1, CS-2 (real binary), AG-4 (one `docker exec` into the analyst container) |
| SR-11 | Met | `git.ts`; GS-1 to GS-4; L7 config refusal |
| SR-12 | Met | `worktree-populate.ts`, `worktree-commit.ts`; RD-11 to RD-15, AG-7 |
| SR-13 | Met | ST-3, ST-12 to ST-19; CI `check_placeholders.py` (H-0088) |
| SR-14 | Met | `docker/cli.ts` sets `DOCKER_CONFIG` to an empty engine-owned folder, as SR-14 now says (v42). Post-start inspect in `docker/plan.ts`, `agent.test.ts` (developer's). The test plan lists inspect mismatches as not in scope; the DR runs show the real inspect passes. Pipe identity deferred to Alpha (v34) |
| SR-15 | Met (Linux real; Windows and macOS through seams) | CH-1 to CH-3, `channel.test.ts`, SDDL tests; see m10 |
| SR-16 | Met | FS-5, FS-6, IT-12 |
| SR-17 | Met | TR-10 to TR-12; L4 open with the owner |
| SR-18 | Met | `config/limits.ts`, `limits.yaml` (H-0087), `analyst-run.test.ts:154` (developer's; test plan says the fake Docker would allow it later). L5 open with the owner |
| SR-19 | Met | `engine.yml` supply-chain job; ratified follow-ups (v40) |
| SR-20 | Met (accepted risk) | SC-4 |
| SR-21 | Met | `fetch_page` only, no `WebFetch`, through the proxy, with stripping and a cap: RW-1 to RW-3. `WebSearch` now passes the gateway on the reader's grant only (v39): `proxy.test.ts` web-search test and `claude-real.test.ts` (the real CLI sends exactly one `web_search_<date>` tool, refused without the grant and passed with it). Query logging from the SDK stream: `agent.test.ts:510`. The search exception has only developer tests (m12) |
| SR-22 | Met | TR-2, RD-9, RD-10 |
| SR-23 | Met | AP-4, AP-5, AP-9, AP-12 to AP-16 |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Two clients on one feature; takeover during approval | Yes: SE-1 to SE-7, AP-10 |
| Approval after the code expired | Yes: AP-tests on expiry |
| GitHub unreachable | Yes: AP-8, AP-12 (fail closed) |
| Same question twice; asking while research runs | Yes: IT-5 (`one_at_a_time`), `research.test.ts:57` |
| Container dies mid-turn; restart with a session open | Yes: RS-1, AG-3, `analyst-run.test.ts:225` |
| Feature started while paused or disabled | Yes: CH-11 to CH-14, ST tests for a disabled project |
| `factory/state` commits the engine didn't make | Yes: TR-11, `remote.test.ts` (L4 false-alarm case open) |
| Disk full while committing | Not tested. The test plan says so and L5 is open. Acceptable at Rapid prototype |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD 1, 2) | Met | Spec v43, status Approved, readiness gate passed on v21. Rows 39 to 43 each cite an owner decision card dated 2026-11-12. No assumptions |
| Architecture / ADRs | Met (cited approved exception) | ADR 0001, 0003, 0004, 0012, 0014 and 0015 are followed. The config-repo placement conflicts with ADR 0009 and ADR 0005, and spec v41 records it as an owner-approved exception for increment 1, to be moved in increment 4. The ADRs themselves don't mention it (m14) |
| Interface contracts | Met | No contract diff since round 1. The `webSearch` flag is on the engine's private proxy stdio message (`proxy/main.ts`), not a contract. Role policy v2.5 already lists `WebSearch` for the reader. CH-*, SE-*, IT-* pass |
| Change-controlled files | Met | `a010208` and `e8a6c0a` ratified (v40). Since round 1 no change-controlled file was edited: the round 2 diff touches only `engine/` and `docs/features/F-007-*`, which this in-progress feature owns. The spec rows each cite a decision card |
| Code quality, readability, maintainability | Met, with findings | `22482e2` is small and fails closed. The exception is opt-in per grant, set only for the role with the tool, and matches an exact `web_search_<8 digits>` form, so `web_search_latest` and other server tools stay refused. Findings: M5 (unchanged), m7, m8, m13 |
| Comments | Met, with findings | New comments say why: `proxy/server.ts:153-154` (the one exception and its owner decision), `Grant.webSearch` doc, `claude-real.test.ts:178,185`, `containers-real.test.ts:183-184` (why the volume goes before cleanup). Outdated: m1, m2 (unchanged) |
| Test tools | Met | The run report's tool table names a best-fit tool for each required type, with a reason and the decision behind it: Vitest (OQ-9), the fake `docker` client at the OQ-5 boundary, the fake SDK at the engine's seam, Docker Desktop for real containers (§7, ADR 0015), Claude Code 2.1.311 (OQ-4), `@vitest/coverage-v8` 5.1.0 (spec v24). Coverage is reported (87.06% lines, 78.55% branches on `4b21531`; 87.1% / 78.68% in my run on `797a8e1`). Stochastic tests aren't required at this level. Substitutes need no new OK: none is a new component |
| Documentation | Met, with findings | The documents the spec requires are updated, as in round 1. The test plan and report now cover milestone 2. Open: README and dev report out of date (m1 to m3); the test report needs a final-commit addendum (M7) |
| Security | Met | Gate 1 and Gate 2 present. Gate 2 is PASS with conditions, with its Highs fixed and tested. The v39 gateway exception loosens an M1 fix on the owner's decision, with real-binary evidence; Gate 2 hasn't seen it (m5). L1, L4, L5 open with the owner, not blocking at this level |

## Findings

### Blocking

None.

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M5 | `src/engine.ts:169-990` | **Maintainability (open since round 1).** `startEngine` is a single 820-line function holding every phase as nested closures over shared mutable maps (`jobs`, `runArtifacts`, `images`, `analystRuns`). Hard to test in isolation and easy to break by side effect. Recommend splitting it per phase (projects, runs, sync) with a context object before increment 2 adds the advisor. |
| M7 | `docs/features/F-007-test-report.md` ("Commit tested", criteria table, "To run on the owner's PC") | **The run report doesn't describe the final commit (DoD 5 record).** It tested `4b21531`, which isn't an ancestor of `797a8e1` and lacks `22482e2`'s gateway change. It still lists AC-8, AC-14, AC-15, AC-16 and SR-6 to SR-9 as "To run on the owner's PC". It still says RW-4 and `WebSearch` wait on the owner, though v39 and v43 have decided both. The evidence exists: my re-run on `797a8e1` and the PC's DR-1 to DR-7 on `797a8e1`. But the record the factory keeps is out of date. **To fix:** the test engineer adds an addendum. It names `797a8e1`, gives the PC results (DR-1 to DR-7, 7/7, 15.6 s, clean teardown), updates the RW-4 and `WebSearch` rows to v43 and v39, and notes the two test edits after their report (m11). |
| M8 | AC-13; `engine.ts:777-785`; `interface-contracts.md:239` | **Needs owner (Product or Interfaces).** When Docker is stopped, the reason is in the transcript and the log only. The owner, working in the skill, gets no message: `engine.status` has no field for it and `interview.next` just returns nothing. **Options:** (A) Accept the transcript entry and log as "told" for increment 1, and add a channel surface (for example a per-feature `note` or `blocked_reason` in `engine.status`) in the VS Code extension increment, as an Interfaces change then. (B) Add that field now: an Interfaces change to Engine control channel, a skill change to show it, and new tests. (C) Change AC-13 to say "the reason is recorded in the transcript". **I recommend A.** The engine already fails closed and resumes when Docker returns (AG-3). The gap is only in where the owner sees the reason, and the extension increment is where engine status gets a real display. |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `engine/README.md:3-13` | Still says "This package is F-007 milestone 1" and "Milestone 2 adds the parts…, each tested with fakes". Out of date. |
| m2 | `engine/src/engine.ts:76-78` | The `resumeAnalyst` doc still says "Milestone 2 starts an Agent SDK session here"; it is now the test seam. |
| m3 | `docs/features/F-007-dev-report.md` | Header still says spec v21 and describes milestone 1 only; no entries for H-0088, v37, v38, `aabaed2`, `8657a80` or `22482e2`. |
| m4 | `engine/test/docker-real.test.ts:57,81` | The developer's AC-8 test name claims "no … owner home" but asserts nothing about it. AC-8 is now covered by DR-2, so this only misleads a reader of that test. |
| m5 | Gate 2 | Gate 2 reviewed `a3a2294`. It hasn't re-reviewed `a061d8a`, `aabaed2`, the H-0088 CI, the v37 and v38 image changes, or now `22482e2`, which re-opens part of the M1 block for the reader. All but `22482e2` tighten. `22482e2` is the owner's decision, narrow, and tested on the real binary. Not required at Rapid prototype; Gate 2 should confirm with the next increment. |
| m6 | `docs/features/` | No `F-007-orchestrator-review.md` yet (DoD 6). Needed before the PR. |
| m7 | `engine/src/agent/session.ts:42,110-118` | Only Glob's `path` is checked, not its `pattern`, so a Glob can list names (not content) under read denies such as `.env`. Unchanged. |
| m8 | `src/agent/page-text.ts:10,15,17`, `src/engine.ts:289,335,459,568,616`, `src/os/ffi.ts:227,245,246` | Very long lines; split the regexes into named parts. Unchanged. |
| m9 | `engine/osv-scanner.toml` | The supply-chain job's "listed, not blocking" output is the only record of unfixed CVEs. Consider keeping the latest list in the run report. |
| m10 | SR-15 | The "another user's peer" and "forced FFI error" tests run against the real OS only on Linux. List as a known issue for promotion. |
| m11 | `engine/test/acceptance/containers-real.test.ts:183-190,261-262` (`af63474`, `797a8e1`) | After the test engineer's report, two commits outside the test engineer's run edited their DR file. The teardown changed, and DR-5's control regex now also accepts "documentation examples". Both are reasonable (example.com changed its page; the volume is kept for resume by design). DR-5 is a control, and DR-4 and DR-6 are unchanged. But the test engineer should confirm the edits in their addendum (M7), since they own the test. |
| m12 | v39 gateway exception | The test engineer's suite doesn't test the web-search exception. Only the developer's `proxy.test.ts` and `claude-real.test.ts` do (the test plan predates v39). An acceptance test is a good addition: the reader's credential passes a `web_search_<date>` request, and the analyst's is refused. |
| m13 | `proxy/server.ts:149-158` | The gateway passes the reader's `web_search` tool with whatever `max_uses` and `allowed_domains` the request carries, and adds no cap of its own. v39 didn't ask for one, and `research_web` is capped per question and per session (SR-18). The number of searches inside one research call is up to Claude Code. Log it for the Alpha review of SR-18. |
| m14 | `docs/adr/0009-factory-state-branch.md`, `docs/adr/0005-branching-feature-agent-branches-squash.md` | The v41 exception is recorded only in the F-007 spec's change log. Someone reading the ADRs won't find it. Add a pointer (owner approval needed, `docs/` is change-controlled) or carry it in the increment 4 spec. |

## Counts

- Blocking: 0.
- Major: 3 (M5, M7, M8). M8 needs the owner.
- Minor: 14 (m1 to m14).
- Lines: **0 Not met**. **1 Needs owner** (AC-13).

## To reach PASS at Rapid prototype

1. **Owner, one card (M8):** decide whether the transcript entry and log count as "the owner is told why" for AC-13. I recommend option A: accept for increment 1, and add a channel surface in the extension increment.
2. **Test engineer (M7, m11):** add an addendum to the run report. Name `797a8e1`, record the PC's DR-1 to DR-7 results, bring the RW-4 and `WebSearch` rows up to v43 and v39, and confirm the two DR test edits.
3. Before the PR: the orchestrator review note (m6), and the README and dev report updates (m1 to m3).
