# 0018. Owner actions from the phone are proven by the owner's GitHub account

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner (thread "Approve inbox items from my phone", decision card)
- **Decision item:** F-012 OQ-2

## Problem
ADR 0015 decision 3 counts an owner action only if its commit is signed with
one of the owner's SSH signing keys. F-012 lets the owner act on inbox items
from the phone by tapping a reaction on a GitHub issue. A phone can't make an
SSH-signed commit, so under ADR 0015 nothing could be finished from the phone.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. Accept a reaction by the owner's GitHub account as proof for phone actions** | Phone actions finish on the phone; GitHub's sign-in and 2FA prove the owner | Anyone with the owner's GitHub session or token can act as the owner |
| B. Record phone taps as pending; a signed confirm in VS Code finishes them | Keeps ADR 0015 unchanged | Nothing finishes from the phone, which defeats the feature |

## Implications
- **Security, residual risk (stated to the owner):** anyone holding the
  owner's GitHub session or token can tap as the owner, for example someone
  with the owner's unlocked phone signed in to GitHub, or a leaked copy of
  the engine's token. The confirm tap for risky actions guards against a
  mis-tap, not a stolen account. GitHub's sign-in and 2FA are the control,
  the same one PR merges rely on under ADR 0017. Agents can't act: they run
  in containers without tokens (ADR 0015 decision 1).
- **Standards:** OWASP LLM Top 10 2025, LLM06 (excessive agency): high-impact
  actions need human approval; the owner's tap, authenticated by GitHub, is
  that approval.

## Decision
1. An owner action recorded from the phone counts if it comes from a
   reaction made by the GitHub user id configured as the owner, on an action
   comment of the item's current revision (F-012 FR-4, FR-8).
2. The engine records it on `factory/state` with `via: phone` and
   `ref: <action comment URL>`, and checks the reaction's author through the
   GitHub API before acting; the record is not signed.
3. Every other owner action keeps ADR 0015 decision 3.

## Consequences
- Amends ADR 0015 decision 3 for phone actions only.
- The engine's Security alert for an unsigned owner action skips entries with
  `via: phone` whose reaction the engine has verified, and still fires for an
  unsigned entry without one.
