# F-001 Validation report

- **Feature:** F-001 Decision inbox in VS Code, spec v2
- **Judge:** validation-judge
- **Date:** 2026-11-09
- **Commit:** `c6db459` (`feature/F-001-decision-inbox`, diff `origin/main...HEAD`)
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Blocking finding or a Not met line still fails.
- **Verdict:** **FAIL**
  - The Architecture line is **Not met**, and finding B1 is Blocking. Change-controlled files were edited and committed without approval, which goes against ADR 0008 and `CLAUDE.md` rule 3.
  - Three lines also need the owner: the spec is not approved, the Inbox item v1.0 contract is not approved, and AC-7 has no evidence. Those three alone would make the verdict NEEDS HUMAN REVIEW.

## My own run (evidence source)

`cd extension && npm ci --no-audit --no-fund && npx tsc --noEmit && npm run build && npx vitest run && npm audit` on `c6db459`:

| Step | Result |
|---|---|
| `npm ci` | 54 packages installed |
| `tsc --noEmit` | 0 errors |
| `npm run build` | `dist/extension.js` built (521.9 kb) |
| `vitest run` | 7 files; **146 passed**, 0 failed, 0 skipped |
| `npm audit` | 0 vulnerabilities |

I also ran a scratch check outside the repo. It drove `performAction` against a real `git` repo, with `GIT_LITERAL_PATHSPECS=1` as `extension.ts` sets it:
- Defer and approve each made exactly one commit. Each message was `D-0001: deferred` or `D-0001: approved`, and each commit touched only `inbox/decision/D-0001.md`.
- An unrelated change to `D-0002.md` that an agent had staged stayed staged and was not swept into either commit.
- The unknown field `custom_x` and the body survived both writes.

Test ids below are vitest names from this run, shown as `file > test`.

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | Code: `src/core/item.ts:44-110`, `src/core/store.ts:11-43`. Tests: `item.test > FR-1: parses a valid decision item with every contract field`; `store.test > FR-1: reads every .md item and ignores non-.md files` |
| FR-2 | Met | Code: `src/core/queue.ts:5-29`, `src/extension.ts:79-88`. Tests: `queue.test > FR-2: open / deferred / decided groups; changes and research requested count as open`; `queue.test > FR-2: same priority sorts by age, oldest first` |
| FR-3 | Met (see m1) | Code: `src/core/queue.ts:31-35`, badge at `src/extension.ts:135-136`, marker at `src/extension.ts:101-105`. Test: `queue.test > AC-2: an open blocking item is counted`. The marker is checked by inspection only |
| FR-4 | Met | Code: `src/core/render.ts:8-97`. Tests: `render.test > AC-9: shows the title` … `AC-9: shows the cost of delay` (one test per field) |
| FR-5 | Met | Code: `src/core/actions.ts:6-61`, buttons at `src/core/render.ts:29-38`. Tests: `actions.test > FR-5: reject sets rejected and appends a rejected history entry with optional note`; `store.test > FR-5: performAction on an approved item is refused with no git call` |
| FR-6 | Met | Code: `src/core/actions.ts:15-21,31-40`. Tests: `actions.test > AC-3: approve without an option on an item with options is refused with a message`; `actions.test > FR-6: request_changes with an empty note is refused`; `actions.test > FR-6: request_research with an empty note is refused` |
| FR-7 | Met | Code: `src/core/actions.ts:41-55`. Tests: `actions.test > FR-7: defer lowers exactly one step for each priority; low stays low`; `actions.test > AC-5: restoring a deferred item sets effective priority back to priority and status open` |
| FR-8 | Met | Code: `src/core/store.ts:62-78`, `src/core/actions.ts:58-59`. Tests: `actions.test > FR-8: every action appends exactly one entry and leaves earlier entries untouched`; `store.test > AC-6: approve creates exactly one commit, message starts with the id, only that file`. Also confirmed by the real-git scratch run |
| FR-9 | Met (by inspection; see AC-7) | Code: `src/extension.ts:203-217`. The watcher on `**/.factory/inbox/decision/*.md` triggers a debounced reload after 200 ms. No automated test |
| FR-10 | Met | Code: `src/core/store.ts:25-39`, error nodes at `src/extension.ts:83,109-116`. Tests: `store.test > AC-8: invalid frontmatter is listed as an error with the file name; valid items still load`; `core.test > lists a misnamed file and an unreadable entry as errors without hiding valid items` |
| FR-11 | Met (see m14) | Code: `src/core/links.ts:5-35`, `src/extension.ts:197-201`. Tests: `links.test > FR-11: a file ref inside the repo resolves to its absolute path`; `links.test > SR-3: an https URL resolves to a url link` |
| FR-12 | Met | Code: `src/core/store.ts:14-41`, label at `src/extension.ts:100`, card label at `src/core/render.ts:60`. Tests: `store.test > AC-10: two repos each with an open item appear in one list, sorted together, labeled by repo`; `render.test > FR-12: card is labeled with its repo` |

### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | `queue.test > AC-1: three open items low, high, critical appear critical, high, low`; `store.test > AC-1: open items low, high, critical load and order as critical, high, low` |
| AC-2 | Met | Badge count: `queue.test > AC-2: an open blocking item is counted` and `store.test > AC-2: an open blocking item on disk is counted for the badge`. Marker: inspected at `src/extension.ts:101-105`, which shows a red `error` icon and the tooltip "Blocks work". Not automated (m15) |
| AC-3 | Met | `actions.test > AC-3: approve without an option on an item with options is refused with a message`; `actions.test > AC-3: a refused action leaves the item unchanged` |
| AC-4 | Met | `actions.test > AC-4: deferring a high blocking item gives effective medium, blocking still true, a deferred history entry`; `store.test > AC-4: deferred high blocking item is still listed, effective medium, blocking true, history deferred` |
| AC-5 | Met | `actions.test > AC-5: restoring a deferred item sets effective priority back to priority and status open`; `store.test > AC-5: restore on disk sets effective priority back to priority` |
| AC-6 | Met | `store.test > AC-6: approve / reject / request_changes / request_research / defer creates exactly one commit, message starts with the id, only that file`; `store.test > AC-6: restore on a deferred item creates exactly one commit`. The tests use a fake git; the real-git scratch run confirms the same behavior |
| AC-7 | **Needs owner** | No passing test, and no recorded result for the "manual check" named in the test report. By inspection the design looks right: a file watcher plus a 200 ms debounce (`src/extension.ts:203-212`). The 2-second bound and whether the watcher fires inside the `.factory/` worktree are runtime behavior that inspection can't prove. ADR 0003 and ADR 0011 name `@vscode/test-electron` for integration tests, but it is not installed. Owner's choice: accept inspection at Rapid prototype, ask for a recorded manual check, or require a test-electron test |
| AC-8 | Met | `store.test > AC-8: invalid frontmatter is listed as an error with the file name; valid items still load`; `item.test > AC-8: invalid YAML is an error naming the path` |
| AC-9 | Met | `render.test > AC-9: shows the title`, `…category`, `…priority`, `…status`, `…blocking`, `…the Context section`, `…options with pros and cons`, `…the project impact`, `…the recommendation`, `…the cost of delay` |
| AC-10 | Met | `store.test > AC-10: two repos each with an open item appear in one list, sorted together, labeled by repo`; `queue.test > AC-10: items from two repos sort together by priority, repo label kept` |
| AC-11 | Met | `links.test > AC-11: ../../secret is refused with a message`; `…sibling…`; `…absolute path…`; `…symlink inside the repo that points outside is refused (real path check)` |
| AC-12 | Met | `render.test > AC-12: a <script> in the body does not appear as a live script tag`; `…onerror attribute…`; `…the dangerous text is shown inert (escaped), not dropped` |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met | Code: `src/core/render.ts:6,44`, `src/extension.ts:146-149` (`localResourceRoots: []`). Tests: `render.test > SR-1: has a CSP meta tag with default-src 'none' and nonce-only scripts and styles`; `render.test > SR-1: no remote resources are referenced`; `render.test > SR-1: HTML in frontmatter fields (title, option labels) is escaped too` |
| SR-2 | Met (by inspection) | I listed every call that opens, runs, or writes. `openExternal` and `vscode.open` are reached only through `follow()` (`src/extension.ts:197-201`). `follow()` is called only from webview messages (`:159-166`), and those messages are posted only from `click` handlers (`src/core/render.ts:76-93`). Git runs only from `act()` (`:170-195`), which a button-click message triggers. The error-node `vscode.open` (`:114`) opens the malformed item file itself, on a tree click. Body script can't post messages because of the nonce CSP (SR-1, tested). Nothing runs on load or refresh. Inspection is enough here because the property is "no call path without a user event", and that path list is complete. A host test would add little |
| SR-3 | Met | Code: `src/core/links.ts:5-35`. Tests: `links.test > SR-3: http://example.com/ is refused`, `…javascript:alert(1)…`, `…file:///etc/passwd…`, `…command:workbench.action.terminal.new…`, `…unknown kind with a ref escaping the repo is refused` |
| SR-4 | Met | Code: `src/core/item.ts:4,66`, `src/core/store.ts:57-60,69-70`, `src/extension.ts:25-35` (`execFile`, absolute git path, no shell). Tests: `item.test > SR-4: isValidItemId rejects invalid ids`; `store.test > AC-6 / SR-4: commit message is passed as one argument, not shell-quoted`; `store.test > SR-4: a file whose id becomes invalid on disk is refused before any git call` |
| SR-5 | Met | Code: `src/core/store.ts:81-85`, `src/core/item.ts:83-87,112-121`. Tests: `store.test > SR-5: unknown frontmatter fields survive an action on disk`; `store.test > SR-5: no temp files are left in the inbox folder after a write`; `core.test > keeps a __proto__ frontmatter key through a round trip` |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD item 1) | **Needs owner** | The spec status is "In review (readiness gate passed; awaiting owner approval)" (`F-001-decision-inbox.md:4`). The v2 change log has no approver (`:97`). Definition of done item 1 needs status `Approved`, with the approval recorded |
| Architecture / ADRs | **Not met** | ADR 0008 (`docs/adr/0008-ci-required-gate-by-maturity.md:27`) makes `.github/workflows/` change-controlled. `CLAUDE.md` rule 3 does the same for `scripts/`. Both were changed with no approval and no approved exception cited (B1). Other ADRs: ADR 0002 and 0009 are followed (items under `.factory/inbox/decision/`, one commit per action in the `factory/state` worktree). ADR 0003 is followed: TypeScript, a tree view, and a webview; one panel per item is m6. ADR 0011 is followed for dependencies (`markdown-it` 14.3.3, `yaml` 2.9.1, exact pins, lockfile committed, `html: false`) |
| Interface contract (Inbox item v1.0) | **Needs owner** | No diff to `docs/interface-contracts.md`. The contract round-trip tests pass (`item.test > Round trip: parse → serialize → parse is stable for a file as agents write it`). But the contract is still **Proposed**, not approved (`docs/interface-contracts.md:8,27`), and is listed as awaiting owner approval in `docs/open-decisions.md:35-38`. The feature is built on an open Interfaces decision. The undefined link `kind` values (m14) belong to the same decision |
| Code quality, readability, maintainability | Met | `src/core/` is small, pure, and free of VS Code imports. `applyAction` doesn't mutate its input. Minor findings: m3, m4, m5, m7, m9, m10, m11 |
| Comments | Met | Comments explain why, for example `item.ts:17-18,77-78,83`, `actions.ts:42-43`, `queue.ts:37`, `store.ts:27,31,52,72-73`, and `extension.ts:21-24,155,204`. I found no redundant, crutch, or misleading comments. The only outdated prose is in `API.md` (m2) |
| Documentation | Met | The spec names no required docs. `extension/README.md` and `src/core/API.md` are added, and ADR 0009 and ADR 0011 are recorded and indexed in `docs/adr/README.md`. There is drift in m2 and m13 |
| Security | Met | The Gate 1 and Gate 2 reports are present. Gate 2 found nothing that blocks at this level. I checked the Gate 2 fixes 1, 2, 3, 6, 8, 9 and 12 by inspection and they are in place. Known issues 7, 10, 11 and 13 remain (m16). Fix verification was the orchestrator's, with no security re-review (M2) |

