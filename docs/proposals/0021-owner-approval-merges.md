# Proposal 0021: Approve and merge pull requests from the inbox, with the owner's own account

- **Raised:** 2026-11-13, by the owner: no separate GitHub account for the
  factory, work attributed to the owner, no approving PRs on GitHub, no
  admin bypass on every PR. The two-account model may stay as an option.
- **Category:** Architecture and Security
- **Status:** Decided 2026-11-13 (owner, thread, F-011 OQ-2): the owner's
  click in the inbox is the only thing needed, no signing step. That is
  option B below, with C kept as an optional mode. Recorded as
  [ADR 0017](../adr/0017-owner-account-prs-inbox-merge.md), which supersedes
  ADR 0006. Option A's analysis is kept for when the owner returns to it.

## Problem
ADR 0006 assumes a factory machine account: it opens PRs, and `main`
requires the owner's approving review, so the factory can't merge. The owner
doesn't want that account. If the factory uses the owner's own token instead,
the owner is the PR author, GitHub doesn't let an author approve their own
PR, and every merge needs an admin bypass, which is what happens today.

What has to stay true: nothing reaches `main` without the owner's decision,
and the factory (its engine, its agents, or a leaked token) can't fake that
decision.

## Options
| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Signed approval + required check (recommended)** | Owner approves in the inbox; the extension writes an approval record for the exact change (repo, PR, base, head, diff hash) in an SSH-signed commit on `factory/state` (ADR 0015). A workflow defined on `main` verifies the signature against the owner's keys on GitHub and reports `factory/owner-approval`. The ruleset on `main` requires that check and CI, has no required review and no bypass actors. The engine merges with the owner's token after re-verifying. | One account; merges and PRs attributed to the owner; no bypass for anyone; GitHub enforces it; uses the signing already decided in ADR 0015; same check works for PRs from any author | New workflow and script per managed repo; approval depends on the signing key; GitHub only sees a check, not a review, in the PR history |
| B. Extension merges directly | Owner clicks Approve; the extension calls GitHub's merge API with the owner's VS Code GitHub sign-in. `main` requires only CI. | Least to build | Nothing on GitHub stops the engine's token (also the owner's) from merging unapproved work; enforcement is only "the engine doesn't do that" |
| C. Keep ADR 0006 (machine account) | Machine account opens PRs; inbox Approve submits a real GitHub review as the owner using his VS Code GitHub sign-in; required review stays. | GitHub's own review rule; factory actions visibly separate | A second account the owner doesn't want; work attributed to the machine |

Recommendation at the time: A as the default, C as `machine_account` mode.
**Owner's decision: B, C kept as `machine_account` mode.** The owner trusts
his PC and prefers usability where no cited standard asks for more. OWASP
LLM Top 10 2025 (LLM06, excessive agency) asks for human approval of
high-impact actions, which the click is; it does not ask for signatures.

## How option A would be protected
| Attack | Stopped by |
|---|---|
| An agent writes an approval record or a `history` entry | Not signed with the owner's key; the key is never in an agent container (ADR 0015) |
| An agent adds a workflow that posts a passing `factory/owner-approval` | Role policy denies `.github/**` to every role; the engine's token has no Workflows permission, so GitHub refuses the push |
| The PR edits the approval workflow itself | The check runs from `main`'s workflow file (`pull_request_target` / dispatch on `main`) and never runs PR code |
| Approval reused for a different or changed PR | The record names repo, PR, base, head and diff hash; any mismatch fails |
| The engine merges without approval | The ruleset requires the check and has no bypass actors; the engine also re-verifies before merging |
| The engine (or a leaked token) removes the ruleset | The everyday token has no Administration permission (F-011 OQ-7) |

## Risks of option A (for reference)
1. **A program running as the owner, outside the factory's containers, can
   sign and merge.** It can use the owner's signing key and token just as
   he can. Today's decisions carry the same risk (ADR 0015). Reduced by a
   hardware-backed key that needs a touch for every signature (F-011 OQ-8).
2. **F-010 gave the factory token admin rights** for private security
   advisories. With the owner's own token, that admin right would let the
   engine change the ruleset. Proposal: a second, admin-only token used only
   by the advisory path (F-011 OQ-7).
3. **Keeping approval across a merge of `main`** (F-011 OQ-5 (b)) means the
   merged code was not exactly what the owner saw; the PR's own changes are,
   and CI runs on the merged head.
4. **Workflows permission.** Without it, the engine can't push branches that
   change `.github/workflows/`, and GitHub may refuse to merge `main` into a
   branch when that brings in workflow changes. Workflow changes in managed
   repos then go through the owner's own login (as onboarding does today,
   F-003 FR-10), and the keep-PRs-mergeable workflow labels any branch it
   can't update.

## Owner setup for option A (not needed under B)
- A fine-grained token of the owner's, limited to the factory's repos:
  Contents read and write, Pull requests read and write, Issues read and
  write, Commit statuses and Checks read, Metadata read. No Workflows, no
  Administration. Stored in the engine's config outside Git; never committed.
- The ruleset on `main`: require `factory/owner-approval` and the level's CI
  checks, no required review, no bypass list.
- An SSH signing key on the owner's GitHub account (already needed by ADR 0015).

## Outcome
ADR 0017. Residual risk under B is in F-011 SR-7, with an optional
lightweight safeguard put to the owner as F-011 OQ-9.
