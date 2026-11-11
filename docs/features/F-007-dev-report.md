# F-007 Developer completion report — milestone 1 of 2

- **Feature:** F-007 Run spec interviews on the real engine, spec v21
- **Role:** software-developer
- **Date:** 2026-11-11
- **Branch:** `f007-dev` (not pushed; the orchestrator merges it)
- **Deliverable:** the new package `engine/`. It holds everything in F-007 that needs no container runtime:
  - config, pinned keys and authorization;
  - OS secrets through koffi;
  - the control channel on a Unix socket or Windows named pipe;
  - GitHub device approval;
  - the engine-only interview transcript and agent reports on `factory/state`, scanned by gitleaks;
  - the analyst's interview tools as plain functions;
  - FR-14 run bookkeeping;
  - `startEngine(options)` and a CLI.
- **Dependencies:** exactly the approved pins.
  - Runtime: koffi 3.3.6 and yaml 2.9.1.
  - Dev only: typescript 5.9.2, esbuild 0.28.2, vitest 5.1.0 and @types/node 22.19.1.
  - `engine/package-lock.json` is committed and installed with `npm ci --ignore-scripts`.
  - There is no other library, and no Agent SDK yet.
- **Contracts used:**
  - Engine control channel v1.3, served as reported version 1.2 (see "Interpretations").
  - Interview tools v1.0.
  - Inbox item v1.1 (Security items).
  - Agent report v1.1.
  - Project manifest keys H-0080.
  - Gate 1 component review 5 (gitleaks).
- **Change-controlled files:** none edited. The proposed CI workflow is at the end of this report for the owner to approve as a hygiene item.

## What changed

All files are new. Paths are under `engine/` unless noted otherwise.

| File | What it holds |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | The package, with exact pins. The build bundles `src/cli.ts` to `dist/engine.js` with esbuild and leaves koffi external. The TypeScript settings are strict and include `noUncheckedIndexedAccess`. |
| `README.md` | The build, the CLI, and `startEngine(options)` with every injectable dependency. |
| `src/constants.ts` | The served channel version, RPC error codes, tool limits, the pinned gitleaks SHA-256 values and the stage names. |
| `src/clock.ts`, `src/fsutil.ts`, `src/log.ts`, `src/proc.ts` | Clock seam. Owner-only folders and atomic 0600 writes. The file logger (0700/0600, 30-day pruning, an action log for SR-4). The list of the engine's own children with an ancestry walk, and fixed-argument runs with no shell. |
| `src/os/ffi.ts` | **The only koffi module (SR-15).** It has a fixed `FUNCTIONS` list per OS. Linux: `geteuid` and `getsockopt(SO_PEERCRED)`, plus libsecret. macOS: `getpeereid`, `LOCAL_PEERPID` and Security.framework keychain calls. Windows: `CreateNamedPipeW` with an SDDL descriptor, ACL read-back as SDDL, `GetNamedPipeClientProcessId`, the token user SID, `CredReadW`/`CredWriteW`/`CredDeleteW`, and file owner and ACL as SDDL. Every failure throws `FfiError`, and callers refuse on it. |
| `src/os/sddl.ts` | A pure TypeScript SDDL parser, so ACLs are judged without reading structs by offset. Checks: an owner-only pipe, and a file only the owner, SYSTEM or Administrators can write. |
| `src/secrets.ts` | `OsCredentialStore` (service `software-factory-engine`; names `model-credential` and `factory-token/<project>`; SR-20) and `MemoryCredentialStore`. |
| `src/git.ts` | Every git command carries the SR-11 overrides, and its environment is built fresh. Push uses an askpass script, so the token never appears in argv. |
| `src/gitleaks.ts` | Exactly per component review 5. The binary's SHA-256 and version are checked. Blobs are written with `cat-file` into a 0700 folder named by SHA. The command is `gitleaks dir` with the fixed flags, run from an empty folder with no `GITLEAKS_*` variables. Exit 0 is clean, 99 is a finding, and anything else fails closed. |
| `src/state/state-repo.ts` | The `factory/state` worktree at `.factory`, written only through plumbing (`hash-object`, temporary index, `commit-tree`, `update-ref` with compare-and-swap). Commits are serialized and scanned first. A refused commit leaves no ref change. Also `checkStatePath`. |
| `src/state/record.ts`, `transcript.ts`, `inbox.ts`, `runs.ts` | The engine record: chain heads, features, runs and alerts. The JSONL transcript with a canonical-JSON sha256 chain. Security items (Inbox item v1.1). `RunBook` and Agent report v1.1. |
| `src/interview/model.ts`, `frame.ts`, `readiness.ts`, `feature.ts`, `tools.ts` | The interview state reducer. The random-boundary reply frame. The FR-12 checks and the SR-12 path rule. One feature's interview: exclusive appends, revisions, the one-at-a-time rule, researching. The five analyst tools with every v1.0 limit, cap and error. `research_web` is a stub. |
| `src/github.ts` | The device flow (ADR 0014, SR-23) and the repo lookup, against injectable base URLs. |
| `src/config/paths-file.ts`, `manifest.ts`, `pins.ts`, `authorize.ts`, `confirm.ts` | The SR-13 paths file. The manifest read from `main` with the H-0080 keys. The pinned keys in engine home (SR-5). The FR-2 and FR-3 checks. The `confirm` command. |
| `src/channel/framing.ts`, `sessions.ts`, `methods.ts`, `unix.ts`, `windows.ts` | Line framing with the 1 MiB limit. Sessions with device approval, the 30-minute idle limit, the 2-hour limit and takeover. Every channel method. The Unix socket and Windows pipe listeners with their access rules and read-back. |
| `src/engine.ts`, `src/index.ts`, `src/cli.ts` | `startEngine` and its phases. The public exports. The `start`, `confirm` and `secret set` commands. |
| `test/helpers.ts` and five test files | 94 unit tests. Fixtures hold placeholder ids only (owner 1000001, org 2000001, client id `Iv1.placeholder0001`). The fake gitleaks is a shell script. |
| `docs/features/F-007-dev-report.md` | This report. |

