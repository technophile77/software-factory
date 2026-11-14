# F-001 Test run report

- **Feature:** F-001 Decision inbox, spec v2
- **Tests written by:** test engineer, from the spec, contract, and API only
- **Result on final commit `9467e21`:** 151 run, 151 passed, 0 failed, 0 skipped (136 acceptance, 15 developer unit tests). Earlier run on `c1b7b4b`: 144 of 144.

## Orchestrator review (stage 6)
First run: 131 tests, 2 failed.

| Failure | Cause | Resolution |
|---|---|---|
| AC-8: file without `history` parsed as valid | Product code | Fixed: `history` is required |
| SR-3: link of unknown `kind` not refused | Test code: SR-3 classifies links by target, and the contract lists no kinds | Test replaced with target-based tests (unknown kind inside repo opens as a file; escaping or non-https refs refused) |

Also during review: `npm audit` found ReDoS issues in markdown-it 14.1.0 and a stack-overflow issue in yaml 2.8.1. Upgraded to markdown-it 14.3.3 and yaml 2.9.1 (same approved libraries), plus dev tools vitest 5.1.0 and esbuild 0.28.2. `npm audit` now reports 0 vulnerabilities. A git failure during an action now restores the item file, so an uncommitted change can't ride along with a later commit.

## Coverage by criterion
| Criterion | Covered by |
|---|---|
| AC-1 | queue and store sort tests, including from disk |
| AC-2 | badge count tests (marker in the tree view: by inspection; integration test required before Alpha) |
| AC-3 | approve without option / unknown option refused |
| AC-4, AC-5 | defer and restore, in memory and on disk |
| AC-6 | one commit per action, message starts with id, only that file, args not shell-quoted |
| AC-7 | Not automated (needs the VS Code host). Accepted by code inspection at Rapid prototype (owner, 2026-11-09); integration test required before Alpha |
| AC-8 | malformed files listed as errors, valid neighbours still load |
| AC-9 | one test per required card field |
| AC-10 | two repos in one queue, labeled; one repo without `.factory` |
| AC-11 | `../../secret`, sibling escape, absolute path, symlink escape |
| AC-12 | script, onerror, inline handlers, javascript: links, iframes inert |
| SR-1, SR-3, SR-4, SR-5 | CSP, link schemes, id validation, unknown-field and body preservation |
| SR-2 | Not automated (extension host): by code inspection; integration test required before Alpha |

## After Code Review and validation
Fixes for Code Review findings and the validation judge's findings added 7 developer unit tests (git lookup, time ordering, `__proto__`, misnamed and unreadable files). The independent acceptance tests were not changed and all still pass.

## Open spec ambiguities (for the owner, not blocking)
- Link `kind` values are not listed in the Inbox item contract.
- Deferring an already deferred item lowers priority again (current behavior).

## Required before Alpha
Add a VS Code integration test harness (`@vscode/test-electron`, already approved in ADR 0011) covering AC-7, FR-9, SR-2 and the AC-2 tree marker. Owner decision, 2026-11-09.
