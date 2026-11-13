# Feature: One inbox for all approvals, on GitHub issues

- **Id:** F-011
- **Status:** In review (revision for ADR 0022; v19 was Approved 2026-11-13)
- **Requested by / date:** Alex, 2026-11-10 (one inbox rule), 2026-11-13 (PR
  approval and merge in the inbox, no machine account; phone approvals,
  F-012; "can't [a VS Code issues extension] be used in place of the
  inbox?", proposal 0026)
- **Spec version:** 23 (draft)
- **Replaces:** F-001's inbox view and all of F-012 (both superseded by this
  version, see their change logs). Their approved requirements that still
  apply are carried here, each marked with where it came from.

## 1. Objective and business purpose
Everything the factory needs the owner to approve reaches the owner in one
place, and the owner can act on it from the PC or the phone the same way.

Version 19 kept items as files on `factory/state`, showed them in our own
VS Code extension (F-001) and copied blocking ones to GitHub issues for the
phone (F-012). That is two stores, a sync between them, and an inbox UI to
build. The owner chose to use what GitHub already has instead (ADR 0022):
**each inbox item is a GitHub issue in the project's private config repo**,
shown in VS Code by Microsoft's GitHub Pull Requests extension and on the
phone by GitHub Mobile. The factory renders the issues and reads the owner's
actions; it no longer has an inbox UI.

## 2. Expected behavior
**Filing.** When an agent or the engine needs the owner, the engine (code,
not an agent) renders an issue from a fixed template for the item's kind
and has the config repo's workflow open it, as `github-actions[bot]`, so
GitHub notifies the owner (GitHub sends no notification for a person's own
activity, and the engine acts as the owner, ADR 0017). The issue is
assigned to the owner and labelled `factory-inbox`, its kind, its category
(decisions only), its priority, and `blocking` where it is. The workflow
then posts one short **action comment** per action the kind allows, for
example "Option A: Redis", "Approve", "Defer".

**Seeing it.** In VS Code, the GitHub Pull Requests extension's Issues view
lists items through queries the factory ships (one per priority, H-0163). On
the phone, GitHub Mobile shows the push and the issue. On the web, it is an
ordinary issue.

**Acting.** Two ways, both accepted everywhere:
- **Tap:** 👍 on an action comment chooses that action. This is the phone
  way; the owner asked for taps, not typing, on the phone (2026-11-13).
- **Command:** a comment such as `/choose A`, `/approve`, `/defer`. This is
  the VS Code way: the extension can add comments to an issue but its
  documentation and issue view show no reactions (checked 2026-11-13,
  `src/github/issueOverview.ts`).

The engine reads actions every poll, accepts only the owner's GitHub
account on the item's current revision, replies with what it recorded,
writes the record to `factory/state`, carries the action out, and closes the
issue.

**Risky actions** (merge, Approve on Hygiene, Maturity, Security decision
and Spec sign-off items; v19 FR-15, F-012 FR-8) need a second step: the
engine posts a confirm comment naming the exact action and target with a
short code, and only a 🚀 on it or `/confirm <code>` within 15 minutes acts.

**Pull requests** are merged in GitHub's own PR view: the VS Code
extension, the web, or GitHub Mobile. Each asks for a confirmation before
merging (the extension's merge form has a separate confirm button,
`webviews/components/merge.tsx`; F-012 A-2 for Mobile). `main` requires
only a pull request and green CI (ADR 0017), so no bypass is needed.
Pull requests are not inbox issues (OQ-12): the owner finds them in
GitHub's PR list (the extension's Pull Requests view, with a query the
factory ships, or GitHub Mobile). When a factory PR is ready, the engine
posts its definition-of-done evidence on the PR as a comment.