## Requirement mapping

Test names are `file: test name` (shortened). Ids marked *(m2)* are deferred to milestone 2; see below.

| Id | Where | Tests |
|---|---|---|
| FR-1 | `engine/` package, `src/cli.ts start`, `startEngine` | `engine: AC-1 …` |
| FR-2 | `config/manifest.ts` (read from `refs/heads/main`), `config/authorize.ts` with injectable `GitHubClient`; refusal files a Security item and stops only that project | `engine: AC-2 …`, `FR-2: an unreachable repo and a missing factory token …`, `invalid manifest on main …`, `a disabled project …`, `units: validates the H-0080 keys exactly` |
| FR-3 | `config/authorize.ts` `credentialKind`, `billingMismatch` | `engine: AC-3 …`, `FR-3: refuses a subscription credential …`, `units: model credential kind follows ADR 0012` |
| FR-4 | `channel/*`, `engine.ts` phase 3, `engine.json` 0600 with the served version; advisor kinds → `kind_not_allowed` | `engine: AC-1`, `channel: *`, `interview: refuses advisor reply kinds …` |
| FR-5 | `engine.ts` `feature.start` (next id over record, transcripts, branches, specs on main; branch by `update-ref` from `main`) | `interview: AC-5 …`, `numbers after the specs already on main …` |
| FR-6 | `channel/methods.ts`, `channel/sessions.ts`, `interview/feature.ts` | `interview: busy, then takeover`, `stale revisions, unknown items, repeated reply ids and deferred-once-per-session`, `interview.next gives up at wait_s …`, `channel: rejects unexpected or malformed params` |
| FR-7 | `github.ts startDeviceApproval`, `sessions.ts` (approval recorded in the transcript before the session counts) | `interview: device approval (FR-7, AC-6)` block, `units: GitHub device flow` block |
| FR-8, FR-9, FR-11 | *(m2)* | — |
| FR-10 | `interview/tools.ts` (the five tools, as functions) | `interview: analyst and owner` block |
| FR-12 | `interview/readiness.ts`, `tools.ts interview_spec_ready` (moves the stage to `security_gate_1` on pass) | `readiness: *` |
| FR-13 | `state/runs.ts agentReport`, written by `interview_spec_ready` | `readiness: passes a clean spec, writes the agent report …`, `AC-10: check 6 …` (outcome `partial`) |
| FR-14 | `state/runs.ts RunBook`, `engine.ts` marks left-running runs `interrupted` at start | `engine: FR-14 …`, `units: resumes from the session, then from the last commit …`, `interview: rebuilds the interview from the transcript after a restart` |
| AC-1 | — | `engine: AC-1 …` |
| AC-2 | — | `engine: AC-2 …` |
| AC-3 | — | `engine: AC-3 …` |
| AC-4 | `channel/unix.ts` (uid and engine-ancestry checks), `channel/windows.ts` (client SID, client pid ancestry) | `channel: AC-4 …` ×2, `refuses a peer the engine spawned`, `units: serves an owner client and refuses another user's` |
| AC-5 | — | `interview: AC-5 …` |
| AC-6 | — | `interview: interview.open returns the approval …`, `AC-6: approval by another GitHub account …` |
| AC-7 | `interview/frame.ts` | `interview: AC-7 …`, `units: reply frame` |
| AC-8, AC-9, AC-13 to AC-17, AC-21 | *(m2)* | — |
| AC-10 | `readiness.ts` checks 5 and 6 | `readiness: AC-10 …` ×2, `only an approve_assumption at the item's current revision counts` |
| AC-11 | `state-repo.ts` scans before every commit | `interview: refuses a request holding a secret …`, `AC-11: a secret in a reply blocks the commit …`, `a failing secrets scan fails closed` |
| AC-12 | FR-14 part only (marking and resume bookkeeping); the session resume itself is *(m2)* | `engine: FR-14 …`, `units: runs` |
| AC-18 | `git.ts` overrides; state commits made by plumbing only | `units: AC-18 …` (repo `core.hooksPath`, `.husky`, `.git/hooks`, `core.fsmonitor`, clean/smudge filters all armed; none fires) |
| AC-19 | `readiness.ts readSpec` (refuses a link in any path segment, says nothing of the target) | `readiness: AC-19 …` |
| AC-20 | `config/pins.ts`, `config/confirm.ts` | `engine: AC-20 …`, `a new project path stops the project until confirmed …`, `confirm: the owner types the name and approves as the previously pinned owner …`, `an unmerged edit in the working tree changes nothing` |
| SR-1 | Tokens and codes never logged or written; askpass for push; internal errors hidden behind a fixed message | `units: talks to a fake GitHub over HTTP: … token never logged`, `channel: hides internal errors …`, `units: fails closed when the OS store fails, and never echoes the secret` |
| SR-2 | Fail closed throughout | Tests listed for FR-2, FR-7, SR-15, AC-11 |
| SR-3 | `tools.ts` validates every argument against v1.0; owner text stored as JSON strings | `interview: one question at a time …`, `readiness: SR-12 …` |
| SR-4 | `log.ts` action log (agent, action, target, time, approval id, outcome) | covered indirectly by the GitHub and confirm tests |
| SR-5 | `manifest.ts` reads `main` only; `pins.ts` in engine home | `engine: pinned keys` block, `units: pins compare …` |
| SR-6 to SR-10, SR-14, SR-18 (session caps), SR-21 | *(m2)* | — |
| SR-11 | `git.ts overrideArgs` and `env` on every command | `units: every command carries the overrides`, `AC-18 …` |
| SR-12 | `readiness.ts readSpec` | `readiness: SR-12 …`, `AC-19 …` |
| SR-13 | `config/paths-file.ts` (link, owner, mode; Windows owner and ACL through FFI and SDDL; master repo or clone refused) | `engine: SR-13` block, `units: project paths file …`, `on Windows, checks the owner and ACL through the FFI module` |
| SR-15 | `os/ffi.ts`, `unix.ts checkSocketReadBack`, `windows.ts` ACL read-back | `channel: SR-15 …` ×2, `the real FFI module on Linux` block, `units: SDDL`, `Windows pipe listener through a fake WindowsApi`, `the FFI module declares a fixed list of functions per OS` |
| SR-16 | `engine.ts` (ambiguous ids refused in every project, Security item), sessions per project | `interview: refuses an id found in two projects`, `units: sessions never share approvals across projects` |
| SR-17 | `transcript.ts`, `record.ts` (head in the engine record) | `units: transcript chain` block, `interview: refuses a transcript someone else appended to …` |
| SR-19 | CI only; proposed workflow below | — |
| SR-20 | `secrets.ts`, `cli.ts secret set` | `units: secrets` block |
| SR-22 | Transcript entries are JSON strings; `readiness.ts remoteContentLines` | `readiness: SR-22 …`, `finds reference-style remote images` |
| SR-23 | `github.ts parseDeviceCode`, `parsePoll` | `units: validates every field of the device code answer`, `reads poll answers …` |

