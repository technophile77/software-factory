# F-007 test report: full run with milestone 2 acceptance tests

Report per `docs/testing-strategy.md` § Run report. The test plan, with the
full criteria-to-test map and what is out of scope, is
`F-007-test-plan.md` (milestone 1 at spec v21, milestone 2 at spec v38).
This report replaces the milestone 1 report on `925e850`.

## Run

| | |
|---|---|
| Commit tested | `4b21531` (the milestone 2 tests and plan, on top of `5be079c`). The report itself is the only change after it |
| Command | `cd engine && npm ci --ignore-scripts && npm run typecheck && npx vitest run --coverage --coverage.reportsDirectory=<scratch folder>` (the coverage folder is outside the repo; the default `engine/coverage/` is git-ignored anyway) |
| Environment | Linux container, Node 22.23.4, system git, running as root (so the root-only tests CH-3 and ST-14 ran). No Docker |
| Typecheck | Clean (engine and `test/acceptance`) |
| Test files | 33: 31 passed, 2 skipped (the two real-Docker files) |
| Tests run | 498 |
| Passed | 484 |
| Failed | 0 |
| Skipped | 14, each with its reason below |

By project:

| Project | Tests | Passed | Skipped |
|---|---|---|---|
| Acceptance (`test/acceptance/`, the test engineer's) | 239 | 230 | 9 |
| Unit (`test/*.test.ts`, the developer's) | 259 | 254 | 5 |

**Result: pass for everything that can run here; not yet complete.** No
test fails. The 7 gated real-Docker tests (DR-1 to DR-7) cover AC-8, AC-14,
AC-15 and AC-16 and must run on the owner's PC before those four criteria
count as tested (see "To run on the owner's PC"). Every other skip is a
platform gate or a pending owner decision, named below.

## Coverage

`@vitest/coverage-v8` 5.1.0, whole suite (unit and acceptance), over
`engine/src/**`:

| Measure | Covered |
|---|---|
| Lines | **87.06%** (3,621 / 4,159) |
| Branches | **78.55%** (2,820 / 3,590) |
| Statements | 82.96% (4,388 / 5,289) |
| Functions | 83.48% (758 / 908) |

The bar at Rapid prototype is "reported" (`testing-strategy.md`). These
figures are from Linux without Docker: code that runs only against a real
daemon, on Windows or on macOS isn't counted.

## Tool choice

Rapid prototype requires unit tests on core logic, reported coverage and a
regression test per fixed bug. Stochastic tests aren't required.

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Acceptance | Vitest. The engine is TypeScript on Node, and the tests start it in-process and drive it as a black box | `vitest` 5.1.0, `typescript` 5.9.2, `@types/node` 22.19.1 | OQ-9 (Vitest), approved pins |
| Contract (channel, Interview tools) | Vitest with a JSON-RPC client built on `node:net` from the contract's framing rule. No client library, so nothing hides a framing bug | Vitest + `support/rpc.ts` | OQ-9 |
| Fakes (GitHub, gitleaks, git logging) | Node `http`/`https` and the system git's `git http-backend`, plus Node scripts for gitleaks and the git wrapper | Node built-ins, system `git`, `openssl` | No new component |
| Fakes for agents (milestone 2) | A fake `docker` client program at the command-line boundary the spec fixes (OQ-5) and a fake Agent SDK at the engine's SDK seam. They run on every CI OS and see every command and tool result | Vitest + `support/fake-docker.ts`, `support/agents.ts` (Node built-ins) | No new component |
| Acceptance on real Docker (milestone 2) | Docker Desktop with WSL2, the engine's own runtime. Only a real daemon shows network isolation, mounts and the image's user | Docker Desktop on the owner's PC, through the engine's `docker` command line | Spec §5 and §7, ADR 0015 (the product's runtime) |
| Acceptance on real Claude Code (AC-17) | The Claude Code 2.1.311 binary the SDK package ships, run through the real SDK 0.3.311 against a fake Messages API on loopback | Claude Code 2.1.311, Agent SDK 0.3.311, Node `http` | OQ-4 (approved pins) |
| Unit | The developer's, with Vitest | Vitest (run here, not written by the test engineer) | OQ-9 |
| Coverage (reported) | `@vitest/coverage-v8` 5.1.0, matching the runner | `@vitest/coverage-v8` 5.1.0 | OQ-9 follow-up, spec v24 |
| Regression | Vitest, one test per fixed bug | The milestone 1 failures (a-1, c-1 to c-3) now have passing tests: ST-1, RS-1, GS-4, TR-11 | OQ-9 |
| Stochastic | Not required at Rapid prototype | None | None |

## Criteria to tests

| Criterion | Tests | Status |
|---|---|---|
| AC-1 | ST-1, ST-2, CH-16 | Pass |
| AC-2 | ST-4 to ST-7 | Pass |
| AC-3 | ST-10, ST-11 | Pass |
| AC-4 | CH-1, CH-3, CH-4 | Pass |
| AC-5 | FS-1 to FS-4 | Pass |
| AC-6 | AP-1 to AP-4, AP-6 to AP-8 | Pass |
| AC-7 | IT-1 to IT-3, SE-8 | Pass |
| **AC-8** | DR-1, DR-2, DR-3 | **To run on the owner's PC** (gated) |
| **AC-9** | AG-4 (control), AG-5 ×5, AG-6, AG-7 | **Pass** |
| AC-10 | RD-1 to RD-8 | Pass |
| AC-11 | TR-4, TR-9, GS-4 | Pass |
| AC-12 | RS-1 | Pass |
| **AC-13** | AG-1, AG-2 (control), AG-3 | **Pass** |
| **AC-14** | DR-3, DR-6 | **To run on the owner's PC** (gated) |
| **AC-15** | DR-4, DR-5 (control), DR-6 | **To run on the owner's PC** (gated) |
| **AC-16** | DR-2, DR-7 | **To run on the owner's PC** (gated) |
| **AC-17** | CS-1, CS-2 (control) | **Pass** (real binary, Linux) |
| AC-18 | GS-1 to GS-3 | Pass |
| AC-19 | RD-11 to RD-15 | Pass |
| AC-20 | PIN-1, PIN-2, PIN-3, PIN-5 | Pass |
| **AC-21** | RW-1, RW-2, RW-3; RW-4 skipped | **Pass** for inline hiding, comments, scripts, styles, templates, zero-width and bidi characters. RW-4 (text hidden by a stylesheet class) waits on the owner (validation M6(b)) |
| SR-1 | SC-1, SC-2, GS-4, ST-10 | Pass |
| SR-2 | ST-7, ST-8, AP-8, AP-12, TR-5, TR-6, SC-5, PIN-3 | Pass |
| SR-3 | IT-6, IT-7, IT-13, IT-14 | Pass |
| SR-5 | PIN-1 to PIN-5, ST-20 | Pass |
| SR-6, SR-7 | DR-3, DR-6 | To run on the owner's PC |
| SR-8 | DR-4, DR-6 | To run on the owner's PC |
| SR-9 | DR-2, DR-7 | To run on the owner's PC |
| SR-10 | CS-1, CS-2, AG-4 | Pass |
| SR-11 | GS-1 to GS-4 | Pass |
| SR-12 | RD-11 to RD-15, TR-8, AG-7 | Pass |
| SR-13 | ST-3, ST-12 to ST-19 | Pass |
| SR-15 (Linux) | CH-1 to CH-3 | Pass |
| SR-16 | FS-5, FS-6, IT-12 | Pass |
| SR-17 | TR-10, TR-11, TR-12 | Pass |
| SR-19 | TR-4 to TR-9 | Pass |
| SR-20 | SC-4 | Pass |
| SR-21 | RW-1 to RW-3 | Pass (`WebSearch` not tested: validation M2 is with the owner) |
| SR-22 | TR-2, RD-9, RD-10 | Pass |
| SR-23 | AP-4, AP-5, AP-9, AP-12 to AP-16 | Pass |
| FR-14 (session never started) | AG-1, AG-3 | Pass |

All contract rules in the plan's milestone 1 contract table pass. The
channel version check (ST-1) expects `1.2`, as spec v22 (FR-4) sets until
the advisor increment.

## To run on the owner's PC

Docker isn't available in this container. These tests are gated on
`FACTORY_DOCKER_TESTS=1` and skipped here with that reason:

| Test | Criterion |
|---|---|
| DR-1 | AC-8: non-root user, read-only root, `/tmp` writable, no Docker socket |
| DR-2 | AC-8, AC-16: no file from the owner's home (a marker file the test puts in the real home folder and removes after), no `engine.json` and no engine socket anywhere in the container; the model credential in no file, no process environment and not in `docker inspect`; the only host folder is `/workspace` |
| DR-3 | AC-14, AC-8: direct connections to 1.1.1.1, 8.8.8.8, example.com and `host.docker.internal` fail; the proxy answers 407 to no credential and to a wrong one, and 403 to the analyst's own credential for a host outside its policy |
| DR-4 | AC-15: `fetch_page` refuses 127.0.0.1, localhost, 10.0.0.1, 192.168.1.1, 169.254.169.254, [::1] and `localtest.me` (a public name for 127.0.0.1) |
| DR-5 | AC-15 control: `fetch_page` reaches example.com (needs the internet) |
| DR-6 | AC-15, SR-8: CONNECT with the reader's own credential is 403 for each address above and for port 80, and 200 for example.com:443 (control) |
| DR-7 | AC-16: no model credential in the web reader's container either |

The developer's four gated tests in `test/docker-real.test.ts` are skipped
here for the same reason.

On Windows, in PowerShell, from the repo root:

```powershell
cd engine
npm ci --ignore-scripts
npm run build
$env:FACTORY_DOCKER_TESTS = "1"
npx vitest run --config test/acceptance/vitest.config.mts containers-real
Remove-Item Env:FACTORY_DOCKER_TESTS
```

Docker Desktop must be running. The first run builds the agent image, which
needs the internet (base image, npm, `deb.debian.org`) and can take several
minutes; the setup step allows 30. DR-5 and DR-6 need the internet for
example.com and for resolving `localtest.me`.

## Skipped here, and why

| Test | Why |
|---|---|
| DR-1 to DR-7 (`containers-real.test.ts`) | Gated: no Docker here. To run on the owner's PC (above) |
| `docker-real.test.ts` ×4 (developer's) | Same gate |
| RW-4 | Pending owner decision: validation M6(b) proposes accepting stylesheet-hidden text as a residual risk until Alpha. Unskip if the owner asks for the fix |
| FX-7 | Windows only (the fixtures' Windows ACL check) |
| `units.test.ts` "the real parent lookup reports this process's parent" (developer's) | macOS and Windows only |

On Windows, CS-1 and CS-2 (AC-17) skip as well: the engine never runs the
Windows build of Claude Code (it runs only in the Linux container), so they
are meant to run on Linux and macOS hosts, CI's included. Only Linux was
run here.

## Failures

None in this run.

The milestone 1 run on `925e850` had 4 failures (a-1, c-1, c-2, c-3). They
pass now: ST-1 follows spec v22's channel version, and the engine has the
crash, push and fetch seams that RS-1, GS-4 and TR-11 needed.

### Engine bugs found

None. The failures seen while the milestone 2 tests were written were all
test-code faults, fixed before this run: the fake Docker logged the
long-running proxy container only when it ended, AG-1 counted the engine's
start-up sweep as session commands, and AG-4 counted one Security item twice
(seen locally and on the remote). No assertion was weakened.

## Spec and contract gaps

1. **"The owner is told why" (AC-13).** The engine tells the owner in the
   feature's transcript (an `analyst_session` entry) and in its log. No
   channel method shows it, so the skill can't. Product or Interfaces.
2. **AC-9 "its commits are rejected".** The analyst makes no commits of its
   own; the engine commits after the session. The tests read AC-9 as
   "nothing the session changed is committed", as FR-9 says.
3. From the milestone 1 report, still open: the first pin of a new project
   (SR-5 wording), `.factory/` in the config repo (validation M4), and error
   `-32000` for a tampered feature.
