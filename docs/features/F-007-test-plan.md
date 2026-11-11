# F-007 test plan: milestone 1 (no Docker)

- **Feature:** F-007 Run spec interviews on the real engine, spec v21
- **Author:** test-engineer, 2026-11-11
- **Scope:** milestone 1 of 2: config and manifest loading, pinned owner
  keys, credential store, control channel and its access checks, GitHub
  device flow, transcript and hash chain, gitleaks scan, git with safe
  overrides, the interview tools as engine functions, readiness checks.
  Containers, the proxy, Agent SDK sessions and `fetch_page` are milestone 2.
- **Written from:** the spec, `F-007-security-gate1.md` (findings and the
  gitleaks review), `interface-contracts.md` (Engine control channel v1.3,
  Interview tools v1.0, Project manifest v1.3, Role policy v2.5, Inbox item
  v1.1, Agent report), ADRs 0005, 0009, 0012, 0014, 0015, F-005 AC-7 and
  AC-8, and the F-006 dev report's "Deferred to the engine feature" list.
  No implementation code or developer notes were read.
- **Where:** `engine/test/acceptance/`. Run from `engine/` with
  `npx vitest run --config test/acceptance/vitest.config.mts`.
- **State now:** 214 tests (132 test ids; parameterised ids count once per
  case). They typecheck against the harness (`tsc -p
  test/acceptance/tsconfig.json`). With no engine on the branch, 207 fail
  with `engine not available: …/engine/src/index.ts does not exist` and
  none passes by accident. Seven pass without the engine on purpose: six
  fixture self-checks (FX-1 to FX-6) and ST-3, which checks the master repo
  itself.

## Tool choice

At Rapid prototype `testing-strategy.md` asks for unit tests on core logic,
reported coverage and a regression test per fixed bug; no stochastic tests.

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Acceptance | Vitest: the engine is TypeScript on Node, the tests start it in-process and drive it as a black box; same runner as the extension | `vitest` 5.1.0, `typescript` 5.9.2, `@types/node` 22.19.1 | OQ-9 (Vitest), approved pins |
| Contract (channel, Interview tools) | Vitest with a JSON-RPC client written on `node:net` from the contract's framing rule; no client library, so nothing hides a framing bug | Vitest + `support/rpc.ts` | OQ-9 |
| Fakes (GitHub, gitleaks, git logging) | Node's `http`/`https` and `git http-backend` from the system git, so pushes and auth are observed for real; Node scripts for gitleaks and the git wrapper | Node built-ins, system `git`, `openssl` (AP-16 only) | No new component |
| Unit | Developer's, Vitest | — | OQ-9 |
| Coverage (reported) | `@vitest/coverage-v8` 5.1.0, matching the runner | **Not chosen yet.** Not approved; needs a tool decision (Architecture) with its S4.1 review. Raised to the orchestrator; the type stays open until the owner decides | — |
| Regression | Vitest; one test per fixed bug once runs begin | Vitest | OQ-9 |
| Stochastic | Not required at Rapid prototype | — | — |

## Harness assumptions (the developer's API must meet these)

All of them live in `engine/test/acceptance/harness.ts`, the one file to
adapt if the real API differs. The rest of the suite uses only the channel,
files, the fake GitHub and the fake gitleaks.

1. `engine/src/index.ts` exports `startEngine(options): Promise<EngineHandle>`.
2. `options`:
   - `clock: { now, setTimeout, clearTimeout, sleep }`. The engine takes
     **all** time from it: timestamps, device-flow polling and expiry, the
     30-minute idle and 2-hour session limits, `wait_s`. Tests advance it by
     hand.
   - `env`: the engine's whole environment; it doesn't read `process.env`
     (AC-3 sets `ANTHROPIC_API_KEY` here; GS tests set `HOME`).
   - `github: { webBaseUrl, apiBaseUrl }` standing for `https://github.com`
     and `https://api.github.com` (device flow at `/login/device/code` and
     `/login/oauth/access_token`; `/user`; `/repos/{owner}/{repo}`; git
     smart HTTP at `/<owner>/<repo>.git`). The fake is plain HTTP on
     127.0.0.1, except AP-16 which uses an untrusted certificate.
   - `credentialStore: { get, set, delete }` by name. The fixtures seed
     `software-factory/model-credential` and
     `software-factory/factory-token` (`CREDENTIAL_NAMES`).
   - `gitleaks: { path, sha256 }`: the test pin replaces the release pin,
     and the engine checks the binary against it.
   - `gitPath`: absolute path of `git` (a logging wrapper in tests).
   - `paths: { masterRepo, projectsFile, stateDir, logDir, runtimeDir,
     repoClones }`. `repoClones` maps each `repos[].url` to its local clone,
     whose `origin` is the fake GitHub; `.factory/` and `engine.json` are in
     that clone.
   - `analyst: { start(ctx), turn({ feature, message }) }`: the seam where
     milestone 2 plugs in the Agent SDK session. `start` gets `{ feature,
     worktree, tools, project?, resume? }`; `tools.call(name, args)` runs
     the Interview tools, resolving with the result or rejecting with an
     error whose `code` is the contract's name (`invalid`, `limit`, …).
     `turn` gets each owner reply wrapped in the engine's frame.