## Tests run

All runs used Node 22 on Linux, from `engine/`:

- `npm ci --ignore-scripts`
- `npm run typecheck`: passes.
- `npm run build`: produces `dist/engine.js` (403 KB). `node dist/engine.js --help` works.
- `npm test`: 5 files and 94 tests, all passing.

| File | Tests |
|---|---|
| `engine.test.ts` | 17 |
| `interview.test.ts` | 22 |
| `readiness.test.ts` | 9 |
| `channel.test.ts` | 15 |
| `units.test.ts` | 31 |

The Linux FFI paths are tested against the real kernel through koffi: `SO_PEERCRED`, `geteuid`, and fail-closed on a bad descriptor or a file that isn't a socket.

## Spec deviations

None intended. The points below are where the spec or the contracts leave the
choice open. Each is my reading, and each is easy to change.

## Interpretations (owner to confirm)

1. **Served channel version is `"1.2"`.** FR-4 says to serve v1.3 but to refuse the advisor kinds and report the served version "so the skill doesn't offer the advisor". The F-006 client offers the advisor at 1.3 or later. Reporting 1.3 would make it offer a feature that always returns `kind_not_allowed`. The engine therefore implements v1.3's methods, refuses the advisor kinds, and reports `1.2` in `engine.json` and `engine.status`. *Decided by the owner in fix round 1: spec v22's FR-4 now says this.*
2. **Feature branch, spec and transcript live in the project's config repo.** That is the repo whose `main` holds the manifest and whose `factory/state` is checked out at `.factory`. The analyst's worktree is passed in by the caller (milestone 2 creates it).
3. **`suggested` uses the 4,000-character text limit.** Interview tools v1.0 gives no separate limit for it.
4. **Assumption matching is by normalized text.** Check 5 matches a spec row to an interview assumption when whitespace-collapsed, case-folded text is equal. The approval must be an `approve_assumption` reply at the item's current revision.
5. **Entries past the recorded chain head are refused.** A transcript is accepted only if it ends exactly at the head in the engine record. This counts as tampering: the feature is refused, a Security item is filed and the readiness checks fail.
6. **`settings.budget.mode` is required** in the manifest, and **the project name must match** `^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$` (it names a credential and a Security item).
7. **Logs are kept 30 days.**
8. **`research_web` caps.** The per-question and per-session cap values are still undecided. `research_web` is a stub that returns error code `unavailable` and appends nothing.
9. **After all checks pass, the stage becomes `security_gate_1`.**
10. ~~Code -32000 is used for refusals the channel contract has no code for.~~ *Replaced in fix round 1 by the contract code -32008 `refused` (H-0084).*

