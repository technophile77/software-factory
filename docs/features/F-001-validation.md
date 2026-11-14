# F-001 Validation report

- **Feature:** F-001 Decision inbox in VS Code, spec v2 (v2.1 evidence rule for AC-7)
- **Judge:** validation-judge
- **Date:** 2026-11-09
- **Commit:** `506a891` (`feature/F-001-decision-inbox`, diff `origin/main...HEAD`, `origin/main` = `410e454`)
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Blocking finding or a Not met line still fails.
- **Verdict:** **PASS**
  - Every checklist line is Met. B1 from the last report is fixed. No Blocking findings.
  - 2 Major findings are open and logged (M2, M3). Both count against promotion to Alpha.
  - Replaces the FAIL report on `c6db459`.

## My own run (evidence source)

On `506a891`, in `extension/` and then at the repo root:

| Step | Result |
|---|---|
| `npm ci` | Installed from the lockfile; 0 vulnerabilities |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities, exit 0 (a full `npm audit` is also 0) |
| `npm run typecheck` | `tsc --noEmit`, 0 errors |
| `npm run build` | `dist/extension.js` built (522.3 kb) |
| `npm test` | 7 files; **151 passed**, 0 failed, 0 skipped |
| `python3 scripts/check_docs.py` | "All docs checks passed.", exit 0 |

The working tree stayed clean after the run.

I repeated the real-git scratch check outside the repo. It drove `performAction` from `src/core/store.ts` against a real `git` repo, with `GIT_LITERAL_PATHSPECS=1` as `extension.ts` sets it:
- Defer, restore and approve each made exactly one commit: `D-0001: deferred`, `D-0001: restored`, `D-0001: approved`. Each touched only `inbox/decision/D-0001.md`.
- An agent's staged change to `D-0002.md` stayed staged and was not swept into any commit.
- The unknown field `custom_x` and the body survived all three writes.

The test report's final commit is `9467e21`. `git diff 9467e21 506a891 -- extension/` is empty, so its 151 of 151 covers the code at HEAD. My run gives the same count.

Test ids below are vitest names from this run, shown as `file > test`.

## Claims checked

