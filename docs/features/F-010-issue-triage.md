# Feature: Triage GitHub issues into the factory

- **Id:** F-010
- **Status:** Draft (open questions in section 13)
- **Requested by / date:** Alex, 2026-11-12
- **Spec version:** 3

## 1. Objective and business purpose
Issues opened on a project's repos are a second way work reaches the factory,
next to a feature request. Today nothing reads them. The owner wants every new
issue triaged. A confirmed bug is fixed by the factory without the owner's
input up to the pull request. Anything that needs the owner goes to the one
inbox, labeled by category, or becomes a feature request that the requirements
analyst interviews the owner about.

The owner's existing rules still hold:
- Code only follows an approved requirement (CLAUDE.md rule 1). A bug fix
  restores behavior an approved requirement already states, so it needs no new
  interview. Behavior no requirement covers is a feature, not a bug.
- Agents never answer for the owner. An issue never stands in for an owner
  decision, and the reporter's opinion of the right fix is a hint, not a
  requirement.
- Issue text is external content written by anyone (S9). It can't steer what
  the factory does, and the factory doesn't write to anyone's issue without the
  owner's approval of the exact action (S9.2).
- The owner merges. Nobody else does (development workflow).

## 2. Expected behavior
1. For each repo of an enabled project where the manifest turns issue triage
   on, the engine checks for new issues on a schedule (OQ-5) with the factory
   token, read only.
2. It takes a snapshot of each new issue: title, body, author, the author's
   relation to the repo (owner, collaborator, other), labels and time. It runs
   the secrets scan on the snapshot and stores it on `factory/state` at
   `.factory/issues/<repo>/<number>/snapshot.json`, with a hash. Later edits
   and comments are not read in this increment.
3. The issue triager, a new role in its own container, reads the snapshot and
   the repo at `main` (read only, no network). It returns one triage record
   through a tool the engine provides. The record is structured: a kind, the
   evidence for it, and short text fields with length caps. The triager can't
   write files, file inbox items, or start anything.