## Findings

### Blocking

| # | Location | Finding |
|---|---|---|
| B1 | `scripts/check_docs.py:17-19,22,32`; `.github/workflows/extension.yml:1-26` (commit `c1b7b4b`) | **Change-controlled files were edited without approval.** Both paths are change-controlled under `CLAUDE.md` rule 3, and ADR 0008 covers the workflow. Both were committed inside the feature commit with no Configuration hygiene item. `docs/decision-management.md:43-56` says "No change is applied before approval" and "On approval the change is committed on its own, with the item's id". The Gate 2 follow-up says the PR will present them as hygiene items so that "merging approves them". That route doesn't exist in the decision rules, and it can't meet the "committed on its own" rule. The changes themselves look harmless. Needed: file one hygiene item for each file, with all 8 fields. Move both changes out of the feature commit, and commit each one separately once the owner approves it. |

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `docs/features/F-001-test-report.md:5` | The test run report doesn't match the final commit. It reports 144 tests; `c6db459` has 146, because 2 developer tests were added with the Gate 2 fixes. No test-engineer run against the final commit is recorded, which definition of done item 5 requires. This verdict uses my own run instead. |
| M2 | `src/extension.ts:31,37-58,128-134,157-166`; `src/core/store.ts:69-70` | The Gate 2 hardening in the VS Code glue has no tests and no security re-review. That covers the absolute git path, `GIT_LITERAL_PATHSPECS`, the refresh error path, and webview message validation. Literal pathspecs (the fix for Gate 2 #2) are set only by the caller's runner. The core `GitRunner` type (`src/core/types.ts:99-100`) doesn't require them, so another caller of `performAction` would bring the glob issue back. Gate 2 asked for a test that the runner never gets a bare `git`. |
| M3 | `extension/package.json:66-73` | There is no integration test harness. ADR 0003 and ADR 0011 name `@vscode/test-electron`, but it isn't installed, so AC-7, the AC-2 marker, FR-9 and SR-2 have no host-level evidence. (This is why AC-7 is Needs owner.) |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `src/core/queue.ts:31-35` | FR-3 asks for a count of "open blocking items". The badge also counts `deferred`, `changes_requested` and `research_requested` items, while the tree's "Open" group leaves deferred items out (`queue.ts:24`). This fits spec §4.1 (deferral is not approval), but the spec is ambiguous. Raise it with the owner. |
| m2 | `src/core/API.md:13,18` | `countOpenBlocking` is documented as "Open or deferred" and leaves out the requested statuses. The `performAction` row doesn't mention the `<id>.md` name check, the rollback on git failure, or the literal-pathspec expectation. |
| m3 | `src/core/actions.ts:12` | The history entry starts with the placeholder `action: "approved"`, and every branch overwrites it. Setting it per branch would be clearer. |
| m4 | `src/extension.ts:94` | The collapse state is decided by checking whether the label starts with `"Decided"`. This breaks silently if the label changes. Carry a group key on the node instead. |
| m5 | `src/extension.ts:137-140` | Every refresh rebuilds each open card's HTML, so an agent's edit to any item clears the note or option the owner is typing. A panel for an item that was deleted or renamed keeps showing stale content. |
| m6 | `src/extension.ts:126,143-152` | The extension opens one webview panel per item, while spec §5 and ADR 0003 say "tree view + one webview". Probably within intent, but it is a deviation. |
| m7 | `src/extension.ts:226-229`; `src/core/links.ts:37-40` | Two copies of the path-containment helper. Both treat a name inside the repo that starts with `..` (for example `..notes.md`) as outside, so such links are wrongly refused. |
| m8 | `src/extension.ts:51` | The check that skips workspace folders in `PATH` is case-sensitive. On Windows, a `PATH` entry spelled with different case would not be skipped. This is left over from Gate 2 #1. |
| m9 | `src/core/store.ts:18-21` | Any `readdir` failure, such as `EACCES` or `ENOTDIR`, is treated as "no inbox", so the view says "No decisions waiting." A symlinked `decision/` folder is still followed, because `lstat` checks only the entries inside it. |
| m10 | `src/core/queue.ts:9` | Age is compared as a string. `created_at` values with different UTC offsets will sort in the wrong order. |
| m11 | `src/core/item.ts:72`; `src/core/store.ts:35-39` | `category` is optional even for decision items, though the contract says the decision inbox uses it. `loadInbox` doesn't check `item.inbox === "decision"`. |
| m12 | `.github/workflows/extension.yml:17-26` | CI doesn't run `npm audit`, which ADR 0011 requires before each PR. Actions are pinned by tag, not SHA (Gate 2 #13). |
| m13 | `docs/architecture.md:44`; `docs/adr/0011-inbox-extension-libraries.md:5`; repo root | `architecture.md` lists ADR 0009 but not ADR 0011. ADR 0011 cites no decision item id, so the owner's approval can't be traced. ADR 0009 says `.factory/` is git-ignored on `main`, but there is no root `.gitignore` entry; the README relies on `.git/info/exclude`. |
| m14 | `src/core/links.ts:5-35` | FR-11 "diff" links open only as files. The contract defines no link `kind` values; the test engineer already raised this for the owner. |
| m15 | `src/extension.ts:101-105` | The AC-2 blocking marker and SR-2 are verified by inspection only. |
| m16 | see Gate 2 #7, #10, #11, #13 | Known Low security issues are still open: link to a missing target through a symlinked directory, body link text that doesn't match its target, gaps in the atomic write and rollback, and unpinned actions. They count against promotion to Alpha. |

## What would change the verdict

1. Fix B1. File the two hygiene items, take both changes out of the feature commit, and commit each one separately after the owner approves it.
2. Owner decisions:
   - Approve spec v2.
   - Approve the Inbox item v1.0 contract, including link `kind` values.
   - Accept the evidence for AC-7, or ask for a recorded manual check or a test-electron test.
3. Re-issue the test report against the final commit (M1).

When 1 and 3 are done and the owner has made the three decisions, this feature can PASS at Rapid prototype, with M1 to M3 and m1 to m16 logged.
