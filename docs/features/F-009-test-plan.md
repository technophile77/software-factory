# F-009 test plan: start an interview from an existing document

- **Feature:** F-009 Start an interview from an existing document, spec v7
- **Author:** test-engineer, 2026-11-12
- **Written from:** the spec (FR-1 to FR-9, AC-1 to AC-10, SR-1 to SR-14,
  section 6), `docs/testing-strategy.md`, and the contracts in
  `docs/interface-contracts.md`: Engine control channel v1.4 ("Starting from
  a document", error -32009), Interview tools v1.1, Role policy v2.6. The
  developer's own tests (`engine/test/document.test.ts`,
  `tests/test_document_f009.py`) were read only after these tests were
  written, to look for gaps.
- **Where:**
  - Engine: `engine/test/acceptance/f009-document.test.ts`. It drives the
    whole engine through the acceptance harness (`harness.ts`,
    `support/world.ts`): the control channel, the Interview tools as engine
    functions, the fake gitleaks, and for agent sessions the fake Docker and
    fake Agent SDK of `support/agents.ts`. Run from `engine/` with
    `npx vitest run --config test/acceptance/vitest.config.mts f009-document`.
  - Client: `plugins/software-factory/skills/spec-interview/tests/test_acceptance_f009.py`,
    against the shared `fake_engine.py`, using `test_interview_client.Base`
    with `engine.json` at channel v1.4. Run with
    `python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests -p 'test_acceptance_f009.py'`.
- **Size:** engine 38 test ids, 76 cases (parameterised ids count once per
  case); client 40 tests.
- **Out of scope:** SR-13 (deferred by the owner to Alpha, spec v7).

## Tool choice

Rapid prototype asks for unit tests on core logic, reported coverage and a
regression test per fixed bug; no stochastic tests.

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Acceptance, engine | Vitest: the engine is TypeScript on Node; the suite starts it in-process and drives it as a black box | `vitest` 5.1.0 with the F-007 acceptance harness | OQ-9 (Vitest), approved pins |
| Acceptance, client | `unittest` from the standard library: the client is stdlib-only Python (F-005 FR-1) | `unittest`, `fake_engine.py` | F-005 |
| Contract (channel v1.4, Interview tools v1.1) | Same runners, from the contract text | As above | As above |
| Stochastic | Not required at Rapid prototype | None | None |

## What can't be unit-tested

AC-4, AC-5, AC-6 and AC-8 and parts of AC-7, FR-6, FR-7, FR-9, SR-1 and
SR-12 describe what the analyst model chooses to do: which items it files,
whether a statement is a gap or an assumption, whether it acts on text in the
document. That is model behaviour and is **stochastic / not unit-testable**
here: the suite replaces the model with a scripted fake. What the engine
enforces around those choices is tested (marked "engine part" below). The
model behaviour needs an evaluation run on the real analyst with planted
documents; that is a gap to close before Alpha, not something this suite
can show.

## Criteria to tests

