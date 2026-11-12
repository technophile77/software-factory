# F-007 Validation report

- **Feature:** F-007 Run spec interviews on the real engine, spec v38
- **Judge:** validation-judge
- **Date:** 2026-11-12
- **Commit:** `4504497` (`claude/project-thread-xnrw8z`). The diff is `git diff origin/main...HEAD`: 82 commits, 139 files. Most of it is the new `engine/` package. The rest is `.github/workflows/` (engine.yml, docs-checks.yml, extension.yml), `scripts/` (`check_placeholders.py`, `osv_fixable.py` and their tests), `docs/interface-contracts.md`, `agents/web-reader/AGENT.md`, `.gitignore`, the onboarding checker and template, and the F-007 documents.
- **Contracts:** Engine control channel v1.3 with H-0084 (served as 1.2, FR-4 v22). Interview tools v1.0 (H-0082). Role policy v2.5 (H-0083). Project manifest v1.3 and v1.4 (H-0080, H-0087). Agent report v1.1. Inbox item v1.1.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Not met line or a Blocking finding still fails.
- **Verdict:** **FAIL**
  - **9 lines are Not met.** AC-8, AC-9, AC-13, AC-14, AC-15, AC-16, AC-17 and AC-21 have no test from the test engineer. Their test plan and run report cover milestone 1 only. The report is on `925e850`, about 70 commits back, and says "not a pass". Developer tests exist for these criteria and pass, apart from AC-17, which has no behavioural test at all. My role forbids taking developer evidence in place of the independent run (DoD 5). The Test tools line is also Not met, because the run report's tool table is out of date and no coverage is reported for the final commit.
  - **5 lines are Needs owner:** Architecture (where the feature branch and `factory/state` live), SR-14 (`DOCKER_CONFIG`), SR-21 together with §2 step 5 (the gateway's server-tool block also blocks `WebSearch`), AC-21's residual risk, and the change-controlled edits made after H-0088 without a recorded approval.
  - Blocking: 0. Major: 6. Minor: 10.
  - The product itself is in good shape. The full suite passes in my run on `4504497`. Gate 2 has no Critical finding, and its High findings are fixed and tested against the real Claude Code binary. Most of what fails is missing independent evidence, not broken behaviour.

## My own run (evidence source)

On `4504497`, Linux container, Node 22, running as root. The working tree was clean before this report.

| Step | Result |
|---|---|
| `cd engine && npm ci --ignore-scripts` | OK |
| `npm run typecheck` (engine and `test/acceptance`) | Clean, exit 0 |
| `npx vitest run` (unit and acceptance projects) | **29 files: 28 passed, 1 skipped. 474 tests: 468 passed, 6 skipped.** Matches the figure I was given. The skipped file is `test/docker-real.test.ts` (gated on `FACTORY_DOCKER_TESTS=1`, no Docker here). The other skips are platform-gated: macOS/Windows parent lookup (`units.test.ts:110`) and FX-7 (Windows). `test/claude-real.test.ts` (the H1 gate against the real Claude Code binary) **ran and passed** |
| `npx vitest run --project unit --coverage` (reports to my scratch folder, none in the repo) | Unit project: lines 85.6%, branches 76.5%, statements 81.2%, functions 81.3% |
| `python3 -m unittest discover -s scripts/tests` | 14 run, OK |
| `python3 -m unittest discover -s plugins/software-factory/skills/onboard-repo/tests` | 318 run, OK, 1 skipped (no python3.10) |
| `python3 scripts/check_placeholders.py`, `python3 scripts/check_docs.py` | Both pass |
| Search for real owner values: `Iv1.`+16 hex, `Ov23li`+14, numeric `github_id`, `oauth_client_id` values | **None found.** The only matches are the placeholder script's own bad-value tests, placeholder fixtures (1000001, 2000001, 424242, 3003, 7777777, `Iv1.placeholder0001`, `Iv1.example`, `Iv1.someoneelse`) and regex replacements |

Evidence I didn't produce, as reported to me by the owner-side session (I record it, I didn't reproduce it):
- GitHub CI on `4504497` is green: engine build-and-test on ubuntu, macOS and Windows, supply-chain (OSV), and docs-checks.
- On the owner's Windows 11 PC, at `4504497`:
  - `test/docker-real.test.ts`: 4 of 4 pass (AC-8, AC-14, AC-15, AC-16).
  - Full suite: 446 passed, 0 failed, 28 skipped.
  - The agent image is 781 MB, runs as user 1000:1000 on base `node:26.13.1-trixie-slim@sha256:e6bedef2…`, and has the `apt-get upgrade` layer.