## Deferred to milestone 2

- Agent SDK sessions for the analyst and the web reader (FR-8), with the SR-10 options.
- Containers, the `--internal` network, the proxy and its per-session credentials, and egress rules: SR-6 to SR-9, SR-14, AC-8, AC-13 to AC-16.
- Role policy enforcement on file tool calls, and the end-of-session write-rule check: FR-9, FR-11, AC-9, AC-17.
- MCP wiring of the five interview tools (they exist as functions now).
- `research_web` and `fetch_page`: SR-21, AC-21.
- SR-18 caps per session and per container.
- Fetching `factory/state` on start, and the SR-17 check after a fetch. Milestone 1 checks the chain on every read of the local transcript.
- Resuming the actual SDK session (AC-12). The bookkeeping half is done.

## Untested, and why

| What | Why |
|---|---|
| Windows FFI: pipe creation, ACL read-back, client SID and pid, Credential Manager, file owner and ACL | This container runs Linux. The pure parts (SDDL parsing, owner-only judgement) and the listener logic are tested through a fake `WindowsApi`. The proposed CI runs the suite on `windows-latest`, but nothing there drives the real FFI yet. |
| macOS FFI: `getpeereid`, `LOCAL_PEERPID`, Keychain | No macOS host. Tested only through the `UnixApi` and `CredentialApi` seams. |
| Linux libsecret | There is no secret service daemon in the container. Tested through the `CredentialApi` seam. |
| The real gitleaks binary | It isn't installed here, and only the pinned build may run. The argument list, working folder, environment and exit-code mapping are tested with a fake that logs them. The pinned SHA-256 values in `constants.ts` must be checked against the release before first use. |
| Real GitHub (device flow, `/user`, repo lookup) | No network access to GitHub, and no OAuth app. Tested against a fake over loopback HTTP, including the real `HttpGitHub` parser. |
| Push of `factory/state` over HTTPS with askpass | No remote. `push` defaults to false in tests. |
| `cli.ts` itself (`start`, `secret set`) | Thin wrappers. `confirmProject` is unit-tested; the CLI was only run with `--help`. |

