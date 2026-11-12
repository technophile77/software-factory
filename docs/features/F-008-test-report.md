# F-008 test report: Security Gate 1 on the engine

Report per `docs/testing-strategy.md` § Run report. The plan, with the full
criteria-to-test map, the edge cases and what is out of scope, is
`F-008-test-plan.md`.

## Run

| | |
|---|---|
| Commit tested | `8f3a566` (Gate 2 fixes), with the test engineer's uncommitted files on top: `engine/test/acceptance/gate1.test.ts`, `support/gate1.ts`, a one-line role check in `support/agents.ts`, and these two documents. No product file was changed |
| Command | `cd engine && npm run typecheck && npx vitest run --coverage --coverage.reportsDirectory=<scratch folder outside the repo> --coverage.reportOnFailure=true` |
| Environment | Linux container, Node 22.23.4, system git, as root. No Docker |
| Typecheck | Clean (engine and `test/acceptance`) |
| Test files | 36: 33 passed, 1 failed (`acceptance/gate1.test.ts`), 2 skipped (real Docker) |
| Tests run | 614 |
| Passed | 595 |
| Failed | 5, all in `gate1.test.ts`, all product (one of them a spec/code disagreement waiting on the owner) |
| Skipped | 14, each with its reason below |

The suite was run twice in full with the same result.

| Project | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| Acceptance (`test/acceptance/`) | 305 | 291 | 5 | 9 |
| of which F-008 `gate1.test.ts` | 66 | 61 | 5 | 0 |
| Unit (`test/*.test.ts`, the developer's) | 309 | 304 | 0 | 5 |

**Result: fail.** Three product failures (AC-13/SR-12, AC-17/SR-11 through
a worktree bug, and the AC-7 own-wording case that the code now handles
differently from the spec).

## Coverage

`@vitest/coverage-v8` 5.1.0, whole suite, over `engine/src/**`:

| Measure | Covered |
|---|---|
| Lines | 88.22% (4,151 / 4,705) |
| Branches | 79.66% (3,319 / 4,166) |
| Statements | 83.99% (5,043 / 6,004) |
| Functions | 84.44% (863 / 1,022) |

The bar at Rapid prototype is "reported".

## Tool choice

As in the plan: Vitest 5.1.0 with the milestone 2 fakes (fake `docker`,
fake Agent SDK, fake GitHub, fake gitleaks); `yaml` 2.9.1 (an engine
dependency) to parse inbox front matter; `@vitest/coverage-v8` 5.1.0. No
real-Docker test was written for F-008 (see "Didn't run").

## Criteria to tests

| Criterion | Tests | Status |
|---|---|---|
| AC-1 | G1-1, G1-2 | Pass |
| AC-2 | G1-4, G1-5 | Pass |
| AC-3 | G1-6, G1-7 ×4 | Pass (fakes; real-Docker network route not run) |
| AC-4 | G1-8, G1-9 ×4 | Pass |
| AC-5 | G1-10 ×10, G1-11 ×4 | Pass |
| AC-6 | G1-3 | Pass |
| **AC-7** | G1-12, G1-13, G1-14 pass; **G1-15 fails** | **Fail** (owner's own wording; see F-3) |
| AC-8 | G1-16, G1-17 | Pass |
| AC-9 | G1-18, G1-19 | Pass |
| AC-10 | G1-20 ×3 | Pass |
| AC-11 | — | Not run: real trial on the owner's project, out of scope |
| AC-12 | G1-23, G1-24 | Pass |
| **AC-13** | G1-25, G1-26, G1-27 pass; **G1-28 ×3 fail** | **Fail** (see F-1) |
| AC-14 | G1-29 | Pass |
| AC-15 | G1-30 ×3 | Pass |
| AC-16 | G1-31, G1-32, G1-33 ×3 | Pass |
| **AC-17** | G1-12, G1-37, G1-38, G1-40 pass; **G1-36 fails** | **Fail** (see F-2) |
| AC-18 | G1-37, G1-38, G1-39 | Pass |
| FR-3, FR-10, FR-11, FR-12 | G1-21; G1-11, G1-18, G1-19; G1-3, G1-6, G1-22, G1-40; G1-1, G1-3 | Pass |
| SR-1, SR-4, SR-5, SR-7, SR-8, SR-9, SR-10 | as in the plan | Pass |
| **SR-11** | G1-40 passes; **G1-36 fails** | **Fail** (F-2) |
| **SR-12** | **G1-28 ×3** | **Fail** (F-1) |

The coordinator's five changes in `8f3a566`: 1 (question must carry the
fix as `suggested`) is exercised by G1-12 and G1-37 to G1-39, which pass;
2 is F-3; 3 (raw scan) by G1-30, pass; 4 (spec on the branch must still pass
the checks) is not tested separately: no test changes the branch behind the
engine; 5 (S id in any Markdown form) by G1-33 ×3, pass.

## Failures: product

### F-1. AC-13 / SR-12: other files in the report folder are ignored, and the report is accepted

- **Tests:** G1-28 ×3, `engine/test/acceptance/gate1.test.ts:677`.
- **Spec:** AC-13 "given … any path other than the named one is changed,
  then … the report is invalid or the session's changes are rejected";
  SR-12 "The write check accepts exactly the run's named report path, not
  every path the role's write glob allows"; FR-2 (the folder is
  engine-owned and starts empty).
