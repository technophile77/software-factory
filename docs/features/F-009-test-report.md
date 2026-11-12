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

## Addendum 1: spec v11 on `acd6e9e` (validation round 1, M2)

The run above tested `9ae4c85` against spec v7 and ended **fail** (E-1, C-1,
E-2). Since then the owner decided v8 to v11 and the developer fixed Gate 2
and validation round 1 (B1, M1). This addendum re-runs everything on the
final commit, confirms or corrects the developer's edits to these tests, and
adds tests for v9, v10 and v11 from the spec and the contracts (Engine
control channel v1.4, Interview tools v1.1). The plan's new rows are in
`F-009-test-plan.md`.

### Run

| | |
|---|---|
| Code tested | `acd6e9e` (`claude/project-thread-qzenwf`), plus the new tests in this commit. No product code changed |
| Commands | `cd engine && npm run typecheck && npx vitest run`; `npx vitest run --coverage --coverage.reportOnFailure=true`; `python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests` |
| Environment | Linux container, Node 22.23.4, Python 3.13.18, system git, running as root. No Docker |
| Typecheck | Clean (engine and `test/acceptance`): B1 is fixed |

| Suite | Run | Passed | Failed | Skipped |
|---|---|---|---|---|
| Engine, whole (35 files) | 661 | 646 | **1** | 14 |
| of which F-009 acceptance (`f009-document.test.ts`) | 134 | 133 | **1** | 0 |
| Client, whole (`spec-interview/tests`) | 428 | 426 | **2** | 0 |
| of which F-009 acceptance (`test_acceptance_f009.py`) | 43 | 43 | 0 | 0 |

The 14 engine skips are the same gated real-Docker files and platform gates
as before; no F-009 test is skipped.

Coverage (`@vitest/coverage-v8` 5.1.0, whole engine suite, `src/**`):
statements 83.98%, branches 80.01%, functions 84.19%, lines 87.89%. F-009
files (statements / branches / functions / lines): `document.ts` 96.9 / 95.4
/ 97.6 / 98.4; `tools.ts` 95.6 / 92.8 / 97.1 / 98.6; `readiness.ts` 96.4 /
92.1 / 100 / 97.2.

**Result: fail.** One F-009 test fails on product code (D-1). Two F-006
client tests fail because a pin in them is out of date after the skill's
v1.4 wording (T-1); that is a test to update, not a product failure. E-1,
C-1 and E-2 from the first run now pass.

### Earlier failures

| Failure | Now |
|---|---|
| E-1 (DOC-7) | Pass. The owner replaced the version rule with the capability list (v9); DOC-7 checks it (see below) |
| C-1 (client `ChannelVersion`) | Pass. The client refuses a document when `"document"` isn't listed |
| E-2 (DOC-13, HTML in `text/plain`) | Pass. The engine refuses it in plain text too |

### The developer's edits to these tests

| Test | Edit | Verdict |
|---|---|---|
| DOC-7 | Checks `"document"` in `capabilities` of engine.json and `engine.status`, not the version | **Confirmed.** It is what v9 and channel v1.4 now say. CAP-1 adds the rest of the contract's shape (same list in both, plain names, at most 32) |
| SRC-1 | Expects `spec_line: expect.stringContaining(ref)` | **Corrected.** The contract says `spec_line` is "the spec's own line for `spec_ref`, copied by the engine"; containing the ref doesn't show that. SRC-1 now expects the exact lines (`\| FR-1 \| Export all rows as CSV. \|` and the whole SR-1 row). Passes |
| SRC-6 | The added row cites FR-1, not FR-2 | **Confirmed.** Under v11 a `Spec ref` needs a line in the spec, and the fixture spec has no FR-2. The test still adds a row after confirmation, which is what it checks |
| Client `ChannelVersion.test_v13_engine_gets_no_document` | engine.json written with `capabilities: []`; docstring states the capability rule | **Confirmed.** Two tests added beside it (below), because the version no longer decides |
| Client fixtures (`source_confirmation`, `test_fr8_source_confirmation_shows_every_quote_fenced`) | Each source carries `spec_line` | **Confirmed.** Required by channel v1.4 as amended in v11 |
| `write_engine_json` (shared helper) defaults to `["document"]`; `World.engineJson()` type gains `capabilities` | Harness only | **Confirmed.** A default v1.4 engine lists it; the type fix is B1 |

### New tests