## Proposed CI workflow (needs owner approval; `.github/` is change-controlled)

`.github/workflows/engine.yml`:

```yaml
name: engine
on:
  push:
    paths: ["engine/**", ".github/workflows/engine.yml"]
  pull_request:
    paths: ["engine/**", ".github/workflows/engine.yml"]
permissions:
  contents: read
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        working-directory: engine
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm ci --ignore-scripts
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
  osv:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: google/osv-scanner-action/osv-scanner-action@v2.0.2
        with:
          scan-args: --lockfile=engine/package-lock.json
```

Before approval, pin each action to a full commit SHA (the tags above are
placeholders for review). The job has no secrets. The image scan in SR-19
joins this workflow in milestone 2, when the image exists.

## Open questions for the owner

1. ~~Confirm interpretation 1: report channel `1.2` until the advisor increment.~~ Decided: spec v22.
2. Confirm interpretations 4 to 6: assumption matching, refusing entries past the chain head, and the manifest rules.
3. Set the `research_web` cap values before milestone 2.
4. Approve the CI workflow above as a hygiene item.

## Fix round 1

The orchestrator merged milestone 1 with the test engineer's acceptance
suite. On that branch (`00f7d69`), 210 of 214 acceptance tests passed. This
round fixes the four items the coordinator assigned. It also applies the
owner's decisions on the two held items:

- **Channel version (ST-1):** keep reporting `1.2`. Spec v22's FR-4 now says so, and the code is unchanged.
- **Refusals:** use the new code -32008 `refused` (amendment H-0084).

### Changes

| Item | What changed | Where |
|---|---|---|
| RS-1 (AC-12) | **`handle.crash()`.** It stops as a kill would. Every later commit, push and alert is refused, and `engine.json` stays. It still ends sessions and frees the sockets, so a new `startEngine` can run in the same process.<br>**Run bookkeeping.** The first `interviewTools` call for a feature starts its analyst run, recording the worktree, and a passing `interview_spec_ready` completes it. At start, each analyst run left `running` is marked `interrupted`. The engine then commits an Agent report for it (outcome `partial`, saying it was interrupted), resumes it with no retry counted, and hands its tools and resume plan to a new `resumeAnalyst` option.<br>**Crash-safe chain head.** The engine record now holds a *pending* head before each transcript commit. If a kill lands between the commit and the record update, the next start accepts the engine's own append; before this change it would have flagged it as tampering. The test report saw exactly this. | `engine.ts`, `state/record.ts`, `state/transcript.ts`, `interview/feature.ts`, `interview/tools.ts`, `state/runs.ts` |
| GS-4 (SR-1, SR-11; AC-11) | **Push target.** Pushes go only to `<webBase>/<owner>/<repo>.git`. `webBase` is the injected GitHub base (`https://github.com` by default). The engine rebuilds the URL from `origin`'s owner and repo; any other `origin` is neither pushed to nor fetched from.<br>**Plain http.** It is allowed only for a loopback base, and only one passed through the in-process options. Git then gets `-c protocol.http.allow=always` for that one command. Config and the CLI can't set a base. A non-loopback `http://` base stops the engine at start.<br>**`GitHubClient.webBase`.** This optional field carries the base when a client object is injected. | `state/state-repo.ts`, `github.ts`, `engine.ts` |
| TR-11 (SR-17, "on fetch") | **When it runs.** With `push` on, the engine fetches `factory/state` from the same URL at start and on the new `handle.sync()`, with the token through askpass. `sync()` also re-checks every open transcript on the local branch.<br>**Interview changes.** If the remote changes anything under `interviews/` that the local branch doesn't hold, nothing of it is adopted. One Security item is filed for each remote commit and folder, and the feature's readiness checks fail (`transcript_intact`). The interview itself goes on, because the engine's local transcript is intact. This is what TR-11 expects. A local edit to a transcript (checked by `sync()` and at start) still closes the feature. Only the engine writes under `interviews/`, so a whole extra file such as `forged.jsonl` counts too.<br>**Other changes.** Remote changes elsewhere are adopted when they fast-forward, with files written from blobs as at checkout. A diverged branch is not adopted, and the engine logs a warning. | `engine.ts`, `state/state-repo.ts` |
| H-0084 (-32008 `refused`) | **Code.** Every security refusal on the channel now returns -32008 with one fixed message: "Refused for a security reason. The reason is in a Security inbox item." This covers a secret found in `feature.start` or `interview.reply`, and a tampered transcript on `interview.open` or `interview.reply`.<br>**Security item.** A tampered transcript already filed one when the tampering was found. A found secret now files its own item, holding only the method, the feature and the gitleaks rule ids, never the text.<br>**What else changes on factory/state.** The secret refusal now makes one commit: the item. The transcript and everything else stay as they were.<br>**Unchanged.** Interview tools v1.0 errors keep their own codes. | `constants.ts` (`RPC.refused`, `REFUSED_MESSAGE`), `channel/methods.ts`, `engine.ts` |
| SR-5 confirm | `handle.confirmProject(path, io)` runs the confirm command with the engine's GitHub, clock and logger. `io` answers the name prompt and receives the device code, as the test report (c-4) asked. | `engine.ts` |