- **Expected:** a session that writes its valid named report plus
  `security-reviewer-99.json`, `notes.txt` or `sub/security-reviewer-1.json`
  in the same report folder does not get its report accepted (stage not
  `readiness_gate`, no rendering).
- **Actual:** the report is accepted, the rendering is committed and the
  feature moves to `readiness_gate`
  (`AssertionError: expected 'readiness_gate' not to be 'readiness_gate'`).
  Log: `F-001: Gate 1 run R-… filed 0 finding(s); the feature is at readiness_gate.`
- **Where:** `engine/src/engine.ts:1039-1040`: the check reads only the
  named file (`readReportFile(reportDir, reportName, …)`,
  `engine/src/gate1/report.ts:75`); nothing looks at what else is in
  `reportDir`, and the worktree check (`verify`) doesn't see that folder.

### F-2. AC-17 / SR-11 (and FR-1): a second Gate 1 run for the same feature can't start: "an internal error"

- **Test:** G1-36, `gate1.test.ts:847` (waiting for the second run).
- **Spec:** FR-1 (at engine start a feature at `security_gate_1` gets a
  run), FR-10, SR-11 (three runs, then a Security item), AC-17.
- **Expected:** after run 1 fails (report invalid twice), the next engine
  start runs Gate 1 again; after three failed runs the fourth doesn't start
  and a Security item is filed.
- **Actual:** after the restart no second run is recorded; the log says
  `F-001: Gate 1 stopped: an internal error`, and the feature sits at
  `security_gate_1` with nothing in the transcript about why. Timed out
  after 40 s waiting for 2 settled reviewer runs.
- **Likely cause (not confirmed in product code, which I didn't change):**
  `engine/src/engine.ts:980` calls `prepareWorktree` for the fixed
  `<feature>-gate1` folder with no `git_dir` for a new run;
  `engine/src/agent/runtime.ts:106-108` runs `git worktree prune` *before*
  removing the old folder, then `git worktree add` on a path git still
  has registered. Git refuses that: reproduced by hand,
  `fatal: '../X' is a missing but already registered worktree`. The
  error isn't a `ConfigError`/`DockerError`, so the owner sees only "an
  internal error".
- **What still passes:** the SR-11 limit itself works when reached
  without a second worktree: G1-40 lowers `runs_per_feature` to 1 in the
  project's `limits:`, and the next start files the Security item, starts
  no session and records the feature as blocked.

### F-3. AC-7 / FR-9: an Approved SR with the owner's own wording doesn't resolve the finding (spec and code disagree; owner decision pending)

- **Test:** G1-15, `gate1.test.ts:452`.
- **Spec as written:** §2 step 6 "the owner approves, changes or rejects
  it in the spec interview"; FR-9 "a security requirement in the spec's
  section 9 that cites the finding, with status Approved and text matching
  the owner's approved answer in the transcript"; AC-7.
- **Expected:** the owner answers the Gate 1 question with their own
  wording; the analyst writes that wording, word for word, as an Approved
  SR citing `Gate 1 #1`; the spec passes the checks; the feature reaches
  `readiness_gate`.
- **Actual:** the feature stays at `security_gate_1`, the engine files the
  FR-13 risk item and records `gate1_blocked`. Log: `F-001: Gate 1 findings
  not resolved: Gate 1 #1: the owner's answer to Q-001 isn't the suggested
  requirement and no Gate 1 assumption asks to record it.`
- **Where:** `engine/src/gate1/flow.ts:160` (change 2 of `8f3a566`, built
  as recommended while the spec update waits on the owner). If the owner
  approves that change, the spec and this test change together; until then
  it is a failure against spec v12.

## Failures: environment or test code

None in the final run. Test-code faults found and fixed while writing,
none by weakening an assertion: a race reading the spec commit after the
rendering landed; markers with hyphens that the engine's plain-text
escaping turned into `\-` (the tests now use letters and digits, so
"engine text only" can't pass by accident); a wait that matched the
question text instead of the check's evidence; and G1-35's first version,
whose premise (a linked additions file reaching Gate 1) can't happen,
because F-007's worktree rule already stops any feature whose branch holds
a link. G1-35 now checks what SR-10 needs: nothing from the link's target
reaches a session.

## Didn't run, and why

| Test | Why |
|---|---|
| AC-11 | Real trial on the owner's F-002, out of scope here |
| AC-3 on a real daemon | No Docker here, and no F-008 real-Docker test was written; F-007's DR-3 (owner's PC) covers the same network and proxy setup for the analyst |
| DR-1 to DR-7 (`containers-real.test.ts`), `docker-real.test.ts` ×4 | Gated on `FACTORY_DOCKER_TESTS=1`; no Docker here |
| RW-4 | Accepted residual until Alpha (owner, F-007 spec v43) |
| FX-7 | Windows only |
| `units.test.ts` parent lookup (developer's) | macOS and Windows only |

## Spec and contract gaps

See the plan, "Spec and contract gaps": where the agent report is
committed (FR-2 says `factory/state`, FR-6 and AC-6 say the feature branch;
the engine uses `factory/state`), no `blocked` on the channel, the finding
citation format, unnumbered text and nesting caps, SR-11's "correction
resume included", whether a failed run counts as "a report" for FR-1, and
the owner's own wording (F-3).
