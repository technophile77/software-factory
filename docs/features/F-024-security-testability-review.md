# F-024 Security and Testability Review (requirements review)

- **Feature:** F-024 Windowed console with an agent transcript, spec v1
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`,
  plus the testability check of stage 3
- **Date:** 2026-11-20
- **Maturity level:** Rapid prototype. Only Critical findings block there
  (`security-blocking.json`).
- **Result:** 4 findings: 0 Critical, 0 High, 2 Medium, 2 Low. Nothing
  blocks. Each is covered by SR-1 to SR-4 of spec v1, which need the
  owner's approval; SR-2 carries a residual risk to accept.

## Checklist

| Question | Answer |
|---|---|
| Touches input, auth, secrets, sensitive data, dependencies, external systems? | Input: engine and agent text drawn on screen. Auth: who may read the transcript. Secrets: agents may mention them. Dependencies: Ink and React, new. External systems: none new. |
| Permissions needed; each the minimum (S8)? | One new read-only channel method, behind the existing console session. |
| New or upgraded external component; S4.1 review and CVE check? | Yes, Ink and React (SR-4). |
| Reads from or acts on anything external (S9)? | No. |
| A requirement for each? | Yes: SR-1 to SR-4. |
| Abuse cases in the edge cases? | Yes: imitated menus and escapes; a secret in an agent's message. |
| Acceptance criteria testable? | Yes. The console's state is plain TypeScript, tested without a terminal; drawing is tested with Ink's test renderer at fixed sizes (AC-1, AC-2, AC-3). |
| Needs the owner's decision (Security)? | SR-1 to SR-4, and the SR-2 residual risk. |

## Findings

| # | Severity | Finding | Covered by |
|---|---|---|---|
| 1 | Medium | Transcript text is model output steered by whatever the agent read (web pages, repo files). Drawn raw, it could carry terminal escapes (OSC 52 clipboard writes, hyperlinks) or imitate the answer bar to get a pick the owner didn't mean. | SR-1, AC-12 |
| 2 | Medium | Agents read files and run commands where secrets live. Tool output would put those on screen and in screenshots. | SR-2: tool output is never kept or sent. Residual: an agent may still quote a secret in its own words or in a command line. |
| 3 | Low | Any local program could ask for the transcript. | SR-3: approved console session of the same project only. |
| 4 | Low | Two new libraries with their own dependency trees enter the engine bundle. | SR-4: exact pins, S4.1 review and CVE check, single-file bundle. |
