# F-007 test report: milestone 1 acceptance and contract run

Report per `docs/testing-strategy.md` § Run report. The test plan, with the
full criteria-to-test map and what is out of scope, is
`F-007-test-plan.md`.

## Run

| | |
|---|---|
| Commit tested | `f007-test` at `925e850`: the merge `49d2d94` (developer milestone 1 + suite) plus the harness adaptation |
| Command | `cd engine && npm ci --ignore-scripts && npx vitest run --config test/acceptance/vitest.config.mts` |
| Environment | Linux container, Node 22, system git, running as root (so the root-only tests CH-3 and ST-14 ran) |
| Tests run | 214 |
| Passed | 210 |
| Failed | 4 |
| Skipped | 0 |

**Result: not a pass.** 4 tests fail: 1 product bug (a), 3 missing
seams (c). A run with failures is not a pass at any maturity level.

The first run against the merge, before the harness was adapted, had 180
failures and 34 passes, nearly all from the harness's assumed API. After the
adaptation: 199 passed, 15 failed. 11 of those 15 were test bugs, now fixed
(below). The other 4 are listed under Failures.

## Tool choice

Rapid prototype requires unit tests on core logic, reported coverage and a
regression test per fixed bug. Stochastic tests aren't required.

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Acceptance | Vitest. The engine is TypeScript on Node, and the tests start it in-process and drive it as a black box | `vitest` 5.1.0, `typescript` 5.9.2, `@types/node` 22.19.1 | OQ-9 (Vitest), approved pins |
| Contract (channel, Interview tools) | Vitest with a JSON-RPC client built on `node:net` from the contract's framing rule. No client library, so nothing hides a framing bug | Vitest + `support/rpc.ts` | OQ-9 |
| Fakes (GitHub, gitleaks, git logging) | Node `http`/`https` and the system git's `git http-backend`, plus Node scripts for gitleaks and the git wrapper | Node built-ins, system `git`, `openssl` | No new component |
| Unit | The developer's, with Vitest | Not part of this run | OQ-9 |
| Coverage (reported) | `@vitest/coverage-v8` 5.1.0, matching the runner | **Not run.** The tool isn't approved and needs a tool decision (Architecture) with its S4.1 review. This type stays open until the owner decides | None |
| Regression | Vitest, one test per fixed bug | No product bug fixed yet | OQ-9 |
| Stochastic | Not required at Rapid prototype | None | None |

## Criteria to tests

The full map is in `F-007-test-plan.md` § Criteria to tests. Status per
criterion in this run:

| Criterion | Tests | Status |
|---|---|---|
| AC-1 | ST-1, ST-2, CH-16 | **ST-1 fails** (a-1) |
| AC-2 | ST-4 to ST-7 | Pass |
| AC-3 | ST-10, ST-11 | Pass |
| AC-4 | CH-1, CH-3, CH-4 | Pass |
| AC-5 | FS-1 to FS-4 | Pass |
| AC-6 | AP-1 to AP-4, AP-6 to AP-8 | Pass |
| AC-7 | IT-1 to IT-3, SE-8 | Pass |
| AC-10 | RD-1 to RD-8 | Pass |
| AC-11 | TR-4, TR-9 | Pass for the commit path. "Nothing pushed" can't be seen without the push seam (c-2) |
| AC-12 | RS-1 | **Fails** (c-1) |
| AC-19 | RD-11 to RD-15 | Pass |
| AC-20 | PIN-1, PIN-2, PIN-3, PIN-5 | Pass |
| SR-1 | SC-1, SC-2, GS-4, ST-10 | **GS-4 fails** (c-2). The others pass |
| SR-2 | ST-7, ST-8, AP-8, AP-12, TR-5, TR-6, SC-5, PIN-3 | Pass |
| SR-3 | IT-6, IT-7, IT-13, IT-14 | Pass |
| SR-5 | PIN-1 to PIN-5, ST-20 | Pass |
| SR-11 | GS-1 to GS-4 | **GS-4 fails** (c-2). GS-1 to GS-3 pass |
| SR-12 | RD-11 to RD-15, TR-8 | Pass |
| SR-13 | ST-3, ST-12 to ST-19 | Pass |
| SR-15 (Linux) | CH-1 to CH-3 | Pass |
| SR-16 | FS-5, FS-6, IT-12 | Pass |
| SR-17 | TR-10, TR-11, TR-12 | **TR-11 fails** (c-3). TR-10 and TR-12 pass |
| SR-19 | TR-4 to TR-9 | Pass |
| SR-20 | SC-4 | Pass |
| SR-22 | TR-2, RD-9, RD-10 | Pass |
| SR-23 | AP-4, AP-5, AP-9, AP-12 to AP-16 | Pass |
| G1 #15 (logs) | SC-3 | Pass |
| FR-2 | ST-20 | Pass |
| FR-4 (advisor kinds refused) | CH-15 | Pass |
| FR-10 | IT-4, IT-14 | Pass |
| FR-11 | TR-1, TR-3, TR-12 | Pass |