| Rule | Tests | Result |
|---|---|---|
| v9 capability list | Engine DOC-7, CAP-1. Client `test_v9_without_the_document_capability_the_client_refuses_before_reading` (no list, `[]`, only other names; on v1.4 and v1.9: refused, the file never opened, no `feature.start`), `test_v9_the_capability_not_the_version_decides` (listed on v1.2, v1.3 and v1.4, with unknown names around it: the document is sent unchanged) | Pass |
| v10 link rules (SR-8, AC-10) | LNK-1 ×26: titled definitions in three title styles and with the title on the next line, an unused definition, the `[//]: # (…)` idiom; in a block quote, a nested block quote, bullet and ordered list items, a list item's second paragraph (also indented 4 spaces), a block quote in a list item; empty links and images; link text of only spaces, `&nbsp;`, `&#160;`, `&#xA0;`, a literal U+00A0, an em space; an image alt of only `&nbsp;`; an empty full reference link; empty links in a block quote and a list item. Each refused as `hidden_content` naming its line, nothing kept. LNK-2: every kind in one document named line by line. LNK-3 ×7 controls accepted | Pass (all 34) |
| v11 spec-line lock (FR-8) | SRC-1 (exact line), SPL-5 (the three spec-line forms), SPL-6 ×2 (a confirmed line reworded, or its status cell changed: `sources_confirmed` fails until a new item shows the new line and is confirmed), SPL-7 (control: an uncited line changes, the confirmation holds). Client `test_fr8_v11_each_spec_ref_shows_its_own_spec_line_as_data` (shown, fenced, a planted fence can't close it) | Pass |
| v11 quote and Section rules (SR-7) | SPL-1 ×7 accepted; SPL-2 ×8 refused naming the row with no item filed; SPL-3 (`-` without headings); SPL-4 ×2 (a ref with no spec line, or only mid-sentence) | **SPL-2 "across two table rows" fails (D-1)**; the rest pass |
| Interview tools v1.1 `source_unchanged` | SRC-14 | Pass |

The engine names a failing row by its line number in the spec ("line 50:
…"), not its ref. The contract asks only that it name the failing rows, so
the new tests accept either, as SRC-7 already did.

### Failures

#### D-1 (SPL-2, "text that runs across two table rows"): a quote spanning two rows of a table without outer pipes is accepted

- **Expected** (Interview tools v1.1, as amended in v11; spec v11 change
  log): the quote "sits in one paragraph, list item or table row under that
  heading"; otherwise `invalid`, naming the row.
- **Document** (under `## Storage`), a GFM table whose rows have no pipe at
  either end, which GFM allows ("The pipes on either end of the table are
  optional"):
  ```
  Rule | Value
  --- | ---
  Limit | Rows stop at ten thousand per export
  Retention | Files are kept for seven whole days
  ```
- **Row:** `| FR-1 | Storage | ten thousand per export Retention |`, which
  joins the end of one row to the start of the next.
- **Actual:** `{"ok":true,"value":{"item":{"id":"S-001","kind":"source_confirmation",…,"sources":[…,{"spec_ref":"FR-1","section":"Storage","quote":"ten thousand per export Retention","spec_line":"| FR-1 | Export all rows as CSV. |"}]}}}`.
- **Likely cause:** the block splitter treats only lines starting with `|`
  as table rows, so these lines read as one paragraph. With outer pipes a
  quote can't span rows without containing `|`, so only this table form is
  open.
- **Class:** product code; developer fix. Impact is low: the words are in
  the document in that order and the owner sees the quote, but the engine
  doesn't hold the v11 rule for this table form.

#### T-1 (client `test_acceptance_f006`, `SkillTextF006` and `SkillTextRound2`, `test_regression_v12_named_and_tools_unchanged`): out-of-date pin

- **Expected by the test:** `SKILL.md` names "Engine control channel (v1.3".
- **Actual:** since `acd6e9e` (validation m8) it says "(v1.4)", which is
  right for F-009.
- **Class:** test needs updating, not a product failure. The F-006 intent
  is that the skill names a channel version that has the advisor (v1.3 or
  later). Per my role I don't change it unasked: for the orchestrator, the
  fix is to match `v1\.[3-9]` in that test.

### Not tested, and why

- **Link rules in `text/plain`.** SR-8 says "a Markdown link reference
  definition", so whether it applies to plain text is open; not asserted
  either way.
- **Link-definition text inside fenced code.** CommonMark doesn't treat it
  as a definition; the spec doesn't say whether the engine should refuse it
  as it refuses HTML in code. Not asserted.
- **Model behaviour** (AC-4 to AC-8's analyst half, FR-6, FR-9, SR-1's
  "never followed", SR-12): unchanged from above; validation M3 is with the
  owner.
- **SR-13:** deferred to Alpha.

## Addendum 2: validation round 2 fixes on `e88678a`

Validation round 2 found link labels and link text that run over two lines
accepted against SR-8 and AC-10 (M1), and link text that is only a blank code
span accepted (m13). The developer fixed them in `e88678a`, and fixed D-1 and
T-1 from Addendum 1 in `fe24185`. This addendum adds tests for those cases
from the spec (SR-8, AC-10, as extended in v10) and Interview tools v1.1 (as
amended in v11), and re-runs everything on the final commit. The plan's new
rows are marked "round 2" in `F-009-test-plan.md`.

### Run

| | |
|---|---|
| Code tested | `e88678a` (`claude/project-thread-qzenwf`), plus the new tests in this commit. No product code changed |
| Commands | `cd engine && npm run typecheck && npx vitest run`; `python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests` |
| Environment | Linux container, Node 22.23.4, Python 3.13.18, system git, running as root. No Docker |
| Typecheck | Clean (engine and `test/acceptance`) |
| Renderings | Each new case's rendering was checked against the CommonMark reference renderer (commonmark.js 0.31.2, installed in the scratch area only, not in the repo) |

| Suite | Run | Passed | Failed | Skipped |
|---|---|---|---|---|
| Engine, whole (35 files) | 694 | 677 | **3** | 14 |
| of which F-009 acceptance (`f009-document.test.ts`) | 167 | 164 | **3** | 0 |
| Client, whole (`spec-interview/tests`) | 428 | 428 | 0 | 0 |
| of which F-009 acceptance (`test_acceptance_f009.py`) | 43 | 43 | 0 | 0 |

The 14 engine skips are the same gated real-Docker files and platform gates
as before; no F-009 test is skipped. Coverage was not re-measured.

**Result: fail.** Three new F-009 tests fail on product code (D-2). Every
other test passes, including all of Addendum 1's tests.

### Earlier failures

| Failure | Now |
|---|---|
| D-1 (SPL-2, a quote across two rows of a table without outer pipes) | Pass. SPL-8 adds a regression (below) |
| T-1 (F-006 pin on channel v1.3) | Pass. The test now accepts `v1\.[3-9]`, the fix Addendum 1 gave; the F-006 intent (a channel version with the advisor) is kept. Both F-006 tests pass |

### New tests

| Rule | Tests | Result |
|---|---|---|
| SR-8 / AC-10, link label or link text over two lines (round 2 M1) | LNK-4 ×16: the `[//]: # (…)` idiom with its label split; link text of only a line break (LF and CRLF), of spaces around one, of `&nbsp;` and one; an image alt and a full reference link of only a line break; an unused untitled definition and a used titled one with split labels; the split idiom in a block quote (second line marked, or lazy), a nested block quote and a list item; line-break link text in a block quote (marked, or lazy) and a list item. Each refused as `hidden_content` naming a line the construct covers, nothing kept | Pass (16) |
| SR-8 / AC-10, blank code span (round 2 m13) | LNK-5 ×7: one space; a double-backtick span of spaces; a span holding only a line break; a span holding only a no-break space; an image alt, a full reference link, and a link in a block quote, each of a blank span | Pass (7) |
| SR-8 / AC-10, shortcut reference links | LNK-6 ×3: a shortcut reference link (`[text]` with a matching definition) whose text is `&nbsp;` or a blank code span, and a shortcut image whose alt is `&nbsp;` | **Fail (D-2)** |
| AC-10 controls | LNK-7 ×5: link text with words over two lines; a used untitled definition with its label over two lines, also in a block quote; a code span with words as link text; a `[` left open across a blank line (not a link in CommonMark) | Pass (5) |
| Interview tools v1.1 (v11), D-1 regression | SPL-8 ×2: in a table without outer pipes, one row is accepted; a quote across a row and the pipe-less line after it (a further table row in GFM) is refused as `invalid`, naming the row | Pass (2) |

### Failures

#### D-2 (LNK-6 ×3): a shortcut reference link with blank text is accepted

- **Expected** (SR-8, AC-10 as extended in v10): a document with "a link or
  image with empty text" is refused as `hidden_content`, naming the line.
- **Documents** (`M` stands for the test's marker):
  ```
  See [&nbsp;].

  [&nbsp;]: https://example.org/M
  ```
  ```
  See [` `].

  [` `]: https://example.org/M
  ```
  ```
  See ![&nbsp;].

  [&nbsp;]: https://example.org/M.png
  ```
- **CommonMark renders** them as `<p>See <a href="https://example.org/M"> </a>.</p>`,
  `<p>See <a href="https://example.org/M"><code> </code></a>.</p>` and
  `<p>See <img src="https://example.org/M.png" alt=" " />.</p>`: a link or
  image with no visible text, its target hidden. A label of `&nbsp;` or
  `` ` ` `` is a valid label (it holds a non-whitespace character), and the
  definition is used and untitled, so the definition rules don't catch it.
- **Actual:** `feature.start` succeeds (`{"feature":"F-001"}`); the document
  is stored.
- **Likely cause:** the link-text check at `engine/src/interview/document.ts:171`
  only looks at brackets followed by `(` or `[` (inline, full and collapsed
  references). A shortcut reference is `[text]` alone, so its text is never
  checked. The collapsed form `[&nbsp;][]` is refused, which shows the gap is
  only the shortcut form.
- **Class:** product code; developer fix. Same class as round 2 M1, smaller:
  no title can be hidden this way (a titled definition is refused already),
  only the link's target.
- **Logs:** the run log, failing assertion `expected error -32009, got result
  {"feature":"F-001"}` at `f009-document.test.ts` (LNK-6).

### Not tested, and why

Unchanged from Addendum 1 (link rules in `text/plain`; link-definition text
in code; model behaviour, validation M3; SR-13). Also: a `[` and `]` with a
blank line between them is not a link in CommonMark; LNK-7 asserts it is
accepted, and the engine's "a blank line ends the paragraph" check holds it.

## Addendum 3: validation round 3 M4 on `20d2bff`

Validation round 3 found that an empty link or image after a stray `[`, and
link text of only emphasis around a no-break space, were accepted against
SR-8 and AC-10 (M4). The developer fixed them in `20d2bff`; D-2 was fixed in
`490c562`, after Addendum 2's run. This addendum adds tests for those forms
from the spec (SR-8, AC-10 as extended in v10), with controls, and re-runs
everything on the final commit. The plan's new rows are marked "round 3".

### Run

| | |
|---|---|
| Code tested | `20d2bff` (`claude/project-thread-qzenwf`), plus the new tests in this commit. No product code changed |
| Commands | `cd engine && npm run typecheck && npx vitest run`; `python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests` |
| Environment | Linux container, Node 22.23.4, Python 3.13.18, system git, running as root. No Docker |
| Typecheck | Clean (engine and `test/acceptance`) |
| Renderings | Each new case was rendered with the CommonMark reference renderer (commonmark.js 0.31.2, scratch area only): every refused case is a link or image with no visible text and its title or target hidden; every control shows its text |
| Fails before the fix | With `engine/src/interview/document.ts` from `0e826cd` swapped in locally (then restored), all 19 LNK-8 tests fail and all 8 LNK-9 controls pass, so the new tests detect M4 |

| Suite | Run | Passed | Failed | Skipped |
|---|---|---|---|---|
| Engine, whole (35 files) | 721 | 707 | 0 | 14 |
| of which F-009 acceptance (`f009-document.test.ts`) | 194 | 194 | 0 | 0 |
| Client, whole (`spec-interview/tests`) | 428 | 428 | 0 | 0 |
| of which F-009 acceptance (`test_acceptance_f009.py`) | 43 | 43 | 0 | 0 |

The 14 engine skips are the same gated real-Docker files and platform gates
as before; no F-009 test is skipped. Coverage was not re-measured.

**Result: pass.** No failures.

### Earlier failures

| Failure | Now |
|---|---|
| D-2 (LNK-6 ×3, a shortcut reference link with blank text) | Pass on `20d2bff` (fixed in `490c562`) |

### New tests

| Rule | Tests | Result |
|---|---|---|
| SR-8 / AC-10, stray `[` before an empty link (round 3 M4) | LNK-8 ×9: one `[`, two, and a word and `[` before an empty link; a stray `[` before a `&nbsp;` link, an empty link that hides its target (no title), an empty image, line-break link text, an empty full reference link, and an empty link in a list item | Pass (9) |
| SR-8 / AC-10, emphasis around a blank (round 3 M4) | LNK-8 ×10: link text of `*&nbsp;*`, `_&nbsp;_`, `**&nbsp;**`, `__&nbsp;__`, `***&nbsp;***`; `*&nbsp;*` as an image alt, a full reference link's text, a shortcut reference link's text, link text in a block quote, and after a stray `[` | Pass (10) |
| AC-10 controls | LNK-9 ×8: link text and an image alt in emphasis; strong, emphasis and words mixed; a full reference link in emphasis; underscores inside link text; a stray `[` before a link with text; link text holding balanced brackets; emphasis, a link and a lone `[` on one line | Pass (8) |

### Not tested, and why

Unchanged from Addendum 2. Also: link text that is only a lone `*` (which
CommonMark shows as a visible `*`) may be refused by the engine; that is
fail-closed and not asserted either way.
