# Feature: Triage GitHub issues into the factory

- **Id:** F-010
- **Status:** Draft (open questions in section 13)
- **Requested by / date:** Alex, 2026-11-12
- **Spec version:** 7

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
  the factory does. The factory replies to and labels issues only from fixed
  templates that the owner approved once (ADR in H-0114, the S9.2 exemption).
  The only model-written text it posts is one short, filtered question in a
  "need more information" reply (OQ-7).
- The owner merges. Nobody else does (development workflow).

## 2. Expected behavior
1. For each repo of an enabled project where the manifest turns issue triage
   on, the engine checks for new issues every 5 minutes while it runs, and
   catches up when it starts (OQ-5), with the factory
   token.
2. It takes a snapshot of each new issue: title, body, author, the author's
   relation to the repo (owner, collaborator, other), labels and time. It runs
   the secrets scan on the snapshot and stores it on `factory/state` at
   `.factory/issues/<repo>/<number>/snapshot.json`, with a hash. Later edits
   and other people's comments are not read in this increment. The one
   exception is the reporter's answer to a "need more information" reply
   (step 10).
3. The issue triager, a new role in its own container, reads the snapshot and
   the repo at `main` (read only, no network). It returns one triage record
   through a tool the engine provides. The record is structured: a kind, the
   evidence for it, and short text fields with length caps. The triager can't
   write files, file inbox items, or start anything.
