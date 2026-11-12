# F-009 Developer completion report

- **Feature:** F-009 Start an interview from an existing document, spec v10
- **Role:** software-developer
- **Date:** 2026-11-12
- **Branch:** `claude/project-thread-qzenwf`
- **Contracts used:** Engine control channel v1.4 (H-0105), Interview tools v1.1 (H-0106), Role policy v2.6 (H-0107), analyst instructions (H-0108). All approved 2026-11-12.
- **New dependencies:** none. The engine uses only its pinned packages. The client uses only the Python standard library.

## What changed

### Engine (`engine/`)
- `src/interview/document.ts` (new):
  - `validateDocument` re-checks every `document` field on the engine side (SR-9). It refuses text a reader can't see (SR-8, AC-10): HTML comments, raw HTML outside code in Markdown, and zero-width, bidi and tag characters in any document. A byte order mark is allowed only at the very start.
  - Refusals use `DocumentRefused` and become error -32009, carrying line numbers and rule ids only.
  - The module also reads the spec's `## Sources` table, hashes it, and checks every quote against the stored document (SR-7).
- `src/engine.ts`:
  - `feature.start` with a document scans it with gitleaks before anything else (FR-3, AC-3).
  - It then commits the document byte for byte on top of `main` at `docs/features/F-nnn-source.md` or `.txt`, through a private index, and points the new feature branch at that commit (FR-4, AC-1).
  - The transcript records the name, type, provenance, path, size, SHA-256 and git blob id, never the text.
  - The analyst's first turn carries the document, framed with a fresh boundary (FR-5).
  - Before every use the engine reads the document back by blob id and refuses it if its SHA-256 no longer matches.
- `src/interview/tools.ts`, `model.ts`, `feature.ts`, `readiness.ts`:
  - `type` (`gap`, `conflict` or `ambiguity`) and worktree-path finding sources are accepted on document-started features only.
  - The new tool `interview_confirm_sources` builds the `source_confirmation` item from the spec's table, not from analyst text. A newer confirmation supersedes an open one.
  - New replies `confirm_sources` and `reopen_sources`.
  - New readiness check `sources_confirmed`, for owner provenance only. It needs the latest confirmation approved and built from the spec's current table.
  - A `*-source.*` file is never a `spec_path`.
- `src/policy/role-policy.ts`: `SOURCE_DOCUMENT_DENIES` is required in the write deny list of every role that writes outside `.factory/` (H-0107, AC-9).
- `src/gitleaks.ts`: findings now carry each hit's start line, so a refusal can name lines (SR-11).

### Client and skill (`plugins/software-factory/skills/spec-interview/`)
- `interview_client.py`:
  - `start` takes `document: {path, provenance}`. The script reads the file before connecting.
  - It refuses UNC, device, drive-relative and data-stream paths, links, FIFOs and other non-regular files.
  - It also refuses a file swapped between the check and the open, anything over 256 KiB, anything that isn't UTF-8, and any type other than `.md`, `.markdown` or `.txt` (SR-4, SR-6, AC-2).
  - Only the name, size and provenance come back; the text never does (SR-2).
  - Error -32009 is shown with its reason, lines and rule id, checked to the contract's shape. An engine before v1.4 is reported as `document_unsupported`.
  - It shows `source_confirmation` items fenced and labels question types.
- `SKILL.md`:
  - New "Start from a document" path, with the sensitive-data notice (SR-11).
  - Provenance comes only from the owner's pick (SR-14), and the skill never reads the document (SR-2).
  - New "Source confirmation" step.
- Plugin version 0.4.0.

### Other
- `onboard-repo`:
  - The template and `factory_check.py` carry the two new write denies.
  - The acceptance test's copy of the contract list is updated.
- `agents/requirements-analyst/AGENT.md` (H-0108) was merged with PR #29.

## Gate 2 fixes (`F-009-security-gate2.md`)
- H1: the hidden-content check no longer trusts code spans or fences, and covers entities and plain text.
- H2: the client refuses any mix of two leading slashes or backslashes and the `\??\` prefix.
- M1: the invisible-character set now covers all format, private-use, unassigned and surrogate code points, plus the fillers and variation selectors.
- L1: readiness check `source_unchanged` confirms the branch copy of the document still matches the stored blob.
- L2: the client also runs the UNC check on the real path, after every link on the way.
- Test defect E-2 (acceptance tests) fixed.
- L3: closed by the capability list (owner decision 2026-11-12).
- M2: SR-8 extended by the owner (2026-11-12). `hiddenLinkLines` refuses link reference definitions with a title (on the same or the next line) or that no link uses, and links or images with empty text, in code and plain text too, as for H1.
- Open: M3 (what the source confirmation binds), waiting on an owner decision.

## Repo documents
A document inside the owner's repo is named by its repo path and read from the working copy, uncommitted edits included (owner decision, spec v8). A path that leaves the repo gets the same local checks as any other path. Covered by `test_a_requirements_document_in_the_repo_itself_by_its_repo_path`.

## Tests
- Engine: `test/document.test.ts` (new, 22 tests) plus updated agent and gitleaks tests. Full run: 508 passed, 14 skipped (the real-Docker and real-Claude files, as before); typecheck and build clean.
- Client: `tests/test_document_f009.py` (new, 14 tests). Full spec-interview suite: 381 passed. onboard-repo suite: 318 passed, 1 skipped.
- Docs checks and placeholder check pass.

## Interpretations and deviations
1. **Capability, not version.** The engine still reports channel 1.2, because it doesn't serve v1.3's advisor. The owner chose a capability list (2026-11-12): engine.json and `engine.status` carry `capabilities: ["document"]`, and the client refuses a document before reading it when the list lacks `"document"`. This closes Gate 2 L3 and fixes DOC-7 and C-1. A -32602 from an engine that lists the capability but refuses the key is still reported as `document_unsupported`.
2. **Hidden Markdown.** "Raw HTML" follows CommonMark: a tag name must follow `<` directly, so `a < b` is text. After Gate 2 (H1), HTML comments, tags, declarations, processing instructions and entities that decode to invisible characters are refused everywhere, inside code and in plain text documents too, because the tracking of code spans could be fooled and a plain text file can still be rendered as Markdown.
3. **Secret refusals.** A document holding a secret gets -32009 `secret`, with lines and rule, and no Security item. The document never left the owner's machine, unlike a secret in a request, which keeps H-0084's -32008 and Security item.
4. **Status words.** A confirmed source list is `approved` and a reopened one is `rejected`, reusing the contract's status values rather than adding new ones.

## Known issues
- SR-13 (budget check at start) deferred to Alpha by the owner, 2026-11-12. Until then the 256 KiB cap is the only size guard.
- **Existing project manifests.** Under Role policy v2.6, existing manifests must add `docs/features/*-source.md` and `docs/features/*-source.txt` to every outside writer's `write.deny`. Without them the engine refuses the project. This includes the e2e trial config repo.
- The plugin's Python tests aren't run by GitHub CI, as before this feature. They were run here on Linux. The Windows checks in `tests/windows` weren't run.
