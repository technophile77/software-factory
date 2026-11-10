# Proposal 0015: Merge conflict resolution

**Status:** proposed, for the owner's decision. Raised by the owner on
2026-11-10. Not a decision until the owner chooses.

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
| Verify | Engine and orchestrator | Full test suite and CI on the merged result. Security Gate 2 on the resolved hunks. If the feature had already passed validation, the judge re-checks the resolved hunks against both specs. The bar is the repo's maturity level, as always. |

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
