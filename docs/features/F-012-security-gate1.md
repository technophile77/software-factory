# F-012 Security Gate 1 (requirements review)

- **Feature:** F-012 Phone notifications and approvals, spec v5
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Maturity level:** Rapid prototype (the factory repo's level). Only
  Critical findings block there.
- **Result:** 6 findings: 0 Critical, 0 High, 3 Medium, 3 Low. Nothing
  blocks. The owner's decisions (OQ-1 to OQ-4, ADR 0018, the confirm list
  from F-011 FR-15) are not re-opened. Each finding cites its criterion.
  Recommendations are proposed as SR-8 to SR-13 in the spec, for the owner
  to approve.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S2.1, S6.2 | Medium | No | Anyone with write access to the config repo can edit the workflow's action comments and the issue body. They could swap the labels so the owner taps 👍 on "Reject" while it reads "Approve", or change the text of a confirm comment. The engine maps a reaction to an action by comment id, so the owner would approve something other than what they read. | SR-8: the engine stores each action comment's id and a hash of its text when it is posted, and refuses a tap on a comment that was edited (text differs or `updated_at` differs from `created_at`). Same for the issue body and confirm comments. |
| 2 | S8.1, S5.2 | Medium | No | Phone issues for Security items can hold vulnerability details. The owner's rule (2026-11-12) keeps those private until resolved; in a config repo with other collaborators, they'd see them. | SR-9: turning phone notifications on (FR-11) also checks that the owner is the config repo's only collaborator with access; with others, it refuses and says why. A single-owner project, the normal case, is unaffected. |
| 3 | S6.1, S9.3 | Medium | No | Item text can carry other people's words (PR titles and bodies from outside authors under F-011 OQ-6, issue text under F-010). Rendered as GitHub Markdown in the issue, it could add links, images that load from outside servers, @mentions that notify others, or text that looks like an action comment. | SR-10: the engine puts every field that can carry outside text in a fenced code block, strips @mentions and remote image links from the rendered body, and shows the author of outside text in a fixed engine-written line above it (as F-011 SR for PR cards). |
| 4 | S2.1, LLM06 | Low | No | The engine holds the owner's token, which can add reactions as the owner. A bug could add a 👍 and 🚀 itself, which ADR 0018 would accept. | SR-11: a CI test fails if engine code calls the create-reaction endpoint (REST `POST .../reactions` or the GraphQL `addReaction` mutation), in the style of F-011 FR-14. The engine only reads reactions. |
| 5 | S4, S8.2 | Low | No | The config repo workflow is new code with GitHub's `GITHUB_TOKEN`; its permissions and action pins aren't stated. | SR-12: the workflow uses `permissions: issues: write` only (no `contents: write`), actions pinned by commit SHA, and is triggered only by `repository_dispatch` from the engine with an engine-rendered body; it runs no code from the payload. |
| 6 | S3.3, S9.6 | Low | No | The record of a phone action is the history entry plus the comment URL. If the issue is deleted, the reaction and its author are gone. | SR-13: the history entry also records the reacting user id, reaction id and time read from GitHub, so the record stands without the issue. |

**Already covered by the spec or decisions:** GitHub is the only service,
with the calls listed (SR-1); a tap counts only from the owner's user id
(SR-2, ADR 0018); risky actions need a 🚀 on a comment naming the exact
action within 15 minutes and at the same revision (SR-3, FR-8); comment text
never instructs an agent (SR-4); item text goes only to the private config
repo (SR-5, FR-11); the stolen-session risk is stated and accepted (SR-6);
no secrets in issues (SR-7); PR merges stay in GitHub's own merge dialog, so
there is no new merge path (FR-9, F-011 FR-14).

## Threat model (S9.7)
External interactions: the GitHub API (issues, comments, reactions, PR
state) and the config repo's Actions workflow.

| STRIDE | Threat | Control |
|---|---|---|
| Spoofing | Someone other than the owner taps | Owner user id check (SR-2); collaborator check (#2); residual: stolen owner session (SR-6, accepted) |
| Tampering | Action comment or body edited after posting | Edit check (#1); revision binding (FR-4, FR-7) |
| Repudiation | Who approved what from the phone | History entry with comment URL, reaction id and user id (#6) |
| Information disclosure | Item text or vulnerability details reach others | Private repo, owner-only collaborators (SR-5, #2); no remote images (#3) |
| Denial of service | Workflow or Actions down | Notice after two polls (section 6); VS Code still works |
| Elevation of privilege | Engine or agent self-approves | Agents hold no tokens (ADR 0015); CI test against reaction writes (#4) |

OWASP Top 10 for Agentic Applications: prompt injection through item text
is limited to display (#3), since no agent reads the phone issue; identity
abuse is the accepted SR-6 risk; tool misuse is bounded by #4 and the
workflow permissions (#5). OWASP LLM Top 10 2025, LLM06: risky actions need
the owner's confirming tap (FR-8).
