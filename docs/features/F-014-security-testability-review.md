# F-014 Security and Testability Review (requirements review)

- **Feature:** F-014 Fewer engine git calls, spec v3
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Maturity level:** Rapid prototype (the factory repo's level). Only
  Critical findings block there.
- **Result:** 4 findings: 0 Critical, 0 High, 1 Medium, 3 Low. Nothing
  blocks. The owner's decisions (OQ-1, OQ-2) are not re-opened.
  Recommendations are proposed as SR-5 to SR-8 in the spec, for the owner
  to approve.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S1.1, S5.1 | Medium | No | FR-1 adds a parser of git tree objects inside the engine. Trees come from config repos and master clones the owner may have fetched from others, and git doesn't check a fetched tree's entry names unless `fsck` runs on fetch. A crafted tree could hold names such as `a/b`, `..`, an empty name, or the same name twice, which `ls-tree` passed through as text and the engine then compared to the path it wanted. A parser that accepts them could map a requested path to the wrong entry. | SR-5: the tree parser refuses a tree with an entry name that is empty, `.`, `..`, or holds `/` or NUL, a duplicate name, an unknown mode, or an id of the wrong length; such a tree reads as unreadable (the same error as a missing or non-regular file today). A test feeds each of these as a hand-built tree object. |
| 2 | S1.1, S5.1 | Low | No | The reader's output is trusted to follow the protocol. A header for a different object, or a size larger than the data that follows, could make one read return another object's bytes. | SR-6: each reply's header must name the exact object id or ref the engine asked for (resolved ids are checked against the request), with a type the engine expects and a size within the read's limit, or the reader is killed and FR-2's fallback runs. Bodies over the limit are never read into memory. |
| 3 | S8.4, S5.1 | Low | No | A reader is a long-lived child process. If it hangs, or outlives an engine stop, it holds repo files open and the engine waits on it. | SR-7: every reader is registered with the engine's `Children` (killed on stop like every other child), each read has the same timeout as a git call today, and a timed-out reader is killed before the fallback runs. |
| 4 | S5.1 | Low | No | FR-3 (A-1) and FR-4 serve values from memory. A stale value could let the engine act on old state. | SR-8: cached values are only ever an input to a step that git then checks: factory/state writes keep their compare-and-swap, and a failed swap clears the cache. Master repo facts (FR-4) are only read at engine start, so the cache lives for one process (already SR-4). |

**Already covered by the spec or decisions:** the reader runs with the same
overrides and environment as every engine git call and only gets validated
ids and ref names (SR-2); mode checks are kept on parsed modes (SR-1); the
Code Review L7 config check still runs before every push and fetch (SR-3);
nothing cached crosses repos or outlives the process (SR-4).

**Not applicable:** no new dependency or external component (S4), no new
permission (S8.5), no new external interaction, so no S9.7 threat model.
