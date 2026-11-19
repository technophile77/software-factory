# F-023 Security and Testability Review (requirements review)

- **Feature:** F-023 One factory for all projects, spec v3
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`,
  plus the testability check of stage 3
- **Date:** 2026-11-19
- **Maturity level:** Rapid prototype (the engine repo's level). Only
  Critical findings block there (`security-blocking.json`).
- **Result:** 11 findings: 0 Critical, 0 High, 6 Medium, 5 Low. Nothing
  blocks. Each is covered by a proposed requirement (SR-8 to SR-14, and
  changes to FR-7, FR-11c and FR-11d) in spec v4, which need the owner's
  approval.
- **Not re-opened (owner decisions):** agents on the owner's PC with a full
  shell for the developer and test engineer until Beta (ADR 0026); no
  interview sign-in at Rapid prototype (F-018); one factory per PC,
  portable projects, feature ids per project, no configuration for shared
  repos, and a unanimous Architecture decision for joint changes (owner,
  2026-11-19 02:00Z to 02:26Z).

## Security and Testability Review checklist

| Question | Answer |
|---|---|
| Touches input, auth, secrets, sensitive data, dependencies, external systems? | Input: project files, the lease and checkout records (the checkout record sits in code repos other people can push to), the engine index. Auth: who may take over a project or a shared repo. Secrets: per-project tokens, unchanged. Sensitive data: project names and spec text that may now cross into another project or a public repo. Dependencies: none new. External systems: GitHub, with two new kinds of write (lease commits on `factory/state`, checkout commits on a `factory/checkout` branch in code repos). |
| Permissions needed; each the minimum (S8)? | The factory token already pushes to the code repo; the checkout branch is one more branch there. No new scope. The widening is that a project's state now moves between PCs, which the SR-5 confirm already guards. |
| New or upgraded external component; S4.1 review and CVE check? | None. |
| Reads from or acts on anything external; scope, irreversible actions, threat model (S9)? | The checkout record is written to repos that may be public and shared with other people, and is read back from them. Threat model below. No S9.2 action: the factory writes only its own branches and records, as ADR 0017 grants. |
| A requirement for each? | Yes after v4: SR-8 to SR-14 and the FR changes listed per finding. |
| Abuse cases in the edge cases? | Added in v4: a forged or deleted checkout record, a squatted lock, clock skew between PCs, another project's text steering an analyst. |
| Acceptance criteria testable? | All but two: FR-11c's "within the item's wait" and FR-11d's "undo each other more than twice" have no value a test can check (findings 10 and 11). |
| Needs the owner's decision (Security)? | Approval of SR-8 to SR-14, and of the two definitions in findings 10 and 11. |

## Threat model (STRIDE, S9.7)

| Threat | Where | Covered by |
|---|---|---|
| Spoofing | A forged checkout or lease record claims a repo or project for "another factory" | Findings 1, 7 |
| Tampering | The `factory/checkout` branch force-pushed or deleted, so two projects write at once | Finding 1 |
| Repudiation | Which factory wrote what after a takeover | Lease and checkout commits name the factory id; the log records takeovers (FR-7) |
| Information disclosure | A private project's name in a public repo's checkout record; one project's spec text in another project's inbox | Findings 2, 3 |
| Denial of service | A squatted lock or a stuck checkout blocks a project | Findings 1, 5 |
| Elevation of privilege | A feature writes to a repo it was only meant to read; a bare feature id reaches another project | Findings 4, 6 |

## Findings

| # | Severity | Criterion | Finding | Requirement |
|---|---|---|---|---|
| 1 | Medium | S2.1, S5.1 | The checkout record lives on a `factory/checkout` branch in a code repo that other people may push to (an org repo like the mesbot one). Anyone who can push there can delete the branch or force-push it, which releases a held checkout and lets two projects write at once, or forge one that blocks every project. A fast-forward push only protects against other factories, not against a rewrite. | SR-8 |
| 2 | Low | S3.2 | The checkout record names the project. In a public repo that publishes the name of a project whose config repo is private. | SR-9 |
| 3 | Medium | S3.2, S6.1, S9.3, S9.4 | FR-11c has the two projects' analysts write one proposal and files it in both inboxes. That moves one project's requirements into another project's private config repo, possibly owned by a different person, and makes one project's agent text input to the other's analyst: a path for prompt injection and for leaking a spec. | SR-10 |
| 4 | Medium | S2.2, S6.2 | FR-11 relies on the spec's `Repo:` lines to decide what a feature may change, but nothing stops an agent's session from pushing to a repo the spec only reads. "Read-only" has to be enforced by the engine, not trusted from the agent. | SR-11 |
| 5 | Low | S5.1, S8.4 | The one-factory lock is a fixed pipe or socket name. Another local program could create it first and keep the factory from starting, or a lock left by a crashed engine could do the same. | SR-12 |
| 6 | Medium | S2.1 | Dropping F-007 SR-16 removes the safety net that made a bare feature id name one project. Any code path left that looks a feature up by id alone, now or later, can act on the wrong project (the held-command bug fixed in PR #116 was this kind). | SR-13 |
| 7 | Low | S5.1 | Lease and checkout staleness (30 minutes) compares times written by different PCs. A PC with a wrong clock could treat a live lease as stale, or the reverse. | FR-7 change (v4) |
| 8 | Low | S6.2 | Developer and test engineer sessions have a full shell on the PC until Beta (ADR 0026), so SR-6's denied paths don't stop them from deleting a project file (stopping the project) or editing its URL. They can't add trust: a changed file still needs the SR-5 confirm. This is within the risk ADR 0026 accepted; noted, not re-opened. | SR-6 (as is) |
| 9 | Low | S5.1 | After a takeover the old factory stops at its next push or renewal (FR-7 c, e). A GitHub write already in flight (a comment, a label) can still land once. | FR-7 change (v4) |
| 10 | Medium | Testability | FR-11c: "a project that hasn't answered within the item's wait" has no wait set, so AC-7f can't be tested, and a silent "independent" after a timeout is a decision the owner never made. | FR-11c change (v4) |
| 11 | Medium | Testability | FR-11d: "undo each other more than twice" has no definition code can count, so AC-7g can't be tested. | FR-11d change (v4) |

## Proposed requirements (spec v4)

- **SR-8:** Onboarding asks for a branch ruleset on `factory/checkout` in
  every code repo (no deletion, no force push), and the engine checks it
  at start. Each checkout commit must descend from the last one this
  factory saw; a rewrite or deletion stops every project's writes to that
  repo and files a Security item in each project that uses it.
- **SR-9:** The checkout record holds a project key (the first 16 hex
  characters of SHA-256 of the config repo URL), not the name. The console
  shows the name for projects on this factory and "another project"
  otherwise.
- **SR-10:** What crosses between projects is only the interface proposal
  for the shared repo, written for that repo (it will be public there if
  the repo is). It passes the secrets scan, carries no text copied from
  either spec, and reaches the other project's analyst only as a
  structured, validated result (S9.3). When the projects' owners differ,
  each owner approves sending it before it is filed in the other's inbox.
- **SR-11:** The engine refuses any push, branch, pull request, issue or
  label in a repo the feature's signed-off spec doesn't name as changed,
  and files a Security item. The agent's worktree for a read repo is
  checked out without push credentials.
- **SR-12:** The lock is created owner-only and exclusive (Windows:
  first-instance pipe with an owner-only DACL; elsewhere a socket in an
  owner-only folder). If the name is held, the start message says which
  process holds it; a lock whose holder is gone is cleared.
- **SR-13:** The engine's feature lookup takes a project and an id
  together; the lookup by bare id is removed, so the compiler finds every
  caller. AC-6 runs two projects that both have F-001, F-002 and S-0001.
- **SR-14:** The checkout and lease commits name only the factory id and
  times (SR-3, SR-9).

## Proposed spec changes (spec v4)

- **FR-7 (finding 7):** a lease or checkout is stale when its commit has
  not changed for 30 minutes as measured by this factory's own clock since
  it first saw that commit, never by the times written in the record.
- **FR-7 (finding 9):** before a GitHub write the factory's lease check
  is at most 60 seconds old; one write in flight at a takeover can still
  land, and is logged.
- **FR-11c (finding 10):** the Architecture item has no timeout. Joint
  needs every owner's A; independent needs any owner's B; until then both
  features wait, and the item is reminded as other inbox items are.
- **FR-11d (finding 11):** a round is one of the two features going back
  to its spec because the other project's merge in the shared repo failed
  its tests or changed the agreed interface. The third round for either
  feature stops both and files the Architecture item.

## Notes for Code Review

- Check that no map, file name or log key in the engine is keyed by a
  bare feature id or inbox item id (SR-13).
- Check the race tests (AC-5b, AC-7c) inject the competing push between
  the read and the push, deterministically, rather than relying on timing.
- Check that a read repo's worktree has no credential helper or token.
