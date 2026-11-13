# Feature: One inbox for all approvals

- **Id:** F-011
- **Status:** Draft
- **Requested by / date:** Alex, 2026-11-10 (one inbox rule), 2026-11-13 (PR
  approval and merge in the inbox, no machine account)
- **Spec version:** 6

## 1. Objective and business purpose
Everything the factory needs the owner to approve reaches the owner in one
place: the inbox in VS Code. Today that inbox (F-001) shows only Decision
items. Hygiene items, testing escalations, spec sign-off, maturity changes
and pull requests have no owner surface, and pull requests can only be
merged on GitHub with an admin bypass, because the owner is also the PR
author and GitHub won't let an author approve their own PR.

The owner wants the factory's work attributed to his own GitHub account, not
a machine account (ADR 0006 stays available as an option), and wants to
approve pull requests in the inbox instead of on GitHub, without bypassing
branch protection on every PR.

## 2. Expected behavior
The Factory view in VS Code shows one queue. Each item carries a label that
says what kind of approval it is (OQ-1): a Decision with one of the five
categories, a Hygiene change, a Testing escalation, a Spec sign-off, a Pull
request, a Maturity change, or a Notice that needs no action. The queue sorts
all kinds together by effective priority and age, across every open repo and
the project's config repo.

Each kind opens a card with what the owner needs to decide and only the
actions that make sense for that kind. Acting is one commit on
`factory/state`, and the engine carries out the result: it applies an approved hygiene change, moves a feature past
spec sign-off, records a maturity change, or merges an approved pull request.

**Pull requests.** When a PR is ready (stage 9, CI green), the engine files a
Pull request item. The card shows the PR title, link, the definition-of-done
evidence, the diff summary and CI state. The owner chooses **Approve and
merge**, **Request changes** (with a note, routed to the orchestrator as
review feedback), or **Defer**. The owner's click is the
approval; there is no signing step (owner, 2026-11-13, OQ-2). On that click
the extension merges the PR through GitHub with the owner's own VS Code
GitHub sign-in, pinned to the head commit the card showed, so the merge and
the PR are both attributed to the owner. On GitHub, `main` requires a pull
request and the CI checks for the repo's level, but no approving review, so
nobody needs a bypass, the owner included (ADR 0017).

