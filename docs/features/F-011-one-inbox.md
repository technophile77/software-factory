# Feature: One inbox for all approvals

- **Id:** F-011
- **Status:** Draft
- **Requested by / date:** Alex, 2026-11-10 (one inbox rule), 2026-11-13 (PR
  approval and merge in the inbox, no machine account)
- **Spec version:** 1

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
actions that make sense for that kind. Acting is one signed commit on
`factory/state`, as for decisions today (ADR 0015), and the engine carries
out the result: it applies an approved hygiene change, moves a feature past
spec sign-off, records a maturity change, or merges an approved pull request.

**Pull requests.** When a PR is ready (stage 9, CI green), the engine files a
Pull request item. The card shows the PR title, link, the definition-of-done
evidence, the diff summary and CI state. The owner chooses **Approve and
merge**, **Request changes** (with a note, routed to the orchestrator as
review feedback), or **Defer**. Approve records a signed approval bound to
the exact change (repo, PR number, base and head commits, diff hash). The
engine then merges the PR with the owner's own token, so the merge and the
PR are both attributed to the owner. On GitHub, `main` no longer requires an
approving review; it requires a status check, `factory/owner-approval`,
that passes only when a signed owner approval for that exact change exists
(OQ-2, proposal 0021). Nobody bypasses the rules, the owner included.

PRs that the engine didn't open (for example ones made by Claude Code
sessions, or by the owner) can be listed too (OQ-6).

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | One queue in the Factory view lists every open item of every kind from every open repo's `factory/state` and the project config repo's, sorted by effective priority then age (extends F-001 FR-2, FR-12). |
| FR-2 | Every item shows a kind label: Decision (with its category), Hygiene, Testing, Spec sign-off, Pull request, Maturity, or Notice (OQ-1). The view can filter by kind and by repo. |
| FR-3 | Each kind has a card with its required fields (section 10, H-0120) and only its allowed actions: Decision as today; Hygiene: Approve, Reject, Request changes, Defer; Testing: the recommended next step or another listed step, Ask for more research, Defer; Spec sign-off: Approve, Request changes, Defer; Pull request: Approve and merge, Request changes, Defer; Maturity: Approve, Reject, Defer; Notice: Dismiss. |
| FR-4 | Every owner action is one commit on `factory/state` signed with one of the owner's SSH signing keys listed on GitHub (ADR 0015). The engine acts only on signed owner actions and files a Security alert for an unsigned or wrongly signed one. |
| FR-5 | The engine acts on each approved action: applies an approved hygiene change as its own commit or PR with the item id in the message; advances a feature past spec sign-off (definition of done item 1); records an approved maturity change in the manifest; routes Request changes on a PR to the orchestrator as review feedback; merges an approved PR (FR-7). |
| FR-6 | The engine files a Pull request item when the orchestrator marks a PR ready (stage 9, CI green on the head). The card shows title, link, feature, definition-of-done evidence, files changed with additions and deletions, CI state, and whether the branch is behind `main`. |
| FR-7 | **Approve and merge** writes a PR approval record (H-0121) naming repo, PR number, base branch, head commit, and a hash of the PR's diff against its merge base. The engine re-verifies the signature and that the PR still matches the record, waits for every required check including `factory/owner-approval` to pass, then merges with the owner's token using the repo's merge method. It never merges without a matching signed record. |
| FR-8 | A new commit on the PR after approval invalidates the approval, except a merge of `main` whose result leaves the PR's own diff unchanged (OQ-5). An invalidated item goes back to open with the reason shown. |
| FR-9 | `factory/owner-approval` is a required status check on `main` in every managed repo in owner-token mode. It is computed by a GitHub Actions workflow defined on `main`, never from the PR's own files, and passes only if a valid signed approval record for the PR's current change exists (H-0123). |
| FR-10 | Two GitHub modes per project (manifest, H-0124): `owner_token` (default; engine uses the owner's fine-grained token; FR-7 to FR-9 apply) and `machine_account` (ADR 0006; the inbox approval submits a real GitHub approving review using the owner's VS Code GitHub sign-in, and the required-review rule stays). |
| FR-11 | Hygiene approval covers the change once: when the engine applies an approved hygiene change through a PR whose diff equals the approved diff exactly, the hygiene item's signed approval satisfies FR-7 and FR-9 for that PR, with no second approval (OQ-4). Any difference needs a Pull request approval. |
| FR-12 | The owner is told of new blocking items outside the Factory view (OQ-3). |
| FR-13 | Onboarding (F-003) prepares the owner-token mode: the approval workflow file, the ruleset (required checks, no required review, no bypass actors), and the token scopes, applied only after the owner confirms. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given one open item of each kind across two repos and the config repo, when the view opens, then all appear in one list sorted by effective priority then age, each with its kind label and repo. | FR-1, FR-2 |
| AC-2 | Given a filter on Pull request, then only Pull request items show, and the badge still counts all open blocking items. | FR-2 |
| AC-3 | Given a card of each kind, then it offers exactly the actions FR-3 lists for that kind. | FR-3 |
| AC-4 | Given an owner action, then exactly one signed commit on `factory/state` records it; given the same action in an unsigned commit, then the engine ignores it and files a Security alert. | FR-4 |
| AC-5 | Given an approved hygiene item, then the engine applies exactly the approved diff, in one commit whose message starts with the item id. | FR-5 |
| AC-6 | Given a PR marked ready with CI green, then a Pull request item with every FR-6 field appears within one engine poll. | FR-6 |
| AC-7 | Given Approve and merge on a PR whose head is unchanged and checks are green, then the PR is merged by the owner's account and the item closes with the merge commit linked. | FR-7 |
| AC-8 | Given an approval record whose head commit differs from the PR's head, then `factory/owner-approval` fails and the engine does not merge. | FR-7, FR-8, FR-9 |
| AC-9 | Given an approved PR to which `main` is merged cleanly and the PR's diff hash is unchanged, then the approval still holds (if OQ-5 (b)); given any other new commit, then the item reopens with the reason. | FR-8 |
| AC-10 | Given a PR with no approval record, a record signed by a key not on the owner's GitHub account, or a record for another PR, then `factory/owner-approval` fails. | FR-9 |
| AC-11 | Given a PR that adds or changes a workflow which reports a check named `factory/owner-approval`, then the push is refused by GitHub (token has no Workflows permission) or the role policy, and the real check still decides. | FR-9, SR-3 |
| AC-12 | Given `machine_account` mode, when the owner approves, then a GitHub review by the owner's account is submitted on the PR's head commit. | FR-10 |
| AC-13 | Given an approved hygiene item applied as a PR with the identical diff, then `factory/owner-approval` passes without a Pull request item; given one changed line, then it fails and a Pull request item is filed. | FR-11 |
| AC-14 | Given a new blocking item, then the owner is notified as OQ-3 decides within one engine poll. | FR-12 |

