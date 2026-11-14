# F-011 Security and Testability Review (requirements review)

- **Feature:** F-011 One inbox for all approvals, spec v11
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Maturity level:** Rapid prototype (the factory repo's level, as for
  F-007 to F-010). Only Critical findings block there.
- **Result:** 7 findings: 0 Critical, 0 High, 4 Medium, 3 Low. Nothing
  blocks. #1 was decided by the owner (2026-11-13, decision card): amend
  S9.6 and S9.2. The owner's decisions (OQ-1 to OQ-9, A-1, the confirmation
  dialog) are not re-opened; the findings cover what they leave. Each
  finding cites the criterion it comes from, as the owner asked
  (2026-11-13).

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S9.6, S9.2 | Medium | No | The standards still describe ADR 0006. S9.6 says agents act "under the factory's own scoped credentials, never the owner's personal accounts", and S9.2 exempts PRs because "ADR 0006" grants them. Under ADR 0017 the engine opens PRs with the owner's own token. The engine isn't an agent, and agents still never hold the token (ADR 0015), so the intent holds, but the text now contradicts an accepted ADR and Code Review would have to flag it. | **Owner decision (Security):** amend S9.6 and S9.2 through a hygiene item: agents never hold any GitHub credential; the engine may use the owner's fine-grained token in `owner_token` mode (ADR 0017); the PR exemption cites ADR 0017. Alternative: leave the text and record the exception in ADR 0017 only. |
| 2 | S6.1, S1.2, S2.1 | Medium | No | OQ-6 puts every PR into `main` in the inbox, including PRs from forks and outside contributors on public repos. Their title, body and file names are someone else's text on the card (S6.1), and one confirmed click merges them. The card and dialog don't say who wrote the PR. | Add to FR-6 and FR-15: the card and the confirmation dialog show the PR author and whether it is from a fork or an account without write access, in a fixed engine-written line above any PR text. PR text is rendered under F-001 SR-1 (no raw HTML, no remote content). No change to OQ-6. |
| 3 | S2.1, S6.2 | Medium | No | The engine's only merge (FR-11) acts on a hygiene approval. That approval is trusted because owner actions on hygiene items are signed (ADR 0015, FR-4). If signing is later dropped for other kinds, an unsigned `approved` entry on a hygiene item, which any process that can push to `factory/state` could write, would make the engine merge. | Add an SR: the engine merges under FR-11 only on a hygiene approval in a commit signed per ADR 0015. If signing for hygiene items is ever removed, FR-11 is withdrawn in the same change and hygiene PRs go through Approve and merge. |
| 4 | S8.2, S8.5 | Medium | No | VS Code's built-in GitHub sign-in grants a classic OAuth scope (`repo`) covering every repo the owner can reach, not just managed ones. The spec doesn't state this permission or its reason (S8.5). VS Code asks the owner before another extension may use the same session. | State it in section 5: the extension uses the owner's VS Code GitHub session with `repo` scope because merge needs it and VS Code offers nothing narrower; the extension calls only the merge and PR-read endpoints for repos in the project manifest, and refuses any other repo. Add that repo check to FR-7. |
| 5 | S5.1, S1.1 | Low | No | FR-11's "diff equals the approved diff exactly" needs a defined comparison. A text diff can miss mode changes, renames, binary files or symlinks. | Define it in FR-11: compare the full `git diff --binary` of the PR's merge base to head with the approved one, byte for byte, plus the file list and modes; any difference, or a failure to compute it, files a Pull request item instead (fail closed). |
| 6 | S8.2 | Low | No | The two tokens (everyday and admin, OQ-7) have no stated expiry. | Section 5: both are fine-grained tokens with an expiry of at most 90 days; the engine files a Notice 7 days before either expires and merges nothing with an expired one. |
| 7 | S9.6, S3.3 | Low | No | Merges done by the extension are logged only in the item's history. | The `approved_merge` history entry records repo, PR number, head commit, merge commit and time, and no token. GitHub's own record names the owner as merger. Nothing more is needed. |

**Already covered by the spec or decisions:** the merge is pinned to the
head commit the owner saw (SR-1); the owner's GitHub session never reaches
items, logs or the engine (SR-2); the everyday token has no Administration,
so it can't remove `main`'s required CI (SR-3, OQ-7); no bypass actors
(SR-4); the engine has no other merge path, enforced by a CI test (SR-5,
FR-14, OQ-9); risky actions need a modal confirmation that Enter and Escape
cancel (FR-15); no token in logs or commits (SR-6); residual risk of other
use of the owner's credentials stated and accepted (SR-7).

## Threat model (S9.7)
External interactions: the GitHub API (read PRs and checks; merge; open
PRs) and PR text written by other people (OQ-6).

| STRIDE | Threat | Control |
|---|---|---|
| Spoofing | Something other than the owner triggers a merge | Only the extension's confirmed click merges (FR-7, FR-15); engine has no merge path except FR-11 on a signed hygiene approval (#3); residual: other use of the owner's credentials (SR-7, accepted) |
| Tampering | PR changed after the owner looked | Expected-head merge (SR-1, FR-8) |
| Tampering | `main` protection removed | No Administration on the everyday token (SR-3); no bypass (SR-4) |
| Repudiation | Who merged what | GitHub merge record plus `approved_merge` entry (#7) |
| Information disclosure | Tokens or session leak into items or logs | SR-2, SR-6; tokens in engine config outside Git |
| Denial of service | Many outside PRs flood the queue | Items sort by priority; PR items from outside authors are labeled (#2); inbox filters by kind (FR-2) |
| Elevation of privilege | Agent forges an approval or a check | Agents hold no tokens (ADR 0015); a fake history entry does nothing for PR items; hygiene approvals are signed (#3) |

OWASP Top 10 for Agentic Applications: prompt injection through PR text is
limited to display (#2), since no agent acts on the card; tool misuse is
bounded by FR-14 and the token scopes; identity abuse is the accepted SR-7
risk. OWASP LLM Top 10 2025, LLM06 (excessive agency): the merge is a
high-impact action and needs the owner's confirmed click (FR-15).
