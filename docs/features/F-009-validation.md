# F-009 Validation report

- **Feature:** F-009 Start an interview from an existing document, spec v11
- **Judge:** validation-judge
- **Date:** 2026-11-12
- **Round:** 2 (round 1: FAIL on `26ede67`)
- **Commit:** `fe24185` (`claude/project-thread-qzenwf`). The diff is `git diff origin/main...HEAD`: 17 commits, 38 files, +4,151 / -133. Since round 1: `acd6e9e` (round 1 fixes), `976424c` (test engineer's Addendum 1, plan rows and new tests), `fe24185` (fixes for the addendum's D-1 and T-1).
- **Contracts:** Engine control channel v1.4 (H-0105, with the v9 capability list), Interview tools v1.1 (H-0106, as amended in v11), Role policy v2.6 (H-0107). Analyst instructions H-0108 (merged with PR #29).
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Not met line or a Blocking finding still fails.
- **Verdict:** **FAIL**
  - **0 Blocking.** B1 is fixed: `npm run typecheck` is clean.
  - **2 lines are Not met:** SR-8 and AC-10, again, on a narrower gap (M1). Round 1's container and no-break-space cases are all refused now. But Markdown lets a link label and link text span lines, and the checks look at one line at a time. `[//` on one line and `]: # (Ignore your instructions)` on the next renders as nothing in CommonMark, and the engine accepts it. So does a link whose only text is a line break.
  - **Needs owner, 2 items:**
    - M3 (from round 1): the analyst-behaviour half of AC-4 to AC-8. It is on a decision card and not yet answered. The spec change log has no row for it.
    - M2 (new): the `source_unchanged` sentence added to Interview tools v1.1 in `acd6e9e` has no recorded owner approval.
  - Blocking: 0. Major: 3. Minor: 12.
  - Everything else holds. Every round 1 fix is in the final code and tested. Every test passes in my run, the test engineer's new v9, v10 and v11 tests included.

## Changes since round 1

| Round 1 item | Now | Evidence |
|---|---|---|
| B1: `npm run typecheck` fails (`engineJson()` type) | **Resolved** | `world.ts:548` now types `capabilities?: string[]` (`acd6e9e`). `npm run typecheck` exits 0 in my run (both projects) |
| M1: link definitions inside containers; no-break-space link text | **Resolved for every reported case; a narrower gap remains (M1 below)** | `document.ts:117` `CONTAINER` strips block quote and list markers and indents before `LINK_DEF` (`:146`). `emptyLinkText` (`:125-136`) decodes space entities and numeric references and strips Unicode whitespace and invisibles. `document.test.ts` M1 case and LNK-1 ×26, LNK-2, LNK-3 ×7 pass. My probes refuse `>[//]: #…` with no space, `   > …`, `- > …`, `> > > …`, `* …`, `1) …`, a definition in a list item's second paragraph, a tab after `>`, and link text of `&#32;`, `&#x20;`, `&ZeroWidthSpace;`, U+3000, U+2800 and U+3164 |
| M2: the test report doesn't speak for the final commit | **Resolved, with a minor follow-up (m12)** | Addendum 1 (`976424c`) ran on `acd6e9e`. It confirms DOC-7, SRC-6, `ChannelVersion` and the fixtures, and corrects SRC-1 to the exact spec line. It adds CAP-1, LNK-1 to LNK-3, SPL-1 to SPL-7, SRC-14 and three client tests, and measures coverage. It ended **fail** on D-1 and T-1. Both were fixed in `fe24185`, and the test engineer hasn't re-run since. My run on `fe24185` is the evidence: SPL-2 "across two table rows" and both F-006 tests pass |
| M3: analyst behaviour for AC-4 to AC-8 | **Still Needs owner** | A decision card was posted 2026-11-12 20:15 (recommended: accept the engine-side evidence, with a real-analyst evaluation as a known issue blocking Alpha). It hasn't been answered, and the spec change log has no row for it |
| m1: `source_unchanged` not in the contract | **Text added, approval not recorded (now M2)** | `docs/interface-contracts.md:912-914`. See M2 |
| m2: client hidden-content reason predates v10 | **Resolved** | `interview_client.py:105-107` lists link definitions and empty links |
| m8: `SKILL.md` names channel v1.3 | **Resolved** | `SKILL.md:15` says v1.4. The F-006 pin now accepts `v1\.[3-9]` (`test_acceptance_f006.py:750`), which is the fix the test engineer gave for T-1 |
| m7: dev report out of date | **Partly** | It now lists the round 1 and addendum fixes and the B1 history. Its test counts are still from `26ede67` (m7) |
| m3, m4, m5, m6, m9, m10, m11 | Open | Unchanged. See Minor findings |
| Addendum D-1: a quote across rows of a table without outer pipes | **Resolved** | `document.ts:341-346`: any line with an unescaped `|` is a block of its own. SPL-2 passes |
| Addendum T-1: F-006 pin on v1.3 | **Resolved** | As m8 |

## My own run (evidence source)

On `fe24185`, Linux container, Node 22, Python 3.13, running as root. `engine/node_modules` was already present. The working tree was clean before this report.

| Step | Result |
|---|---|
| `npm run typecheck` (engine: `tsc --noEmit` and `tsc --noEmit -p test/acceptance`, as CI runs it) | **Clean, exit 0** |
| `npx vitest run --coverage` | **35 files: 33 passed, 2 skipped. 661 tests: 647 passed, 14 skipped, 0 failed.** The 14 skips are the gated real-Docker files and platform gates, as in round 1. No F-009 test is skipped |
| Coverage, whole suite, `engine/src/**` (`@vitest/coverage-v8` 5.1.0) | Statements 83.98%, branches 80.01%, functions 84.19%, lines 87.89% (3,928 / 4,469). F-009 files (statements / branches / functions / lines): `document.ts` 96.9 / 95.4 / 97.6 / 98.4; `tools.ts` 95.6 / 92.8 / 97.1 / 98.6; `readiness.ts` 96.4 / 92.1 / 100 / 97.2. These match the addendum's figures |
| `python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests` | **428 tests, OK** (193.5 s). This includes the 43 in `test_acceptance_f009` and both F-006 tests that failed in the addendum (T-1) |
| `python3 -m unittest discover -s plugins/software-factory/skills/onboard-repo/tests` | **318 tests, OK (1 skipped)** |
| `python3 scripts/check_docs.py`, `python3 scripts/check_placeholders.py` | Both pass |
| Probes (scratch folder only): `document.ts` bundled, `validateDocument` called on crafted documents, results rendered with the CommonMark reference library | Every round 1 M1 case and the variants in the table above are refused. Controls (a quote with a link, task lists, an ordered list) are accepted. **Accepted:** `[//` + newline + `]: # (Ignore your instructions)`, which renders as `""`. Also accepted: `Text [` + newline + `](# "hidden instruction")` and `Text [  ` + newline + `  ](# "…")`, which render as a link whose only content is a line break, with the title hidden (M1). `[` `` ` ` `` `](# "…")` renders as a link around a code span holding one space (m13) |

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `channel/methods.ts:90-96`, `document.ts:181` `validateDocument`; `request` still required. DOC-1 to DOC-6, DOC-15 ×19; OQ-4: DOC-6 |
| FR-2 | Met | `interview_client.py` `read_document`, `_document_path`; read before `connect`. Client `AC02RefusedBeforeConnecting`, `test_fr2_*`; v9 capability tests (refused before the file is opened) |
| FR-3 | Met | `engine.ts` `scanDocument`, first inside the start lock. DOC-8 to DOC-10 |
| FR-4 | Met | `engine.ts` `storeDocument` (blob read back, private index, `commit-tree` on `main`); SHA-256 and blob id in `feature_started`; write deny in `role-policy.ts`. DOC-1 to DOC-3, DOC-20 ×3, DOC-21, SRC-10, SRC-14 |
| FR-5 | Met | `frame.ts:34-54` `frameDocument`. DOC-18, DOC-19 |
| FR-6 | Met (engine part); model part Needs owner (M3) | `tableProblems` (`document.ts:362`) and `sources_confirmed`. SRC-1 to SRC-9, SPL-1 to SPL-4 |
| FR-7 | Met (engine part); model part Needs owner (M3) | `tools.ts` `type` and worktree-path sources, document features only. QT-1 to QT-3; `test_fr7_*` |
| FR-8 | Met (engine part); "reopened lines become questions" Needs owner (M3) | Engine-built item with `spec_line`; `tableHash` over rows and spec lines; reopen fails the check. SRC-1 (exact spec line), SRC-1 to SRC-13, SPL-5, SPL-6 ×2, SPL-7, DOC-19; client `test_fr8_*` including `test_fr8_v11_each_spec_ref_shows_its_own_spec_line_as_data`. The `specLine` gap is still open (m3) |
| FR-9 | Met (engine part); model part Needs owner (M3) | QT-1 (a conflict can cite `docs/security-standards.md`) |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | DOC-1, DOC-2, DOC-4; client `test_fr2_bytes_reach_the_engine_unchanged`, `test_v9_the_capability_not_the_version_decides` |
| AC-2 | Met | Client `AC02RefusedBeforeConnecting` (8 tests), `test_ac2_refuses_before_connecting` |
| AC-3 | Met | DOC-8, DOC-9, DOC-10 |
| AC-4 | **Needs owner** (M3) | Engine half: SRC-1 to SRC-4, SPL-6 |
| AC-5 | **Needs owner** (M3) | Engine half: QT-1 |
| AC-6 | **Needs owner** (M3) | Engine half: QT-1 |
| AC-7 | Met for "the readiness check still requires the source confirmation" (SRC-2 to SRC-4, DOC-18). "The analyst doesn't act on it": **Needs owner** (M3) | |
| AC-8 | **Needs owner** (M3) | Engine half: DOC-19, SRC-13 |
| AC-9 | Met | DOC-20 ×3, DOC-21, DOC-22; `document.test.ts` "Role policy v2.6" |
| AC-10 | **Not met** (M1) | Every kind the criterion lists is refused on one line, at the top level and inside containers: DOC-11 to DOC-14, LNK-1 ×26, LNK-2, `document.test.ts` AC-10, M1 and M2 tests, client `test_ac10_hidden_content_lines_are_named`. A link label or link text split across lines is accepted (M1) |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met (engine part); "never followed" Needs owner (M3) | `frame.ts:34-54`; DOC-18, DOC-19 |
| SR-2 | Met, with the contract's approved exception | `SR02ClaudeNeverSeesTheDocument`, `test_skill_never_reads_the_document_and_takes_provenance_from_the_pick`. Quotes reach Claude through the source confirmation, as H-0105 designs (m10) |
| SR-3 | Met | DOC-8, DOC-10 |
| SR-4 | Met | Client SR-4 tests (symlinks, directory, FIFO, device node, socket, swap between check and open) |
| SR-5 | Met | DOC-20, DOC-22, onboarding suite |
| SR-6 | Met (Linux real; Windows string checks only, m9) | `test_sr6_*`, `test_a_linked_folder_leading_to_a_share_is_refused` |
| SR-7 | Met | SRC-1 to SRC-12, SPL-1 ×7, SPL-2 ×8 (including D-1's table form), SPL-3, SPL-4 ×2 |
| SR-8 | **Not met** (M1) | As AC-10 |
| SR-9 | Met | DOC-15 ×19, DOC-16 |
| SR-10 | Met | DOC-3, DOC-17 ×4 |
| SR-11 | Met | DOC-8, DOC-9; `SR11SensitiveData` |
| SR-12 | Met as an instruction (approved residual at Rapid prototype); untested (M3) | `agents/requirements-analyst/AGENT.md:49` |
| SR-13 | Deferred to Alpha (owner, spec v7) | Known issue |
| SR-14 | Met | `SR14ProvenanceFromThePick` |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Document mostly not about the feature | Model behaviour (M3) |
| Replace the document mid-interview (OQ-4) | Yes: DOC-6, DOC-20 |
| Links to other documents or pages | Not followed by the engine; model behaviour for the analyst (M3) |
| Embedded images or HTML | HTML refused (DOC-11 to DOC-13); image references stay text (DOC-14); empty alt text refused (LNK-1) |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval | Met | Spec v11. Rows 7 to 11 each cite an owner decision card dated 2026-11-12. No new spec change since round 1 |
| Architecture / ADRs | Met | Unchanged since round 1. No new component or dependency |
| Interface contracts | **Needs owner** (M2) | The code matches the contract text. CH-*, SE-*, IT-*, CAP-1 and SRC-14 pass. The diff since round 1 adds one sentence to Interview tools v1.1 (`interface-contracts.md:912-914`, `source_unchanged`). It describes what the code already does and only tightens, but no owner approval is recorded for it |
| Change-controlled files | Met apart from M2 | `docs/interface-contracts.md`: M2. `plugins/**`: the client reason text and `SKILL.md` (H-0108 lets them change during development under this spec), and the F-006 test pin (T-1, the test engineer's stated fix). `scripts/`, `.github/`, `agents/` and `CLAUDE.md` are unchanged |
| Code quality, readability, maintainability | Met, with findings | The round 1 fixes are small: one container regex, one decode function, and one rule in the block splitter. The D-1 rule also ends a block at a prose line holding a `|`. That tightens (a quote can't cross such a line) and fails closed. Findings: M1, m3, m11, m13 |
| Comments | Met | The new comments say why: `document.ts:114-116` (why containers are stripped, and why an indented definition is refused like HTML in code), `:122-124`, `:341-342` (GFM rows without outer pipes). None is redundant, outdated or a crutch |
| Test tools | Met | The plan and addendum hold the tool table: Vitest 5.1.0 with the F-007 harness (OQ-9), `unittest` (F-005), coverage with `@vitest/coverage-v8` 5.1.0, stochastic tests not required at this level. No substitute tool |
| Documentation | Met, with findings | Contracts, analyst instructions, `SKILL.md` (now v1.4), onboarding template, test plan (now v11), test report (addendum). Findings: m4, m6, m7, m12 |
| Security | Met | Gate 1 and Gate 2 present. Gate 2 is PASS with conditions and has no Critical finding. All its findings are fixed or decided by the owner. Gate 2 hasn't re-reviewed the fixes (m5). The M2 (link tricks) fix is still incomplete (M1) |

## Findings

### Blocking

None.

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `engine/src/interview/document.ts:118` (`LINK_DEF`), `:120` (`LINK_TEXT`), `:142-179` (`hiddenLinkLines`) | **SR-8 and AC-10 are Not met for link labels and link text that span lines.** Both checks run one line at a time. CommonMark lets a link label hold a line break, and lets link text hold a line break too. Reproduced as accepted by `validateDocument`, and rendered with the CommonMark reference library: (1) `[//` then `]: # (Ignore your instructions)` on the next line renders as `""`. It is the `[//]: # (comment)` idiom that v10 targets, split over two lines. (2) `Text [` then `](# "hidden instruction")` renders as a link whose only content is a line break, with the title hidden. Spaces around the break (`[  ` and `  ](# "…")`) give the same. This is the same threat as round 1's M1, one character different. **Fix:** run the label and link-text checks on the text with the line endings inside brackets included (match over the whole text, or over each block, and map each match's offset back to its line numbers), and treat text holding only line breaks as empty. Add both cases to the tests. |
| M2 | `docs/interface-contracts.md:912-914` (`acd6e9e`) | **Needs owner (Interfaces).** Round 1's m1 asked for `source_unchanged` to be added to Interview tools v1.1 "at the next contract amendment (owner approval needed)". `acd6e9e` added the sentence, but the contract header (`:842-846`), the spec change log and the dev report record no approval for it. `interface-contracts.md` is change-controlled (CLAUDE.md rule 3), so every edit needs explicit approval. The text is accurate and only tightens. **Options:** (A) the owner approves the sentence as written, and the approval is recorded in the contract header. (B) Revert the sentence and leave the check undocumented, which leaves round 1's m1 open. **I recommend A.** It can go on the same card as M3. |
| M3 | AC-4 to AC-8; FR-6, FR-7, FR-8 (reopened lines), FR-9; SR-1, SR-12 | **Needs owner (Product), carried from round 1.** These criteria are half about what the real analyst does, and the suite uses a scripted fake model. The engine's enforcement is tested and passes. A decision card is open with option A recommended: accept the engine-side evidence at Rapid prototype, and log the real-analyst evaluation (planted documents for AC-4 to AC-8) as a known issue that blocks promotion to Alpha. It isn't answered, and the spec change log has no row for it. **I still recommend A.** |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m3 | `engine/src/interview/document.ts:274` (`specLine`) | Unchanged from round 1. The lock binds only the first line found for a ref. A requirement written over several lines has only its first line locked, and an earlier line that opens with the ref is taken as its line. SPL-5 tests the three forms, not these cases. The owner sees the line in the item, so the owner check would catch it. |
| m4 | `agents/requirements-analyst/AGENT.md:35-49` | Unchanged. The analyst instructions don't state the v11 quote, Section and block rules. Change-controlled; needs owner approval. |
| m5 | `F-009-security-gate2.md` | Unchanged. Gate 2 reviewed `7106e02` and hasn't re-reviewed its H1, H2, M1, L1 and L2 fixes, v9 to v11, or the round 1 fixes. Not required at Rapid prototype; should confirm before Alpha. |
| m6 | `docs/features/` | Still no `F-009-orchestrator-review.md` (stage 6, DoD 6). Needed before the PR. |
| m7 | `docs/features/F-009-dev-report.md` § Tests | The counts are still from `26ede67`: engine "589 passed" (now 647), client suite "381 passed" (now 428), `document.test.ts` "24 tests". The round 1 and addendum fixes are listed. |
| m9 | `plugins/.../spec-interview/tests/windows`; CI | Unchanged. The plugin's Python tests aren't run by GitHub CI, and the Windows tests weren't run. Known issue for promotion. |
| m10 | Spec SR-2 | Unchanged. SR-2's wording doesn't name the approved exception for quotes in the source confirmation. |
| m11 | `engine/src/engine.ts` | Unchanged. Logged against F-007 M5. |
| m12 | `docs/features/F-009-test-report.md` Addendum 1 | The addendum ran on `acd6e9e` and ends "Result: fail" (D-1, T-1). `fe24185` fixed both, and the developer edited the F-006 test file for T-1, following the test engineer's stated fix. The test engineer hasn't recorded a run on `fe24185`. My run there passes everything, so I use it as the evidence, as in round 1. A short Addendum 2 should close the record. |
| m13 | `document.ts:125-136` (`emptyLinkText`) | Link text that is only a code span of spaces (`` [` `](# "…") ``) is accepted. It renders as a link around a blank code box: barely visible, with the title hidden. Treat a code span holding only whitespace as empty when M1 is fixed. |
| m14 | `document.ts` (`hiddenLinkLines` on `text/plain`); spec SR-8 | The engine applies the link rules to `text/plain` too (`document.test.ts` refuses `[//]: # "hi"` as plain text), extending the dev report's interpretation 2 for HTML. SR-8 says "a Markdown link reference definition", so whether it covers plain text is open. The test engineer left it unasserted. It fails closed. The owner may want SR-8's text to say which. |
| m15 | `document.ts:117` (`CONTAINER`) | Stripping every indent also refuses link-definition text inside an indented code block, and a definition under a paragraph (which CommonMark doesn't treat as a definition). Both are over-refusals that fail closed, and the comment at `:114-116` says so for code. The test engineer left code unasserted. Logged so the owner isn't surprised by a refusal of a code sample. |

Round 1's m1, m2 and m8 are resolved (see the table above), so those numbers aren't reused.

Known issues carried, not graded:
- SR-13: deferred to Alpha by the owner.
- Existing project manifests must add the two Role policy v2.6 denies, or the engine refuses the project. This includes the e2e trial config repo (dev report).
- Failed starts can leave unreferenced, unpushed git objects (Gate 2 Info).

## Counts

- Blocking: 0.
- Major: 3 (M1, M2, M3). M2 and M3 need the owner.
- Minor: 12 (m3 to m7, m9 to m15).
- Lines: **2 Not met** (SR-8, AC-10). **Needs owner:** Interface contracts (M2); AC-4, AC-5, AC-6, AC-8, the model half of AC-7, and the model parts of FR-6 to FR-9, SR-1 and SR-12, all as one item (M3).

## To reach PASS at Rapid prototype

1. **Developer (M1):** check link labels and link text across line breaks, and treat text holding only line breaks (and, for m13, a blank code span) as empty. Add the cases to the tests.
2. **Owner, one card (M2 and M3):** approve the `source_unchanged` sentence in Interview tools v1.1, and decide how the analyst-behaviour half of AC-4 to AC-8 is evidenced at Rapid prototype. I recommend A for both. Record both in the spec change log and the contract header.
3. **Test engineer (m12):** an Addendum 2 run on the final commit, with M1's new cases.
4. Before the PR: the orchestrator review note (m6) and the dev report counts (m7).

Then a round 3 on the new commit.