## 5. Constraints
- TypeScript, extends the F-001 extension and the engine (ADR 0003, ADR 0011).
- Items stay files on `factory/state` (ADR 0002, ADR 0009); owner actions are
  SSH-signed commits (ADR 0015).
- GitHub only for now; other hosts behind the same interface later (ADR 0006).
- No owner-specific value (token, GitHub id, key) is committed to the master
  repo; they live in the owner's engine config and repo secrets (owner rule,
  2026-11-11).
- Verification is done by code (engine and a workflow script), not by an
  agent (owner rule, 2026-11-13: tools, not tokens).
- Works on Windows, macOS and Linux.

## 6. Edge cases
- PR closed, reopened, or retargeted after approval: approval no longer
  applies; item reopens or closes.
- Base `main` moves while waiting for checks: handled by the keep-PRs-mergeable
  workflow (H-0115) and FR-8.
- Merge refused by GitHub (conflict, check failed, rate limit): item stays
  approved-not-merged, with the error; the engine retries only on a new
  check result, never in a loop.
- Owner approves the same PR twice, or approves from two machines: one merge.
- Approval record present but `factory/state` not reachable from Actions
  (branch deleted, force-pushed): check fails closed.
- Signing key removed from GitHub after approval: check fails; owner re-approves.
- Owner's token expired or revoked: engine files a Notice and merges nothing.
- A repo opened in VS Code without the engine running: items still list and
  actions still record; the engine acts when it starts.
- Abuse: an agent writes a fake approval record, a fake `history` entry, or a
  workflow that posts a passing check (SR-1 to SR-4).

## 7. Dependencies
- F-001 extension (Decision items) and its signed-actions follow-up (ADR 0015).
- Engine increment 3 (acting on answers) and increment 5 (Factory view).
- F-003 onboarding, for FR-13.
- H-0115 keep-PRs-mergeable workflow, for FR-8.
- Proposal 0021 decided (OQ-2), then an ADR superseding ADR 0006.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | The baseline spec's "separate" testing and hygiene inboxes (sections 5, 6) means separate item kinds and stores, not separate screens; one queue showing all kinds, each labeled, meets it. | OQ-1 | Pending |
| A-2 | The owner's SSH signing key is never inside an agent container (ADR 0015), so an agent cannot produce a signed approval. | ADR 0015 | Pending |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | An approval counts only if its commit is signed by a key listed on the owner's GitHub account and its record matches the PR's current repo, number, base, head and diff hash. Anything else fails closed. | Analyst (S8) | Proposed |
| SR-2 | The approval check runs from `main`'s workflow file (`pull_request_target` or dispatch on `main`), never checks out or runs PR code, and has read-only permissions except `checks: write`/`statuses: write`. | Analyst (S1, S8.3) | Proposed |
| SR-3 | The engine's token has no Workflows and no Administration permission, so nothing the engine pushes can add a workflow that forges the check, or change the ruleset. Role policy also denies `.github/**` to every role (Role policy v2.6). | Analyst (S8) | Proposed; conflicts with F-010 OQ-8, see OQ-7 |
| SR-4 | The ruleset on `main` has no bypass actors in owner-token mode, so the owner's token (and so the engine) can merge only through the check. | Analyst (S8) | Proposed |
| SR-5 | The engine re-verifies the signature and the record itself before calling merge, so a forged passing check alone never causes a merge. | Analyst | Proposed |
| SR-6 | Tokens never appear in items, logs, commits or the Actions log (S3.1). | Analyst (S3.1) | Proposed |
| SR-7 | Residual risk, to be stated to the owner and accepted or reduced (OQ-8): a program running as the owner on his machine, outside the factory's containers, can use his signing key and token, and so approve and merge. | Analyst | Open |