PRs that the engine didn't open (for example ones made by Claude Code
sessions, or by the owner) can be listed too (OQ-6).

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | One queue in the Factory view lists every open item of every kind from every open repo's `factory/state` and the project config repo's, sorted by effective priority then age (extends F-001 FR-2, FR-12). |
| FR-2 | Every item shows a kind label: Decision (with its category), Hygiene, Testing, Spec sign-off, Pull request, Maturity, or Notice (OQ-1). The view can filter by kind and by repo. |
| FR-3 | Each kind has a card with its required fields (section 10, H-0120) and only its allowed actions: Decision as today; Hygiene: Approve, Reject, Request changes, Defer; Testing: the recommended next step or another listed step, Ask for more research, Defer; Spec sign-off: Approve, Request changes, Defer; Pull request: Approve and merge, Request changes, Defer; Maturity: Approve, Reject, Defer; Notice: Dismiss. |
| FR-4 | Every owner action is one commit on `factory/state` whose message starts with the item id. For a Pull request item the click itself is the approval and needs no signature (ADR 0017). Other kinds follow ADR 0015 (signed owner actions) unless the owner decides otherwise. |
| FR-5 | The engine acts on each approved action: applies an approved hygiene change as its own commit or PR with the item id in the message; advances a feature past spec sign-off (definition of done item 1); records an approved maturity change in the manifest; routes Request changes on a PR to the orchestrator as review feedback; merges an approved PR (FR-7). |
| FR-6 | The engine files a Pull request item when the orchestrator marks a PR ready (stage 9, CI green on the head). The card shows title, link, feature, definition-of-done evidence, files changed with additions and deletions, CI state, and whether the branch is behind `main`. |
| FR-7 | **Approve and merge** is enabled only while every required check on the PR head is green. On the click, the extension calls GitHub's merge API with the owner's VS Code GitHub sign-in, the repo's merge method, and the head commit the card showed as the expected head, then records `approved_merge` with the merge commit in the item's history. |
| FR-8 | If the PR's head changed after the card was shown, GitHub refuses the merge (expected head mismatch); the card refreshes, shows what changed, and the owner clicks again. |
| FR-9 | In owner-token mode, `main` in every managed repo has a ruleset that requires a pull request and the level's CI checks, with no required review and no bypass actors (H-0123). |
| FR-10 | Two GitHub modes per project (manifest, H-0124): `owner_token` (default; the engine opens PRs with the owner's fine-grained token; FR-7 to FR-9 apply) and `machine_account` (ADR 0006; the inbox approval submits a real GitHub approving review using the owner's VS Code GitHub sign-in, and the required-review rule stays). |
| FR-11 | Hygiene approval covers the change once: when the engine applies an approved hygiene change through a PR whose diff equals the approved diff exactly, the engine merges that PR without a second click (OQ-4). Any difference files a Pull request item instead. |
| FR-12 | The owner is told of new blocking items by the VS Code badge and notification, by an OS notification from the engine when VS Code is closed (OQ-3). Phone notifications and approving from the phone are a separate feature (owner, 2026-11-13). |
| FR-14 | A CI test in this repo fails if engine code calls GitHub's merge API anywhere except the FR-11 hygiene path (OQ-9). |
| FR-13 | Onboarding (F-003) prepares the owner-token mode: the ruleset (pull request and required checks, no required review, no bypass actors) and the token scopes, applied only after the owner confirms. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given one open item of each kind across two repos and the config repo, when the view opens, then all appear in one list sorted by effective priority then age, each with its kind label and repo. | FR-1, FR-2 |
| AC-2 | Given a filter on Pull request, then only Pull request items show, and the badge still counts all open blocking items. | FR-2 |
| AC-3 | Given a card of each kind, then it offers exactly the actions FR-3 lists for that kind. | FR-3 |
| AC-4 | Given an owner action, then exactly one commit on `factory/state` records it, its message starting with the item id; given Approve and merge, then no signing prompt or key is involved. | FR-4 |
| AC-5 | Given an approved hygiene item, then the engine applies exactly the approved diff, in one commit whose message starts with the item id. | FR-5 |
| AC-6 | Given a PR marked ready with CI green, then a Pull request item with every FR-6 field appears within one engine poll. | FR-6 |
| AC-7 | Given Approve and merge on a PR whose head is unchanged and checks are green, then the PR is merged by the owner's account and the item closes with the merge commit linked; given a required check not green, then the button is disabled. | FR-7 |
| AC-8 | Given a push to the PR after the card was shown, when the owner clicks Approve and merge, then nothing is merged and the card shows the new head. | FR-8 |
| AC-10 | Given a managed repo in owner-token mode, then its `main` ruleset requires a pull request and the level's checks, has no required review and an empty bypass list. | FR-9 |
| AC-12 | Given `machine_account` mode, when the owner approves, then a GitHub review by the owner's account is submitted on the PR's head commit. | FR-10 |
| AC-13 | Given an approved hygiene item applied as a PR with the identical diff, then the engine merges it with no Pull request item; given one changed line, then nothing is merged and a Pull request item is filed. | FR-11 |
| AC-15 | Given engine code that calls GitHub's merge endpoint (REST `PUT .../pulls/{n}/merge` or the GraphQL `mergePullRequest` mutation) outside the FR-11 module, then the CI test fails and names the file and line. | FR-14 |
| AC-14 | Given a new blocking item, then the owner is notified as OQ-3 decides within one engine poll. | FR-12 |

## 5. Constraints
- TypeScript, extends the F-001 extension and the engine (ADR 0003, ADR 0011).
- Items stay files on `factory/state` (ADR 0002, ADR 0009).
- Security controls cite the standard they come from (owner, 2026-11-13);
  the owner prefers usability where no standard asks for more.
- GitHub only for now; other hosts behind the same interface later (ADR 0006).
- No owner-specific value (token, GitHub id, key) is committed to the master
  repo; they live in the owner's engine config and repo secrets (owner rule,
  2026-11-11).
- Routing and merging are done by code, not by an
  agent (owner rule, 2026-11-13: tools, not tokens).
- Works on Windows, macOS and Linux.

## 6. Edge cases
- PR closed, reopened or retargeted while the card is open: item closes or
  refreshes.