3. `EngineHandle`: `stop()` (graceful), `crash()` (as if killed, no shutdown
   bookkeeping), `projects()` → `[{ path, state }]` with `state:
   "running"` for a running project, `confirmProject(configRepoPath)` →
   `{ approval?: { user_code, verification_uri, expires_at }, done }` for
   the SR-5 engine command; optional `sync()` (fetch `factory/state` now;
   otherwise the suite restarts the engine, which must fetch at start) and
   optional `flush()` (pending commits and pushes done).
4. Everything the engine does with git, gitleaks and HTTP is asynchronous:
   the fakes run in the test process, so a synchronous call to them would
   deadlock.
5. Readiness checks are found by name: check 5 by `5` or "assumption",
   check 6 by `6`, "decision", "deferred" or "question"
   (`readinessCheck`). Security items are found as Inbox items with
   `category: Security` in `.factory/inbox/decision/` or on `factory/state`
   of any fixture repo (`World.securityItems`).

## Criteria to tests

| Criterion | Tests |
|---|---|
| AC-1 | ST-1, ST-2, CH-16 |
| AC-2 | ST-4, ST-5, ST-6, ST-7 |
| AC-3 | ST-10, ST-11 (control) |
| AC-4 | CH-3 (root only), CH-4, CH-1 |
| AC-5 | FS-1, FS-2, FS-3, FS-4 |
| AC-6 | AP-1, AP-2, AP-3, AP-4, AP-6, AP-7, AP-8 |
| AC-7 | IT-1, IT-2, IT-3, SE-8 |
| AC-10 (F-005 AC-7, AC-8) | RD-1 (control), RD-2 to RD-8 |
| AC-11 | TR-4, TR-9 |
| AC-12 (bookkeeping) | RS-1 |
| AC-19 | RD-11, RD-12, RD-13, RD-14, RD-15 (control) |
| AC-20 | PIN-1, PIN-2, PIN-3, PIN-5 (control) |
| SR-1 | SC-1, SC-2, GS-4, ST-10 |
| SR-2 | ST-7, ST-8, AP-8, AP-12, TR-5, TR-6, SC-5, PIN-3 |
| SR-3 | IT-6, IT-7, IT-13, IT-14 |
| SR-5 | PIN-1 to PIN-5, ST-20 |
| SR-11 (and the AC-18 abuse case) | GS-1, GS-2, GS-3, GS-4 |
| SR-12 | RD-11 to RD-15, TR-8 (blobs read from git) |
| SR-13 | ST-12 to ST-19, ST-3 (file untracked and ignored) |
| SR-15 (Linux parts) | CH-1, CH-2, CH-3 |
| SR-16 | FS-5, FS-6, IT-12 |
| SR-17 | TR-10, TR-11, TR-12 (control) |
| SR-19 / gitleaks review | TR-4 to TR-9 |
| SR-20 (names) | SC-4 |
| SR-22 | TR-2, RD-9, RD-10 (control) |
| SR-23 | AP-4, AP-5, AP-9, AP-12 to AP-16 |
| G1 #15 (logs) | SC-3 |
| FR-2 manifest from `main` | ST-20 |
| FR-4 advisor kinds refused (F-006 deferred: channel part) | CH-15 |
| FR-10 | IT-4, IT-14 |
| FR-11 | TR-1, TR-3, TR-12 |