4. The engine (code, not a model) validates the record and routes it:

   | Kind | Route | Reply and label on the issue (step 11) |
   |---|---|---|
   | `bug` with evidence: it contradicts an approved spec requirement, is a regression from an earlier tagged release, or is a crash or unhandled error on input the docs allow (OQ-1) | Confirmation step (5) | None until confirmed; then "Bug confirmed" |
   | `needs_info`: the report is missing something needed to triage or reproduce it | Wait for the reporter (10) | "Need more information" |
   | `feature_request`, a `bug` against behavior no approved requirement covers, or `unclear` (expected behavior can't be told from specs or docs) | Decision inbox, Product: "Start an interview for this?" (7) | "Feature request" |
   | `security_report` | Decision inbox, Security, high priority. Never fixed in the open lane (OQ-4). | None. A public reply or label would point at the vulnerability. |
   | `duplicate` of an open issue | Recorded | Label only |
   | `question`, `not_actionable` | Recorded | Label only |

5. **Confirmation.** The test engineer gets the triage record, never the
   issue text. It writes a test that reproduces the bug as stated in the
   record. The bug is confirmed when that test fails on `main` for the stated
   reason and the test engineer's report says so. The engine then posts
   "Bug confirmed". A test that passes, or fails for another reason, means not
   confirmed: the engine posts "Need more information" with the items the test
   engineer says it lacked. After the second failed attempt it files a Product
   item ("Couldn't reproduce issue #N") with what was tried instead.
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
   Reject leaves the issue alone; any reply about it is the owner's own.
8. **Fix scope guard.** If the fix needs a change to an interface contract, a
   dependency, a change-controlled file, or a security-relevant file
   (`security-standards.md` S8), the lane stops and files an item in the right
   inbox (Interfaces, Architecture, Security, or Hygiene). A bug fix that needs
   one of those is the owner's call.
9. Every route writes the triage record, the route taken, every reply and
   label posted, and any inbox item or feature id next to the snapshot, so the
   owner can see why each issue went where it did.
10. **Reporter's answer.** On a `needs_info` issue, the first comment the
    issue's author adds is snapshotted and secret-scanned like the issue, and
    the issue is triaged again with it. At most two "need more information"
    rounds per issue; after that, a Product item. With no answer in 30 days
    the issue is recorded as stale and nothing more is done.
11. **Replies and labels.** The engine posts them, not an agent, from fixed
    templates (section 10, H-0114). A template has fixed text and typed slots
    the engine fills from validated data only: the issue number, a link to the
    fix PR, and for "need more information" items from a fixed list plus
    at most one short question (OQ-7). Apart from that question, no slot holds
    text a model wrote or text taken from the issue. The labels are
    `factory: bug confirmed`, `factory: fix in progress`,
    `factory: needs info`, `factory: feature request`, `factory: duplicate`,
    `factory: question` and `factory: not actionable`. The engine creates any
    that are missing, sets one triage label per issue, and swaps it as the
    issue moves on. When the fix PR opens it adds `factory: fix in progress`.
    The owner's merge closes the issue through the PR link.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Triage is off by default. It is turned on per repo in the project manifest (H-0110), which also holds the check interval and the caps in FR-11. Nothing owner-specific goes in the master repo. |
| FR-2 | The engine lists new issues with the factory token, using conditional requests so an unchanged list costs no rate limit. Pull requests, issues opened by the factory's own account, and issues opened before triage was turned on are skipped (OQ-6). |
| FR-3 | The engine stores a snapshot of each new issue as in section 2 step 2, after the secrets scan. A snapshot that fails the scan is stored with the finding redacted, and a Security item is filed. |
| FR-4 | A new `issue-triager` role (H-0112) runs in its own container with read access to the snapshot and the repo at `main`, no network, no write, and one tool, `submit_triage`. |
| FR-5 | `submit_triage` accepts only the triage record contract (H-0111). The engine rejects a record that doesn't validate and retries once, then files a Testing item. |
| FR-6 | The engine routes each valid record by the table in section 2 step 4. Routing is engine code, not a model decision. |
| FR-7 | Confirmation runs as in section 2 step 5. The test engineer's session gets the triage record and the repo, never the issue snapshot. |
| FR-8 | A confirmed bug gets a feature id, a branch per ADR 0005 and a fix spec per OQ-2, and runs stages 5 to 9. The PR body links the issue. |
| FR-9 | The fix scope guard in section 2 step 8 stops the lane and files an item in the matching inbox. |
| FR-10 | Owner approval of "Start an interview" queues a feature seeded from the snapshot in F-009 reference mode. |
| FR-11 | Caps per repo: issues triaged per day (default 20), fix lanes running at once (default 2), and the ADR 0012 token budget per fix. Issues over a cap wait in order; none are dropped. |
| FR-12 | The engine, not an agent, posts the replies and sets the labels in section 2 steps 4 and 11, from the approved templates only. It never closes, assigns, edits or locks an issue, never comments on a `security_report`, and posts at most one reply per template per issue, plus the second "need more information" round. |
| FR-14 | Template slots take only validated, typed values (issue number, PR link, items from the fixed list, the question). The engine rejects a reply whose rendered text differs from its template outside the slots. |
| FR-17 | The question slot (OQ-7) is optional and holds one sentence ending in "?", plain text, at most 200 characters, from the triage record. The engine drops the question, and posts the reply without it, if it holds a link or anything shaped like a domain, an @-mention, a `#` issue reference, an email address, Markdown or HTML, code formatting, or a line break. It never retries with a different question. Each dropped question is logged. |
| FR-15 | On a `needs_info` issue, the issue author's first new comment is snapshotted and the issue triaged again, as in section 2 step 10. Comments by anyone else, and the factory's own, are not read. |
| FR-16 | Templates and label names ship in the master repo; a project may override them in its config repo (agents.override pattern), and a fresh factory pull never overwrites an override. |
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
| AC-14 | Given any run, then every write to the issues API is a template reply or a label from the approved set, made by the engine, and logged; there are no close, assign, edit or lock calls. | FR-12 |
| AC-16 | For each kind, given a valid record, then exactly the reply and label in the routing table are posted, and a `security_report` gets neither. | FR-12 |
| AC-17 | Given a triage record whose free-text fields other than the question hold text, links or @-mentions, then no posted reply contains any of it; given a slot value outside its type, then nothing is posted and a Testing item exists. | FR-14, SR-9 |
| AC-21 | Given a question that holds a link, a domain, an @-mention, a `#` reference, an email, Markdown, HTML, code or a line break, or is over 200 characters, then the reply is posted without the question and the drop is logged; given a clean question, then it appears in the reply word for word. | FR-17, SR-11 |
| AC-18 | Given a `needs_info` issue, when its author comments, then it is triaged again with that comment; when someone else comments, then nothing happens; after two rounds without enough information, a Product item exists. | FR-15 |
| AC-19 | Given a confirmed bug, then "Bug confirmed" and `factory: bug confirmed` are on the issue before the fix lane starts, and `factory: fix in progress` once the PR opens. | FR-12 |
| AC-20 | Given a project override of a template, when the factory is updated, then the override is still used. | FR-16 |
| AC-15 | Given an issue whose body asks the factory to do something else (prompt injection test set), then the route matches the issue's real content and the record flags the instructions. | FR-4, FR-6, SR-2 |

## 5. Constraints
- Builds on engine increments 3 (the engine reads the inbox) and 4 (stages 5
  to 9 and the PR). The fix lane can't run before increment 4; triage and
  inbox routing could ship after increment 3.
- The engine runs on the owner's machine with no inbound port, so issues are
  found by checking, not by webhook (OQ-5).
- The factory token needs `issues: write` on each triaged repo, which also
  covers reading issues and managing labels (H-0114).

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
  Re-triage on edits is a later increment.
- **Reply loops.** The factory ignores its own comments, and a reporter's
  answer only counts on a `needs_info` issue, so two bots can't keep each
  other going.
- **Someone removes a factory label or deletes a reply.** The factory doesn't
  put it back; the record keeps what it posted.
- **Owner changes a label by hand.** The factory doesn't change that issue's
  labels again.
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
| A-1 | Checking for issues every 5 minutes is fast enough; nothing needs a reply within seconds. | OQ-5 | Approved (owner, 2026-11-12, decision card) |
| A-2 | The test engineer can reproduce most bugs in the agent container. | — | Pending |

## 9. Security considerations
Drafted by the analyst; Gate 1 (F-008) reviews them and adds the threat model.

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | External services (S9.1): GitHub issues API with the factory token: read issues, post template replies, set labels from the approved set. No other service and no other write. These writes are S9.2 actions, exempt only through the ADR in H-0114. | Analyst | Draft |
| SR-2 | The triager is the only session that reads issue text. It has no network, no write and one tool (S9.3, S8). Instructions found in an issue are flagged in the record, never followed. | Analyst | Draft |
| SR-3 | The triage record is schema-validated with length caps before any other session sees it (S1.1). | Analyst | Draft |
| SR-4 | Issue snapshots are secret-scanned before they are stored (S3). | Analyst | Draft |
| SR-5 | Security reports never enter the fix lane. | Analyst | Draft |
| SR-6 | The fix scope guard keeps a bug fix away from contracts, dependencies, change-controlled and security-relevant files. | Analyst | Draft |
| SR-7 | Daily and concurrency caps bound what an outside reporter can make the factory spend. Any reporter can reach the fix lane (OQ-4), so these caps and the ADR 0012 budget are the only spending limit on public repos. | Analyst | Draft |
| SR-8 | Every GitHub call is logged with agent, action, target and time, without secrets (S9.6). | Analyst | Draft |
| SR-9 | Replies are posted by engine code, never by a session that read issue text (S9.3). Apart from the question slot, no reply contains text from the issue or text a model wrote. | Analyst | Draft |
| SR-11 | The question slot is the one place a crafted issue could choose words the factory's account posts (owner accepted this risk, OQ-7). The FR-17 filter keeps out links, mentions, references and formatting, and the length cap and one-sentence rule bound the rest. Gate 1 reviews whether that is enough. | Analyst | Draft |
| SR-10 | A `security_report` gets no public reply or label. | Analyst | Draft |

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
- **H-0114** A new ADR: the factory may reply to and label issues on triaged
  repos from the approved templates, without asking each time (the S9.2
  exemption, owner, 2026-11-12, thread). It also gives the factory token
  `issues: write` on those repos (ADR 0006 amendment) and adds the templates
  and labels. Security.

### Reply templates (draft, part of H-0114)
- **Bug confirmed:** "Thanks for the report. We've reproduced this bug and a
  fix is underway. The pull request will link here when it's ready."
- **Need more information:** "Thanks for the report. To look into this we
  need: {items}. {question} Please add them in a comment on this issue."
  `{items}` is a list from: steps to reproduce; expected and actual behavior;
  version or commit; operating system and environment; error message or log
  output; a minimal example that shows the problem. `{question}` is the
  optional question (OQ-7, FR-17).
- **Feature request:** "Thanks for the suggestion. This reads as a feature
  request rather than a bug, so it has gone to the maintainer to decide
  whether to take it on." 

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
| 4 | 2026-11-12 | OQ-3: the factory replies to and labels issues from fixed templates (bug confirmed, need more information, feature request); reporter answers on needs-info issues are triaged again; OQ-7 added | Owner, 2026-11-12 (thread) |
| 5 | 2026-11-12 | OQ-7: "need more information" may add one short filtered question (FR-17, SR-11) | Owner, 2026-11-12 (decision card) |
| 6 | 2026-11-12 | OQ-4: any reporter's confirmed bug reaches the fix lane, on every repo | Owner, 2026-11-12 (decision card) |
| 7 | 2026-11-12 | OQ-5: the engine checks every 5 minutes and catches up on start; A-1 approved | Owner, 2026-11-12 (decision card) |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | What counts as a confirmed bug that the factory may fix without the owner? (a) Only behavior that contradicts an approved spec requirement, shown by a failing test. (b) (a), plus a regression from an earlier tagged release, or a crash or unhandled error on input the docs allow, each shown by a failing test. (c) Whatever the triager judges a bug, if a test reproduces it. Recommended: (b). (a) leaves most issues on onboarded repos with the owner; (c) lets an outside reporter define requirements. **Decided: (b).** | Product | Decided (owner, 2026-11-12, decision card) |
| OQ-2 | How does "requirements approved" (DoD item 1) apply to a fix? (a) The fix spec cites an approved requirement or the OQ-1 evidence, and that stands in for approval; no owner step before the PR. (b) The owner approves each fix spec in the inbox first. Recommended: (a); (b) contradicts "without my input". The owner still merges either way. **Decided: (a).** | Product | Decided (owner, 2026-11-12, decision card) |
| OQ-3 | May the factory write to an issue? (a) Never. (b) Only comments the owner approves one by one. (c) An ADR lets it reply and label without asking. **Decided: (c), extended by the owner:** replies for bug confirmed and fix underway, need more information (saying what is needed), and feature request sent to the owner, plus labels. | Security | Decided (owner, 2026-11-12, thread) |
| OQ-4 | Who may open an issue that reaches the fix lane? (a) Anyone. Confirmation is by the factory's own test, not the reporter's word, and caps bound cost. (b) Only the owner and repo collaborators; others' bugs go to the inbox first. Recommended: (a) for private repos and (b) for public ones, set per repo in the manifest. **Decided: (a), anyone on every repo.** The factory's own failing test and the FR-11 caps are the guard. | Security | Decided (owner, 2026-11-12, decision card) |
| OQ-5 | How does the engine learn of new issues? (a) It checks GitHub every few minutes (default 5) while running, and catches up on start. (b) A GitHub Actions workflow in each repo relays issue events to somewhere the engine reads. Recommended: (a); no inbound port, no new workflow in every repo, and conditional requests cost no rate limit. **Decided: (a).** | Architecture | Decided (owner, 2026-11-12, decision card) |
| OQ-6 | What about issues already open when triage is turned on? (a) Ignore them; only new issues. (b) Triage the backlog too, inside the daily cap. (c) Ask once when triage is turned on. Recommended: (c). | Product | Open |
| OQ-7 | How specific can "need more information" be? (a) Only items from the fixed list in section 10. (b) The fixed list plus one short question written by the factory, plain text, at most 200 characters, with no links, @-mentions or code. Recommended: (a). The text in (b) would come from a session that read the issue, so a crafted issue could make the factory's account post words chosen by its author. **Decided: (b)**, with the filter in FR-17. | Security | Decided (owner, 2026-11-12, decision card) |
