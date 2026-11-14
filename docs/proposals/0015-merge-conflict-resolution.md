# Proposal 0015: Merge conflict resolution

**Status:** decided by the owner on 2026-11-10 (PR #14 comment): Q1 A and
Q2 approved. Recorded as ADR 0013.

## What is decided today

ADR 0007: after any feature merges to `main`, the orchestrator rebases every
other active feature branch and reruns its tests before its next gate. A
conflict it can't resolve without changing approved behavior goes to the
Testing inbox; a conflict between two features' contract changes goes to the
Decision inbox (Interfaces). ADR 0005: the orchestrator merges agent
branches into the feature branch at gates.

## Gaps

1. **Who edits the code.** The orchestrator's role policy lets it run `git`
   but write only `.factory/` (least privilege, S8.1), so it can't fix a
   conflict in source, tests, or docs itself.
2. **Rebase vs. engine checkpoints.** ADR 0012 has the engine commit after
   every agent edit. Rebasing rewrites those commits and needs force pushes.
3. **Which checks rerun.** Only "tests" are named, not CI, security, or the
   judge.
4. **Limits.** No cap on resolution attempts.
5. **Conflicts inside one feature**, between its own agent branches at a
   gate, and conflicts in change-controlled files are not covered.

## Proposed process

| Step | Who | What |
|---|---|---|
| Detect | Orchestrator | After each merge to `main`, merge `main` into every active feature branch (Q1). Clean merges go straight to verification. |
| Classify | Orchestrator | By file: lockfiles and generated files; source; tests; spec and docs; interface contracts; change-controlled files. |
| Resolve | The role that owns the files | Lockfiles and generated files: software developer regenerates them with the repo's tooling. Source: software developer. Tests: test engineer (the developer may not write tests). Feature spec: requirements analyst. Each works on its own agent branch, keeps the approved behavior of **both** sides, and records what it chose and why in its agent report. |
| Verify | Engine and orchestrator | Full test suite and CI on the merged result. Code Review on the resolved hunks. If the feature had already passed validation, the judge re-checks the resolved hunks against both specs. The bar is the repo's maturity level, as always. |

**Escalation**, using the existing inboxes:
- Resolving it would change approved behavior of either feature: Testing inbox.
- Two features change the same interface contract: Decision inbox, Interfaces.
- Two approved specs contradict each other: Decision inbox, Product.
- A change-controlled file conflicts: never resolved by an agent; it becomes a Configuration hygiene item.
- Three failed resolve-and-verify cycles, the same limit as product fixes: Testing inbox.

## Decisions needed

### Q1. Merge or rebase `main` into feature branches (Architecture)

| Option | Pros | Cons |
|---|---|---|
| **A. Merge `main` in (recommended)** | No history rewrite or force push; engine checkpoints (ADR 0012) stay valid; each conflict resolution is one reviewable commit | Feature branch history has merge commits (gone after the squash merge, ADR 0005) |
| B. Rebase (as ADR 0007 says today) | Linear branch history | Rewrites checkpoints, needs force pushes, and replays conflicts commit by commit |

Option A amends ADR 0007's wording.

### Q2. Approve the process above (Architecture)

Who resolves, what reruns, and when it escalates, as in the table.

## Recommendation

A for Q1, and approve the process. The orchestrator AGENT.md, the workflow,
and ADR 0007 are then amended through hygiene items (H-0031 onward).

## Owner decisions and clarifications (2026-11-10)

- **Q1:** A. Merge `main` into feature branches.
- **Q2:** approved.
- **Does the requirements analyst need an interactive session?** No. It
  resolves a spec conflict from the two approved specs, non-interactively,
  and may only combine them; it can't change an approved requirement. When
  the two specs can't both hold, that is a Product decision for the owner,
  which is the interactive step.
- **Where do questions raised during a merge go?** Into the existing inboxes
  under the five existing categories (no new "merge" category, CLAUDE.md
  rule 5): Product for behavior, Interfaces for contracts, Architecture for
  design, and the Testing inbox for a resolution that failed verification.
  Each item's `links` names both features and the merge commit, and its
  title starts with "Merge conflict:", so they're easy to find. While an item
  is open, that feature waits at the merge; other features continue.