- A real gateway turn with a subscription token went through at `12ffb06`.

### Is the test engineer's run enough for `4504497`?

**No.**
- `F-007-test-report.md` tested `925e850`, reported 4 failures, and says "Result: not a pass".
- `F-007-test-plan.md` is written against spec v21 and scopes itself to "milestone 1 of 2 (no Docker)". It lists AC-8, AC-9, AC-13 to AC-18, AC-21, SR-6 to SR-10, SR-14, SR-18 and SR-21 under "What isn't tested here", as milestone 2.
- No milestone 2 test plan or run report exists. The suite under `engine/test/acceptance/` has been adapted since (ST-1 now expects 1.2, RS-1 is wired, Windows fixes), and it all passes on `4504497` in my run and in CI. So I accept the test engineer's tests as evidence for the milestone 1 criteria, as F-006 accepted a re-run (F-006 m4). The milestone 2 criteria have no test-engineer test to accept.

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `engine/` package; `src/cli.ts start`; `startEngine` in `src/engine.ts`. ST-1, CH-16; one engine across projects in FS-5, FS-6 |
| FR-2 | Met | `src/config/manifest.ts` (read from `refs/heads/main`), `authorize.ts`, `paths-file.ts`; refusal files a Security item and stops only that project. ST-4 to ST-7, ST-20 |
| FR-3 | Met | `config/authorize.ts` `billingMismatch`. ST-10, ST-11 |
| FR-4 | Met | `channel/*`, `constants.ts` (served 1.2, per spec v22), -32008 (H-0084), advisor kinds `kind_not_allowed`. ST-1, CH-1 to CH-16 |
| FR-5 | Met | `engine.ts` `feature.start`. FS-1 to FS-5. Which repo the branch is made in: see the Architecture line |
| FR-6 | Met | `channel/methods.ts`, `sessions.ts`, `interview/feature.ts`. SE-1 to SE-18, AP-10 |
| FR-7 | Met | `github.ts`, `sessions.ts`. AP-1 to AP-16 |
| FR-8 | Met | `src/agent/sandbox.ts`, `docker/plan.ts` (post-start inspect), `docker/image.ts`, `agent.Dockerfile`. Unit: `agent.test.ts` (inspect mismatches, session group), `analyst-run.test.ts` (full path). Real Docker: `docker-real.test.ts` 4/4 on the owner's PC (reported). See M1 for the missing independent test |
| FR-9 | Met | `agent/session.ts` `toolGate` as both PreToolUse hook and `canUseTool` (Gate 2 H1 fix); `write-check.ts`, `worktree-commit.ts`. `claude-real.test.ts` (real binary, passed in my run), `policy.test.ts` AC-9 cases, `analyst-run.test.ts` AC-9 |
| FR-10 | Met | `interview/tools.ts`, `agent/factory-tools.ts`, `interview/frame.ts`. IT-1 to IT-14 |
| FR-11 | Met | `state/state-repo.ts` (scan before commit), `agent/worktree-commit.ts`. TR-1, TR-3, TR-4, TR-9, TR-12 |
| FR-12 | Met | `interview/readiness.ts`. RD-1 to RD-8. Assumption matching is by normalized text (dev interpretation 4). The spec says only "matches", so I accept it; the owner's confirmation is still listed as open |
| FR-13 | Met | `state/runs.ts agentReport`, engine-filled model, usage and artifacts. `readiness.test.ts:59`, `analyst-run.test.ts:93` |
| FR-14 | Met | `state/runs.ts RunBook`, `engine.ts` resume. RS-1, `engine.test.ts:247`, `analyst-run.test.ts:225` |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | ST-1, ST-2, CH-16 (test engineer's, passed on `4504497`) |
| AC-2 | Met | ST-4 to ST-7 |
| AC-3 | Met | ST-10, ST-11 |
| AC-4 | Met | CH-1, CH-3 (ran as root), CH-4 |
| AC-5 | Met | FS-1 to FS-4 |
| AC-6 | Met | AP-1 to AP-4, AP-6 to AP-8 |
| AC-7 | Met | IT-1 to IT-3, SE-8 |
| AC-8 | **Not met** (evidence) | No test-engineer test. Developer's gated `docker-real.test.ts:57` passed 4/4 on the owner's PC (reported). Its assertions cover uid 1000, the read-only root, no `docker.sock` and no npm, but not the owner's home or `engine.json` (m4). The mounts are pinned by the post-start inspect (`plan.ts`, `agent.test.ts`) |
| AC-9 | **Not met** (evidence) | No test-engineer test. Developer tests `policy.test.ts:172,228` and `analyst-run.test.ts:179` pass in my run |
| AC-10 | Met | RD-1 to RD-8 |
| AC-11 | Met | TR-4, TR-9, GS-4 (the push seam now exists) |
| AC-12 | Met | RS-1 (test engineer's, passes now); also `analyst-run.test.ts:225` |
| AC-13 | **Not met** (evidence) | No test-engineer test. Developer test `analyst-run.test.ts:200` passes |
| AC-14 | **Not met** (evidence) | No test-engineer test. Developer: `proxy.test.ts:142`; `docker-real.test.ts:64` on the PC (reported) |
| AC-15 | **Not met** (evidence) | No test-engineer test. Developer: `proxy.test.ts:161`; `docker-real.test.ts:72` on the PC (reported) |
| AC-16 | **Not met** (evidence) | No test-engineer test. Developer: `docker-real.test.ts:81` checks the environment only, not files (m4) |
| AC-17 | **Not met** (evidence) | No test anywhere plants `CLAUDE.md` or `.claude/settings.json` hooks and shows they don't load. `agent.test.ts:384` only asserts `settingSources: []`, and `containerSpawn` requires `--setting-sources=`. Gate 2's probe 3 showed the behaviour, but it was a throwaway outside the repo |
| AC-18 | Met | GS-1 to GS-3 (test engineer's: planted hooks, `.husky`, fsmonitor, filters); `units.test.ts:413` |
| AC-19 | Met | RD-11 to RD-15 (ran here as root) |
| AC-20 | Met | PIN-1 to PIN-3, PIN-5 |
| AC-21 | **Not met** (evidence) and **Needs owner** | No test-engineer test. Developer: `proxy.test.ts:302-330` (hidden elements, zero-width, bidi). Text hidden only by a stylesheet class still reaches the reader (dev report; Gate 2 Info; residual not yet accepted), so "hidden text doesn't reach the reader" holds only for inline hiding |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met | SC-1, SC-2, GS-4, ST-10; proxy credential over stdin; askpass |
| SR-2 | Met | ST-7, ST-8, AP-8, AP-12, TR-5, TR-6, SC-5, PIN-3; SDDL now anchored (Gate 2 M2 fix, `os/sddl.ts`) |
| SR-3 | Met | IT-6, IT-7, IT-13, IT-14 |
| SR-4 | Met | `log.ts` action log; Gate 2 confirmed. No direct test (the test plan defers it) |
| SR-5 | Met | PIN-1 to PIN-5, ST-20. The scope question (pin more keys) is the owner's and doesn't change SR-5 as written |
| SR-6, SR-7 | Met | `sandbox.ts`, proxy tests, `docker-real` AC-14 (reported). L1 (the web reader's `*` grant) is still open with the owner |
| SR-8 | Met | `proxy/rules.ts` with the L6 ranges; `proxy.test.ts` address table |
| SR-9 | Met | Gateway key swap, own-credential drop, M1 body and beta filtering (`proxy/server.ts:104-160, 262-317`; `proxy.test.ts:239-254`); real subscription turn at `12ffb06` (reported) |
| SR-10 | Met | `session.ts sessionOptions`, `containerSpawn`. See AC-17 for the missing behavioural test |
| SR-11 | Met | `git.ts`; GS-1 to GS-4; L7 config refusal |
| SR-12 | Met | `worktree-populate.ts` (H2 fix, plus `aabaed2` on Windows), `worktree-commit.ts`, RD-11 to RD-15, `worktree-populate.test.ts` |
| SR-13 | Met | ST-3, ST-12 to ST-19; CI `check_placeholders.py` (H-0088) |
| SR-14 | **Needs owner** | `docker/cli.ts` sets `DOCKER_CONFIG` to an empty engine-owned folder. SR-14 says it is cleared. The reason is sound (clearing would load the owner's `~/.docker/config.json`), but it is a departure from the spec text and still waits on Gate 2 owner decision 7. Pipe identity is deferred to Alpha (spec v34) |
| SR-15 | Met (Linux real; Windows and macOS through seams) | CH-1 to CH-3, `channel.test.ts` real FFI on Linux, SDDL tests; see m10 |
| SR-16 | Met | FS-5, FS-6, IT-12 |
| SR-17 | Met | TR-10 to TR-12; `remote.test.ts`. L4 (false alarm after a failed push) is open with the owner |
| SR-18 | Met | `config/limits.ts`, `limits.yaml` (H-0087), `analyst-run.test.ts:154`. L5 is open with the owner |
| SR-19 | Met | `engine.yml` supply-chain job (OSV 2.7.1 by SHA-256, both lockfiles, the image, `osv_fixable.py`); no npm in the final image; `contents: read`; gitleaks pinned |
| SR-20 | Met (accepted risk) | SC-4 |
| SR-21 | **Needs owner** | `fetch_page` is the only fetch path, and `WebFetch` is refused (met). But see M2: the M1 gateway block refuses every tool whose `type` isn't `custom`. By analysis, Claude Code's `WebSearch` runs as Anthropic's server-side `web_search` tool, so the web reader's search, which H-0083 says "stays", would be refused at the gateway. Nothing tests `WebSearch` end to end |
| SR-22 | Met | TR-2, RD-9, RD-10 |
| SR-23 | Met | AP-4, AP-5, AP-9, AP-12 to AP-16 |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Two clients on one feature; takeover during approval | Yes: SE-1 to SE-7, AP-10 |
| Approval after the code expired | Yes: AP-tests on expiry |
| GitHub unreachable | Yes: AP-8, AP-12 (fail closed) |
| Same question twice; asking while research runs | Yes: IT-5 (`one_at_a_time`), `research.test.ts:57` |
| Container dies mid-turn; restart with a session open | Yes: RS-1, `analyst-run.test.ts:225` |
| Feature started while paused or disabled | Yes: CH-11 to CH-14, ST tests for a disabled project |
| `factory/state` commits the engine didn't make | Yes: TR-11, `remote.test.ts` (L4 false-alarm case open) |
| Disk full while committing | Not tested. The test plan says so and L5 is open. Acceptable at Rapid prototype |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD 1, 2) | Met | Spec v38, status Approved, readiness gate passed on v21. Every later change has an owner approval row in §14. No assumptions |
| Architecture / ADRs | **Needs owner** (M4) | ADR 0001, 0003, 0004, 0012, 0014 and 0015 are followed (engine on Node, separate process, containers per role, device flow, credential gateway). Conflict: the engine creates the feature branch, spec, transcript and `factory/state` worktree in the project's **config repo** (dev interpretation 2; test report gap 2). ADR 0009 puts `factory/state` in "each managed repo", ADR 0010 puts only cross-repo items on the config repo, and FR-5 and ADR 0005 put feature branches in the code repo. No approved exception is recorded |
| Interface contracts | Met | Every contract diff is an approved item: H-0080 to H-0084, H-0087 (commits `053c2e7`, `6eda8c5`, `75caf97`). Contract tests: CH-*, SE-*, IT-* pass. Agent report v1.1 is used as is: `interrupted` goes in the engine record and the summary, `partial` in the outcome. RS-1 checks it this way |
| Change-controlled files | **Needs owner** (M3) | H-0085 to H-0088 and the spec v37 and v38 changes are approved. `a010208` (engine.yml: a copied build context with an empty `skills/`) and `e8a6c0a` (osv_fixable.py: Debian release matching) both came after H-0088 and v37, and their commits cite no approval. Both look like faithful fixes to approved intent, but CLAUDE.md rule 3 needs approval for every edit |
| Code quality, readability, maintainability | Met, with findings | Strict parsing that fails closed throughout (SDDL, manifest, limits, gateway body, tree checks). Small, focused modules outside `engine.ts`. Findings: M5 (`startEngine` is one 820-line closure), m7, m8 |
| Comments | Met, with findings | Comments mostly say why, for example `worktree-populate.ts:129-131` (Windows has no O_NOFOLLOW), `proxy/server.ts:104-111` (why betas are allow-listed), `session.ts:93-99`. Outdated: m1, m2 |
| Test tools | **Not met** | `F-007-test-report.md` "Tool choice" still says coverage "Not run… stays open until the owner decides". The owner approved `@vitest/coverage-v8` in spec v24, and `npm run coverage` exists, but no run report gives coverage for the final commit. "Reported" is the Rapid prototype bar (`testing-strategy.md`). My own figure (unit project: 85.6% lines, 76.5% branches) is not the test engineer's report. The rest of the table (Vitest, the `node:net` RPC client, built-in fakes) is sound |
| Documentation | Met, with findings | The spec requires contracts, the onboarding template and checker, `.gitignore`, the web reader's AGENT.md and the engine CI, and all are updated. `engine/README.md` exists. The dev report misses the last rounds (m3) and the README's framing is out of date (m1). The test report is covered under M1 |
| Security | Met | Gate 1 and Gate 2 are present. Gate 2 is PASS with conditions: no Critical, 2 High, 4 Medium, 7 Low. H1, H2, M1, M2, L2, L6 and L7 are fixed (`a061d8a`, `aabaed2`), and H1 is verified here by `claude-real.test.ts` against the real binary. M3 is deferred to Alpha (v34). M4 and L3 are done (H-0088). L1, L4 and L5 are open with the owner, which doesn't block at this level. Gate 2 hasn't re-reviewed the fixes (m5) |

## Findings

### Blocking

None. The FAIL comes from the Not met lines.

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `docs/features/F-007-test-plan.md`, `F-007-test-report.md`; `engine/test/acceptance/` | **No independent testing of milestone 2, and no run report for the final commit (DoD 5).** The plan covers milestone 1 at spec v21. The report covers `925e850` and says "not a pass". AC-8, AC-9, AC-13 to AC-17 and AC-21 have only the developer's own tests. AC-17 has no behavioural test at all: nothing plants `CLAUDE.md` or hooks and shows they don't load. Coverage isn't reported. **To fix:** the test engineer writes a milestone 2 plan from the spec (black box, without reading the developer's tests). It adds acceptance tests for AC-8, AC-9 and AC-13 to AC-17, plus AC-21: AC-8, AC-14, AC-15 and AC-16 gated on real Docker like `docker-real.test.ts`, and AC-17 against the real binary like `claude-real.test.ts`. It then runs the whole suite on the final commit with coverage, and rewrites the run report and its tool table. The owner's PC can run the gated part. |
| M2 | `engine/src/proxy/server.ts:126-152` (`refusedBody`); spec v33; H-0083; `agents/web-reader/AGENT.md:11-12`; spec §2 step 5 | **Needs owner (Product, Security).** The gateway refuses any `tools` entry whose `type` isn't `custom`, as the owner chose (v33). By analysis (not run: nothing tests `WebSearch` end to end), Claude Code's `WebSearch` sends Anthropic's server-side `web_search` tool through this same gateway, so it would get 403. The web reader's fixed tools are `fetch_page` and `WebSearch`. With the search refused, a `research_web` query can only reach pages whose addresses the model already knows, so "More information" (§2 step 5) can't do what H-0083 and SR-21 describe. Gate 2 suggested keeping `web_search` for a web-reader grant "if the owner wants it", but the v33 decision didn't say. **Options:** (A) allow `web_search_*` only on the web reader's gateway credential, perhaps with `allowed_domains` unset and `max_uses` capped; the searches run on Anthropic's side, outside SR-8, but return only results, and the pages are still fetched through `fetch_page`. (B) Keep the block, drop `WebSearch` from Role policy v2.5 (an Interfaces change), and accept that research needs addresses. (C) Add a search tool in the engine with a search API (a new component and S4.1 review). **I recommend A**, with a real-binary test that a web reader search succeeds and an analyst-credential search is refused. |
| M3 | `a010208` (`.github/workflows/engine.yml`), `e8a6c0a` (`scripts/osv_fixable.py`, its test) | **Needs owner (configuration hygiene).** Two edits to change-controlled files came after H-0088 and v37 and record no approval. `a010208` builds the CI image from a copied context with an empty `skills/` folder, which is needed because the engine adds skills per project. `e8a6c0a` counts a Debian fix as available only when it is for the same Debian release. Both are narrow and match the approved intent, and I see nothing wrong in them. But CLAUDE.md rule 3 asks for explicit approval of every edit. **I recommend** the owner ratifies both as follow-ups to H-0088 and v37, recorded in the spec change log. |
| M4 | `src/engine.ts` (feature branch, `.factory` worktree and transcript in the config repo); ADR 0009 "Each managed repo…"; ADR 0010; ADR 0005; dev report interpretation 2; test report gap 2 | **Needs owner (Architecture).** The engine treats the project's config repo as the repo it works on: `feature/F-nnn-*` branches, specs, `factory/state`, transcripts and Agent reports all go there. The ADRs put `factory/state` and feature work in each managed (code) repo, and only cross-repo items in the config repo. In tests the config repo "doubles as the managed clone", so the split has never been exercised. This is fine for the first increment if the owner says so, but it decides where every later increment writes. **Options:** (A) approve it for increment 1 as a recorded exception, and move to managed repos in increment 4 (build to PR). (B) Fix it now. I recommend A, with a note in ADR 0009 or a new ADR. |
| M5 | `src/engine.ts:169-990` | **Maintainability.** `startEngine` is a single 820-line function. It holds every phase (config, pins, channel, sessions, transcripts, fetch and sync, the analyst runs, reports, shutdown) as nested closures that share mutable maps (`jobs`, `runArtifacts`, `images`, `analystRuns`). It is readable in parts, but hard to test in isolation and easy to break by side effect. Seven lines in it, and others elsewhere, run past 200 characters (m8). Recommend splitting it into modules per phase (projects, runs, sync) that take a context object, before increment 2 adds the advisor. |
| M6 | SR-14 and AC-21 interpretations (dev report "Interpretations"; Gate 2 owner decisions 6 and 7) | **Needs owner (Security).** Two developer readings depart from the spec text and are still unconfirmed. (a) `DOCKER_CONFIG` points to an engine-owned empty folder instead of being cleared (SR-14). I recommend approving it as written, since it is stricter in practice. (b) Text hidden only by a stylesheet class reaches the web reader. AC-21 says hidden text doesn't. I recommend accepting this as a residual risk for Rapid prototype, with the fix before Alpha. Gate 2's other open items (L1, L4, L5, the SR-5 scope, "refuse if any DNS answer is blocked", "the commit includes ignored files", "one network per run") don't change whether a requirement is met, so I leave them to the owner's existing list. |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `engine/README.md:3-13` | Says "This package is F-007 milestone 1, … the analyst's interview tools, as plain functions" and "Milestone 2 adds the parts…, each tested with fakes". Both are out of date: the tools are MCP tools, the analyst runs end to end, and there are real-Docker and real-binary tests. |
| m2 | `engine/src/engine.ts:76-78` | The `resumeAnalyst` doc says "Milestone 2 starts an Agent SDK session here". Milestone 2 now does that through `agents`. `resumeAnalyst` is the test seam. Say so. |
| m3 | `docs/features/F-007-dev-report.md` | The header still says spec v21 and "no Agent SDK yet". There is no entry for H-0088, the v37 base-image move, the v38 `apt-get upgrade`, `aabaed2` or `8657a80`. |
| m4 | `engine/test/docker-real.test.ts:57,81` | The AC-8 test's name claims "no … owner home", but it asserts nothing about the home folder or `engine.json`. AC-16 checks only the environment, not files, and the AC says "environment or files". The mount inspection covers it indirectly. |
| m5 | Gate 2 | Gate 2 reviewed `a3a2294`. It hasn't re-reviewed `a061d8a`, `aabaed2`, the H-0088 CI or the v37 and v38 image changes. All of them tighten, and H1 is proven by a test here. At Rapid prototype I don't require a re-review, as for F-006 (n4). Gate 2 should confirm with the next increment. |
| m6 | `docs/features/` | There is no `F-007-orchestrator-review.md` (DoD 6). It is needed before the PR. |
| m7 | `engine/src/agent/session.ts:42,110-118` | Only Glob's `path` is checked, not its `pattern`, so a Glob from an allowed folder can list the names (not the content) of files under read denies, such as `.env`. That is low impact, but the deny lists exist to hide these files. |
| m8 | `src/agent/page-text.ts:10,15,17` (regexes of 255 to 341 characters), `src/engine.ts:289,335,459,568,616`, `src/os/ffi.ts:227,245,246` | Very long lines. Split the regexes into named parts. |
| m9 | `engine/osv-scanner.toml` | The file is empty, as intended. The supply-chain job's "listed, not blocking" output of unfixed CVEs is the only record of them. Consider keeping the latest list in the run report. |
| m10 | SR-15 | The "another user's peer" and "forced FFI error" negative tests run against the real OS only on Linux. On Windows and macOS they run through the `WindowsApi`/`UnixApi` seams. The multi-user parts are deferred to Alpha (v34). The rest should be listed as a known issue for promotion. |

## Counts

- Blocking: 0.
- Major: 6 (M1 to M6). M2, M3, M4 and M6 need the owner.
- Minor: 10 (m1 to m10).
- Lines: **9 Not met** (AC-8, AC-9, AC-13, AC-14, AC-15, AC-16, AC-17, AC-21, Test tools). **5 Needs owner** (Architecture, Change-controlled files, SR-14, SR-21, AC-21).

## To reach PASS at Rapid prototype

1. **Test engineer (M1):** a milestone 2 test plan and acceptance tests for AC-8, AC-9, AC-13 to AC-17 and AC-21, written black box from the spec. Then a full run on the final commit, with the gated real-Docker part on the owner's PC, coverage reported, and a new run report and tool table.
2. **Owner, one card (Security and Product, M2):** what to do about `WebSearch` behind the server-tool block. I recommend option A, with a real-binary test.
3. **Owner, one card (Architecture, M4):** approve config-repo placement for increment 1 as a recorded exception (recommended), or move to managed repos now.
4. **Owner, one card (Security, M6):** approve the `DOCKER_CONFIG` reading. Accept stylesheet-hidden text as a residual risk until Alpha.
5. **Owner (M3):** ratify `a010208` and `e8a6c0a` as follow-ups to H-0088 and v37.
6. Before the PR: the orchestrator review note (m6), the dev report and README updates (m1 to m3).
