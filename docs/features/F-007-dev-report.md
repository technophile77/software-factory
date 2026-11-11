# F-007 Developer completion report — milestones 1 and 2

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

## Fix round 2 (Windows and macOS)

This round merges `claude/project-thread-xnrw8z` at `c03bfe5`. That merge
brings in the engine CI workflow, portable test fakes and FX-7.

### What changed

| Item | Change | Where |
|---|---|---|
| SR-13 / SR-15: SDDL aliases | **The bug.** Windows writes some SIDs as aliases relative to the machine or domain, such as `LA` for the built-in Administrator (the CI runner's user). The parser knew only `SY` and `BA`, so every projects file and pipe ACL was refused.<br>**The fix.** The parser now knows every fixed alias (`WD`, `AU`, `BU` and the others). Machine- and domain-relative aliases (`LA`, `LG`, `DA`, `DU` and similar) stay *unresolved*: such an alias never matches the owner and counts as an untrusted writer, so the check fails closed.<br>**The current user's own alias.** The FFI layer passes the user's SID through Windows' own converter to learn which alias, if any, Windows writes for it. It then writes that one alias back as the SID in `fileSddl` and `handleSddl` (`withSelfSid`). The alias is never taken from the descriptor being checked. | `os/sddl.ts`, `os/ffi.ts` |
| AC-4: ancestry off Linux | **What changed.** The channel's "a process the engine started" check now walks the whole ancestry on macOS (`proc_pidinfo` with `PROC_PIDTBSDINFO`, reading `pbi_ppid`) and on Windows (Toolhelp snapshot, reading `th32ParentProcessID`). Both go through koffi 3.3.6, and the new functions are on the fixed FFI list. Before, only direct children were refused there.<br>**On failure.** If a lookup fails, or an OS has none, the check throws and the peer is refused.<br>**Residual risk (Windows).** A parent pid can be stale after its process exits and Windows reuses the number. A walk can then wrongly refuse a peer (fail closed); it can't wrongly admit one past a live engine. | `proc.ts` (`osParent`), `os/ffi.ts`, `engine.ts` |
| Windows pipe | **The hang.** Once the SR-13 fix let projects reach the channel, the whole test run hung on Windows. There were two causes:<br>• `FlushFileBuffers` after each write waits until the client has read everything. That deadlocks a client in the same process, which is how both test suites connect.<br>• A blocking `ConnectNamedPipe` held one of libuv's four pool threads for each listener.<br>**The fix.** The listener now waits in nonblocking mode and polls every 20 ms. It returns to blocking mode once a client is connected, and an instance left behind by a client that came and went is reset. The flush is gone. | `os/ffi.ts` |
| Portable unit tests | **git path.** `GIT_PATH` uses the engine's own `findOnPath` in place of `/usr/bin/git`.<br>**Real paths.** On Windows the engine compares real paths with `fs.realpathSync.native` (`realPath`), so the 8.3 short name `RUNNER~1` and git's long path compare equal. This was the next cause of "not the top of a Git work tree".<br>**SR-13 unit tests.** POSIX mode checks are skipped on Windows, with a reason. The group-writable test uses `grantWrite` on Windows. The paths-file test uses the real FFI with `ownerOnly`.<br>**Timeouts.** The unit-test timeout is now 30 s, because the loopback git-over-HTTP tests ran past 5 s on macOS. | `test/*`, `fsutil.ts`, `vitest.config.mts` |

New unit tests:

- the exact runner SDDL `O:LAD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)`, unresolved aliases, and `withSelfSid`'s rules;
- ancestry through `osParent` (a grandchild is refused, and a missing lookup throws);
- on macOS and Windows only, the real parent lookup returns `process.ppid`.

### Results

The last CI run was `39cbb6a` (run 43004419742). Before this round, Windows passed 69 and failed 235.

| OS | Passed | Failed | Skipped |
|---|---|---|---|
| ubuntu-latest | 317 | 0 | 4 |
| macos-latest | 307 | 0 | 14 |
| windows-latest | 304 | 3 | 14 |

In that run, FX-7 passed on Windows and CH-4 passed on macOS.

The three Windows failures:

- **The unit worktree test.** git prints `/`, not `\`. Fixed after the last push; three pushes were allowed, so CI hasn't run the fix.
- **IT-10 (200 items) timed out at 600 s.** Each item makes several git calls plus a scan through the launcher, and the Windows runner is slow. This is a speed problem, not a wrong result.
- **SE-11 measured 630 s of engine time against a limit of ≤ 620 s.** The engine waits exactly `wait_s`. The fake clock's `drive` loop advances further while a slow runner answers late, so this looks like the test's tolerance, not the engine.

On Linux, run locally after the final commit: typecheck clean, build passes, and `npx vitest run` passes 319 and skips 2 of 321.

CH-4 was un-skipped on Windows (`test/acceptance/channel.test.ts`, as the coordinator asked). It passes on Linux. The new ancestry lookup's own unit test passed on the Windows runner, but CH-4 itself hasn't yet run in Windows CI.

### Left open

1. **IT-10 and SE-11 on Windows** (see above). IT-10 needs more time or a lighter fixture on Windows. SE-11 needs `drive` to step more finely, or a wider tolerance. Both are the test engineer's call.
2. **Windows stale parent pids** in the ancestry walk: a residual risk for Security Gate 2. It can only fail closed.
3. **Speed of the pipe on Windows.** Connections are now polled every 20 ms and data every 10 ms. That is fine for the channel, but it is polling, not overlapped I/O.
4. **No job timeout.** The workflow (`.github/workflows/engine.yml`) has no `timeout-minutes`. The hung run sat for 54 minutes until it was cancelled. I suggest `timeout-minutes: 45` per job; this needs approval.

## Milestone 2

Built against spec v26 and the Gate 1 report. No Docker daemon was available,
so everything that touches Docker, the network or the model is behind a seam
and unit-tested with fakes. Real-daemon checks are in
`test/docker-real.test.ts`, which is skipped unless `FACTORY_DOCKER_TESTS=1`.

### What was built

| Part | Files | Requirements |
|---|---|---|
| `@vitest/coverage-v8` 5.1.0 (exact, dev only, integrity matches review 6) and `npm run coverage`. Reported only; no threshold. | `package.json`, `vitest.config.mts` | OQ-9 |
| Role policy v2.5, read from the manifest's `policy:` when a session starts, with repo overrides. Required denies, the open-web rule and the fixed web-reader policy are checked. The H-0046 glob dialect and the ADR 0015 real-path rule. | `src/policy/` | FR-9, SR-12 |
| The docker command line: absolute path, argument array, `DOCKER_*` and proxy variables cleared, an engine-owned empty `DOCKER_CONFIG`, and `--host` set to a fixed local endpoint. Names come from validated ids only. | `src/docker/cli.ts` | SR-14, AC-13 |
| Container plans (`docker run` arguments) and the post-start `docker inspect` check. The check covers image id, user, read-only root, capabilities, `no-new-privileges`, CPU, memory and pids limits, tmpfs, networks, exact mounts, log driver and host namespaces. Any mismatch removes the container. Values go in through `--env NAME` from docker's own environment, never in an argument (SR-1). | `src/docker/plan.ts` | FR-8, SR-14 |
| The session group, one per run. It has an `--internal` network, an outside network that only the proxy joins, and the proxy sidecar. The proxy runs from the pinned base image with `dist/proxy.js` mounted read-only. The model credential goes over the proxy's stdin only after the proxy passes its check. Each agent container gets its own random proxy credential, bound to its role's `network.allow`. The credential is revoked when the session ends. Containers, session volumes and networks are removed at the end. | `src/agent/sandbox.ts` | SR-6, SR-7, SR-16, sensitive data |
| The proxy, on Node built-ins only. CONNECT goes to port 443 only, for hosts on the role's list. The proxy resolves each name itself and refuses if **any** answer falls in an SR-8 range or a Docker subnet. It then connects to the address it checked. IP literals and numeric host forms are refused. The credential gateway lives at `/gw/<cred>/v1/messages[/count_tokens]`. A request carrying any key other than the dummy is dropped. The real key goes in as `x-api-key`, or a subscription token goes in as a bearer token. Nothing is logged with a credential. | `src/proxy/` | SR-7, SR-8, SR-9, AC-14 to AC-16 |
| `fetch_page`. The fetch runs inside the proxy, under the reader's credential, with each redirect checked again and the size capped. The engine then strips comments, scripts, styles, `head`, hidden elements (attribute, `aria-hidden`, inline styles), and zero-width, bidi and tag characters, and caps the text. | `src/agent/page-text.ts`, `src/agent/factory-tools.ts` | SR-21, AC-21, H-0083 |
| SR-10 options: `settingSources: []`, `strictMcpConfig`, the `factory` server only, the role's built-in tools plus its `mcp__factory__*` tools, `permissionMode: "default"`, `hooks: {}`, instructions passed in (from `agents/<role>/AGENT.md`, never the worktree), skills only from a baked plugin folder, and `env` limited to the four "off" flags. | `src/agent/session.ts` | SR-10 |
| The container spawn: `docker exec -i` into the session's container, running `/opt/claude/claude`. The SDK's host `command` is ignored, only SDK protocol variables pass, and bypass-permission arguments are refused. | `src/agent/session.ts` | SR-10 |
| The FR-9 tool gate (`canUseTool`). Every Read, Grep, Glob, Write and Edit path is mapped from `/workspace` to the worktree and checked with the real-path rule against the read or write rules. `Bash` is limited to one listed program with no shell syntax. Any other tool is denied. | `src/agent/session.ts` | FR-9 |
| SR-18 session caps: turns, output tokens or dollars, and wall time. A cap aborts the session and reports which cap. The SDK session id is recorded as soon as it is seen (FR-14). `WebSearch` queries are logged from the message stream. | `src/agent/session.ts` | SR-18, SR-21 |
| Interview tools v1.0 as `factory` MCP tools: JSON Schemas with the H-0082 limits, results mapped to `CallToolResult`, and research results labelled untrusted. | `src/agent/factory-tools.ts` | H-0082 |
| `research_web`, real version. The request is recorded under the feature lock, but the reader runs outside it. The query is logged against the item, with per-question and per-session caps. Each query gets its own web-reader session and container, with only the query as prompt. Sources are the pages the engine actually fetched. | `src/interview/tools.ts`, `src/agent/web-reader.ts` | H-0082, F-005 SR-6/SR-17 |
| Worktree commit (FR-11) with the end-of-session check in front. The engine reads the worktree itself (no git porcelain, links taken as links). git runs with an explicit `--git-dir`, because the agent can rewrite the worktree's `.git` file. The commit is refused on any path outside the write rules, a new or changed symlink, a changed `.git` link, history that no longer descends, or a secrets-scan hit. The branch moves by compare-and-swap. | `src/agent/worktree-commit.ts`, `src/agent/write-check.ts` | FR-9, FR-11, SR-11, SR-12, AC-9 |
| The analyst session from start to end: billing check, policy, group, container, tools, session; the container is stopped *before* the commit and check; then breach handling and cleanup. | `src/agent/analyst.ts` | FR-8 to FR-11, SR-18 |
| The agent image. The base is `node:26.13.0-trixie-slim@sha256:5adad64f…` (Gate 1 review 4). Claude Code 2.1.311 comes from an exact lockfile with `--ignore-scripts`; its binary's SHA-256 is checked against the SDK 0.3.311 manifest in the build stage. The final stage has no npm, npx or corepack, runs as `USER 1000:1000` and has no entrypoint script. | `docker/` | SR-19, G1 #18, #22 |
| CI flake fix: `driveClock` advances the fake clock only while something is waiting on it. The two confirm tests used a fixed number of steps. On a slow runner, the steps ran out before the device poll started sleeping, and the poll then waited forever. That was the Windows timeout in "confirm on the handle". | `test/helpers.ts`, `test/engine.test.ts` | — |

### Tests

There are five new unit files: `policy.test.ts`, `proxy.test.ts`, `agent.test.ts`, `research.test.ts`, and `docker-real.test.ts` (gated). They cover:

- the glob dialect and path rule;
- policy validation and overrides;
- the write check and worktree commit, against real git (including AC-9, symlinks, a tampered `.git` link and a secret hit);
- the SR-8 address table (mapped, NAT64 and numeric forms);
- the proxy end to end on loopback, with fake DNS: 407 and 403 paths, tunnelling, revocation, the gateway key swap, own-credential drop, subscription headers, `fetch_page` redirects and caps, and no credentials in logs;
- page stripping;
- docker argument building;
- inspect mismatches, one case for each field;
- the session group, with a fake docker that answers `inspect` from the arguments it was given (a tampered agent or proxy fails closed, and the credential is never sent to a proxy that failed);
- SR-10 options;
- the tool gate;
- container spawn;
- caps;
- the MCP tool mapping;
- research caps through the engine handle;
- the analyst session order.

The bundled `dist/proxy.js` was also smoke-run over stdio.

Results on Linux (this container): typecheck is clean, the build passes (`dist/proxy.js` is 17.5 kB and requires only `node:` modules), and `npx vitest run` passes 380 and skips 6 of 386. The skips are the gated Docker file and the earlier platform-only skips. The coverage summary for unit tests alone, from before the milestone 2 files existed, was 78% of lines.

### Blocked: decisions needed from the owner

1. **Agent SDK peer dependencies (Architecture, Security).** `npm ci` refuses a lockfile without the SDK's peers. `sdk.mjs` bundles its own zod and MCP code and imports neither peer at run time. Only its type file uses `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`, and `tool()` needs the caller's zod. So the SDK isn't installed yet. Options:
   - **A.** Pin all three peers exactly: zod 4.6.7 and MCP SDK 1.32.2 (both in Gate 1 review 2), plus an `@anthropic-ai/sdk` version, which review 2 left "not verified, choose at implementation". This adds about 100 packages to the host lockfile, including express, hono, cross-spawn, jose and ajv. None of them is loaded at run time and `npm audit` finds nothing, but none was reviewed under S4.1.
   - **B.** An `engine/.npmrc` with `legacy-peer-deps=true`, plus zod 4.6.7 as a direct dependency. The lockfile gains only the SDK, its 8 platform packages and zod, and peer type imports degrade to `any`. This is factory configuration, so it needs approval, and CI's `npm ci` picks it up unchanged.

   I recommend **B** (the smallest supply chain). With either option, the 8 SDK platform packages carry a native Claude Code binary of about 290 MB. One of them lands on the host and is never run, because every session goes through the container spawn. Once this is decided, the remaining work is one binding file (`src/agent/sdk-binding.ts`, about 30 lines, mapping `query` and `createSdkMcpServer`/`tool` onto `src/agent/sdk.ts`) and a test that `docker/claude-sha256.json` equals the installed SDK manifest.
2. **SR-18 and H-0082 values (Product, Security).** The spec puts them in "change-controlled config" but gives no numbers and no file. Without them no session starts, because the engine has no defaults. Needed:
   - per session, for the analyst and for the reader: turns, output tokens or dollars, and wall time;
   - per container: CPU, memory, pids and temp size, for agents and for the proxy;
   - `research_web` per question and per session;
   - `fetch_page` bytes per page and characters per page;
   - research summary length and the most sources returned;
   - the worktree commit's file-count and byte limits.

   Also: **which file** holds them. I suggest a `limits:` block in the engine home's `engine.yaml` (outside every repo), or keys in the project manifest under a hygiene item.
3. **The gateway's API paths (Interfaces, Security).** SR-9 says "the paths Claude Code uses". I allowed only `POST /v1/messages` and `/v1/messages/count_tokens` (query `?beta=true`). The first real-daemon run will show whether Claude Code 2.1.311 needs others.
4. **Subscription tokens through the gateway (Security; SR-9 says ask before any fallback).** The gateway sends a subscription token as `Authorization: Bearer` plus `anthropic-beta: oauth-2025-04-20`. This is unverified. If the first real run fails in subscription mode, the owner decides the fallback. Nothing falls back on its own.
5. **Skills baked into the image (Architecture).** SR-10 says skills come only from the pinned master factory version, baked into the image. Two things are open: which version (`factory.version` in the manifest? a commit of the master clone?), and how the image gets them. I suggest copying `skills/` from that commit into a local plugin folder at build time. Until this is decided, a role with `Skill`, which includes the analyst, refuses to start.
6. **Where `AGENT.md` is read from (Architecture).** It must be "from the master factory, never the worktree". It could be read from the master clone's working tree, its `HEAD` commit, or the commit named by `factory.version`. I'd read the blob from a pinned commit.
7. **Which item a research call counts against (Product).** `research_web` takes only `{ query }`. I count it against the item in `researching`, or else the open question. A call with neither counts only against the session cap. "Per session" is per analyst session, held in memory.
8. **The OSV-Scanner image scan in CI (SR-19).** It needs a step in `.github/workflows/engine.yml`, which is change-controlled, and a component review of OSV-Scanner. The step would build the agent image and scan it. It needs a hygiene item. The image's Debian packages haven't been CVE-checked yet (Gate 1 review 4).

### Interpretations (owner to confirm)

- **`DOCKER_CONFIG`.** SR-14 says to clear `DOCKER_CONFIG`. I set it to an empty engine-owned folder instead. Clearing it would load the owner's `~/.docker/config.json`, which can set a remote context, inject proxy variables into containers, and run credential helpers. The endpoint is passed as `--host`, chosen from a fixed per-OS list of local sockets and pipes. Remote (tcp/ssh) endpoints are refused.
- **Network scope.** There is one internal network and one proxy per run; the analyst and its web readers share it, each with its own credential. That satisfies SR-16, which allows sharing within a project. Docker gives identical images the same id, so two projects with the same Dockerfile get the same agent image id. They hold no state.
- **Which DNS answers refuse.** The proxy refuses a name if any of its DNS answers is blocked, not just the one it would use. This is stricter than SR-8. It also refuses reserved IPv4 (240/4) and NAT64 forms carrying a blocked address.
- **Hidden content.** Only inline markup and styles are recognised. Text hidden by a stylesheet class still reaches the reader. That residual risk goes to Gate 2.
- **Directory-level reads.** `Grep` and `Glob` on a directory are checked against the directory, not each file under it. Deny globs on files inside an allowed directory therefore don't stop a directory-wide `Grep`. The fresh-worktree rule (tracked files only) limits the impact. That residual risk goes to Gate 2.
- **Whether to commit at all.** The worktree commit includes ignored files, so they pass the write rules and the secrets scan too. Ignored files are left out only if the owner prefers that.
- **The proxy's control channel.** The proxy runs attached (`docker run -i`, log driver `none`), so pages and logs never land in Docker's log files.

### Not done in this milestone

- Starting the analyst from `feature.start` and feeding owner replies in as turns. The `frameTurn` / `undelivered` pieces exist, and `runAnalystSession` takes the turns as a stream, but the engine doesn't call it yet. It is blocked on decision 1 (no SDK) and decisions 2, 5 and 6 (no limits, skills or instructions source).
- Using the session volume on resume: the volume is created per container, and passing an existing one in on resume is still to come.
- The real-daemon run of AC-8 and AC-13 to AC-16. The test is written and needs the owner's machine (`FACTORY_DOCKER_TESTS=1`).
- A sweep of leftover containers after a crash (by the `factory.run` label).

### Agent SDK installed (owner decision, 2026-11-11)

- **What's installed:** `@anthropic-ai/claude-agent-sdk` 0.3.311 and `zod` 4.6.7, both exact. `engine/.npmrc` sets `legacy-peer-deps=true`, so `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` aren't installed. CI runs `npm ci --ignore-scripts` in `engine/` and picks up the `.npmrc`; that was checked from a clean `node_modules`.
- **A side effect, fixed by pinning:** with peers no longer installed automatically, vitest's peer `vite` would have dropped out of the tree. It is now an exact dev dependency at 8.3.8, the version already in the reviewed lockfile.
- **What the lockfile gained:** the SDK, its 8 platform packages and zod. Nothing else was added, changed or removed. `npm audit --audit-level=high` reports 0.
- **The binding:** `src/agent/sdk-binding.ts` loads the ESM package at run time; the engine bundle keeps it external.
  - The `factory` server is built with `createSdkMcpServer` and `tool()`.
  - Each tool's JSON Schema becomes its zod shape through `z.fromJSONSchema`, and the handler still checks every argument itself.
  - `query()` refuses any session without `spawnClaudeCodeProcess`.
  - `test/sdk-binding.test.ts` checks that `docker/claude-sha256.json` equals the installed SDK manifest.
- **The host binary is never executed:** the SDK's platform package (`claude-agent-sdk-<os>-<arch>`, plus the musl variant on Linux) puts a native Claude Code binary of about 290 MB on the host. The engine never runs it:
  1. Install scripts are off.
  2. The SDK starts the CLI only through `spawnClaudeCodeProcess` when one is given. The engine always gives one, and the binding refuses a session without it.
  3. The engine's spawn ignores the SDK's `command`, which is that host binary's path; the unit test confirms that's what the SDK passes. It runs `docker exec … /opt/claude/claude` in the session's container instead.
  4. No other SDK function that starts the CLI is called.
- **SR-10, checked against the SDK:** a real `query()` against a stand-in spawn shows that SDK 0.3.311 passes SR-10 as `--setting-sources=`, `--strict-mcp-config` and `--permission-mode=default`. The container spawn now refuses to start without the first two, and refuses `--permission-mode=bypassPermissions`. It also lets the SDK's protocol variable `CLAUDE_CODE_SDK_READS_SESSION_STATE` through.

### Session limits (H-0087, owner decision, 2026-11-11)

This settles blocked decision 2 above.

- **The file:** `engine/config/limits.yaml` holds the spec v29 §10 values exactly. The spec gives the values; the section and key names are mine, with units in the names:
  - sections `analyst`, `web_reader`, `proxy`, `research_web`, `fetch_page`, `research_result` and `worktree_commit`;
  - keys such as `turns`, `output_tokens`, `dollars`, `wall_time_minutes`, `cpus`, `memory_mib`, `pids` and `tmp_mib`.
- **Where it is read from:** superseded by spec v30 (below): the commit `factory.version` names, through `git cat-file`, never a working tree.
  - The file must hold every key. Each value must be a positive finite number, and whole where the key needs it. Unknown sections and keys are refused.
  - The engine has no built-in values. If the file is missing or invalid, nothing that needs limits can run.
- **When it is read:** superseded by spec v30 (below): for every project in phase 1, so a project runs only once its limits are known.
- **The manifest block (v1.4):** it is checked in phase 1, after the manifest and before the pins.
  - The engine takes the lower of the project's value and the default, key by key.
  - The project is stopped and a Security item is filed if any of these holds: a value is above the default, the block is invalid, or the defaults can't be read. The item names the keys; it is filed once per main commit and reason.
- **Consumers (`src/config/limits.ts`):**
  - SR-18 session caps for the analyst and the reader. `dollars` applies only in tokens mode, so a subscription project's session has no budget cap.
  - Container limits per role. `GroupConfig.agentLimits` is now keyed by role, and a role without an entry gets no container. The proxy has its own limits.
  - `research_web` per question and per session.
  - `fetch_page`: the proxy's byte cap and the characters returned.
  - Research summary length and the number of sources.
  - The worktree commit.
- **Worktree commit:** the caps now count changed files only: files changed (deletions included), total size, and largest file.
  - A file whose size or mode differs from its base entry meets the caps before it is read. Once a cap is passed, nothing more is read.
  - The result is `over_limit` with the cap's name, and nothing is committed. The analyst logs which cap.
  - The write rules are still checked on every changed path, so a breach past a cap still rejects the session and files its Security item (AC-9).
- **Onboarding plugin:** `factory_check.py` checks an optional `limits` block: known sections and keys, mappings, and positive numbers, whole where needed. Its parser returns decimals as text, so decimal text counts as a number.
  - A test keeps its key table equal to `engine/config/limits.yaml`.
  - The template has a commented example saying projects may only lower values.
  - The checker doesn't compare values with the master defaults; the engine does.
- **Tests:**
  - `test/limits.test.ts`: the shipped values, parse refusals, the merge, reading from a given commit, and each converter.
  - `test/engine.test.ts`: lowered values, a value above the default, an invalid block, missing or invalid defaults, and the tagged commit versus later commits and the working tree.
  - `test/agent.test.ts`: per-role container limits.
  - `test/policy.test.ts`: each worktree cap, unchanged files, and breaches past a cap.
  - The onboarding suite gains the `LimitsV14` class.

### Agent sources pinned to `factory.version` (spec v30, owner decision, 2026-11-11)

This settles blocked decisions 5 and 6 above.

- **The master commit:** `src/config/factory-source.ts` resolves `factory.version` through `refs/tags/<version>` only. All of these refuse the project with a Security item:
  - a name that isn't a plain tag name (for example `HEAD~1`);
  - a missing tag;
  - a name that is also a branch (ambiguous);
  - a tag of anything but a commit.

  Limits, `AGENT.md` and skills are read as blobs from that commit, never a working tree. The engine now requires all of this for every project in phase 1, so `handle.limits()` is synchronous.
- **Project overrides win (owner rule: a project's changed agent is never overwritten by a factory pull):** `src/config/agent-sources.ts` reads `agents` and `skills` (`custom`, `override`, `exclude`) from the manifest. Their files come from the config repo's `main` commit, the one the manifest was read from.
  - For `AGENT.md`, the order is: project override, then project custom, then `agents/<role>/AGENT.md` at the master commit. A role with none of these may not run; `handle.instructions()` throws for it.
  - For skills, the order is: the master `skills/<name>/` folders, minus excluded ones, with overridden ones replaced by the project's folder, plus custom ones. A custom skill with `agents:` goes only to the roles it lists.
- **Path rules:** each path must be relative and `/`-separated, with no `..`, `.`, `.git`, drive or absolute part.
  - The file or folder is read from the git tree. A symlink, a submodule, a path through a symlink or a missing file refuses the project, and the engine files a Security item.
  - A skill path must end in `/SKILL.md`; its folder is the skill.
- **Proposal 0013 rules, now enforced by the engine too:**
  - `override` and `exclude` names must exist at the master commit;
  - `reason` is required on each;
  - a name may appear only once;
  - `security-review` and the six core agents can't be excluded;
  - overriding a protected item needs `decision: D-nnnn`;
  - a custom name can't shadow a master default (use `override`).
- **Bounds (my choice, an engine guard, not owner limits):** 256 KiB per `AGENT.md`; per skill folder, 100 files and 2 MiB.
- **Baked into the image:**
  - `writeBuildContext` assembles a fresh context. It holds the engine's own image files plus `skills/<role>/`, a local plugin (`.claude-plugin/plugin.json` and `skills/<name>/…`) for each role in the policy and each custom agent. File modes are kept.
  - The Dockerfile copies it to `/opt/factory/skills`, root-owned and read-only. `skillsPluginDir(role)` gives the session its plugin path.
  - The image carries the labels `factory.master_commit` and `factory.skills_sha256` (a digest of every role's skill files) and the tag `factory-agent:<project>-<commit12>-<digest12>`. So different versions, or different overrides, give different images. `buildAgentImage` checks both labels on the built image.
- **Fixtures:** the unit master repo now holds `limits.yaml`, two `AGENT.md` files and two skills, tagged `v0.1.0`. The acceptance master (already tagged `v0.1.0`) gains `engine/config/limits.yaml`, as the coordinator allowed.
- **Tests (`test/engine.test.ts`, `test/agent.test.ts`):**
  - the tagged commit versus later commits and the working tree;
  - seven ways the version or its files fail;
  - master defaults per role;
  - overrides and custom skills winning over a newer master and over an unmerged edit;
  - exclude, including a protected skill;
  - ten path and rule refusals, symlinks included;
  - image labels, tag and build context.
- **Not done (at the time):** starting the analyst from `feature.start`, and recording the resolved skill list in the agent report. Both are done in the next section.

### The analyst, wired end to end

- **Who starts it:** `feature.start` and every resume of an interrupted run now start the analyst. They do this through `EngineOptions.agents` (an `AgentRuntime`: Docker, the SDK loader, the image's files, the proxy bundle). The CLI builds the real one.
  - With no docker client or local daemon, the CLI passes a stand-in that refuses every call with that reason, so a session never starts (AC-13).
  - Without `agents`, the engine behaves as before; the acceptance harness relies on this.
- **What one run does (`runAnalyst` in `src/engine.ts`, helpers in `src/agent/runtime.ts`):**
  1. **The worktree:** an engine-owned checkout of the feature branch at `<engine home>/worktrees/<project hash>/<feature>`.
     - It is made with `git worktree add --no-checkout`, then filled from git blobs and `read-tree`, so no repo filter, attribute or hook runs (SR-11).
     - Its git dir is taken before any agent runs and kept in the run record (`git_dir`).
  2. **The image:** the project's image for its `factory.version` commit and skills digest. An image already tagged for that identity is reused if its labels and user check out; otherwise it is built. The pinned base image doubles as the proxy image.
  3. **The containers:** the run's `SessionGroup`, with the project's effective limits for each role and the proxy, the page byte cap, and the model credential chosen as for the billing check.
  4. **The session:** `runAnalystSession` with the analyst's resolved `AGENT.md` (and the reader's, for `research_web`), the session caps from the limits, and the role's baked plugin path.
  5. **Turns (`TurnQueue`):**
     - The first turn names the branch and the spec path and gives the owner's request in a boundary frame (`frameRequest`). A resume from a commit adds the transcript summary; a resume of an SDK session gets a short "continue" turn instead.
     - After that, each batch of owner replies is handed over through `takeTurn` (framed, and recorded as delivered) as soon as it is committed, except while the feature is paused.
     - A passing `interview_spec_ready` closes the stream, which ends the session.
  6. **The commit:** after the container is gone, the FR-9/FR-11 commit goes to the branch, and `last_commit` is recorded.
- **How a run ends:**
  - **Complete:** the spec passed.
  - **Failed, with a partial report and a transcript note naming the reason:**
    - a cap, including a worktree cap;
    - a breach: a Security item is filed and the worktree reset to the branch;
    - a secret in the change: a Security item is filed and the worktree reset;
    - a session error;
    - a session that ended without a ready spec.
  - **Interrupted, with a transcript note:** the session couldn't start at all (Docker down, image build failed, no credential). The next engine start resumes it.
  - **On `stop()`:** sessions end with their turn streams, their work is committed, and the runs stay open. The next start marks them interrupted and resumes them (FR-14). `crash()` writes nothing more.
- **Reports:** the agent report's envelope `artifacts` lists `{ kind: "image", ref: <tag> }` and one `{ kind: "skill", ref: "<name> (<master|project>: <path>)" }` per resolved skill. This applies to the spec-ready report and to the report of a stopped run. Using `artifacts` needs no contract change. A dedicated field would.
- **Resume (AC-12):**
  - The analyst's SDK session lives on the run's own volume (`factory-<run>-session`). `startAgent(…, { sessionVolume: "run" })` creates it, or reuses it only if its labels name this run and project. Group close leaves it in place; it is removed when the run ends.
  - A resume with a recorded session id passes `resume`. If the volume is gone, it starts again from the commit instead.
- **Sweep at start:** containers, networks and volumes carrying the `factory.run` label are removed. The exception is the session volume of a run that is still interrupted, so it can resume.
- **Interpretations for the owner:**
  - A session that couldn't start leaves the run interrupted, not failed. It then retries only at the next engine start; there is no retry while the engine runs.
  - The sweep removes every `factory.run`-labelled resource on the Docker daemon. It assumes one engine per daemon.
  - Models: see "Models (spec v32)" below.
- **Tests (`test/analyst-run.test.ts`, fake Docker and a scripted SDK that drives the real factory tools):**
  - the full path from `feature.start` to a committed spec, with the image identity, instructions, limits, framed turns and report artifacts checked;
  - a turns cap;
  - AC-9 (a breach);
  - AC-13 (Docker down, then a resume from the commit);
  - AC-12 (a kill, the sweep, the kept volume, and an SDK-session resume).

  The fakes moved to `test/fakes.ts`. The real-docker test stays behind `FACTORY_DOCKER_TESTS=1`.

## Models (spec v32)

- **The file:** `engine/config/models.yaml` maps `requirements-analyst` to `claude-opus-5-5` and `web-reader` to `claude-haiku-5-5`. The engine reads it from the `factory.version` commit, in the same listing and blob read as `limits.yaml`, so a start still costs three git processes for these sources.
- **Checks (fail closed, Security item):** the file is missing, is not a regular file, is over 16 KiB, is not YAML, names a role other than those two, lacks either role, or has an empty or non-string model id. A model id may hold letters, digits and `._:@/-`, up to 200 characters.
- **Use:** the analyst's SDK options get `model` from `requirements-analyst`, and each web reader's from `web-reader`. The agent report's `model` field is the analyst's model. Its `artifacts` list `{ kind: "model", ref: "<role>: <model>" }` for the analyst, and for the web reader when the project has one. A project can't override the models yet; that comes with F-002's rungs.


## Docker on Windows (real run on Docker Desktop, WSL2)

- **Client lookup:** `findOnPath` takes a name that already ends in a PATHEXT extension (`docker.exe`) as is, matching case-insensitively; any other name gets each extension. It skips relative, drive-relative (`C:dir`) and rooted-without-drive (`\dir`) PATH entries and empty entries, so the current directory is never searched.
- **Endpoint:** on Windows, `pickEndpoint` probes each named pipe on the fixed list by connecting and closing at once. An open connection or EBUSY counts as present; any other error, or no answer within 1 s, counts as absent, so sessions are refused.
- **Builds:** the agent image is built only with `docker buildx build --load`, and `DOCKER_BUILDKIT=1` is set. If `docker buildx version` fails, the build is refused with a clear message instead of falling back to the legacy builder. BuildKit makes no intermediate containers, so there are none to label or sweep. The image is shared by every run of a project version, so it carries `factory.project` and no `factory.run` label.
- **Environment:** on Windows the client also gets `ProgramData`, `ProgramFiles` and `ProgramW6432`. The client finds CLI plugins only under the first two, and the third covers an engine started from a 32-bit process. Home and AppData variables stay out, because `DOCKER_CONFIG` replaces `~/.docker`. `DOCKER_*` from the owner's environment is never passed.
- **Arch:** the Dockerfile uses `TARGETARCH` when BuildKit sets it, and otherwise uses the base image's `node -p process.arch`. It fails with a message naming both values when the result isn't amd64/x64 or arm64.
- **Errors:** `DockerError` carries the last 4 KiB of docker's stderr, cut at a line start. Process stderr capture now keeps its first 4 KiB and last 8 KiB, where it used to keep only the start. The engine log gets the whole tail; the owner's transcript note stays at 300 characters.

## Windows test run on the owner's PC (non-elevated, Defender on)

- **Timeouts:** the acceptance world ran all of the engine's git through a logging wrapper. On Windows each call started a launcher, then Node, then git. Logging is now opt-in (`World.create(…, { logGit: true })`), used only by the tests that read the log: GS-1 to GS-4 and SC-1. The launcher was already compiled once per source text. Each world still copies it, because Windows can't delete any name of a running image, so a shared hard link would block cleanup.
- **Transcript commits:** these now use 7–8 git processes, down from 11 plus 4 per extra file. Blob ids are computed in-process and scanned before anything is written, so a refused secret never becomes a git object and nothing needs removing. All blobs are written in one `hash-object`. Both index updates go through one `--index-info` each. A commit on top of the engine's own last commit reuses its temp index. Git's returned ids must match the scanned ones.
- **SC-3 (engine fixes):** on Windows a virus scanner briefly holds files after a write. Three places now tolerate this:
  - `writeFileAtomic` retries the replace for about a second on EPERM, EACCES or EBUSY.
  - A secrets-scan staging folder that can't be removed no longer turns a finished scan into a failure.
  - Writing `.factory`'s checked-out copy after the commit is made is logged on failure, not reported as a failed record.
- **Symlinks:** tests that need a real symlink (RD-11, RD-12, RD-13, ST-12, unit AC-19 file case, unit paths-file link) skip with a reason when the OS refuses them. Folder-link cases (ST-16, unit AC-19 parent folder) use a junction on Windows.
- **Cleanup:** `World.cleanup` waits at most 15 s for the engine. If removal is refused on Windows, it kills this test process's children and retries. Unit `tmpdir()` folders are removed after each test file (`test/setup.ts`).

## Security Gate 2 fixes

- **H1 (tool gate):** the gate now also runs as a PreToolUse hook, so it sees calls Claude Code approves itself in `permissionMode: "default"`: in-folder reads and read-only Bash. `canUseTool` stays. A Read, Write or Edit without `file_path` is denied. A Grep over a folder is denied if any file under it (up to 100,000 entries) isn't readable. `test/claude-real.test.ts` runs the SDK's real binary on the host, in a scratch folder, against a fake Messages API with a dummy key. Read, Grep, Glob and `cat` on denied paths are refused there, allowed ones work, and no denied content reaches a request. The same run fails without the hook. **Residual:** the paths in an allowed Bash command's arguments aren't checked. F-007's roles have no commands.
- **H2 (populating the worktree):** the whole tree is checked before the worktree is touched. It is refused if it contains:
  - a symlink or submodule entry;
  - `.git` in any case;
  - empty, `.` or `..` segments;
  - names the file system would read as the same: case (when a probe shows the worktree ignores case), Unicode form, or file against folder.

  On Windows these are refused too:
  - trailing dots or spaces;
  - `:` and the other reserved characters;
  - device names (CON, AUX, COM1, LPT9 …, with or without an extension);
  - 8.3 short-name forms.

  These rules are Windows-only, so a Linux project with `aux.c` still runs. Each file is created one folder at a time. Each folder is checked with `lstat` and `realpath`, and each file is opened `O_CREAT|O_EXCL|O_NOFOLLOW`.
- **M2 (SDDL):** the parser matches the whole descriptor with an anchored grammar. It refuses:
  - a NULL DACL, and unknown DACL flags;
  - ACE types other than allow and deny;
  - object and conditional ACEs;
  - unknown ACE flags, and unreadable trustees;
  - a SACL or trailing text.
- **L2:** the agent report's commit is read with an explicit `--git-dir` from the run record. Without one, it is the branch tip in the project repo, never the worktree's own `.git`.
- **L6:** SR-8 also refuses these ranges:
  - IPv4: `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`;
  - IPv6: `100::/64`, Teredo `2001::/32`, `2001:10::/28`, `2001:20::/28`, `2001:db8::/32`, 6to4 `2002::/16`, `3fff::/20`.
- **L7 (repo config on push/fetch):** system and global config were already off, and the URL was already rebuilt from owner and repo only. Before a fetch or push, the engine now lists every config key git would see, without following includes. It refuses the network step if the clone's own config sets any of these:
  - `include*`, `url.*`, `http.*`, `credential.*` or `protocol.*`;
  - `core.gitProxy` or `core.sshCommand`;
  - `remote.*.proxy*`.

  A `-c` override can't remove an `insteadOf` rule or a URL-scoped `http.<url>.*` key, so refusing them is the fail-closed choice. The error names the key without its subsection, which can hold a URL. Pushes also set `push.gpgSign=false`, and fetches pass `--no-recurse-submodules`.
- **M1 (owner decision, 2026-11-11):** the gateway reads the whole `/v1/messages` (and `count_tokens`) body before sending it on. It returns 403 if:
  - any tool has a `type` other than `custom`;
  - the body has `mcp_servers`;
  - the body isn't a JSON object.

  A compressed body gets 415. Each refusal is logged with a reason and never the body. `anthropic-beta` values outside the allow-list in `src/proxy/server.ts` are dropped, and the request still goes. The dropped values are logged after being cleaned to plain tokens. The allow-list is what Claude Code 2.1.311 sent for both the analyst and web-reader models, captured from the real binary, plus `oauth-2025-04-20`. The real-binary test fails if the CLI starts sending a beta that isn't listed.
