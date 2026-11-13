# F-008 test plan: Security Gate 1 on the engine

- **Feature:** F-008 Run Security Gate 1 on the real engine, spec v12
- **Author:** test-engineer, 2026-11-12
- **Written from:** the spec (§2, FR-1 to FR-13, AC-1 to AC-18, §6 edge
  cases, SR-1 to SR-12, H-0095, H-0096), `interface-contracts.md` (Agent
  report v1.3 security-reviewer body, Inbox item v1.1, Interview tools v1.0,
  Role policy v2.5, Engine control channel v1.3 `engine.status`),
  `docs/security-standards.md` (Gate 1 checklist, severity table) and the
  template's `security-reviewer` role policy. How to drive the engine came
  from the existing harness and the engine's seams (`src/engine.ts`,
  `src/agent/reviewer.ts`, `src/gate1/*`, read for how to start and observe
  a run, not for what to expect). The developer's report and tests
  (`F-008-dev-report.md`, `test/gate1.test.ts`, `test/gate1-run.test.ts`)
  were not read.
- **Where:** `engine/test/acceptance/gate1.test.ts` (tests G1-1 to G1-40),
  with `support/gate1.ts`. `support/agents.ts` gained one change: the fake
  SDK tells a reviewer session (no factory tools) from an analyst's
  (interview tools) and a reader's (`fetch_page`).
- **Run:** from `engine/`, `npx vitest run --config
  test/acceptance/vitest.config.mts gate1`.

## Approach

Each test starts the whole engine as F-007 milestone 2 does: the fake
`docker` program at the command-line boundary and the fake Agent SDK at the
SDK seam (`F-007-test-plan.md`, "Milestone 2"). On top of that:

| Piece | What it does |
|---|---|
| Pinned factory version | The master fixture's `v0.1.0` holds the real `agents/security-reviewer/AGENT.md`, `skills/security-review/`, `docs/security-standards.md` and `engine/config/{models,limits}.yaml`. Tests that need a gap (AC-10, FR-3) edit these files at the tag |
| Project manifest | The onboarding template, whose `security-reviewer` role has tools `Read, Grep, Glob, Write` and writes `.factory/runs/**/security-reviewer-*.json`. AC-3 tests widen it; AC-16 tests add `standards.security`; FR-11 and SR-11 tests add `limits:` |
| Analyst (`playAnalyst`) | One step per session: writes the spec in its container, may ask one question and wait for the owner's reply turn, then calls `interview_spec_ready`. On a return session it asks the finding's question with the requirement as `suggested` and writes the SR the test asks for |
| Owner | Opens an interview session over the channel, approves it on the fake GitHub and replies (`answer` or `defer`) |
| Reviewer (`playReviewer`) | Reads its turn, takes the report path the engine names in it, and writes from inside its container (`docker exec`): a valid report, a broken one, a link, an oversize or deeply nested one, extra files. AC-4 tests also change the reviewer's worktree on the host mid-session, standing for "by any means" |
| Report content | Built from the spec and contract: the v1.3 envelope and body, the Gate 1 checklist questions read from the pinned standards file by the test itself, answers citing spec sections |

Stage is read from `engine.status`; runs from the engine record; reports,
renderings and inbox items from git (`factory/state` and the feature
branch, local and remote); the transcript from `factory/state`; the log from
the engine's log folder; what reached each agent from the fake SDK.

## Criteria to tests