| Criterion | What is tested | Tests | Kind |
|---|---|---|---|
| AC-1 | Markdown within limits lands at `docs/features/F-nnn-source.md` on the feature branch byte for byte (CRLF, tabs, trailing spaces, non-ASCII, no final newline); the transcript holds its SHA-256; only that file is added on top of main; exactly 262,144 bytes accepted; the client sends the bytes unchanged | DOC-1, DOC-2, DOC-4; client `test_fr2_bytes_reach_the_engine_unchanged`, `test_ac2_control_exactly_the_limit_is_sent_unchanged` | Acceptance |
| AC-2 | `.docx`, `.pdf`, `.html`, `.rtf`, `.json`, no extension, `.md.exe`, 262,145 bytes and 1 MiB are refused before connecting: exit 2, no connection, no call | client `AC02RefusedBeforeConnecting` (`test_ac2_*`) | Acceptance |
| AC-3 | A test secret: -32009 `secret` with the rule; no feature, branch, ref change, transcript entry, run, analyst session, or the text in any git object, `.factory` file or engine state file; gitleaks ran; with agents, no SDK session (a clean start does start one: control) | DOC-8, DOC-9, DOC-10 | Acceptance |
| AC-4 | The only items are the source confirmation and assumptions | — | Stochastic / not unit-testable (analyst model) |
| AC-5 | Engine part: a `conflict` question quoting both sides, with worktree-path sources, reaches the owner unchanged with its type. That the analyst files exactly one and the spec holds neither value: model behaviour | QT-1; client `test_fr7_conflict_findings_from_worktree_paths_are_fenced` | Engine part; rest stochastic |
| AC-6 | Engine part: a conflict finding may cite `docs/security-standards.md`. Filing it and keeping the review: model behaviour | QT-1 | Engine part; rest stochastic |
| AC-7 | Engine part: with a document that tells the analyst to mark the spec ready, `sources_confirmed` still fails without the owner's confirmation; the document reaches the analyst framed as data, a planted END line can't close the frame | SRC-2, SRC-3, SRC-4, DOC-18 | Engine part; "doesn't act on it" stochastic |
| AC-8 | Engine part: with `reference`, the first turn says the text is only a suggested answer, and `sources_confirmed` doesn't block readiness. Asking every answer as a question: model behaviour | DOC-19, SRC-13 | Engine part; rest stochastic |
| AC-9 | An analyst session that overwrites or deletes the source (alone or with its spec) has nothing committed, the run fails, a Security item names the path; a session writing only its spec is committed and leaves the source unchanged (control); the onboarding template denies both source globs in every role that writes outside `.factory/` | DOC-20 ×3, DOC-21, DOC-22 | Acceptance |
| AC-10 | An HTML comment (one line and multi-line), a raw tag, a `<script>` tag, ZWSP, ZWJ, RLO and a bidi isolate are each refused as `hidden_content` naming the line, nothing stored; all four kinds in one document name each line; the same in `text/plain`; ordinary `<`, `>`, links and image references are accepted (control); the client shows the lines | DOC-11 ×8, DOC-12, DOC-13 ×2, DOC-14; client `test_ac10_hidden_content_lines_are_named` | Acceptance |

## Security requirements to tests

