# F-009 test report: start an interview from an existing document

Report per `docs/testing-strategy.md` § Run report. The plan, with the full
criteria-to-test map, the abuse cases and what can't be unit-tested, is
`F-009-test-plan.md`.

## Run

| | |
|---|---|
| Code tested | `9ae4c85` plus the developer's uncommitted Gate 2 fixes that were in the working tree during the run (`engine/src/interview/document.ts`, `readiness.ts`, `tools.ts`, `interview_client.py`). The F-009 acceptance files were run a second time on the same tree with the same result |
| Commands | `cd engine && npm run typecheck && npx vitest run`; `python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests` |
| Environment | Linux container, Node 22.23.4, Python 3.13.18, system git, running as root (so the device-node test ran). No Docker |
| Typecheck | Clean (engine and `test/acceptance`) |

| Suite | Run | Passed | Failed | Skipped |
|---|---|---|---|---|
| Engine, whole (unit and acceptance, 35 files) | 600 | 584 | 2 | 14 |
| of which F-009 acceptance (`f009-document.test.ts`) | 76 | 74 | **2** | 0 |
| Client, whole (`spec-interview/tests`) | 421 | 420 | 1 | 0 |
| of which F-009 acceptance (`test_acceptance_f009.py`) | 40 | 39 | **1** | 0 |

The 14 engine skips are all outside F-009: the two real-Docker files and the
platform gates already explained in `F-007-test-report.md`. Every F-009 test
ran.

**Result: fail.** Three tests fail, all on product code (below). No test
was changed to pass.

## Criteria to tests

| Criterion | Tests | Status |
|---|---|---|
| AC-1 | DOC-1, DOC-2, DOC-4; client `test_fr2_bytes_reach_the_engine_unchanged`, `test_ac2_control_exactly_the_limit_is_sent_unchanged` | Pass |
| AC-2 | Client `AC02RefusedBeforeConnecting` (8 tests) | Pass |
| AC-3 | DOC-8, DOC-9, DOC-10 | Pass |
| AC-4 | — | Not unit-testable: analyst model behaviour |
| AC-5 | QT-1 (engine part) | Engine part pass; model behaviour not tested |
| AC-6 | QT-1 (engine part) | Engine part pass; model behaviour not tested |
| AC-7 | SRC-2, SRC-3, SRC-4, DOC-18 (engine part) | Engine part pass; model behaviour not tested |
| AC-8 | DOC-19, SRC-13 (engine part) | Engine part pass; model behaviour not tested |
| AC-9 | DOC-20 ×3, DOC-21, DOC-22 | Pass |
| **AC-10** | DOC-11 ×8, DOC-12, **DOC-13 ×2**, DOC-14; client `test_ac10_hidden_content_lines_are_named` | **Fail**: DOC-13 (HTML comment in `text/plain`), defect E-2 |
| SR-1 | DOC-18, DOC-19 | Pass (engine part) |
| SR-2 | Client `SR02ClaudeNeverSeesTheDocument` | Pass |
| SR-3 | DOC-8, DOC-10 | Pass |
| SR-4 | Client `SR04SR06WhatTheClientOpens` | Pass |
| SR-5 | DOC-20, DOC-22 | Pass |
| SR-6 | Client `SR04SR06WhatTheClientOpens` | Pass |
| SR-7 | SRC-1 to SRC-12 | Pass |
| **SR-8** | As AC-10 | **Fail** (E-2) |
| SR-9 | DOC-15 ×19, DOC-16 | Pass |
| SR-10 | DOC-3, DOC-17 ×4 | Pass |
| SR-11 | DOC-8, DOC-9; client `SR11SensitiveData` | Pass |
| SR-12 | — | Not unit-testable: analyst model behaviour |
| SR-13 | — | Not tested: deferred to Alpha (spec v7) |
| SR-14 | Client `SR14ProvenanceFromThePick` | Pass |
| **Channel v1.4 version rule** | **DOC-7**; client `ChannelVersion` (**`test_v13_engine_gets_no_document`**) | **Fail** (E-1, C-1) |

## Failures

All three are classed **product code** (no rerun; developer fixes). E-1 and
C-1 are one contract problem seen from both ends; E-2 may instead need an
owner decision on the spec's wording, so it goes to the orchestrator with
both readings.

### E-1 (DOC-7): the engine accepts `document` but says it speaks channel v1.2