**Notes.** Request changes and Ask for more research need a note, so they
are typed: `/changes <note>`, `/research <note>`. Everything else is a tap
or a one-word command.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Every inbox item of the project is one open issue in the project's config repo, whichever repo it concerns. Its title is `<id> <Kind>[ (<Category>)]: <title>`; its labels are `factory-inbox`, `kind:<kind>`, `category:<category>` (decision only), `priority:<effective priority>`, and `blocking` when blocking. It is assigned to the owner. (Replaces v19 FR-1, F-001 FR-1, FR-2, FR-12.) |
| FR-2 | Item kinds and their allowed actions are those of v19 FR-3 (OQ-1): Decision (one action per option, Reject, Request changes, Ask for more research, Defer, Restore priority); Hygiene (Approve, Reject, Request changes, Defer); Testing (the recommended step or another listed step, Ask for more research, Defer); Spec sign-off (Approve, Request changes, Defer); Maturity (Approve, Reject, Defer); Notice (Dismiss). The engine accepts no other action for a kind. Pull requests are not an item kind (OQ-12, FR-9). |
| FR-3 | The issue body is rendered by engine code from one fixed template per kind (H-0165): a hidden marker with the item id and revision, the kind's sections, links, and the revision line. Text that can come from outside the factory is rendered per SR-10. No agent writes into the issue directly. (F-012 FR-3.) |
| FR-4 | The engine sends the rendered title, body, labels and action labels to the config repo's workflow (H-0162), which opens the issue as `github-actions[bot]`, assigns the owner, and posts the action comments in a fixed order, each with a hidden marker naming the item, revision and action. (F-012 FR-2.) |
| FR-5 | Every poll, the engine reads reactions and new comments on open `factory-inbox` issues. It accepts a 👍 on an action comment, or a comment whose first line is a command (H-0165), only when the GitHub user id equals the owner's (engine config) and the action comment or command is for the item's current revision. Anything else changes nothing; the engine replies once with "Not recorded: <reason>" for a stale revision, two different actions, an expired confirm, or an edited comment. (F-012 FR-4.) |
| FR-6 | A risky action (FR-11 list) records nothing at first: the engine posts a confirm comment restating the action and its target and a 4-character code. Only a 🚀 by the owner on that comment or `/confirm <code>`, within 15 minutes and at the same revision, records it. (v19 FR-15, F-012 FR-8.) |
| FR-7 | A valid action is one commit on the config repo's `factory/state`, appending it to the item's record (H-0165) with its source (`reaction` or `command`), the comment URL, the actor id and the time; the message starts with the item id. The engine then replies `Recorded: <action>.`, carries the action out as v19 FR-5 says, and closes the issue unless the action keeps it open (Defer, Restore priority, Ask for more research). (Replaces v19 FR-4, F-001 FR-8, F-012 FR-5, FR-6.) |
| FR-8 | Defer lowers the effective priority one step (swaps the `priority:` label), keeps `blocking`, and keeps the issue open; Restore priority sets it back. (F-001 FR-7.) If an item changes while open, the engine edits the body to the new revision, marks the old action comments stale, and the workflow posts new ones. (F-012 FR-7.) |
| FR-9 | Pull requests are not inbox issues (OQ-12, owner, 2026-11-13). When the orchestrator marks a factory PR ready (stage 9, CI green), the engine posts one comment on the PR, rendered from a fixed template: feature, spec version, definition-of-done evidence, and an engine-written line saying whether the PR comes from a fork or an account without write access (v19 SR-8). The owner merges in GitHub's PR view. A comment by the owner on a managed PR whose first line is `/changes <note>` routes the note to the orchestrator as review feedback (v19 FR-5); the engine reads no other PR comment as an action. The engine records `merged_on_github` (with the merge commit) or `closed_on_github` in the feature's record when it sees the PR merged or closed. The owner gets no push for PRs the engine opens with the owner's token (stated on the OQ-12 card). |
| FR-10 | Hygiene approval covers the change once: when the engine applies an approved hygiene change through a PR whose diff equals the approved diff exactly (SR-11), the engine merges that PR itself; on any difference it merges nothing and posts a PR comment saying the diff differs from the approved one, so the owner merges or rejects it in GitHub's PR view. The proof is the owner's GitHub-proven, confirmed Approve on the Hygiene item (SR-16; OQ-11, owner, 2026-11-13). |
| FR-11 | Risky actions (owner, 2026-11-13): merging a PR (confirmed by GitHub's merge dialog, FR-9), and Approve on a Hygiene, Maturity, Security decision or Spec sign-off item (confirmed by FR-6). The confirm comment's target is fixed per kind: hygiene, the item id, files changed and that it lands on `main`; maturity, the repo and old and new level; Security decision, the option and the risk it accepts; spec sign-off, the feature, spec version and that development starts. |
| FR-12 | The factory ships a `githubIssues.queries` block for the GitHub Pull Requests extension (H-0163): one query per priority, each `is:open label:factory-inbox assignee:${user} label:priority:<p>`, plus "Blocking" and "Deferred"; and a `githubPullRequests.queries` entry "Factory PRs to merge", `is:open is:pr user:${user} base:main -is:draft` (repos the owner owns; a project whose repos sit in an organization adds `org:` during onboarding, in user settings only). It names no repo and no owner, so it holds no owner-specific value. Onboarding offers to add it to the owner's VS Code user settings. |
| FR-13 | Notifications: GitHub notifies the owner of each new item through the assignment and @mention (GitHub Mobile push, web, email, per the owner's GitHub settings). The engine also shows an OS notification on the PC for a new blocking item (v19 FR-12). **Pending OQ-13** (which items notify). |
| FR-14 | The engine has no merge call except FR-10; a CI test fails if engine code calls GitHub's merge API (REST `PUT .../pulls/{n}/merge`, GraphQL `mergePullRequest`) anywhere else, naming file and line (v19 FR-14, OQ-9). A second CI test fails if engine code calls the create-reaction API (REST or GraphQL `addReaction`): the engine only reads reactions (F-012 SR-11). |
| FR-15 | The inbox works only when the config repo is private and the owner is its only collaborator; the engine checks both at start and before filing, and otherwise files nothing, stops the affected work, and shows the reason on the PC (OS notification and engine log). (F-012 FR-11, SR-9.) |
| FR-16 | Migration: on first start with this version, the engine files an issue for every open item file under `.factory/inbox/` on each managed repo's and the config repo's `factory/state`, writes its record, and removes the file in the same commit. Item files of other schemas are listed in one Notice. After migration the engine reads no item files. |
| FR-17 | Our VS Code extension's inbox view is retired and the extension package removed (H-0164); nothing in the factory writes `.factory/inbox/` again. |
| FR-18 | Two GitHub modes per project (manifest, v19 H-0124): `owner_token` (default) and `machine_account` (ADR 0006). In `machine_account` mode the owner approves the PR with a GitHub review in GitHub's PR view and the required-review rule stays. |
| FR-19 | Onboarding (F-003) prepares owner-token mode: the `main` ruleset (pull request and required checks, no required review, no bypass actors; v19 H-0123), the config repo workflow, and the privacy check, applied only after the owner confirms. (v19 FR-13, F-012 H-0126.) |
| FR-20 | Routing, rendering and reading actions are code. No agent reads inbox comments or writes inbox issues (owner rule, 2026-11-13: tools, not tokens). (F-012 FR-14.) |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a new item of each kind, then within one engine poll each is an open issue in the config repo, opened by `github-actions[bot]`, assigned to the owner, with the FR-1 title and labels, its kind's template, and exactly one action comment per FR-2 action. | FR-1 to FR-4 |
| AC-2 | Given a 👍 from the owner on a non-risky action comment at the current revision, then exactly one commit on the config repo's `factory/state` appends the action (source `reaction`, comment URL, actor id) with a message starting with the item id, the engine replies `Recorded: <action>.`, and the issue closes. | FR-5, FR-7 |
| AC-3 | Given `/approve` (or the kind's command) from the owner as a comment, then the same happens as AC-2 with source `command`. | FR-5, FR-7 |
| AC-4 | Given a 👍 or command from another account, another emoji from the owner, an action on a stale revision, two different actions, or an action comment edited after posting, then nothing is recorded; the stale, two-action and edited cases get one reply giving the reason. | FR-5, SR-8 |
| AC-5 | Given 👍 on a risky action, then nothing is recorded and a confirm comment names the FR-11 target and a code; given 🚀 or `/confirm <code>` from the owner within 15 minutes at the same revision, then the action is recorded; after 15 minutes, with a wrong code, from another account, or after the item changed, nothing is recorded. | FR-6, FR-11 |
| AC-6 | Given Defer on a high-priority blocking item, then the issue stays open with label `priority:medium` and `blocking`, and the record has `deferred`; given Restore priority, then the label is `priority:high` again. | FR-8 |
| AC-7 | Given an item revised while its issue is open, then the body shows the new revision, old action comments are marked stale, new ones are posted, and a 👍 on an old one records nothing. | FR-8 |
| AC-8 | Given a factory PR marked ready, then within one poll it has exactly one engine evidence comment with the FR-9 fields, and no `factory-inbox` issue is filed for it; given `/changes <note>` from the owner on it, then the orchestrator receives the note; given the same from another account, nothing happens; given the owner merges it on GitHub, then `merged_on_github` with the merge commit is recorded. | FR-9 |
| AC-9 | Given an approved hygiene item applied as a PR with the identical diff, then the engine merges it; given one changed line, then nothing is merged and the PR gets a comment saying the diff differs. | FR-10 |
| AC-10 | Given engine code that calls a merge endpoint outside the FR-10 module, or any create-reaction endpoint, then the CI test fails and names the file and line. | FR-14 |
| AC-11 | Given the shipped query block in VS Code user settings, then the Issues view lists the owner's open inbox issues by priority, and the block contains no login, repo or user id. | FR-12 |
| AC-12 | Given a public config repo, or a second collaborator, then the engine files no issue and reports the reason. | FR-15 |
| AC-13 | Given open item files on `factory/state` before upgrade, then after first start each is an issue with a record and the file is gone, in one commit per item. | FR-16 |
| AC-14 | Given a new blocking item, then an OS notification appears on the PC within one poll while the engine runs. | FR-13 |

## 5. Constraints
- TypeScript in the engine; the issue-opening workflow is a GitHub Actions
  workflow in the config repo, shipped as a template and installed by
  onboarding (F-003).
- GitHub only for now; other hosts behind the same interface later.
- The config repo must be private with the owner as only collaborator (FR-15).
  Item text goes only there (F-012 SR-5).
- No owner-specific value (token, login, user id) in the master repo (owner
  rule, 2026-11-11). The login for assignment is the config repo variable
  `FACTORY_OWNER_LOGIN`; the user id the engine checks is in the engine's
  own config.
- Security controls cite their source; usability wins where no standard
  asks for more (owner, 2026-11-13).
- Prefer existing tools (owner, 2026-11-13): no inbox UI of our own.
- Acting needs network access to GitHub.

## 6. Edge cases
- Engine stopped: no new issues; actions wait and are read when it starts;
  a confirm older than 15 minutes is refused, so the owner confirms again.
- Owner removes a 👍 before the engine's poll: nothing recorded. After the
  poll the action stands; undoing it is a new item.
- Owner closes or deletes an issue by hand: the item stays open in the
  record; the engine reopens a closed one once with a note, and files a
  Notice for a deleted one.
- The workflow fails or Actions is down: the engine sees no issue after two
  polls, shows an OS notification and logs it; it doesn't retry in a loop.
- GitHub rate limit or outage: the engine backs off and retries on the next
  poll; nothing is recorded twice (the record keys on comment and reaction
  ids).
- PR closed, reopened or retargeted: the engine records the close; a reopened PR gets a fresh evidence comment when marked ready again.
- Base `main` moves: H-0115 updates the PR branch; its required checks run
  again on the new head, so GitHub won't merge until they are green.
- Abuse: a collaborator reacts (refused, FR-5, and FR-15 forbids them);
  item text tries to look like an action comment or command (body is a
  template with escaped, fenced fields; only marked action comments and the
  owner's own comments count); an agent writes a fake record entry (agents
  have no token and no write access to the config repo, ADR 0015).

## 7. Dependencies
- ADR 0022 (this revision), ADR 0017 (owner account, `main` without required
  review), ADR 0018 (actions proven by GitHub, now for every action).
- Engine increment 3 (acting on answers).
- F-003 onboarding, for FR-12, FR-15, FR-19; it must also stop writing
  `.factory/inbox/` (follow-up amendment, section 11).
- F-008's engine-filed Security items move to issues (H-0161).
- F-010: triage skips `factory-inbox` issues (PR #38).
- H-0115 keep-PRs-mergeable workflow.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | The baseline spec's "separate" testing and hygiene inboxes means separate item kinds, not separate screens. | OQ-1; owner, 2026-11-13 (decision card) | Approved |
| A-2 | GitHub Mobile sends a push for an issue opened by `github-actions[bot]` that assigns and @mentions the owner. Checked in a spike before build; a failure sends the spec back to the owner. | F-012 A-1 | Approved (owner, 2026-11-13); carried |
| A-3 | GitHub's merge confirmation (extension merge form, web, Mobile) counts as the confirmation step for a merge. | F-012 A-2 | Approved for Mobile (owner, 2026-11-13); extension and web to confirm |

## 9. Security considerations
Carried items keep their approval; items whose scope widens from phone
actions to every action, or that are new, are re-checked at Gate 1.

| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | External service (S9.1): GitHub only. Workflow, as `github-actions[bot]`: create issue, add labels, assign, create comment. Engine, with the owner's everyday token: list issues, comments and reactions in the config repo; create comment; update its own and the workflow's comments (to mark them stale); update issue body and labels; close and reopen issue; read PR state, merges and comments in managed repos; create comment on managed PRs (FR-9, FR-10); read the config repo's visibility and collaborators; send `repository_dispatch`; merge only under FR-10. No other call. | F-012 SR-1, widened | Proposed |
| SR-2 | The owner is proven by GitHub: an action counts only if the reacting or commenting user id is the owner's, read from the API; it is recorded with the comment URL, actor id and reaction or comment id, so the record stands if the issue is deleted (ADR 0018, ADR 0022). | F-012 SR-2, SR-13 | Proposed (widened to all actions) |
| SR-3 | Risky actions need a second explicit step naming the exact action and target, bound to the revision, expiring after 15 minutes (OWASP LLM Top 10 2025, LLM06: human approval of high-impact actions). | v19 FR-15, F-012 SR-3 | Accepted (owner, 2026-11-13) |
| SR-4 | Actions are read by code from reactions and fixed command names; comment text is never given to an agent as instructions (S9.3). Notes, including `/changes` on PRs, go to agents as data. | F-012 SR-4 | Proposed (widened) |
| SR-5 | Item content goes only to the private config repo, never to a public repo or a third-party service (owner rule, 2026-11-12). | F-012 SR-5 | Accepted (owner, 2026-11-13) |
| SR-6 | Residual risk, stated: anyone holding the owner's GitHub session or token can act as the owner on every item, from any device. The confirm step guards against a mis-tap, not a stolen account; GitHub's sign-in and 2FA are the control. Agents can't: they run without tokens (ADR 0015). | F-012 SR-6, ADR 0022 | Accepted (owner, 2026-11-13, ADR 0022 card) |
| SR-7 | No secrets or tokens in issue bodies, comments, records or logs; item text passes the secrets scan before it is rendered (S3.1). | F-012 SR-7, v19 SR-6 | Accepted (owner, 2026-11-13) |
| SR-8 | The record keeps each action comment's id and text hash and the body's hash at posting; an action on an edited comment, or on an issue whose body differs from the engine's last version, records nothing. | F-012 SR-8 | Accepted (owner, 2026-11-13) |
| SR-9 | The config repo must be private with the owner as only collaborator, checked at start and before filing (FR-15). | F-012 SR-9 | Accepted (owner, 2026-11-13); now mandatory |
| SR-10 | Fields that can carry outside text (PR titles and bodies, issue text, reviewer quotes) are rendered in fenced code blocks, with @mentions and remote images stripped, under an engine-written line naming their author. | F-012 SR-10, v19 SR-8 | Accepted (owner, 2026-11-13) |
| SR-11 | FR-10's comparison is byte for byte on `git diff --binary` from merge base to head, plus file list and modes; any difference or failure merges nothing (FR-10). | v19 SR-11 | Accepted (owner, 2026-11-13) |
| SR-12 | The config repo workflow has `permissions: issues: write` only, actions pinned by SHA, runs only on `repository_dispatch` from the engine, and executes nothing from the payload. | F-012 SR-12 | Accepted (owner, 2026-11-13) |
| SR-13 | The everyday token has no Administration permission, so it can't change the `main` ruleset; admin rights are on a separate token used only for advisories (OQ-7). Both are fine-grained with at most 90 days' expiry; a Notice 7 days before. | v19 SR-3, SR-12 | Accepted (owner, 2026-11-13) |
| SR-14 | The `main` ruleset has no bypass actors in owner-token mode, so required CI applies to every merge, including the owner's in GitHub's UI and the engine's under FR-10. | v19 SR-4 | Accepted (owner, 2026-11-13) |
| SR-15 | The engine merges only under FR-10; FR-14 enforces it in CI. Residual risk, stated: anything holding the owner's token can merge a green PR without the owner, and GitHub can't tell (v19 SR-7). | v19 SR-5, SR-7 | Accepted (owner, 2026-11-13) |
| SR-16 | The engine merges under FR-10 only on an Approve of that Hygiene item recorded under SR-2 and confirmed under SR-3 (🚀 or `/confirm <code>`), at the revision whose diff is compared. Replaces v19 SR-9 (signed approval). Residual risk, stated: anything holding the owner's GitHub session or token could approve and confirm a hygiene change, and it then reaches `main`; that holder could already merge any green PR directly (SR-15). | v19 SR-9; OQ-11 | Accepted (owner, 2026-11-13, decision card) |
| SR-17 | The engine keeps the id of every comment it posts and never reads those as commands; every engine comment template starts with a fixed word that is not a command, checked by a unit test that renders each template with fields starting `/`. | Gate 1 r2 #1 (S2.1, S6.2) | Proposed |
| SR-18 | A command is only the comment's first line and must match its fixed pattern (Gate 1 r2 #2), case-sensitive; the option or step must exist at the current revision; anything else records nothing and gets "Not recorded: not a command". A command comment edited after posting is refused (as SR-8). | Gate 1 r2 #2 (S1.1, S6.2) | Proposed |
| SR-19 | Security-category items and security notices get the title `<id> Decision (Security): needs your decision`; details only in the body. | Gate 1 r2 #3 (S3.1, S8.1; owner rule 2026-11-12) | Proposed |
| SR-20 | Migration (FR-16) carries only open items, re-renders each through its template and the secrets scan, and copies an owner action into the record only if its commit is signed per ADR 0015, otherwise drops it and notes that. | Gate 1 r2 #4 (S2.1, S3.3) | Proposed |
| SR-21 | The factory installs nothing in the owner's VS Code; onboarding offers the query block, names the extension by its id `GitHub.vscode-pull-request-github`, and states once that the extension runs with the owner's GitHub sign-in. | Gate 1 r2 #5 (S4) | Proposed |

Withdrawn from v19, because our extension no longer merges: SR-1 (head
pinned in the merge call; GitHub's required checks on the current head now
stop a merge of an unchecked push), SR-2 and SR-10 (the extension's GitHub
session), SR-13 (`approved_merge` entry; replaced by `merged_on_github` in
the record, SR-2).

## 10. Interface requirements
Drafts, not yet approved. Each is applied only after the owner approves it.

- **H-0161 (Hygiene):** engine issue store and action reader (FR-1 to FR-11,
  FR-15, FR-16); `fileSecurityItem` and `fileDecisionItem` file issues.
- **H-0162 (Hygiene):** config repo workflow template, revising F-012's
  approved H-0126 to also assign the owner and to run for every item.
- **H-0163 (Hygiene):** the `githubIssues.queries` block (FR-12) and its
  onboarding step.
- **H-0164 (Hygiene):** retire the extension package (FR-17), note on ADR
  0003 that the VS Code UI is GitHub's extension, and update
  `development-workflow.md` stage 9 and `decision-management.md` item
  kinds for issues.
- **H-0165 (Interfaces):** Inbox item v3.0, replacing v1.1 and the approved
  but unapplied v2.0 (v19 H-0120) and v2.1 and Phone issue v1.0 (F-012
  H-0125). Drafted after the open questions are decided.
- F-012's approved H-0128 (manifest `phone` block) is withdrawn: the inbox
  is always on issues, so there is nothing to turn on. v19's H-0124
  (manifest `github` block) and H-0123 (`main` ruleset) stand unchanged.

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [ ] Assumptions explicit (A-3 extension and web part pending)
- [ ] Blocking decisions resolved (OQ-13; Gate 1; H-0161 to H-0165)

Follow-ups outside this spec: F-003 stops writing `.factory/inbox/` and
installs the workflow and query block; F-010's advisory path uses the admin
token (from v19).

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 to 19 | 2026-11-13 | Files on `factory/state`, our extension, PR merge from the extension; see git history of this file for each step | Owner, 2026-11-13 (v19 Approved) |
| 20 | 2026-11-13 | Revised for ADR 0022: items are GitHub issues in the config repo, viewed in GitHub's VS Code extension and GitHub Mobile, acted on by 👍 or command comment, risky actions confirmed by 🚀 or `/confirm`; PRs merged in GitHub's PR view; F-012 folded in, F-001 view retired; migration of item files; OQ-11, OQ-12, OQ-13 opened | — (draft) |
| 21 | 2026-11-13 | OQ-11 decided (a): hygiene auto-merge kept, proven by the confirmed GitHub approval (SR-16 replaces v19 SR-9) | Owner, 2026-11-13 (decision card) |
| 22 | 2026-11-13 | OQ-12 decided (b): PRs are not inbox issues; the owner uses GitHub's PR list; the engine posts definition-of-done evidence on the PR and reads `/changes` there (FR-9); Pull request kind removed | Owner, 2026-11-13 (decision card) |
| 23 | 2026-11-13 | Security Gate 1, second review (`F-011-security-gate1-r2.md`): 0 Critical, 0 High, 2 Medium, 3 Low; SR-17 to SR-21 proposed | — |

## 13. Open questions
OQ-1 to OQ-10 are decided or withdrawn as recorded in v19 (git history);
their outcomes are carried above.

| Id | Question | Category | Status |
|---|---|---|---|
| OQ-11 | Hygiene auto-merge. v19 SR-9 let the engine merge a hygiene PR identical to an approved change only because the approval was SSH-signed, and withdraws that if signing goes; ADR 0022 removes signing. (a) Keep auto-merge, with the GitHub-proven, 🚀-confirmed approval as the proof (SR-2, SR-3); risk: anything holding your GitHub session or token could approve a hygiene change and see it reach `main`, which is already true of merging directly (SR-15). (b) Withdraw it: every hygiene PR also waits for you to merge it in GitHub's PR view. Recommended: (a). | Security | Decided (owner, 2026-11-13, decision card): (a) |
| OQ-12 | Pull requests in the inbox. (a) Keep a Pull request item issue per PR (FR-9): you get a push and see it in the same queue, and merge in GitHub's PR view from the link. (b) No issue for PRs; you find them in GitHub's PR list (the extension's Pull Requests view, Mobile), and the engine posts its definition-of-done evidence as a PR comment. With (b) you get no push for PRs the engine opens with your token, because GitHub doesn't notify you of your own PRs. Recommended: (a). | Product | Decided (owner, 2026-11-13, decision card): (b), accepting no push for PRs opened with the owner's token |
| OQ-13 | Which items notify you? v19/F-012 pushed only blocking items to the phone. Every item is now assigned to you, which notifies. (a) Every item notifies (one path; mute in GitHub settings if noisy). (b) Only blocking items notify: non-blocking ones are opened unassigned and without @mention, and need a second query in VS Code that names your config repo, set by onboarding in your user settings. Recommended: (a). | Product | Open |