| SR | Tests | Kind |
|---|---|---|
| SR-1 | DOC-18 (fresh random boundary not in the text and not the request's, labelled data and "not instructions", appears once unchanged), DOC-19. The analyst, skill and advisor not following the text: model behaviour | Engine part; rest stochastic |
| SR-2 | Client `SR02ClaudeNeverSeesTheDocument`: output carries name, bytes and provenance, never the text; -32009 data outside the contract's keys never reaches stdout; the path can't go on the command line; SKILL.md forbids reading, showing or summarizing it | Acceptance (client) and static (SKILL.md) |
| SR-3 | DOC-8 (scan ran, nothing stored), DOC-10 (no model session after a hit) | Acceptance |
| SR-4 | Client: symlink to a file, symlink to `/dev/null`, directory, FIFO (no hang), device node (root only), socket; opened `O_RDONLY` with `O_NOFOLLOW`; the file is left unchanged | Acceptance (client) |
| SR-5 | DOC-20, DOC-22 | Acceptance |
| SR-6 | Client: `\\server\share`, `//server/share`, `\\?\`, `\\.\pipe\`, `\\.\COM1` refused before any open; a file whose reported size is small but whose content is 768 KiB is read only up to 262,145 bytes and refused | Acceptance (client) |
| SR-7 | SRC-1 (item built from the table, confirm passes), SRC-4 (unanswered), SRC-5 (reopened), SRC-6 (changed table needs a new confirmation), SRC-7 ×3 (fabricated, paraphrased, over 1,000 characters: refused naming the row, no item), SRC-8 (whitespace collapse), SRC-9 (analyst can't pass its own list), SRC-10 (quotes checked against the stored blob, not a changed copy on the branch), SRC-11, SRC-12 | Acceptance / contract |
| SR-8 | As AC-10 | Acceptance |
| SR-9 | DOC-15 ×19 (media types, provenance, missing fields, 262,145 bytes ASCII and multi-byte, NUL, ESC, DEL, C1, lone surrogate, wrong types, empty, long name, unknown key, non-object): refused and nothing kept; DOC-16 (tab, LF, CR allowed) | Acceptance / contract |
| SR-10 | DOC-3 (`.txt` from `text/plain`), DOC-17 ×4 (path, shell and git option text, control characters, 200 characters: stored at the fixed path, never in a commit message or git argument) | Acceptance |
| SR-11 | DOC-8, DOC-9 (rule and line, never the value); client `SR11SensitiveData` (SKILL.md notice before the path is asked, naming GitHub and the model provider; refusal display names line and rule, not the value) | Acceptance and static |
| SR-12 | Not covered here: whether the analyst quotes the document in a `research_web` query is model behaviour; logging every reader request is F-007's (reader tests) | Stochastic / not unit-testable |
| SR-13 | Not tested: deferred to Alpha by the owner (spec v7) | — |
| SR-14 | Client `SR14ProvenanceFromThePick`: missing, wrong-case, empty, other, null, boolean and list values refused before connecting; each pick sent as given; SKILL.md takes provenance from the picker only | Acceptance and static |

## Functional requirements and contracts

| Item | Tests |
|---|---|
| FR-1 | DOC-1 to DOC-6, DOC-15; client `test_fr1_media_type_from_the_extension` |
| FR-1 / OQ-4 (no replacing) | DOC-6, DOC-20 |
| FR-2 | Client AC-2, SR-2, SR-4, SR-6 tests |
| FR-3 | DOC-8 to DOC-10 |
| FR-4 | DOC-1 to DOC-3, DOC-20, DOC-21, SRC-10 |
| FR-5 | DOC-18 |
| FR-6 | Stochastic (citations are the analyst's); the engine's check of each quote is SR-7 |
| FR-7 | QT-1 to QT-3; client `test_fr7_question_type_is_shown` |
| FR-8 | SRC-1 to SRC-6, SRC-13, DOC-19; client `test_fr8_*` |
| FR-9 | Stochastic (QT-1 checks a conflict can cite the standards) |
| Channel v1.4 version rule ("clients check `version` first") | DOC-7 (engine says v1.4 or later); client `ChannelVersion` (a v1.3 engine gets no document; an old engine's -32602 is explained; no document still works) |
| -32009 display | Client `Err32009Display`: each reason explained, lines named, malformed `data` (string lines, booleans, negatives, a rule with spaces or over 100 characters, an unknown reason, extra keys, a non-object) never shown |

## Abuse cases (spec section 6 and beyond)

| Case | Tests |
|---|---|
| A document mostly not about the feature | Stochastic (analyst asks which parts are in scope) |
| Replacing the document mid-interview (OQ-4) | DOC-6 (no channel path), DOC-20 (the analyst can't either) |
| Links to other documents or pages | Stochastic (the analyst doesn't follow them); the engine stores the text only, DOC-14 |
| Embedded images or HTML | DOC-11 to DOC-13 (HTML refused), DOC-14 (image reference kept as text) |
| Instructions to the analyst inside the document | DOC-18, SRC-2 |
| A planted frame END line | DOC-18 |
| Hidden text: HTML comments, zero-width and bidi characters | DOC-11, DOC-12, DOC-13 |
| A secret in the document | DOC-8 to DOC-10, client SR-11 |
| A hostile display name (path, shell, git option, controls) | DOC-17 |
| Oversize, wrong type, control bytes, broken Unicode | DOC-15, client AC-2 |
| Symlink, FIFO, device, socket, UNC or device path | Client SR-4, SR-6 |
| A file that grows past the limit after the size check | Client `test_sr6_reads_at_most_the_limit_plus_one` |
| The analyst edits its branch copy of the source to back a quote | SRC-10 |
| The analyst forges or paraphrases sources | SRC-7, SRC-9 |
| The analyst changes the Sources table after confirmation | SRC-6 |
| A wrong reply kind on a source confirmation | SRC-12 |
| An engine that echoes document text in -32009 data | Client `test_sr2_refusal_output_never_holds_the_text` |
| A v1.3 engine | Client `ChannelVersion` |