## 10. Interface requirements
Hygiene items named here; none filed until the open questions are answered.

- **H-0120 (Interfaces): Inbox item v2.0.** New `kind` field (decision,
  hygiene, testing, spec, pull_request, maturity, notice), per-kind required
  fields and body sections, per-kind owner actions (`approved_merge`,
  `dismissed`), and a project-level location in the config repo. Breaking
  (major) because the action set per item changes.
- **H-0121 (Interfaces): PR approval record v1.0.** A file on `factory/state`
  at `.factory/approvals/<repo>/<pr>.yaml` with repo, pr, base, head, merge
  base, diff hash (sha256 of `git diff --binary <merge-base> <head>`), the
  item id, and approval time; valid only in a commit signed per ADR 0015.
- **H-0122 (Architecture): ADR superseding ADR 0006**, from proposal 0021
  once decided; plus `decision-management.md` and `development-workflow.md`
  ("the owner merges" becomes "the owner approves in the inbox; the engine
  merges on that approval").
- **H-0123 (Hygiene): the approval check.** `.github/workflows/owner-approval.yml`
  and `scripts/verify_owner_approval.py` for the factory repo, and the same
  in the onboarding template for managed repos.
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

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | How is each item labeled? (a) Decisions keep the five categories; every other item shows its kind (Hygiene, Testing, Spec sign-off, Pull request, Maturity, Notice). (b) Every item is forced into one of the five categories. Recommended: (a). CLAUDE.md allows only five decision categories, and a hygiene change or a PR isn't a decision of any of them. | Product | Open |
| OQ-2 | How does an inbox approval become a merge without a GitHub review or bypass? (a) Signed approval record plus required `factory/owner-approval` check; engine merges with the owner's token (proposal 0021 option A). (b) The extension merges directly with the owner's VS Code GitHub sign-in; `main` requires only CI. (c) Keep ADR 0006: machine account opens PRs, inbox submits the owner's real review. Recommended: (a) as default, (c) kept as the `machine_account` mode. (b) leaves nothing on GitHub that stops the engine's token merging unapproved work. | Architecture, Security | Open |
| OQ-3 | How is the owner told of new blocking items? (a) VS Code badge and a VS Code notification only. (b) (a) plus an OS notification from the engine when VS Code is closed. (c) (b) plus a phone notification (for example an email or a GitHub notification). Recommended: (b). | Product | Open |
| OQ-4 | Should an approved hygiene change need a second approval for its PR? (a) No, if the PR's diff equals the approved diff exactly (FR-11). (b) Yes, always. Recommended: (a); it is the same change, and the hash check makes it exact. | Product | Open |
| OQ-5 | After approval, `main` is merged into the PR (H-0115). (a) Any new commit needs re-approval. (b) A merge of `main` that leaves the PR's own diff hash unchanged keeps the approval; anything else reopens it. Recommended: (b); otherwise every merge to `main` re-asks for every open PR. Risk of (b): the merged result can still behave differently from what was approved when `main`'s changes interact with the PR's; required CI on the new head is the guard. | Security | Open |
| OQ-6 | Which PRs appear as Pull request items? (a) Only PRs the engine opened. (b) Every open PR into `main` of a managed repo, including ones by Claude Code sessions or the owner. Recommended: (b), so this repo's own PRs stop needing a bypass; the check works the same for any author. | Product | Open |
| OQ-7 | F-010 OQ-8 gave the factory token admin and advisory rights. With the owner's own token, admin would let the engine (or a leaked token) edit or remove the `main` ruleset and merge anything. (a) Two tokens of the owner's: the everyday token (Contents, Pull requests, Issues, Checks read; no Workflows, no Administration) and a separate admin token used only by the advisory code path. (b) One token with admin, accepting that risk. Recommended: (a). | Security | Open |
| OQ-8 | How strong must the owner's approval be? (a) The existing SSH signing key (ADR 0015); residual risk SR-7. (b) A hardware-backed signing key that needs a touch for each signature (for example a FIDO `ed25519-sk` key or Windows Hello), so a program can't sign without the owner present. (c) GitHub device approval on the phone per merge (as ADR 0014). Recommended: (a) now, (b) before Alpha. | Security | Open |