| Contract rule | Tests |
|---|---|
| Channel: transport, `engine.json` (0600, version 1.3, pid), socket 0600 in owner-only dir | ST-1, CH-1, CH-2, CH-16 |
| Channel: framing (line per message, split and joined writes, UTF-8, 1 MiB exact and over) | CH-6, CH-7, CH-8, CH-10 |
| Channel: JSON-RPC errors -32700, -32600, -32601, -32602 | CH-9, FS-3 |
| `engine.status`, `pause`, `resume`, `shutdown` | ST-1, CH-11 to CH-14 |
| `feature.start`, `interview.list` | FS-1 to FS-5, SE-16 |
| Session lock by token, `busy` with `started_at`, takeover, close, 30-minute idle, 2-hour cap | SE-1 to SE-7, CH-5, AP-10 |
| `approval_pending`, `approval_failed`, `awaitApproval` `wait_s` ≤ 900 | AP-1 to AP-11 |
| Item shape, revisions and `stale`, `more_info` → `researching` → revised | SE-8 to SE-11 |
| `wait_s` on `interview.next` ≤ 600, `interview.itemReady` | SE-10, SE-11 |
| Reply ids | SE-12 |
| Reply kinds per item kind (-32005), advisor kinds refused | SE-13, CH-15 |
| `interview.state`, `recorded_at`, unknown item | SE-14, SE-15 |
| Deferred items once per session, first | SE-17, SE-18 |
| Interview tools: every limit (over is `invalid`, at the limit is accepted), unknown keys, no `feature` param | IT-6, IT-7, IT-8 |
| Interview tools: `one_at_a_time`, caps (`limit`: 5 open assumptions, 200 items) | IT-5, IT-9, IT-10 |
| Interview tools: `unknown_item`, `wrong_status`, per-feature server | IT-11, IT-12 |
| Interview tools: reply frame with random boundary, item, revision, kind, length | IT-2, IT-3 |
| Interview tools: `spec_path` rule | RD-11 to RD-15 |

Fixture self-checks FX-1 to FX-6 prove the fakes work without the engine:
a failure there is environment or test code, not product.

## What isn't tested here, and why

| Item | Why |
|---|---|
| Windows named pipe: owner-only ACL, `FILE_FLAG_FIRST_PIPE_INSTANCE`, client SID check (SR-15) | Needs Windows. Belongs in the Windows CI job SR-15 requires |
| macOS `getpeereid` peer check (SR-15) | Needs macOS; same CI job |
| Forced FFI error (SR-15) | No black-box way to make koffi fail; needs a fault-injection hook in the FFI module, tested as a unit test there |
| Peer of another uid (CH-3) and projects file owned by another user (ST-14) | Need root to switch uid or chown; they run only when the suite runs as root (it does in this container) and are skipped, with that reason, otherwise |
| Real OS credential stores (Keychain, Credential Manager, Secret Service) | Need a desktop session per OS; the store is injected here. SR-20 residual risk is accepted by the owner |
| Real gitleaks behaviour (rules, `.gitleaksignore`, `gitleaks:allow`) | The fake can't reproduce it; TR-7 and TR-8 check the exact invocation that makes those paths safe, as the gitleaks review tested against 8.30.1 |
| gitleaks timeout fail-closed | Needs a hanging fake and a short engine timeout; the timeout isn't an injectable option. Add one or test it as a unit |
| Disk full while committing (edge case) | Not reproducible without a size-limited filesystem (root and loop mount); a unit test with an injected write failure fits better |
| Default TLS checks against the real GitHub | AP-16 checks an untrusted certificate is refused; certificate pinning or revocation can't be tested offline |
| Public-repo warning at start (G1 #15) | The spec doesn't say where the warning goes, so there is nothing to observe |
| "The owner is told" when a cap is hit | The contract doesn't say how |
| `research_web` results and its per-question and per-session caps | Need the web reader (milestone 2); the caps also have no numbers yet. Its argument validation is tested (IT-6) |
| AC-8, AC-9, AC-13 to AC-18, AC-21; SR-6 to SR-10, SR-14, SR-18, SR-21 | Milestone 2 (containers, proxy, SDK sessions, `fetch_page`) |
| SR-4 action log, FR-13 engine-filled report fields | Need real external actions and model runs (milestone 2) |
| The master repo's CI rules in SR-13 (file never tracked, placeholders only) | Belong to the factory repo's CI; ST-3 checks the current state |

## Spec and contract gaps found (for the orchestrator)

These are not assumed. Each test that touches one says what it accepts.

1. **First confirmation of a never-pinned project (SR-5).** A new path stops
   the project until the owner confirms and "approves a device sign-in as
   the previously pinned owner", but a new project has no previous owner.
   The harness approves as the manifest's owner if the engine asks.
   Assumptions or Security.
2. **`interrupted` is not an Agent report outcome**, and the contract has no
   retry field. RS-1 looks for the value `interrupted` anywhere in the
   report and for a zero in any retry-like field. Interfaces.
3. **Where Security items for a refused project are filed** (its repo's
   `factory/state`, or elsewhere) is unstated. The harness searches every
   fixture repo.
4. **Where the managed repo's local clone lives** is unstated; the harness
   passes it (`repoClones`).
5. **Readiness check names, and how a spec assumption row matches its
   `approve_assumption` entry** (item id or text), are unstated. The
   fixtures write both.
6. **`awaitApproval` when `wait_s` runs out** has no stated result. AP-11
   only checks it doesn't wait past 900 s and isn't `approved`.
7. **Over-limit `wait_s` and malformed ids:** refused or clamped is not
   stated; the tests accept either -32602 or the contract's own code.