- **Expected** (Engine control channel v1.4, "Starting from a document"):
  "An engine on v1.3 or earlier refuses `document` as an unknown key;
  clients check `version` first and don't send it." So an engine that takes
  `document` must say v1.4 or later in `engine.json` and `engine.status`.
- **Actual:** `engine.json` and `engine.status` say `"1.2"` while
  `feature.start` accepts and stores a document
  (`engine/src/constants.ts`: `SERVED_CHANNEL_VERSION = "1.2"`).
- **Effect:** a client that follows the contract never sends a document to
  this engine, so the feature only works with a client that skips the check
  (C-1). The two defects hide each other today.
- **Root cause:** the served version wasn't raised with H-0105. It may need
  care: raising it to 1.4 also claims v1.3 (the advisor), so the developer
  should confirm the engine serves every v1.3 method or raise the question
  with the orchestrator.

### C-1 (client `ChannelVersion.test_v13_engine_gets_no_document`): the client sends a document to a v1.3 engine

- **Expected:** same contract sentence. With `engine.json` at `"1.3"`, the
  client refuses before connecting and sends no document.
- **Actual:** exit 0; the whole document went to the engine in
  `feature.start` (`{'ok': True, 'document': {...}, 'feature': 'F-100'}`).
- **Root cause:** `run()` in `interview_client.py` checks the minor version
  for advisor replies (`minor < 3`) but has no `minor < 4` check for
  `start` with `document`. It relies on the engine refusing the unknown key
  with -32602 afterwards (which it explains well:
  `test_old_engine_refusing_the_key_is_explained` passes), but by then the
  document text has been sent.
- **Fix order:** E-1 first, or the client fix makes every document start
  fail against the current engine.

### E-2 (DOC-13 ×2 → 1 failing case): HTML in a `text/plain` document is accepted

- **Expected** (SR-8; AC-10; channel v1.4: "it refuses a document that
  contains an HTML comment, a raw HTML tag, or a zero-width or bidi
  character"): none of these name a media type.
- **Actual:** a `text/plain` document with `<!-- hidden -->` on line 2 is
  accepted and stored (`{"feature":"F-001"}`). The zero-width case in
  `text/plain` is refused correctly.
- **Root cause:** `validateDocument` in `engine/src/interview/document.ts`
  runs the HTML check only when `media_type` is `text/markdown`, on the
  reasoning that plain text isn't rendered, so nothing in it is hidden. The
  developer's own test says so ("… but not in plain text").
- **For the orchestrator:** either the code changes to match SR-8 as
  written, or the owner narrows SR-8 and the contract to Markdown (a Security
  decision, since it loosens a requirement). The test stays as written until
  one of the two happens. Note the analyst reads the raw text either way, so
  a comment in a `.txt` file still reaches the model unseen by an owner who
  views the file through a Markdown-rendering tool.

## Gaps found against the developer's tests

Read after the tests above were written. Nothing the spec asks for is
covered only by the developer's tests. Things the developer tests and this
suite doesn't, because the spec doesn't ask for them: tag-block characters
and invisible HTML entities (Gate 2 additions), HTML inside code (Gate 2
H1), relative document paths resolved from the repo, and a file swapped
between the check and the open. Things this suite adds that the developer's
don't: AC-9 through the whole engine with an analyst session that writes,
the SR-1 frame with a planted END line, quotes checked against the stored
blob when the branch copy changes (SRC-10), a forged `sources` argument
(SRC-9), the client's read capped at the limit + 1 when the size check
is fooled, and the version rule (E-1, C-1).

## Not run, and why

- **Model behaviour** (AC-4 to AC-8's analyst choices, FR-6, FR-9, SR-1's
  "never followed", SR-12): the suite replaces the model with a scripted
  fake, so it can't show what the real analyst does. It needs an evaluation
  run on the real analyst with planted documents.
- **SR-13:** deferred to Alpha by the owner.
- **Secret line numbers with the real gitleaks:** DOC-9 uses the fake
  scanner rewritten to report the marker's file and line, as gitleaks does;
  it is skipped on Windows, where the fake is a launcher plus a script.

## Tool choice

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Acceptance, engine | Vitest with the F-007 acceptance harness: TypeScript engine driven in-process as a black box | `vitest` 5.1.0 | OQ-9 |
| Acceptance, client | `unittest` (stdlib), matching the stdlib-only client | `unittest` | F-005 |
| Coverage (reported) | `@vitest/coverage-v8` 5.1.0 | Not run for this report; the whole-repo figures are in the F-007 report | OQ-9 follow-up |
| Stochastic | Not required at Rapid prototype | None | None |
