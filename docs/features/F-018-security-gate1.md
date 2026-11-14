# F-018 Security Gate 1 (requirements review)

- **Feature:** F-018 Answer interview questions in a terminal command, spec v1
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-14
- **Maturity level:** Rapid prototype (the engine repo's level). Only
  Critical findings block there.
- **Result:** 5 findings: 0 Critical, 0 High, 3 Medium, 2 Low. Nothing
  blocks. All five are covered by SR-1 to SR-3 and SR-7 in spec v2, which
  need the owner's approval with the rest of section 9.
- **Not re-opened (owner decisions):** PC terminal only, no phone (option B,
  2026-11-14); GitHub device approval per session and its recorded residual
  risk (F-005 SR-5, ADR 0014); agents on the owner's PC until Beta (ADR 0026).

## Gate 1 checklist

| Question | Answer |
|---|---|
| Touches input, auth, secrets, sensitive data, dependencies, external systems? | Input: the owner's keystrokes, the command line, and engine text printed to a terminal (analyst, advisor, web findings, document quotes). Auth: the interview session token and device approval, both handled by the existing `Interview` code. Secrets: none new; the owner may still type one into an answer (F-005 SR-4). Dependencies: none new (Node `readline`). External systems: none new; the engine reaches GitHub and the model provider as before. |
| Permissions needed; each the minimum (S8)? | The command runs as the owner, reads `engine.json` and connects to the owner-only socket or pipe, exactly as the MCP mode does. No new permission. If OQ-1 (a) is chosen, the plugin's MCP server and `@modelcontextprotocol/sdk` go away, which removes a component (S8.1, S9.5). |
| New or upgraded external component; S4.1 review and CVE check? | None. A prompt library was considered and not used (spec section 5). |
| Reads from or acts on anything external; scope, irreversible actions, threat model (S9)? | No new external interaction. Replies are recorded in the owner's own config repo by the engine, as today; they are the owner's own actions, not S9.2 actions. No S9.7 threat model is needed; the abuse cases below cover the terminal. |
| A requirement for each? | Yes after v2: SR-1 to SR-7. |
| Abuse cases in the edge cases? | Added to section 6: engine text forging prompts or using terminal escapes; a program driving the command. |
| Needs the owner's decision (Security)? | Approval of SR-1 to SR-7, and the SR-3 residual risk (a program the owner runs can open a pseudo-terminal). |

## Findings

| # | Severity | Criterion | Finding | Requirement |
|---|---|---|---|---|
| 1 | Medium | S1.2, S6.1 | A terminal interprets escape sequences. Engine text, which can come from a web page or a document, could move the cursor and overwrite the item on screen, set the window title, write the clipboard (OSC 52) or show a disguised link (OSC 8). The MCP mode's `clean()` already removes these for the skill; the spec must require it for every byte of engine text the command prints, and the command's own styling must be added after cleaning. | SR-1 |
| 2 | Medium | S6.1 | In a chat, engine text sits in fenced blocks. In a terminal, fence markers are plain text, so an item could hold lines like "1. Approve" or "Open https://github.com/login/device and enter code ..." that look like the command's own output. Each engine line needs a marker the command never uses itself, and the approval link and code must come only from the checked approval values. | SR-2 |
| 3 | Medium | S6.2, S8.1 | Without a model in the path, anything that can run the command and write to its stdin could answer for the owner, including Claude Code's own shell tool if the owner ran it there. F-005 SR-5 (approval per session) and SR-14 (engine refuses its own agents) still apply; refusing non-terminal stdin and stdout closes the simple case. A program that opens a pseudo-terminal remains, the same residual F-005 SR-5 records. | SR-3 |
| 4 | Low | S5.1 | A single-key menu (no Enter) would let a stray keypress approve an assumption, and the transcript is append-only. | SR-7 |
| 5 | Low | S3.1 | If owner text were ever accepted as a command-line argument (for example `--answer`), it would land in shell history and process listings. The spec takes only the feature id and `--project` from the command line. | SR-4, SR-5 |

## Notes for Gate 2

- Check that the token never appears in output, including in an error after
  `session_expired` (F-005 SR-18 tests apply to the command's output too).
- Check `clean()` is applied to engine text before any styling, with a test
  for OSC 52 and OSC 8 specifically.
- Check the TTY refusal happens before any connection.