| Claim | What I found |
|---|---|
| Change-controlled edits removed from the feature | `git diff origin/main...HEAD` touches nothing under `scripts/`, `.github/`, `agents/`, `skills/`, `workflows/`, or `CLAUDE.md`. Commit `b8030ac` reverts both files on the branch |
| H-0001 and H-0002 approved and merged | PR #4 was merged by the owner (`technophile77`) on 2026-11-09. Its body has all 8 fields for each item. Each item is in its own commits on `main`: `70ada4d` (H-0001), `9be4d70` and `7733c78` (H-0002), each naming its id |
| H-0003 set the contracts to Approved | `e65d737` and `e42de89` in PR #4. `docs/interface-contracts.md:8-10,27` now read Approved |
| Spec v2 approved by the owner | Spec status `Approved (owner, 2026-11-09)` (`F-001-decision-inbox.md:4`), change log `:99`. The owner chose "Approve" on the spec decision card in the project thread |
| AC-7 accepted by inspection; integration test before Alpha | The owner chose "Code check now, real test by Alpha" on the decision card. It is recorded as spec v2.1 (`F-001-decision-inbox.md:52,100`) and in the test report (`F-001-test-report.md:25,32,41-42`) |
| Test report re-issued for the final code | `F-001-test-report.md:5`: 151 of 151 on `9467e21`. The code is identical at HEAD (see above) |
| ADR 0009 row in `docs/architecture.md` | Added in `d4d2bbf` together with ADR 0009. The owner chose "Dedicated factory/state branch" on the decision card (A-2) |
| Fixes M2, API.md, placeholder, `isWithin`, Windows case, timezone sort | Checked below, finding by finding |

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | Code: `src/core/item.ts:44-110`, `src/core/store.ts:11-43`. Tests: `item.test > FR-1: parses a valid decision item with every contract field`; `store.test > FR-1: reads every .md item and ignores non-.md files` |
| FR-2 | Met | Code: `src/core/queue.ts:5-29,43-48`, `src/extension.ts:70-79`. Tests: `queue.test > FR-2: open / deferred / decided groups; changes and research requested count as open`; `queue.test > FR-2: same priority sorts by age, oldest first`; `core.test > compares creation times as instants across offsets` |
| FR-3 | Met (see m1) | Code: `src/core/queue.ts:31-35`, badge at `src/extension.ts:126-127`, marker at `src/extension.ts:92-96`. Test: `queue.test > AC-2: an open blocking item is counted`. The marker is checked by inspection only (m15) |
| FR-4 | Met | Code: `src/core/render.ts:8-97`. Tests: `render.test > AC-9: shows the title` … `AC-9: shows the cost of delay` (one test per field) |
| FR-5 | Met | Code: `src/core/actions.ts:6-62`, buttons at `src/core/render.ts:29-38`. Tests: `actions.test > FR-5: reject sets rejected and appends a rejected history entry with optional note`; `store.test > FR-5: performAction on an approved item is refused with no git call` |
| FR-6 | Met | Code: `src/core/actions.ts:16-22,32-41`. Tests: `actions.test > AC-3: approve without an option on an item with options is refused with a message`; `actions.test > FR-6: request_changes with an empty note is refused`; `actions.test > FR-6: request_research with an empty note is refused` |
| FR-7 | Met | Code: `src/core/actions.ts:42-56`. Tests: `actions.test > FR-7: defer lowers exactly one step for each priority; low stays low`; `actions.test > AC-5: restoring a deferred item sets effective priority back to priority and status open` |
| FR-8 | Met | Code: `src/core/store.ts:62-77`, `src/core/actions.ts:59-60`. Tests: `actions.test > FR-8: every action appends exactly one entry and leaves earlier entries untouched`; `store.test > AC-6: approve creates exactly one commit, message starts with the id, only that file`. Also confirmed by the real-git scratch run |
| FR-9 | Met (by inspection; owner decision, spec v2.1) | Code: `src/extension.ts:194-208`. The watcher on `**/.factory/inbox/decision/*.md` triggers a debounced reload after 200 ms. No automated test until the integration harness (M3) |
| FR-10 | Met | Code: `src/core/store.ts:25-39`, error nodes at `src/extension.ts:74,100-107`. Tests: `store.test > AC-8: invalid frontmatter is listed as an error with the file name; valid items still load`; `core.test > lists a misnamed file and an unreadable entry as errors without hiding valid items` |
| FR-11 | Met (see m14) | Code: `src/core/links.ts:6-36`, `src/extension.ts:188-192`. Tests: `links.test > FR-11: a file ref inside the repo resolves to its absolute path`; `links.test > SR-3: an https URL resolves to a url link` |
| FR-12 | Met | Code: `src/core/store.ts:14-41`, label at `src/extension.ts:91`, card label at `src/core/render.ts:60`. Tests: `store.test > AC-10: two repos each with an open item appear in one list, sorted together, labeled by repo`; `render.test > FR-12: card is labeled with its repo` |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | `queue.test > AC-1: three open items low, high, critical appear critical, high, low`; `store.test > AC-1: open items low, high, critical load and order as critical, high, low` |
| AC-2 | Met | Badge count: `queue.test > AC-2: an open blocking item is counted` and `store.test > AC-2: an open blocking item on disk is counted for the badge`. Marker: inspected at `src/extension.ts:92-96`, which shows a red `error` icon and the tooltip "Blocks work". The owner accepted inspection for the marker until Alpha (spec v2.1) |
| AC-3 | Met | `actions.test > AC-3: approve without an option on an item with options is refused with a message`; `actions.test > AC-3: a refused action leaves the item unchanged` |
| AC-4 | Met | `actions.test > AC-4: deferring a high blocking item gives effective medium, blocking still true, a deferred history entry`; `store.test > AC-4: deferred high blocking item is still listed, effective medium, blocking true, history deferred` |
| AC-5 | Met | `actions.test > AC-5: restoring a deferred item sets effective priority back to priority and status open`; `store.test > AC-5: restore on disk sets effective priority back to priority` |
| AC-6 | Met | `store.test > AC-6: approve / reject / request_changes / request_research / defer creates exactly one commit, message starts with the id, only that file`; `store.test > AC-6: restore on a deferred item creates exactly one commit`. The tests use a fake git; the real-git scratch run confirms the same behavior |
| AC-7 | Met (owner-accepted evidence) | No automated test. The owner decided on 2026-11-09 that code inspection is enough at Rapid prototype (spec v2.1, `F-001-decision-inbox.md:52`). Inspection: a file watcher plus a 200 ms debounce (`src/extension.ts:194-203`), well inside the 2-second bound. A `@vscode/test-electron` test is required before Alpha (M3) |
| AC-8 | Met | `store.test > AC-8: invalid frontmatter is listed as an error with the file name; valid items still load`; `item.test > AC-8: invalid YAML is an error naming the path` |
| AC-9 | Met | `render.test > AC-9: shows the title`, `…category`, `…priority`, `…status`, `…blocking`, `…the Context section`, `…options with pros and cons`, `…the project impact`, `…the recommendation`, `…the cost of delay` |
| AC-10 | Met | `store.test > AC-10: two repos each with an open item appear in one list, sorted together, labeled by repo`; `queue.test > AC-10: items from two repos sort together by priority, repo label kept` |
| AC-11 | Met | `links.test > AC-11: ../../secret is refused with a message`; `…sibling…`; `…absolute path…`; `…symlink inside the repo that points outside is refused (real path check)` |
| AC-12 | Met | `render.test > AC-12: a <script> in the body does not appear as a live script tag`; `…onerror attribute…`; `…the dangerous text is shown inert (escaped), not dropped` |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met | Code: `src/core/render.ts:6,44`, `src/extension.ts:137-140` (`localResourceRoots: []`). Tests: `render.test > SR-1: has a CSP meta tag with default-src 'none' and nonce-only scripts and styles`; `render.test > SR-1: no remote resources are referenced`; `render.test > SR-1: HTML in frontmatter fields (title, option labels) is escaped too` |
| SR-2 | Met (by inspection; owner decision, spec v2.1) | I listed every call that opens, runs, or writes again. `openExternal` and `vscode.open` are reached only through `follow()` (`src/extension.ts:188-192`). `follow()` is called only from webview messages (`:144-158`), and those are posted only from `click` handlers (`src/core/render.ts:76-93`). Git runs only from `act()` (`:161-186`), on a button-click message. The error-node `vscode.open` (`:105`) opens the malformed item file itself, on a tree click. Body script can't post messages because of the nonce CSP (SR-1, tested). Nothing runs on load or refresh |
| SR-3 | Met | Code: `src/core/links.ts:6-36`, `src/core/git.ts:30-33`. Tests: `links.test > SR-3: http://example.com/ is refused`, `…javascript:alert(1)…`, `…file:///etc/passwd…`, `…command:workbench.action.terminal.new…`, `…unknown kind with a ref escaping the repo is refused`; `core.test > treats names starting with .. as inside` |
| SR-4 | Met | Code: `src/core/item.ts:4,66`, `src/core/store.ts:57-60,69-70`, `src/extension.ts:26-36` (`execFile`, absolute git path, no shell), `src/core/git.ts:9-28`. Tests: `item.test > SR-4: isValidItemId rejects invalid ids`; `store.test > AC-6 / SR-4: commit message is passed as one argument, not shell-quoted`; `store.test > SR-4: a file whose id becomes invalid on disk is refused before any git call`; `core.test > skips PATH entries inside a workspace folder, case-insensitively on Windows`; `core.test > skips relative PATH entries` |
| SR-5 | Met | Code: `src/core/store.ts:81-85`, `src/core/item.ts:83-87,112-121`. Tests: `store.test > SR-5: unknown frontmatter fields survive an action on disk`; `store.test > SR-5: no temp files are left in the inbox folder after a write`; `core.test > keeps a __proto__ frontmatter key through a round trip` |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD item 1) | Met | Status `Approved (owner, 2026-11-09)` (`F-001-decision-inbox.md:4`). The v2 change log names the owner as approver (`:99`), and v2.1 changes no requirement (`:100`). I matched both to the owner's choices on the decision cards in the project thread. Assumptions A-1 to A-3 are approved (`:71-73`) |
| Architecture / ADRs | Met | No unapproved change-controlled edit. The feature diff against `main` changes `docs/` outside `docs/features/` only to record owner-approved Architecture decisions: ADR 0009 (A-2 card) and ADR 0011 (library card), their index rows in `docs/adr/README.md`, and the ADR 0009 row in `docs/architecture.md`. `decision-management.md` says approved Architecture decisions become ADRs, and `main` records ADRs the same way (for example ADR 0010 in `8704165`). The root `.gitignore` is new (m20). ADR 0002 and 0009 are followed: items are under `.factory/inbox/decision/`, with one commit per action in the `factory/state` worktree. ADR 0003 is followed: TypeScript, a tree view, and a webview (one panel per item is m6). ADR 0008: the extension CI is on `main` via H-0002. ADR 0011 is followed: `markdown-it` 14.3.3 and `yaml` 2.9.1, exact pins, lockfile committed, `html: false`, audit clean. `@vscode/test-electron` is approved but not installed yet (M3) |
| Interface contract (Inbox item v1.0) | Met | The contract is Approved (`docs/interface-contracts.md:8-10,27`; PR #2, recorded by H-0003). The feature makes no diff to `interface-contracts.md`. The contract round-trip tests pass (`item.test > Round trip: parse → serialize → parse is stable for a file as agents write it` and three others). Link `kind` values are still undefined (m14) |
| Code quality, readability, maintainability | Met | `src/core/` is small, pure, and free of VS Code imports. The git lookup has moved into `src/core/git.ts`, where it is tested. `applyAction` doesn't mutate its input. Minor findings: m3, m4, m5, m9, m11, m17, m19 |
| Comments | Met | New comments explain why: `git.ts:3-8`, `queue.ts:42`. Older ones still hold: `item.ts:17-18,77-78,83`, `actions.ts:43-44`, `queue.ts:37`, `store.ts:27,31,52,72-73`, `extension.ts:22-25,146,195`. One comment props up a placeholder (`actions.ts:12`, m3). The only outdated prose is in the Code Review report's follow-up (m18) |
| Documentation | Met | The spec names no required docs. `extension/README.md` and `src/core/API.md` are present, and `API.md` now matches the code (m2 fixed). ADR 0009 and ADR 0011 are recorded and indexed. There is a small drift in m13 |
| Security | Met | The Security and Testability Review and Code Review reports are present, and Code Review found nothing that blocks at this level. The Code Review fixes 1, 2, 3, 6, 8, 9 and 12 are in place by inspection. Fix 1 (git lookup) is now unit-tested, including the Windows case. Fix 4 is now done properly through PR #4. The fix for 5 is ADR 0011. Known issues 7, 10, 11 and 13 remain (m16). The new `git.ts` has had no security re-review (M2) |

## Findings

### Blocking

None.

| # | Status | Finding |
|---|---|---|
| B1 | **Fixed** | Change-controlled edits to `scripts/check_docs.py` and `.github/workflows/extension.yml` inside the feature. They were reverted on the branch (`b8030ac`), then filed as H-0001 and H-0002 with all 8 fields. Each was committed on its own with its id, and the owner approved them by merging PR #4. The feature diff no longer touches either file |

### Major (allowed at Rapid prototype; logged)

| # | Status | Location | Finding |
|---|---|---|---|
| M1 | **Fixed** | `docs/features/F-001-test-report.md:5` | The test report now covers `9467e21`, whose `extension/` is identical to HEAD: 151 of 151, matching my run. |
| M2 | Open (partly fixed) | `src/extension.ts:26-36,38-49`; `src/core/types.ts:100`; `src/core/git.ts` | The PATH search is now a pure, tested function (`findGitOnPath`), and `API.md` states that the `GitRunner` must use an absolute path and literal pathspecs. Still open: `GIT_LITERAL_PATHSPECS` is set only in `makeGit` in the untested glue, and the `GitRunner` type doesn't enforce it, so another caller of `performAction` could bring Code Review #2 back. The `vscode.git` branch of `findGit` is untested. The post-Code-Review security code, including the new `git.ts`, has had no security re-review. |
| M3 | Open (accepted by the owner until Alpha) | `extension/package.json:61-73` | There is no integration test harness, so AC-7, FR-9, SR-2 and the AC-2 marker have no host-level evidence. The owner accepted inspection at this level and made a `@vscode/test-electron` test a requirement before Alpha (spec v2.1). |

### Minor (logged; never block)

| # | Status | Location | Finding |
|---|---|---|---|
| m1 | Open | `src/core/queue.ts:31-35` | The badge counts `deferred`, `changes_requested` and `research_requested` blocking items, while the "Open" group leaves deferred items out. `API.md` now documents this, but the spec is still ambiguous about "open blocking items". Raise it with the owner. |
| m2 | **Fixed** | `src/core/API.md:13,17-19` | `countOpenBlocking` and `performAction` now match the code, and `git.ts` is listed. |
| m3 | Open (partly) | `src/core/actions.ts:12-13` | The placeholder history action is now `"filed"`, with a comment saying each case sets it. It is still a placeholder held up by a comment. Setting the action per branch, or building the entry after the switch, would remove both. |
| m4 | Open | `src/extension.ts:85` | The collapse state is decided by checking whether the label starts with `"Decided"`. This breaks silently if the label changes. |
| m5 | Open | `src/extension.ts:128-131` | Every refresh rebuilds each open card's HTML, which clears a note the owner is typing. A panel for an item that was deleted or renamed keeps showing stale content. |
| m6 | Open | `src/extension.ts:117,134-143` | The extension opens one webview panel per item, while spec §5 and ADR 0003 say "tree view + one webview". |
| m7 | **Fixed** | `src/core/git.ts:30-33` | There is one containment helper now, and it treats `..notes.md` as inside (`core.test > treats names starting with .. as inside`). |
| m8 | **Fixed** | `src/core/git.ts:16-22` | Workspace folders are compared case-insensitively on Windows, with a test. |
| m9 | Open | `src/core/store.ts:17-21` | Any `readdir` failure is treated as "no inbox", so `EACCES` reads as "No decisions waiting." A symlinked `decision/` folder is still followed. |
| m10 | **Fixed** | `src/core/queue.ts:9,42-48` | Ages are compared as instants, with a test across offsets. See m17 for an edge left over. |
| m11 | Open | `src/core/item.ts:72`; `src/core/store.ts:35-39` | `category` is optional even for decision items, and `loadInbox` doesn't check `item.inbox === "decision"`. |
| m12 | **Fixed** | `.github/workflows/extension.yml` (on `main`, H-0002) | CI now runs `npm audit --omit=dev --audit-level=high`. Tag pinning is tracked under m16 (Code Review #13). |
| m13 | Open (partly) | `docs/architecture.md:44`; `docs/adr/0011-inbox-extension-libraries.md:3-5` | The root `.gitignore` entry for `.factory/` is fixed. `architecture.md` still lists ADR 0009 but not ADR 0011. ADR 0011 still names no decision item. I traced the approval to the owner's library card in the project thread, but the ADR itself doesn't point there. |
| m14 | Open | `src/core/links.ts:6-36`; `docs/interface-contracts.md:61-63` | FR-11 "diff" links open only as files. The contract defines no link `kind` values; the test report lists this as open for the owner. |
| m15 | Open (accepted by the owner until Alpha) | `src/extension.ts:92-96` | The AC-2 blocking marker and SR-2 are verified by inspection only. Covered by the before-Alpha requirement in M3. |
| m16 | Open | Code Review #7, #10, #11, #13 | Known Low security issues: a link to a missing target through a symlinked directory, body link text that doesn't match its target, gaps in the atomic write and rollback, and actions pinned by tag. They count against promotion to Alpha. |
| m17 | New | `src/core/queue.ts:43-48`; `src/core/item.ts:61` | `created_at` is required but its format isn't checked. If one timestamp parses and another doesn't, `byTime` falls back to comparing text for that pair only. The comparator is then not consistent, so sort order can depend on input order. Validate `created_at` when parsing, or sort unparseable values last. |
| m18 | New | `docs/features/F-001-code-review.md:69` | The follow-up row for Code Review #4 still says that merging the feature PR approves the hygiene items. That is no longer true: they went through PR #4. |
| m19 | New | `src/core/git.ts:30-33`; `src/core/links.ts:3` | `isWithin` is a general path helper, but it lives in the git module, so `links.ts` imports path logic from `./git`. A small `paths.ts` would read better. |
| m20 | New | `.gitignore` (commit `b8030ac`) | The feature adds a root `.gitignore` with `.factory/`. It is not on the `CLAUDE.md` rule 3 list, and it carries out ADR 0009 ("git-ignored on `main`"), so I don't count it as a change-controlled edit. The PR should name it so the owner sees it. |

## Counts

- Major: 2 open (M2, M3) and 1 fixed (M1).
- Minor: 15 open (m1, m3, m4, m5, m6, m9, m11, m13 to m20) and 5 fixed (m2, m7, m8, m10, m12).

## Before Alpha

PASS here doesn't carry over to Alpha. At Alpha, at most 3 Major findings are allowed, and Critical and High security issues block. Before F-001 can count toward promotion:
1. Add the `@vscode/test-electron` harness covering AC-7, FR-9, SR-2 and the AC-2 marker (M3, m15, owner decision).
2. Close M2. Test `makeGit` and the `vscode.git` lookup, or make literal pathspecs part of the `GitRunner` contract, and get a security re-review of the post-Code-Review code.
3. Fix or accept the Code Review known issues (m16), and get the owner's answer on m1 and m14.