All contract rules in the plan's contract table pass, except the channel
version in `engine.json` and `engine.status` (ST-1, a-1).

## Failures

### (a) Product bugs

**a-1. The channel version is 1.2, not 1.3** (ST-1).
- Spec: FR-4 and § 10 require "Engine control channel v1.3: implemented as
  approved". `interface-contracts.md` § Engine control channel is v1.3
  (H-0063).
- Expected: `engine.json` `version` and `engine.status` report `"1.3"`.
- Actual: `"1.2"` (`SERVED_CHANNEL_VERSION`). The engine README says it
  isn't 1.3 yet. Counts against: software developer. If the gap is
  deliberate, it needs an owner decision (Interfaces), not a silent
  downgrade.

### (c) Seams the API lacks

None of these is faked. Each test fails with a `MissingSeam` error or on
the assertion it can't satisfy.

**c-1. Crash without shutdown** (RS-1, AC-12).
- `EngineHandle` has only `stop()`, which runs the shutdown path. AC-12 is
  about bookkeeping after the engine is killed.
- What the test needs: `handle.crash()` (or `kill()`). It must stop serving
  and drop all in-memory state with no shutdown bookkeeping, no final
  commits and no report writes, as `SIGKILL` would. It must also release
  the socket and lock, so a new `startEngine` on the same `engineHome` can
  run in the same process. The alternative is to run the engine in a child
  process (`dist/engine.js`) with options for injecting the clock, GitHub
  base URLs, credential store and gitleaks pin, and kill it.

**c-2. Pushes can't be observed** (GS-4; also the "nothing pushed" part of
AC-11, and SR-1's `GIT_ASKPASS` check).
- The engine pushes only when `origin` is an `https://github.com/` URL. The
  injected `github.webBase` doesn't extend to git transport, so with the
  fake GitHub it logs "factory/state wasn't pushed" and never pushes.
- What the test needs: pushes go to the remote whose base is the injected
  `github.webBase` (for example, accept `origin` URLs under `webBase`), or
  an option that names the allowed push base. The fake then sees the push,
  its auth header, and whether a token reached the command line or the
  environment.

**c-3. The engine never fetches `factory/state`** (TR-11, SR-17 "on fetch").
- The git calls observed through the wrapper during start, sessions and
  restart are local plumbing only: `rev-parse`, `update-ref`,
  `worktree add`, `ls-tree`, `cat-file`, `hash-object`, `read-tree`,
  `update-index`, `write-tree` and `commit-tree`. No `fetch` or `pull`. A
  forged commit pushed to the remote is never read, so the "on fetch" check
  can't run.
- What the test needs: `handle.sync()` (fetch `factory/state` from origin
  now and apply SR-17), or a fetch at start. If milestone 1 deliberately
  doesn't fetch, SR-17's fetch half needs a spec note saying so, and TR-11
  moves to the milestone that adds it.