| Criterion | Tests |
|---|---|
| AC-1 | G1-1, G1-2 (control: checks fail, no session) |
| AC-2 | G1-4 (no report: a run starts at engine start), G1-5 (report present: no run) |
| AC-3 | G1-6 (tools, no factory tools, internal network only, proxy grant with no host, read-only worktree, only the report folder writable, no credential in the container), G1-7 ×4 (a policy with Bash, WebFetch, a host or a command starts no session) |
| AC-4 | G1-8 (in-container write refused by the read-only mount), G1-9 ×4 (new file, changed spec, deleted file, symlink in the worktree: rejected, nothing committed, Security item names the path) |
| AC-5 | G1-10 ×10 (unknown criterion, unknown severity, text over cap, missing checklist answer, wrong feature, role, stage, commit, invalid JSON, missing: one resume of the same session, reasons in the turn, corrected report accepted), G1-11 ×4 (still invalid: run fails, nothing committed, transcript, log and agent report say why) |
| AC-6 | G1-3 |
| AC-7 | G1-12, G1-13 (spec fails checks), G1-14 (SR Draft), G1-15 (owner's own wording) |
| AC-8 | G1-16, G1-17 (with a requirement finding too) |
| AC-9 | G1-18 (killed mid-session), G1-19 (graceful stop mid-session) |
| AC-10 | G1-20 ×3 (models.yaml, limits.yaml `security_reviewer`, limits.yaml `security_gate_1`) |
| AC-11 | Out of scope: the real trial on the owner's F-002 project. Not run here |
| AC-12 | G1-23, G1-24 (SR-7: answers must cite the spec) |
| AC-13 | G1-25 (symlink), G1-26 (over 256 KiB; exactly 256 KiB as control), G1-27 (nested 50,000 deep), G1-28 ×3 (another file in the report folder) |
| AC-14 | G1-29 |
| AC-15 | G1-30 ×3 (secret in a requirement finding, a choice option label, the summary) |
| AC-16 | G1-31, G1-32 (control), G1-33 ×3 (S id as heading, table row, bold) |
| AC-17 | G1-12 (returning feature: no new session), G1-37, G1-38 (no session after restart), G1-36 (fourth run), G1-40 (limit lowered by the project) |
| AC-18 | G1-37 (owner rejects), G1-38 (SR text differs), G1-39 (deferred) |
| FR-3 | G1-21 (no AGENT.md) |
| FR-10 | G1-11, G1-18, G1-19 |
| FR-11 | G1-3 (model in report), G1-6 (model, turn cap), G1-22 (project lowers the cap), G1-40 |
| FR-12 | G1-1, G1-3 |
| SR-1 | G1-6, G1-7 |
| SR-4 | G1-29 |
| SR-5 | G1-10 (stage `readiness_gate` in the report is refused) |
| SR-7 | G1-23, G1-24 |
| SR-8 | G1-25, G1-26, G1-27 |
| SR-9 | G1-30 |
| SR-10 | G1-31 to G1-35 |
| SR-11 | G1-36, G1-40 |
| SR-12 | G1-28 |

| Contract rule | Tests |
|---|---|
| Agent report v1.3: envelope (`schema`, `role`, `feature`, `stage`, `commit`, `outcome`), body `gate`, `findings`, `checklist`, `items_filed`, engine-filled `model` | G1-3, G1-16, G1-10 |
| Agent report: `outcome` `blocked` with `items_filed` for a choice, `failed` for a failed run | G1-16, G1-11 |
| Inbox item v1.1: `category: Security`, `status: open`, `feature`, `options` (id, label), `recommendation`; front matter engine-written only; fixed body headings | G1-16, G1-29 |
| Interview tools v1.0: Gate 1 requirement as an ordinary question with `suggested` | G1-12 |
| Role policy v2.5: the reviewer's tools, write rule, no commands or hosts | G1-6, G1-7, G1-28 |
| Engine control channel: `engine.status` stage | G1-1, G1-3 and every stage wait |

## Edge cases from spec §6

| Edge case | Tests |
|---|---|
| Spec or transcript telling the reviewer to report no findings | G1-23 |
| Markdown or YAML meant to break the rendering or an item's front matter | G1-29 |
| The spec changes on the branch while Gate 1 runs | Not tested: the spec states no expected outcome |
| A finding cites an SR the analyst later removes or downgrades | G1-14 (Draft), G1-37 (removed) |
| Reviewer finishes without writing the report, or writes it twice | G1-10, G1-11 ("no report"); G1-28 (a second report file) |
| Additions file missing, a link, too large | G1-35 (link), G1-34 (too large); missing not tested (no outcome stated) |
| Spec changed outside the engine | Not tested: no outcome stated beyond F-007's chain checks |
| A reviewer that keeps finding new issues | G1-36, G1-40 |
| Owner rejects or defers a Gate 1 requirement | G1-37, G1-39 |
| A quoted secret in a finding | G1-30 |
| Additions trying to relax or redefine factory rules | G1-31, G1-33 |

## Tool choice

Rapid prototype: unit tests on core logic, reported coverage, a regression
test per fixed bug; no stochastic tests.

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Acceptance | Vitest driving the whole engine in-process, as for F-007 | `vitest` 5.1.0 | OQ-9 |
| Fakes (Docker, SDK, GitHub, gitleaks) | The milestone 2 fakes at the process and SDK boundaries | `support/fake-docker.ts`, `support/agents.ts` | No new component |
| Front matter parsing (AC-14) | The `yaml` package the engine already ships | `yaml` 2.9.1 | Approved engine dependency |
| Acceptance on real Docker | Needed for AC-3's "no network route" on a real daemon | Not written for F-008 (see below) | — |
| Coverage (reported) | `@vitest/coverage-v8` 5.1.0 | same | OQ-9 follow-up |
| Stochastic | Not required at Rapid prototype | None | — |

## What isn't tested here, and why

| Item | Why |
|---|---|
| AC-11 | The real trial on the owner's F-002, on the owner's PC |
| AC-3 network route on a real daemon | The fake Docker shows the reviewer is on the `--internal` network only and its proxy grant has no host; only real Docker shows there is no other route. F-007's DR-3 covers the same container and proxy setup for the analyst; a reviewer DR test would need the owner's PC |
| SR-9 scan of the analyst's input as such | The findings are scanned when the report is recorded, so a secret can't reach the analyst's input without first failing that scan; G1-30 checks the analyst got nothing |
| The spec changing during a run; a spec changed outside the engine; a missing additions file | The spec lists them as edge cases with no expected outcome |
| `blocked` in `engine.status` | The channel contract has no such field; tests read it from the transcript and the agent report |

## Spec and contract gaps (for the orchestrator)

1. **Where the agent report is committed.** FR-2 (v12) says `factory/state`;
   FR-6 and AC-6 still say the feature branch. Tests accept either and note
   it. Interfaces.
2. **`blocked` has no channel surface.** `engine.status` gives only the
   stage. Product or Interfaces.
3. **How a requirement cites a finding** ("Gate 1 #n") isn't in the spec;
   tests follow the wording the engine gives the analyst.
4. **Text caps and the nesting limit** have no numbers in the spec; tests
   use 100,000 characters and 50,000 levels.
5. **SR-11 "the correction resume included"** can be read either way;
   tests count distinct runs.
6. **Whether a failed run's report counts as "a Gate 1 report" (FR-1).**
   Tests expect a failed run to be followed by a new one at the next start,
   up to SR-11's limit.
7. **Owner's own wording (coordinator note on `8f3a566`, point 2).** The
   spec (§2 step 6, FR-9) accepts an SR matching the owner's answer; the
   code now also needs a Gate 1 assumption. G1-15 tests the spec as written.