4. The engine (code, not a model) validates the record and routes it:

   | Kind | Route |
   |---|---|
   | `bug` with evidence: it contradicts an approved spec requirement, is a regression from an earlier tagged release, or is a crash or unhandled error on input the docs allow (OQ-1) | Confirmation step (5) |
   | `bug` against behavior no approved requirement covers | Decision inbox, Product: "Treat as a feature request?" |
   | `feature_request` | Decision inbox, Product: "Start an interview for this?" (7) |
   | `unclear` (expected behavior can't be told from specs or docs) | Decision inbox, Product, with the triager's reading as the question |
   | `security_report` | Decision inbox, Security, high priority. Never fixed in the open lane (OQ-4). |
   | `question`, `duplicate`, `not_actionable` | Recorded only (OQ-3) |

5. **Confirmation.** The test engineer gets the triage record, never the
   issue text. It writes a test that reproduces the bug as stated in the
   record. The bug is confirmed when that test fails on `main` for the stated
   reason and the test engineer's report says so. A test that passes, or fails
   for another reason, means not confirmed: the engine files a Product item
   ("Couldn't reproduce issue #N") with what was tried.
6. **Fix lane.** A confirmed bug gets a feature id and a fix spec generated
   from a template (OQ-2). It names the issue, the approved requirement it
   restores (or the regression or crash evidence), and the reproduction test
   as its acceptance criterion. It then runs stages 5 to 9 like any feature:
   developer, independent tests, orchestrator review, Gate 2, validation, and a
   PR through the factory token whose body says it fixes the issue. The owner
   reviews and merges the PR, which is their only step. Stage failures go to
   the inboxes as they do for features.
7. **Feature requests.** If the owner approves "Start an interview", the engine
   queues a feature that waits for an interview, seeded with the issue snapshot
   as reference material written by someone else (F-009, reference mode). The
   owner holds the interview from `/software-factory:spec-interview` as usual.
   Reject leaves the issue alone.
8. **Fix scope guard.** If the fix needs a change to an interface contract, a
   dependency, a change-controlled file, or a security-relevant file
   (`security-standards.md` S8), the lane stops and files an item in the right
   inbox (Interfaces, Architecture, Security, or Hygiene). A bug fix that needs
   one of those is the owner's call.
9. Every route writes the triage record, the route taken and any inbox item
   or feature id next to the snapshot, so the owner can see why each issue went
   where it did.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Triage is off by default. It is turned on per repo in the project manifest (H-0110), which also holds the check interval and the caps in FR-11. Nothing owner-specific goes in the master repo. |
| FR-2 | The engine lists new issues with the factory token, read only, using conditional requests so an unchanged list costs no rate limit. Pull requests, issues opened by the factory's own account, and issues opened before triage was turned on are skipped (OQ-6). |
| FR-3 | The engine stores a snapshot of each new issue as in section 2 step 2, after the secrets scan. A snapshot that fails the scan is stored with the finding redacted, and a Security item is filed. |
| FR-4 | A new `issue-triager` role (H-0112) runs in its own container with read access to the snapshot and the repo at `main`, no network, no write, and one tool, `submit_triage`. |
| FR-5 | `submit_triage` accepts only the triage record contract (H-0111). The engine rejects a record that doesn't validate and retries once, then files a Testing item. |
| FR-6 | The engine routes each valid record by the table in section 2 step 4. Routing is engine code, not a model decision. |
| FR-7 | Confirmation runs as in section 2 step 5. The test engineer's session gets the triage record and the repo, never the issue snapshot. |
| FR-8 | A confirmed bug gets a feature id, a branch per ADR 0005 and a fix spec per OQ-2, and runs stages 5 to 9. The PR body links the issue. |
| FR-9 | The fix scope guard in section 2 step 8 stops the lane and files an item in the matching inbox. |
| FR-10 | Owner approval of "Start an interview" queues a feature seeded from the snapshot in F-009 reference mode. |
| FR-11 | Caps per repo: issues triaged per day (default 20), fix lanes running at once (default 2), and the ADR 0012 token budget per fix. Issues over a cap wait in order; none are dropped. |
| FR-12 | The factory takes no action on the issue itself (comment, label, close, assign) except as OQ-3 decides. |
| FR-13 | Each issue's folder holds the snapshot, its hash, the triage record, the route, and links to inbox items, the feature and the PR. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a repo with triage off, when an issue is opened, then the engine makes no request for it and stores nothing. | FR-1 |
| AC-2 | Given triage on, when an issue is opened, then within one check interval a snapshot and its hash exist under `.factory/issues/<repo>/<number>/`. | FR-2, FR-3 |
| AC-3 | Given a pull request or an issue by the factory account, then no snapshot is made. | FR-2 |
| AC-4 | Given an issue body holding a test secret, then the stored snapshot has it redacted and a Security item exists. | FR-3 |
| AC-5 | Given a triager session, then its container has no network and no writable mount, and its only tool is `submit_triage`. | FR-4 |
| AC-6 | Given a record that fails validation twice, then no route is taken and a Testing item exists. | FR-5 |
| AC-7 | For each kind in the routing table, given a valid record of that kind, then exactly the listed route is taken. | FR-6 |
| AC-8 | Given a `bug` record, then the test engineer's session inputs contain the record and not the snapshot. | FR-7 |
| AC-9 | Given a reproduction test that passes on `main`, then no fix lane starts and a "Couldn't reproduce" Product item exists. | FR-7 |
| AC-10 | Given a confirmed bug, then a feature id, branch and fix spec exist and the run reaches stage 9 with a PR linking the issue, with no owner action before the PR. | FR-8 |
| AC-11 | Given a fix whose diff touches an interface contract, a dependency manifest or a change-controlled file, then the lane stops before stage 6 and an item in the matching inbox exists. | FR-9 |
| AC-12 | Given owner approval of "Start an interview", then a feature waiting for an interview exists with the snapshot attached as reference material. | FR-10 |
| AC-13 | Given 25 new issues in one day with a cap of 20, then 20 are triaged and 5 wait for the next day, in order. | FR-11 |
| AC-14 | Given any run of this feature, then the factory made no write call to the issues API (unless OQ-3 allows one and it was approved). | FR-12 |
| AC-15 | Given an issue whose body asks the factory to do something else (prompt injection test set), then the route matches the issue's real content and the record flags the instructions. | FR-4, FR-6, SR-2 |

## 5. Constraints
- Builds on engine increments 3 (the engine reads the inbox) and 4 (stages 5
  to 9 and the PR). The fix lane can't run before increment 4; triage and
  inbox routing could ship after increment 3.
- The engine runs on the owner's machine with no inbound port, so issues are
  found by checking, not by webhook (OQ-5).
- The factory token needs `issues: read` on each triaged repo (H-0114).

## 6. Edge cases
- **Prompt injection in an issue.** Only the triager reads the text, and it can
  only return a schema-checked record. Free-text fields are capped and passed
  on as data. The test engineer and developer never see the issue.
- **Issue spam or a flood.** The daily cap bounds cost. Issues over the cap
  wait. Spam is recorded as `not_actionable` with no inbox item.
- **A "bug" that is really a feature.** No approved requirement or regression
  evidence means it goes to the owner as Product, never to the fix lane.
- **An issue reporting a vulnerability.** It goes to Security only. A public
  fix PR would disclose it before the owner chose how to handle it.
- **Two issues for the same bug.** The triager can mark `duplicate` with the
  other number. If both reach confirmation, the second lane stops when the
  first PR exists and links to it.
- **Issue edited after triage.** The snapshot and hash stay what was triaged.
  Re-triage is a later increment.
- **A fix fails tests after retries.** Testing inbox, as for features.
- **The reproduction test needs something the container lacks** (hardware,
  outside service, a specific OS). Not confirmed; the Product item says why.
- **Repo has no approved specs yet** (onboarded with F-003). Only regression
  or crash evidence (OQ-1) can confirm a bug; everything else goes to the
  owner.
- **Issue closed before triage finishes.** The lane stops and the record says
  so.

## 7. Dependencies
- Engine increments 3 and 4 (F-007 section 13).
- F-009 reference mode for seeding interviews from an issue.
- F-008 Security Gate 1, for this feature's threat model (S9.7).
- ADR 0005 branches, ADR 0006 factory token and PRs, ADR 0012 budgets,
  ADR 0015 agent containers.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | Checking for issues every few minutes is fast enough; nothing needs a reply within seconds. | OQ-5 | Pending |
| A-2 | The test engineer can reproduce most bugs in the agent container. | — | Pending |

## 9. Security considerations
Drafted by the analyst; Gate 1 (F-008) reviews them and adds the threat model.

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | External services (S9.1): GitHub issues API, read only, factory token. No other service. Any write to an issue is an S9.2 action and needs the owner's approval of the exact text (OQ-3). | Analyst | Draft |
| SR-2 | The triager is the only session that reads issue text. It has no network, no write and one tool (S9.3, S8). Instructions found in an issue are flagged in the record, never followed. | Analyst | Draft |
| SR-3 | The triage record is schema-validated with length caps before any other session sees it (S1.1). | Analyst | Draft |
| SR-4 | Issue snapshots are secret-scanned before they are stored (S3). | Analyst | Draft |
| SR-5 | Security reports never enter the fix lane. | Analyst | Draft |
| SR-6 | The fix scope guard keeps a bug fix away from contracts, dependencies, change-controlled and security-relevant files. | Analyst | Draft |
| SR-7 | Daily and concurrency caps bound what an outside reporter can make the factory spend. | Analyst | Draft |
| SR-8 | Every GitHub call is logged with agent, action, target and time, without secrets (S9.6). | Analyst | Draft |

## 10. Interface requirements
- **H-0110** Project manifest: per-repo `issues` block (`enabled`, check
  interval, daily cap, fix concurrency). Interfaces.
- **H-0111** New contract, Issue triage record v1.0: kinds, evidence fields,
  caps, and the `submit_triage` tool. Interfaces.
- **H-0112** New role `agents/issue-triager/AGENT.md` and its Role policy entry
  (no network, no write, one tool). Architecture.
- **H-0113** `development-workflow.md`, `workflows/feature-development/` and
  `definition-of-done.md`: the bug-fix lane and how DoD item 1 applies to it
  (OQ-2). Product.
- **H-0114** Factory token gains `issues: read` on triaged repos (ADR 0006
  amendment). Security.

## 11. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-12 | First draft from the owner's request | — |
| 2 | 2026-11-12 | OQ-1: a confirmed bug is a spec contradiction, a regression from a tagged release, or a crash on documented input, each shown by a failing test | Owner, 2026-11-12 (decision card) |
| 3 | 2026-11-12 | OQ-2: a fix spec that cites its OQ-1 evidence counts as approved; no owner step before the PR | Owner, 2026-11-12 (decision card) |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | What counts as a confirmed bug that the factory may fix without the owner? (a) Only behavior that contradicts an approved spec requirement, shown by a failing test. (b) (a), plus a regression from an earlier tagged release, or a crash or unhandled error on input the docs allow, each shown by a failing test. (c) Whatever the triager judges a bug, if a test reproduces it. Recommended: (b). (a) leaves most issues on onboarded repos with the owner; (c) lets an outside reporter define requirements. **Decided: (b).** | Product | Decided (owner, 2026-11-12, decision card) |
| OQ-2 | How does "requirements approved" (DoD item 1) apply to a fix? (a) The fix spec cites an approved requirement or the OQ-1 evidence, and that stands in for approval; no owner step before the PR. (b) The owner approves each fix spec in the inbox first. Recommended: (a); (b) contradicts "without my input". The owner still merges either way. **Decided: (a).** | Product | Decided (owner, 2026-11-12, decision card) |
| OQ-3 | May the factory write to an issue? (a) Never; the PR links the issue and the owner's merge closes it. Anything else the owner does by hand. (b) (a), plus the factory may propose a comment (can't reproduce, duplicate, question answered) as a Security item with the exact text; it posts only on approval (S9.2). (c) An ADR lets it add a fixed set of labels and one templated acknowledgement without asking. Recommended: (b). | Security | Open |
| OQ-4 | Who may open an issue that reaches the fix lane? (a) Anyone. Confirmation is by the factory's own test, not the reporter's word, and caps bound cost. (b) Only the owner and repo collaborators; others' bugs go to the inbox first. Recommended: (a) for private repos and (b) for public ones, set per repo in the manifest. | Security | Open |
| OQ-5 | How does the engine learn of new issues? (a) It checks GitHub every few minutes (default 5) while running, and catches up on start. (b) A GitHub Actions workflow in each repo relays issue events to somewhere the engine reads. Recommended: (a); no inbound port, no new workflow in every repo, and conditional requests cost no rate limit. | Architecture | Open |
| OQ-6 | What about issues already open when triage is turned on? (a) Ignore them; only new issues. (b) Triage the backlog too, inside the daily cap. (c) Ask once when triage is turned on. Recommended: (c). | Product | Open |