- Base `main` moves: the keep-PRs-mergeable workflow (H-0115) updates the
  branch, the head changes, and the card refreshes (FR-8).
- Merge refused by GitHub (conflict, check failed, rate limit): item stays
  approved-not-merged, with the error; the engine retries only on a new
  check result, never in a loop.
- Owner clicks twice, or from two machines: one merge; the second gets
  "already merged".
- Owner not signed in to GitHub in VS Code: the extension asks for the
  sign-in and merges nothing until it succeeds.
- Engine token expired or revoked: engine files a Notice.
- A repo opened in VS Code without the engine running: items still list and
  actions still record; the engine acts when it starts.
- Abuse: an agent writes a fake `approved_merge` history entry (nothing
  happens: the merge is the extension's API call, not the entry), or code
  using the engine's token merges a PR (SR-7, OQ-9).

## 7. Dependencies
- F-001 extension (Decision items).
- Engine increment 3 (acting on answers) and increment 5 (Factory view).
- F-003 onboarding, for FR-13.
- H-0115 keep-PRs-mergeable workflow, for FR-8.
- ADR 0017 (supersedes ADR 0006), from proposal 0021.

- The separate phone notifications and approvals feature will reuse F-011's
  item kinds and actions.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | The baseline spec's "separate" testing and hygiene inboxes (sections 5, 6) means separate item kinds and stores, not separate screens; one queue showing all kinds, each labeled, meets it. | OQ-1 | Pending |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | The merge call carries the head commit the owner saw as the expected head, so a push after the card was shown is never merged on that click (OWASP LLM Top 10 2025, LLM06: human approval of high-impact actions). | Analyst | Proposed |
| SR-2 | The merge uses the owner's VS Code GitHub sign-in, held by VS Code; it is never written to items, logs or the engine, and agents never see it (S3.1). | Analyst (S3.1) | Proposed |
| SR-3 | The engine's token has no Administration permission, so it can't change or remove the `main` ruleset. | Analyst (S8) | Proposed; conflicts with F-010 OQ-8, see OQ-7 |
| SR-4 | The `main` ruleset has no bypass actors in owner-token mode, so required CI applies to every merge. | Analyst (S8) | Proposed |
| SR-5 | The engine merges only in FR-11 (hygiene diff identical to the approved one); it has no other merge code path. | Analyst (LLM06) | Proposed; enforced in CI by FR-14 |
| SR-6 | Tokens never appear in items, logs, commits or the Actions log (S3.1). | Analyst (S3.1) | Proposed |
| SR-7 | Residual risk, stated to the owner (OQ-9): GitHub can't tell the owner's click from anything else using the owner's credentials. The engine's token (the owner's) can merge, so an engine bug, a leaked token, or a program running as the owner could merge a PR with green CI without a click. Agents can't: they run in containers without tokens (ADR 0015). | Analyst | Stated to the owner 2026-11-13; FR-14 guards against a code change adding a merge, not against a leaked token or another program |

## 10. Interface requirements
Hygiene items named here; none filed until the open questions are answered.

- **H-0120 (Interfaces): Inbox item v2.0.** New `kind` field (decision,
  hygiene, testing, spec, pull_request, maturity, notice), per-kind required
  fields and body sections, per-kind owner actions (`approved_merge`,
  `dismissed`), and a project-level location in the config repo. Breaking
  (major) because the action set per item changes.
- **H-0121:** withdrawn (was a signed PR approval record; not needed after
  OQ-2). Free for reuse.
- **H-0122:** ADR 0017 (in this PR) and ADR 0006 marked superseded; plus `decision-management.md` and `development-workflow.md`
  ("the owner merges" becomes "the owner approves in the inbox; the engine
  merges on that approval").
- **H-0123 (Hygiene): the `main` ruleset** for owner-token mode in the
  onboarding skill (F-003 FR-10), and the same settings for this repo.
- **H-0124 (Interfaces): Project manifest v1.5 `github` block**:
  `mode: owner_token | machine_account`, `merge_method`, and where the
  owner's GitHub user id and token reference live (engine config, not the
  manifest, per the master-repo rule).

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
| 1 | 2026-11-13 | Draft with open questions OQ-1 to OQ-8 | — |
| 2 | 2026-11-13 | OQ-2 decided: the owner's click is the approval, no signing; extension merges with the owner's GitHub sign-in; CI-only ruleset. OQ-5, OQ-8 withdrawn; OQ-9 added | Owner, 2026-11-13 (thread) |
| 3 | 2026-11-13 | OQ-9 decided (b): CI test against merge calls outside the hygiene path (FR-14, AC-15) | Owner, 2026-11-13 (decision card) |
| 4 | 2026-11-13 | OQ-1 decided (a): items labeled by kind, decisions keep the five categories | Owner, 2026-11-13 (decision card) |
| 5 | 2026-11-13 | OQ-3 decided (c): VS Code, OS and phone notifications (FR-12, SR-8); OQ-10 added for the phone channel | Owner, 2026-11-13 (decision card) |
| 6 | 2026-11-13 | Phone notifications and phone approvals moved to a separate feature; F-011 keeps VS Code and OS notifications; OQ-10 withdrawn | Owner, 2026-11-13 (thread) |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | How is each item labeled? (a) Decisions keep the five categories; every other item shows its kind (Hygiene, Testing, Spec sign-off, Pull request, Maturity, Notice). (b) Every item is forced into one of the five categories. Recommended: (a). CLAUDE.md allows only five decision categories, and a hygiene change or a PR isn't a decision of any of them. | Product | Decided (owner, 2026-11-13, decision card): (a) |
| OQ-2 | How does an inbox approval become a merge without a GitHub review or bypass? (a) Signed approval record plus required check. (b) The extension merges with the owner's VS Code GitHub sign-in; `main` requires only CI. (c) Machine account (ADR 0006). **Decided (owner, 2026-11-13): the owner's click is the only thing needed for approval, no signing step; (b), with (c) kept as `machine_account` mode.** | Architecture, Security | Decided (owner, 2026-11-13, thread) |
| OQ-3 | How is the owner told of new blocking items? (a) VS Code badge and a VS Code notification only. (b) (a) plus an OS notification from the engine when VS Code is closed. (c) (b) plus a phone notification (for example an email or a GitHub notification). Recommended: (b). | Product | Decided (owner, 2026-11-13): (c), with the phone part (and approving from the phone) moved to a separate feature; F-011 does (b) |
| OQ-4 | Should an approved hygiene change need a second click for its PR? (a) No: the engine merges the PR itself if its diff equals the approved diff exactly (FR-11, SR-5). (b) Yes, always. Recommended: (a); it is the same change, and the exact comparison is done by code. | Product | Open |
| OQ-5 | Does an approval survive a merge of `main` into the PR? **Withdrawn:** with OQ-2 the merge happens on the click, so there is no stored approval to keep. | Security | Withdrawn (moot after OQ-2) |
| OQ-6 | Which PRs appear as Pull request items? (a) Only PRs the engine opened. (b) Every open PR into `main` of a managed repo, including ones by Claude Code sessions or the owner. Recommended: (b), so this repo's own PRs stop needing a bypass; the check works the same for any author. | Product | Open |
| OQ-7 | F-010 OQ-8 gave the factory token admin and advisory rights. With the owner's own token, admin would let the engine (or a leaked token) edit or remove the `main` ruleset, including its required CI. (a) Two tokens of the owner's: the everyday token (Contents, Pull requests, Issues read and write; no Administration) and a separate admin token used only by the advisory code path. (b) One token with admin, accepting that risk. Recommended: (a). | Security | Open |
| OQ-8 | How strong must the owner's approval be? **Withdrawn:** decided by OQ-2 (the click alone). | Security | Withdrawn (moot after OQ-2) |
| OQ-9 | SR-7: anything using the owner's credentials can merge without a click, and GitHub can't tell. Add a lightweight safeguard? (a) None; rely on the engine having no merge code path except FR-11. (b) A CI test in this repo that fails if engine code calls GitHub's merge API outside the FR-11 path, so a later change can't add one silently. Recommended: (b); it costs one test and no owner steps. It does not stop a leaked token or another program. | Security | Decided (owner, 2026-11-13, decision card): (b) |
| OQ-10 | Which phone channel? **Withdrawn:** moved with phone notifications and approvals to a separate feature (owner, 2026-11-13). | Product | Withdrawn |
