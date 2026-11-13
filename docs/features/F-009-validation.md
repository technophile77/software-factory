# F-009 Validation report

- **Feature:** F-009 Start an interview from an existing document, spec v13
- **Judge:** validation-judge
- **Date:** 2026-11-13
- **Round:** 5 (round 1: FAIL on `26ede67`; round 2: FAIL on `fe24185`; round 3: FAIL on `0e826cd`; round 4: FAIL on `6cdd631`)
- **Commit:** `17d2459` (`claude/project-thread-qzenwf`). The diff is `git diff origin/main...HEAD`: 30 commits, 39 files, +4,751 / -134. Since round 4: `ac086e2` (developer's M5 fix), `0b60ae0` (test engineer's Addendum 4: LNK-10 to LNK-12 and a sweep of 190,582 rendered documents, run on `ac086e2`; found D-3, D-4, D-5) and `17d2459` (developer's fix for D-3 to D-5).
- **Contracts:** Engine control channel v1.4 (H-0105, with the v9 capability list), Interview tools v1.1 (H-0106, as amended in v11 and by H-0109), Role policy v2.6 (H-0107). Analyst instructions H-0108 and H-0109.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Not met line or a Blocking finding still fails.
- **Verdict:** **PASS**
  - **0 Blocking. 0 Not met. Needs owner: none.**
  - SR-8 and AC-10 are Met. M5 is fixed, and so are D-3, D-4 and D-5 from the test engineer's sweep. Every M5 form from round 4, every D-3 to D-5 form, and every earlier case is refused in my run and in my probes; the visible controls are accepted.
  - Blocking: 0. Major: 1 (M6, logged). Minor: 10.
  - **M6 must be fixed before the PR is marked ready:** `python3 scripts/check_docs.py` fails on `17d2459` (`F-009-test-report.md: broken link to x.png`), so the repo's `docs-checks` CI job will be red. The cause is an example inside a code span in Addendum 4; it is a one-line doc fix.

## Changes since round 4

| Round 4 item | Now | Evidence |
|---|---|---|
| M5: link text or image alt of only a backslash hard break (SR-8, AC-10 Not met) | **Resolved** | `document.ts:127` drops a `\` that ends a line before the blank test. Lines are split on CR, LF and CRLF first (`:250`), so CRLF is covered. LNK-10 ×16 and the four `document.test.ts` cases pass. In my probes all 7 round 4 forms are refused (inline, CRLF, hidden target, image alt, full reference, block quote, list item, `&nbsp;` on each side); commonmark.js and markdown-it both render each as a link with only `<br />` or an alt of `\n` |
| D-3 (Addendum 4): shortcut reference link or image of only a backslash hard break | **Resolved** | `:186` and `:217` let a label hold an escaped line end (`\\[\s\S]`); `:212` blanks definition lines in place so offsets still map to lines; `:220-224` names every line a blank label's use covers. LNK-11 (7 cases) pass. Probes: shortcut, CRLF, collapsed, image shortcut and a two-line `&nbsp;` label are refused, naming the use's lines and the definition. Controls accepted: a shortcut of words, a shortcut label over two lines with words |
| D-4: `&ThickSpace;` | **Resolved** | Added to `SPACE_ENTITIES` (`:119`). LNK-11 (8 cases) pass. Probes: link text, a table cell refused; `&ThickSpace;` in a code span as link text accepted (renders `<code>&amp;ThickSpace;</code>`) |
| D-5: link text of only a variation selector | **Resolved** | `:137` treats U+FE0E and U+FE0F as blank in link text only; elsewhere they stay allowed for emoji (Gate 2 M1). LNK-11 (9 cases) pass. Probes: U+FE0F, `&#xFE0E;`, U+FE01 and U+E0100 refused; an emoji with U+FE0F accepted |
| Code span content (part of the D-3 to D-5 fix) | New behaviour, correct | `:129` turns a code span with content into visible text before markup and entities are dropped, so a code span shows "as written". `:130` drops `` ` ``, `*`, `_`, `~` before entities are decoded, so `&#42;`, `&#96;` and `\*` count as visible. Controls in LNK-12 and my probes are accepted |
| m7: dev report counts out of date | **Resolved** | `F-009-dev-report.md` § Tests now says 428 client tests and "707 or more" engine tests, pointing to the latest validation round for the exact count (765 in my run). Not wrong, though no longer exact |
| m15: over-refusals that fail closed | **Partly** | link text `&#42;&nbsp;&#42;` (shows `* *`) is now accepted (`document.test.ts`). The rest stays, and two more are listed below |
| m3, m5, m6, m9, m10, m11, m14 | Open | Unchanged. See Minor findings |

## My own run (evidence source)

On `17d2459`, Linux container, Node 22, Python 3.13, running as root. `engine/node_modules` was already present. The working tree was clean before this report. Logs are in the judge's scratch folder only.

| Step | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit` and `tsc --noEmit -p test/acceptance`) | **Clean, exit 0** |
| `npx vitest run --coverage` | **35 files: 33 passed, 2 skipped. 779 tests: 765 passed, 14 skipped, 0 failed** (exit 0, 279 s). The 14 skips are the gated real-Docker files and platform gates, as before. No F-009 test is skipped. Matches the developer's reported 765 / 14. `f009-document.test.ts` alone: **252 passed**, including LNK-10 ×16, LNK-11 ×24 and LNK-12 ×18 |
| Coverage, whole suite, `engine/src/**` (`@vitest/coverage-v8` 5.1.0) | Statements 84.08%, branches 80.07%, functions 84.27%, lines 87.96% (3,956 / 4,497) |
| `python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests` | **428 tests, OK** (204 s), including the 43 in `test_acceptance_f009` |
| `python3 -m unittest discover -s plugins/software-factory/skills/onboard-repo/tests` | **318 tests, OK (1 skipped)** |
| `python3 scripts/check_docs.py` | **Fails, exit 1:** `docs/features/F-009-test-report.md: broken link to x.png` (M6). It passed on `6cdd631`; the line came in with `0b60ae0` |
| `python3 scripts/check_placeholders.py` | Passes. `python3 -m unittest discover -s scripts/tests` (the other `docs-checks` CI step): 14 tests, OK |
| Probes (scratch folder only): `document.ts` bundled from `17d2459`, `validateDocument` called on 47 crafted documents, each rendered with commonmark.js and markdown-it | Refused: all 7 M5 forms; D-3 shortcut (LF, CRLF), collapsed and image-shortcut forms; a blank label over two lines; `&ThickSpace;` (link and table cell); U+FE0F, `&#xFE0E;`, U+FE01, U+E0100; `&zwnj;`, `&zwj;`, `&ZeroWidthSpace;`, `&NegativeThinSpace;`, `&InvisibleTimes;`, `&af;`, `&NoBreak;`, `&shy;`; two hard breaks; a hard break after a stray `[`, inside emphasis, or after `&#160;`. Accepted (visible, correct): `&#42;`, `\*`, `&#96;`, words around a hard break, `` `&ThickSpace;` ``, `` `\` ``, an emoji with U+FE0F, a shortcut of words (one or two lines), a backslash ending a paragraph, `~~words~~`. Refused although visible (fail closed, m15): a lone `` ` `` as link text, and a code span holding a backslash that ends a line |

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `channel/methods.ts:90-96`, `document.ts` `validateDocument`; `request` still required. DOC-1 to DOC-6, DOC-15 ×19; OQ-4: DOC-6 |
| FR-2 | Met | `interview_client.py` `read_document`, `_document_path`; read before `connect`. Client `AC02RefusedBeforeConnecting`, `test_fr2_*`; v9 capability tests |
| FR-3 | Met | `engine.ts` `scanDocument`, first inside the start lock. DOC-8 to DOC-10 |
| FR-4 | Met | `engine.ts` `storeDocument`; SHA-256 and blob id in `feature_started`; write deny in `role-policy.ts`. DOC-1 to DOC-3, DOC-20 ×3, DOC-21, SRC-10, SRC-14 |
| FR-5 | Met | `frame.ts:34-54` `frameDocument`. DOC-18, DOC-19 |
| FR-6 | Met (engine part tested; model part accepted on that evidence, spec v12) | `tableProblems` and `sources_confirmed`. SRC-1 to SRC-9, SPL-1 to SPL-4, SPL-8 |
| FR-7 | Met (as FR-6, spec v12) | `tools.ts` `type` and worktree-path sources. QT-1 to QT-3; `test_fr7_*` |
| FR-8 | Met (as FR-6, spec v12) | Engine-built item with `spec_line`; `tableHash`; reopen fails the check. SRC-1 to SRC-13, SPL-5 to SPL-7, DOC-19; client `test_fr8_*`. The `specLine` gap is still open (m3) |
| FR-9 | Met (as FR-6, spec v12) | QT-1 |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | DOC-1, DOC-2, DOC-4; client `test_fr2_bytes_reach_the_engine_unchanged`, `test_v9_the_capability_not_the_version_decides` |
| AC-2 | Met | Client `AC02RefusedBeforeConnecting` (8 tests), `test_ac2_refuses_before_connecting` |
| AC-3 | Met | DOC-8, DOC-9, DOC-10 |
| AC-4 | Met at Rapid prototype (owner, spec v12) | SRC-1 to SRC-4, SPL-6. Real-analyst evaluation is a known issue blocking Alpha |
| AC-5 | Met at Rapid prototype (owner, spec v12) | QT-1 |
| AC-6 | Met at Rapid prototype (owner, spec v12) | QT-1 |
| AC-7 | Met at Rapid prototype (owner, spec v12) | SRC-2 to SRC-4, DOC-18 |
| AC-8 | Met at Rapid prototype (owner, spec v12) | DOC-19, SRC-13 |
| AC-9 | Met | DOC-20 ×3, DOC-21, DOC-22; `document.test.ts` "Role policy v2.6" |
| AC-10 | Met | DOC-11 to DOC-14, LNK-1 ×26, LNK-2, LNK-3 ×7, LNK-4 ×16, LNK-5 ×7, LNK-6 ×3, LNK-8 ×19, LNK-10 ×16 (M5 and GFM strikethrough), LNK-11 ×24 (D-3 to D-5); controls LNK-7 ×5, LNK-9 ×8, LNK-12 ×18; client `test_ac10_hidden_content_lines_are_named`. All pass in my run on `17d2459`. LNK-10 and LNK-11 are the test engineer's tests, written from SR-8 and AC-10, and shown in Addendum 4 to fail before the fixes (LNK-10 on `9520656`'s `document.ts`, LNK-11 on `ac086e2`) |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met (engine part tested; "never followed" accepted on that evidence, spec v12) | `frame.ts:34-54`; DOC-18, DOC-19 |
| SR-2 | Met, with the contract's approved exception | `SR02ClaudeNeverSeesTheDocument`, `test_skill_never_reads_the_document_and_takes_provenance_from_the_pick` (m10) |
| SR-3 | Met | DOC-8, DOC-10 |
| SR-4 | Met | Client SR-4 tests |
| SR-5 | Met | DOC-20, DOC-22, onboarding suite |
| SR-6 | Met (Linux real; Windows string checks only, m9) | `test_sr6_*` |
| SR-7 | Met | SRC-1 to SRC-12, SPL-1 ×7, SPL-2 ×8, SPL-3, SPL-4 ×2, SPL-8 ×2 |
| SR-8 | Met | As AC-10. `document.ts:121-138` (`blankLinkText`), `:176-182` (inline, full and collapsed forms), `:210-227` (uses of blank definition labels, over lines) |
| SR-9 | Met | DOC-15 ×19, DOC-16 |
| SR-10 | Met | DOC-3, DOC-17 ×4 |
| SR-11 | Met | DOC-8, DOC-9; `SR11SensitiveData` |
| SR-12 | Met as an instruction (approved residual; accepted on engine-side evidence, spec v12) | `agents/requirements-analyst/AGENT.md` |
| SR-13 | Deferred to Alpha (owner, spec v7) | Known issue |
| SR-14 | Met | `SR14ProvenanceFromThePick` |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Document mostly not about the feature | Model behaviour, accepted at Rapid prototype (spec v12) |
| Replace the document mid-interview (OQ-4) | Yes: DOC-6, DOC-20 |
| Links to other documents or pages | Not followed by the engine; model behaviour accepted (spec v12) |
| Embedded images or HTML | HTML refused (DOC-11 to DOC-13); image references stay text (DOC-14); blank alt text refused (LNK-1, LNK-6, LNK-8, LNK-10, LNK-11) |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval | Met | Spec v13, unchanged since round 3 |
| Architecture / ADRs | Met | Unchanged. No new component or dependency |
| Interface contracts | Met | No contract diff since round 4. CH-*, SE-*, IT-*, CAP-1 and SRC-14 pass |
| Change-controlled files | Met | Since round 4, only `engine/src/interview/document.ts`, two test files and `docs/features/F-009-*` changed. These belong to the in-progress feature |
| Code quality, readability, maintainability | Met, with findings | The fixes are small and local to `blankLinkText` and the definition-use loop; folding the old per-line use scan into one pass over the whole text removes a second loop. Findings: m3, m11, m17 |
| Comments | Met, with finding | New comments say why (`:121-124`, `:128`, `:136`, `:211`, `:214-215`). One older comment is now misplaced (m17) |
| Test tools | Met | Vitest 5.1.0 with the F-007 harness (OQ-9), `unittest` (F-005), `@vitest/coverage-v8` 5.1.0. commonmark.js, markdown-it and micromark with GFM were used only in scratch areas (test engineer; commonmark.js and markdown-it by the judge). No substitute tool |
| Documentation | Met, with findings | Test plan (round 4 row), test report (Addendum 4), dev report (M5 and D-3 to D-5 notes, counts). Findings: M6, m6, m18 |
| Security | Met | Gate 1 and Gate 2 present. Gate 2 is PASS with conditions and has no Critical finding. Gate 2 hasn't re-reviewed later fixes (m5) |

## Findings

### Blocking

None.

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M6 | `docs/features/F-009-test-report.md:564` (Addendum 4, Observations) | **The repo's docs check fails on `17d2459`.** `scripts/check_docs.py` reads the markdown-it image example (an image with alt `&#42;` and target `x.png`, written inside a code span) as a real image link and reports `broken link to x.png` (exit 1). The `docs-checks` workflow runs this script on every pull request, so the PR's CI will be red, and stage 9 needs CI green before the PR is marked ready. The dev report's "Docs checks and placeholder check pass" is out of date for the same reason. It passed on `6cdd631`; `0b60ae0` added the line. **Fix (test engineer, feature-owned file):** write the example so it doesn't parse as a link, for example describe the image in words, as this report does, or use a target that exists. Changing `check_docs.py` to skip code spans is a change-controlled edit and would need the owner. |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m3 | `engine/src/interview/document.ts` (`specLine`) | Unchanged. The lock binds only the first line found for a ref. The owner sees the line in the item, so the owner check would catch a wrong one. |
| m5 | `F-009-security-gate2.md` | Unchanged. Gate 2 reviewed `7106e02` and hasn't re-reviewed its fixes, v9 to v11, or the validation fixes. Not required at Rapid prototype; should confirm before Alpha. |
| m6 | `docs/features/` | No `F-009-orchestrator-review.md` yet. Per the orchestrator, it is written after this verdict, so it doesn't count against PASS. Needed before the PR. |
| m9 | `plugins/.../spec-interview/tests/windows`; CI | Unchanged. GitHub CI doesn't run the plugin's Python tests, and nobody ran the Windows tests. Known issue for promotion. |
| m10 | Spec SR-2 | Unchanged. SR-2's wording doesn't name the approved exception for quotes in the source confirmation. |
| m11 | `engine/src/engine.ts` | Unchanged. Logged against F-007 M5. |
| m14 | `document.ts` (`hiddenLinkLines` on `text/plain`); spec SR-8 | Unchanged. The link rules also apply to `text/plain`. This fails closed; the owner may want SR-8 to say which media types it covers. |
| m15 | `document.ts:117` (`CONTAINER`); `:130`; `:176` | Over-refusals that fail closed. Link-definition text in an indented code block or under a paragraph (unchanged); link text that starts with an escaped bracket (`[\[](#)`, shows `[`). New since round 4: link text of a lone backtick (`` [`](#) ``, shows `` ` ``), because `:130` drops it; and a code span holding a backslash that ends a line, because `:127` drops the backslash before `:129` reads the span (renders `<code>\ </code>`). Rare in a requirements document. |
| m17 | `document.ts:194-196` | The comment "Every use of a label with blank text … renders as a link with no visible text (test defect D-2)" sits above the line that flags the *definition*, not its uses; the uses are now handled, with their own comment, at `:214-224`. The line also calls `blankLinkText(m[1]!)` again instead of reading the `blank` value computed on `:193`. Say why the definition line itself is named, or drop the comment, and reuse the value. |
| m18 | `docs/features/F-009-test-report.md` | The latest test engineer run (Addendum 4) is on `ac086e2` and records **fail** (24 LNK-11 tests). No addendum records a run on `17d2459`. The checklist asks for the test engineer's run on the final commit; my run on `17d2459` passes every one of their tests (765 passed, 0 failed), and the orchestrator accepted that as the evidence. A short note in the test report, made with the M6 fix, would close it. |

Round 4's M5 and m7 are resolved (see the table above), so those numbers, and earlier resolved ones such as m12 and m16, aren't reused. D-3 to D-5 were the test engineer's defects and are resolved.

Known issues carried, not graded:
- Real-analyst evaluation of AC-4 to AC-8 against sample documents: blocks promotion to Alpha (owner, spec v12).
- SR-13: deferred to Alpha by the owner.
- Existing project manifests must add the two Role policy v2.6 denies, or the engine refuses the project. This includes the e2e trial config repo (dev report).
- Failed starts can leave unreferenced, unpushed git objects (Gate 2 Info).
- Test engineer's Addendum 4 observations, not asserted and not graded here: GFM footnotes are refused (whether footnotes are in SR-8's scope is for the owner, with m14); markdown-it drops entities from an image's alt (renderer quirk).

## Counts

- Blocking: 0.
- Major: 1 (M6).
- Minor: 10 (m3, m5, m6, m9, m10, m11, m14, m15, m17, m18). m17 and m18 are new this round.
- Lines: 0 Not met. Needs owner: none.

## Before the PR

1. **Test engineer (M6, m18):** reword the `x.png` example in Addendum 4 so `check_docs.py` passes, and add a one-line note of the run on `17d2459`.
2. **Developer (m17, optional):** fix the misplaced comment at `document.ts:194-195`. Any code change after this verdict needs the suite re-run.
3. **Orchestrator (m6):** the review note, then CI green on the PR.