Other changes in `engine/`:

- **`vitest.config.mts`** runs the unit tests and the acceptance suite as two projects, so `npx vitest run` uses the acceptance suite's own timeouts.
- **Typecheck.** `tsconfig.json` excludes `test/acceptance`, and `npm run typecheck` checks it with its own tsconfig.
- **Unit tests.** 9 new ones, plus 3 updated for -32008:
  - `test/remote.test.ts` (6): pushes, origin rules, fetch at start, `sync()`. They run against real git smart HTTP on loopback (`test/git-http.ts`).
  - `engine.test.ts` (3): crash and resume, the pending head, confirm on the handle.
  - `interview.test.ts`, updated: both secret refusals and the tampered `interview.open` expect -32008 with the fixed message. The secret tests also check that the only new commit adds one Security item, and that the item holds the rule id but not the secret.
- **README** documents the handle and the new options.

### Tests run

All runs are from `engine/`, after merging `claude/project-thread-xnrw8z` at `6eda8c5` (spec v23, H-0084).

- `npm run typecheck`: passes for the engine and for the acceptance suite.
- `npm run build`: passes.
- `npx vitest run`: 317 tests, 315 passing.

| Suite | Passed | Failed |
|---|---|---|
| Unit | 103 of 103 | 0 |
| Acceptance | 212 of 214 | 2 |

The two acceptance failures:

- **ST-1** expects channel `1.3`. Spec v22 says `1.2`, so the test needs to change.
- **RS-1** needs harness wiring, and an Interfaces decision on how an interrupted run shows in the report (see below).

GS-4 and TR-11 now pass. TR-11 passes through the fetch at start, because the harness falls back to a restart when the handle has no `sync`.

### Still open

1. **RS-1 also needs harness changes** (the test engineer's file). `harness.ts` still throws `MissingSeam` for `crash()`, and nothing maps `resumeAnalyst` to the fake analyst, so no restart triggers a resume. The test also asserts that some report value is exactly `"interrupted"`. Agent report v1.1 allows only `complete`, `blocked`, `failed` or `partial`. The engine therefore writes `partial`, says "interrupted" in the summary, and the engine record holds the `interrupted` status (`handle.runs`).
   - **Decision needed (Interfaces):** either add an `interrupted` outcome to the Agent report, or have RS-1 check `handle.runs`.
2. **Harness mapping for the other items.** The harness can now call `real.sync()` (TR-11 without a restart) and `real.confirmProject(path, io)` (c-4, in place of building the command from internals).
3. **ST-1** in the acceptance suite still expects channel `1.3`. Under spec v22 it needs to expect `1.2`; that is the test engineer's change.
