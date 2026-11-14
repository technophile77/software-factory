# Proposal 0023: Faster engine CI

- **Raised:** 2026-11-13, by the owner ("the bottleneck is quickly turning
  into the github CI tests, test optimizations locally on my PC to see what
  can be improved")
- **Category:** none needed. This is a Configuration hygiene item. It
  changes how the existing tests are scheduled, not what they check, and
  makes no Product, Architecture, Interfaces, Assumptions or Security
  decision.
- **Status:** Open. Approved by merging the PR that carries it.
- **Hygiene item:** H-0130. H-0131 to H-0134 are reserved for follow-ups.

## Problem

Measured from the `engine` workflow runs of 2026-11-12 and 2026-11-13:

| Job | Wall time | Of which `npm test` |
|---|---|---|
| windows-latest | 30 to 38 min | 34 min |
| macos-latest | 12 to 23 min | 17 min |
| ubuntu-latest | 5 to 6 min | 5.5 min |
| supply-chain | about 1 min | (none) |

Setup, `npm ci`, the audit, the typecheck and the build take under a minute
together. The rest is tests. Per test file on Windows:

| File | Tests | Time |
|---|---|---|
| acceptance/f009-document | 252 | 30 min |
| acceptance/st-review | 67 | 24 min |
| acceptance/interview-tools | 52 | 15 min |
| everything else | about 520 | 3.6 min or less per file |

Vitest runs files in parallel but the tests within a file one after another,
so the longest file sets the floor: 30 minutes on Windows. That holds
however many cores a runner has. The same suite took 35 minutes on the
owner's 16-core PC, where f009-document was again the whole tail.

A profile of 8 f009-document tests on that PC shows why each test is slow:
about 90% of its time is spent waiting on child processes, roughly 100 git
and gitleaks runs per test at 30 to 40 ms each. CPU stayed near 14% with 15
workers. The tests wait on process start-up, which Windows and hosted macOS
do slowly, not on computation.

Two smaller problems:

- Every push to a PR starts a new full run, and the older run keeps going.
  At 08:12 on 2026-11-13, three engine runs for the same PR were in flight
  at once, holding nine runners, five of them macOS or Windows.
- The tests read files outside `engine/` (the requirements-analyst,
  web-reader and security-reviewer `AGENT.md`, `skills/security-review/`,
  `docs/security-standards.md`, the project manifest template, `.gitignore`),
  and the supply-chain job runs `scripts/osv_fixable.py`. A PR that changes
  only those files doesn't run the workflow at all.

## Proposed change (H-0130)

1. **Files:** `.github/workflows/engine.yml`; new `engine/test/shard.ts`,
   `engine/test/shard-select.ts` and `engine/test/shard.test.ts`;
   `engine/vitest.config.mts` and `engine/test/acceptance/vitest.config.mts`
   (one setup file each); `engine/README.md`; this proposal.
2. **Reason:** the owner's request above.
3. **Current content:** one `build-and-test` job per OS, each running the
   audit, typecheck, build and the whole suite.
4. **Proposed content:**
   - **Test-level sharding.** With `FACTORY_TEST_SHARD=k/n`, a setup file
     skips every test that isn't shard k's. Each shard runs every file, and
     takes every n-th test of it, so the long files are split as evenly as
     the short ones. Vitest's own `--shard` splits by file, which would leave
     f009-document's 30 minutes on one runner. The shards together run each
     test exactly once (`shard.test.ts` checks this with random inputs).
     Locally, without the variable, nothing changes.
   - **Shards per OS:** Windows 6, macOS 3, Linux 2, sized so each shard
     takes about the same time. That is 11 test jobs instead of 3.
   - **Workers per runner:** Linux 6, macOS 4, Windows 3 (Vitest's default
     of cores minus one). These tests mostly wait on child processes, so
     extra workers use idle CPU on Linux and macOS. On Windows the first CI
     run with 6 workers made single tests 2 to 3 times slower, and two hit
     their time limit, so Windows stays at the default and gets one more
     shard instead.
   - **One `checks` job** on Linux runs the audit, typecheck and build.
     None of them depends on the OS.
   - **Cancel superseded PR runs.** A `concurrency` group per PR with
     `cancel-in-progress`. Pushes to `main` and the weekly scan get a group
     of their own per run, so they are never cancelled or queued behind
     one another.
   - **Path filter** gains the files the tests and the scan read (above).
   - **Time limit** per test job drops from 45 to 30 minutes, which is still
     about three times a shard's run time (H-0086 set it as a hang guard).
5. **Full diff:** the PR that adds this file.
6. **Expected benefit:** an engine run goes from about 35 minutes to about
   10, set by the slowest Windows shard. Measured figures are in the PR.
   Runs a newer push makes moot stop at once, freeing runners for other PRs.
7. **Risks and side effects:**
   - **Runner minutes.** Each shard repeats checkout, setup and `npm ci`
     (about 30 to 60 seconds), so total minutes rise a little. The repo is
     public, so GitHub-hosted runners cost nothing. A free account runs up
     to 20 jobs at once, 5 of them macOS: one engine run now uses 13 jobs
     (3 macOS), so two PRs pushing at the same moment can queue briefly.
   - **Required checks.** `main` has no required status checks today. If
     some are added later, they must name the new job names
     (`test (windows-latest, 1/5)` and so on).
   - **Security posture unchanged.** Same actions pinned by SHA, same
     `contents: read`, `persist-credentials: false`, the same audit and
     OSV-Scanner steps with the same gates. Cancelling a superseded PR run
     drops nothing: the newer run checks the newer code.
   - **A test that depends on another test in its file running first**
     would break under sharding. The suite was written so each test builds
     its own world; the one shared world (interview-tools limits) is built
     lazily by whichever of its tests runs first, so it works in any shard.
   - **Not done:** speeding up each test. The cost is the engine's own git
     calls, which is engine design, not CI configuration.
8. **Recommendation:** approve.

## Possible follow-ups (not part of this change)

- **H-0131: dropped.** It would have excluded the test temp folders from
  Microsoft Defender on the Windows runners, but GitHub's runner image
  already turns real-time monitoring off and excludes `C:\` and `D:\`
  (`images/windows/scripts/build/Configure-WindowsDefender.ps1` in
  actions/runner-images). The owner spotted this.
- **H-0132 (approved by the owner 2026-11-13, applied in its own PR):**
  build each project's fixture repo with one `git fast-import` run instead
  of about 14 git commands (`engine/test/acceptance/support/fast-import.ts`).
  Copying prebuilt repos wasn't possible, since each test's manifest holds a
  random client id. Measured: 8 f009-document tests went from 50.2 s to
  46.1 s, about 8% per test, less than the 15% first estimated, because the
  engine's own git calls dominate.

## Later changes (owner decisions of 2026-11-13)

- **H-0151:** the acceptance fixtures run the SR-5 confirm command before
  the engine's first start, so each test starts the engine once instead of
  start, stop on the new path and restart. About 8% per test locally. The
  confirm path itself is still the real command, and `pinning.test.ts`
  still covers the start-then-confirm flow.
- **H-0152:** IT-10 (200 items per feature) runs on Linux only. It is
  counting logic with no platform code, and its 200 round trips took 13 of
  the slowest Windows shard's 14 minutes.
- **H-0153:** on PRs, macOS and Windows run only `npm run test:platform`,
  the files that exercise OS-specific code; Linux still runs everything.
  Pushes to `main` and a nightly run (which replaces the weekly CVE run)
  test everything on all three OSes, so a Windows-only regression shows up
  within a day. The owner chose this over running the full suite on every
  OS for every PR.