**c-4. Confirming a pinned-key change isn't on the API** (not a failure).
- The SR-5 confirm command (`factory-engine confirm`) isn't exported. The
  harness builds it as `cli.ts` does, from `src/config/confirm`,
  `src/config/pins`, `src/git`, `src/github`, `src/log`, `src/os/ffi` and
  `src/proc`. That reaches past the public surface.
- What the test needs: export `confirmProject` from `index.ts`, or add
  `handle.confirmProject(path)` with the injected GitHub and clock, and an
  `io` for the name prompt and the device code.

### (b) Test bugs, fixed

| Test | Cause | Fix |
|---|---|---|
| All | The harness assumed an API the engine doesn't have | `harness.ts` maps the suite's options onto the real `startEngine` options and `EngineHandle`. The fixtures use the real secret names (`model-credential`, `factory-token/<project>`), and the config repo doubles as the managed clone |
| All projects | First pin needs confirmation, which the harness didn't do | `World.boot()` confirms each new project as its manifest owner, then restarts |
| AP-10 | Counted all device codes, including the boot confirmation's | Counts codes issued after the session starts |
| CH-3 | A synchronous child deadlocked against the in-process engine, and the engine rightly refuses its own descendants | The probe is spawned asynchronously and double-forked |
| GS-1 (×2) | The fixture's own `git worktree add` ran the planted hooks and fsmonitor | Fixture git runs with hooks and fsmonitor off. The engine is still tested against the planted ones |
| IT-5 | Didn't allow the engine to return the assumption before the second question | Approves the assumption when `next` returns it, then checks `one_at_a_time` |
| PIN-2 (enabled) | Flipped `enabled` back to `true` without confirming the `false` change, so the pin was still `true` | Confirms the switch-off first |
| SC-4 | Expected the plan's guessed names | Asserts that accessed names are within the engine's documented set |
| SE-12 | Snapshot taken before the first turn existed | Waits for the first turn |
| TR-10, TR-12 | The analyst poller called `takeTurn` during `stop()` | The poller stops before the engine does |
| Transcript readiness helper | Opened a channel session it didn't need | Calls the tools directly |
| `FakeClock.sleep` | Ignored the abort signal | Resolves on abort |

No assertion was weakened. CH-15 no longer repeats the version check, which
ST-1 already makes.

### Observations (not failures)

- When it refuses `interview.open` on a tampered feature, the engine
  returns error `-32000`, which isn't in the contract's error table. It
  needs a contract code or a note (Interfaces).
- During TR-10 and TR-12 debugging, a `takeTurn` that overlapped `stop()`
  led the next start to flag the engine's own transcript commit as
  tampered. The test bug is fixed, but an overlap like this is what a kill
  (AC-12) produces. RS-1 should cover it once c-1 exists.

## Not run, and why

The plan's § What isn't tested here still applies: Windows and macOS parts of
SR-15, real OS credential stores, real gitleaks rules, the gitleaks timeout,
disk full, live TLS, and the milestone 2 criteria (AC-8, AC-9, AC-13 to
AC-18, AC-21, SR-4, SR-6 to SR-10, SR-14, SR-18, SR-21). The root-only tests
(CH-3, ST-14) ran, because this container runs as root. Coverage didn't run
(see Tool choice). Nothing was skipped in this run.

## Spec and contract gaps

These are the plan's gaps, updated with what the real engine does:

1. **First pin (SR-5).** The engine asks the manifest's owner to sign in for
   a never-pinned project. That answers plan gap 1 in practice, but the spec
   still says "the previously pinned owner". It needs a spec note.
2. **Where `.factory/` lives.** The engine keeps `.factory/`, `engine.json`
   and feature branches in the listed config repo, while ADR 0009 says "each
   managed repo". This answers plan gap 4 differently from the ADR. It needs
   an Architecture check.
3. **Error code for a tampered feature** (`-32000`, above).
4. Plan gaps 2, 3, 5, 6 and 7 stand as written.
