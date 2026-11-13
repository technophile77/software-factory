# F-011 Security Gate 1, second review (inbox on GitHub issues)

- **Feature:** F-011 One inbox for all approvals, spec v22 (revision for ADR 0022)
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Earlier reviews:** `F-011-security-gate1.md` (v12) and
  `F-012-security-gate1.md` (F-012 v5). Their accepted recommendations are
  carried in v22 (SR-3, SR-8 to SR-14) and are not re-opened.
- **Maturity level:** Rapid prototype (the factory repo's level). Only
  Critical findings block there.
- **Result:** 5 findings: 0 Critical, 0 High, 2 Medium, 3 Low. Nothing
  blocks. The owner's decisions (ADR 0022, OQ-11, OQ-12) are not re-opened.
  Recommendations are proposed as SR-17 to SR-21 in the spec, for the owner
  to approve.

## What is new since the earlier reviews
1. Owner actions can be **typed commands** in comments, not only reactions.
2. Every action, not only phone taps, is proven by the owner's GitHub
   account (ADR 0022), and the engine posts its own comments (replies,
   confirm comments, PR evidence) **with that same account**.
3. Every item, including Security items, becomes an issue that pushes to
   the phone.
4. Open item files are **migrated** into issues once.
5. The VS Code view is a third-party extension (Microsoft's GitHub Pull
   Requests extension).

## Findings
| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S2.1, S6.2 | Medium | No | The engine posts replies, confirm comments and PR evidence comments with the owner's token, so GitHub shows them as written by the owner's user id, which is exactly what FR-5 accepts as an owner command. If an engine comment ever began with a command (a template bug, or a quoted field such as a PR title starting with `/approve`), the engine would read its own comment as the owner approving. | **SR-17:** the engine keeps the id of every comment it posts (in the item's record, or the feature's record for PR comments) and never reads those as commands; every engine template starts with a fixed word that is not a command; a unit test renders every template with fields starting `/` and checks the first line. |
| 2 | S1.1, S6.2 | Medium | No | Typed commands are free text. A loose parser could accept `/approve` inside a quoted reply, a code block, or a later line, or accept an option id the item doesn't have, so the owner approves something other than what they meant. | **SR-18:** a command is only the comment's first line, matching one fixed pattern per command (`^/(choose [A-Z0-9]{1,3}\|approve\|reject\|defer\|restore\|dismiss\|step [0-9]{1,2}\|confirm [A-Z0-9]{4}\|changes .+\|research .+)$`, case-sensitive, no leading quote marker); the option or step must exist on the item's current revision; anything else is not recorded and gets "Not recorded: not a command". A command comment edited after posting is refused, as for action comments (SR-8). |
| 3 | S3.1, S8.1 | Low | No | Security items now push to the phone, and an issue title shows on a locked screen and in email subjects. A title that names a vulnerability leaks it to anyone who sees the phone, against the owner's rule that vulnerability details stay private until resolved (2026-11-12). | **SR-19:** for Security-category items and security notices, the issue title is `<id> Decision (Security): needs your decision`; the details are only in the body of the private issue. |
| 4 | S2.1, S3.3 | Low | No | Migration (FR-16) reads item files that agents and onboarding wrote. Their `history` may contain owner actions (for example `deferred`) whose signatures were never checked by this code, and their text skipped the issue template's escaping. | **SR-20:** migration carries only open items; it re-renders each through its kind's template and the secrets scan; it copies an owner action into the record only if its commit is signed per ADR 0015, and otherwise drops it and notes that in the record. |
| 5 | S4 | Low | No | The VS Code view is now Microsoft's GitHub Pull Requests extension (MIT, `GitHub.vscode-pull-request-github`), running under the owner's VS Code GitHub sign-in. No factory code runs in it and the shipped query block holds no secret or owner value, but a compromised extension update could act as the owner. This is the same exposure as any extension the owner installs. | **SR-21:** the factory installs nothing on the owner's behalf; onboarding only offers the query block, names the extension by its marketplace id `GitHub.vscode-pull-request-github` so a look-alike isn't picked, and states the residual risk once. |

**Already covered by the spec or earlier decisions:** GitHub only, calls
listed (SR-1); owner id from the API (SR-2); confirm step bound to revision
and 15 minutes (SR-3, FR-6); comment text never instructs an agent (SR-4);
items only in the private, owner-only config repo (SR-5, SR-9, FR-15); stolen
session risk stated and accepted (SR-6, ADR 0022); no secrets in issues
(SR-7); edited action comments and bodies refused (SR-8); outside text fenced
(SR-10); engine never adds reactions and merges only under FR-10, both
CI-tested (FR-14); hygiene auto-merge proof stated and accepted (SR-16,
OQ-11); merges confirmed by GitHub's own dialogs, with required checks on the
current head (FR-11, SR-14).

## Threat model (S9.7)
External interactions: the GitHub API (issues, comments, reactions, PR
state, PR comments), the config repo's Actions workflow, and Microsoft's
extension in the owner's VS Code.

| STRIDE | Threat | Control |
|---|---|---|
| Spoofing | Someone other than the owner acts; the engine's own comment read as the owner's | Owner id check (SR-2); owner-only repo (SR-9); engine comment ids skipped (#1); residual: stolen owner session (SR-6, accepted) |
| Tampering | Comment or body edited after posting; command parsed loosely | Edit check (SR-8, #2); strict grammar (#2); revision binding (FR-5) |
| Repudiation | Who approved what | Record with actor id, comment or reaction id and URL (SR-2) |
| Information disclosure | Item text in a public place; Security title on a locked phone | Private owner-only repo (SR-5, SR-9); generic Security titles (#3) |
| Denial of service | Actions down, rate limit | Notice after two polls, back off, no retry loop (section 6) |
| Elevation of privilege | Engine bug merges or approves | Merge and reaction CI tests (FR-14); engine comments never commands (#1) |
