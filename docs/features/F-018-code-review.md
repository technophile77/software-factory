# F-018 Code Review (implementation review)

- **Feature:** F-018 Answer interview questions in a terminal command, spec v10
- **Gate:** 2, implementation review against `docs/security-standards.md`, SR-1 to SR-8 and the notes for Code Review in `F-018-security-testability-review.md`
- **Code reviewed:** `engine/src/terminal/interview.ts`, `engine/src/cli.ts` (`interview`, `terminalIo`, `spinner`), `engine/src/mcp/operations.ts` (approval display, `activities`), `engine/src/channel/sessions.ts`, `engine/src/config/{manifest,pins,confirm}.ts`, `engine/src/interview/activity.ts`, the `engine.status` and session callback parts of `engine/src/engine.ts`, and the retirement of `engine/src/mcp/server.ts`, the plugin's skill and `.mcp.json`
- **Reviewer role:** security-reviewer
- **Date:** 2026-11-14
- **Maturity level:** Rapid prototype (only Critical blocks)
- **Result:** PASS. 0 Critical, 0 High, 1 Medium, 2 Low. Nothing blocks. The Medium is the owner's accepted SR-8 risk, restated here because FR-15 changes its shape.

## Security and Testability Review notes, checked

| Note | Result | Evidence |
|---|---|---|
| The token never appears in output, including after `session_expired` | Met | The token stays in `Interview.sessions`; the command prints only `display` and `approval_display` through `render()`. `terminal-f018.test.ts` "SR-4: the session token never reaches the terminal" runs a whole interview with an expired session and searches the output; `mcp-tools.test.ts` AC-14 does the same for every operation result |
| `clean()` runs on engine text before any styling, tested for OSC 52 and OSC 8 | Met | `render()` cleans each line before the margin marker is added; the command's own text is written separately. AC-8 feeds `ESC]52;c;…`, `ESC]8;;…`, a CSI clear, bidi and zero-width characters and a fake "1. Approve" line; none reaches the output raw and the fake line carries the marker |
| The TTY refusal happens before any connection | Met | `cli.ts` checks `stdin.isTTY` and `stdout.isTTY` before `Interview` is created; AC-9 spawns the built command with piped input and finds no connection on the fake engine |

## Findings

| # | Criterion | Severity | Blocks? | Location | Finding | Status |
|---|---|---|---|---|---|---|
| M1 | S2.1, S6.2 (SR-8) | Medium | No | `engine/src/channel/sessions.ts` (`needsSignIn`) | With `every: never`, `engine_start` or `hours`, a session opened without sign-in takes replies from any process running as the owner that reaches the socket or pipe, including agents with a shell (ADR 0026). The transcript records each such session as `session_opened_without_sign_in` with the setting in force, so the record never claims the owner signed in. `never` is refused above `rapid-prototype` when the manifest is read. | Accepted risk (SR-8, owner, 2026-11-14) |
| L1 | S5.1 (FR-15) | Low | No | `engine/src/config/manifest.ts` (`interviewSignIn`) | A manifest without `settings.interview_sign_in` follows the level's default, and `maturity` isn't pinned, so lowering it to `rapid-prototype` in such a manifest turns sign-in off without `factory-engine confirm`. Onboarding now always writes the key (H-0226), which closes this for new projects. | Logged; existing projects close it by adding the key |
| L2 | S6.1 (FR-14) | Low | No | `engine/src/terminal/interview.ts` (`waitForItem`) | Status lines come only from the command's fixed `ACTIVITY` table, keyed by codes the operations filter to `^[a-z_]{1,40}$`; an unknown code shows "Working". No engine-written text is shown as status. While waiting, the command calls `engine.status` every 2 s and `interview.next` every 15 s for up to 30 minutes, which is a few hundred small local calls; no budget or model cost. | Info, no change |

## Other checks

- **Pinned key (FR-15).** `comparePin` adds `settings.interview_sign_in`; a pin made before it (no field) matches a manifest without the key, so existing projects don't stop on upgrade. The inbox confirm path from increment 3 pins through `pinnedKeys`, so it carries the new key too. Tests: `units.test.ts` pins, `pinning.test.ts` PIN-2 "the interview sign-in setting".
- **Approval link.** The device link and code are printed from `approval()`'s checked values (`USER_CODE_RE`, exact `https://github.com/login/device`), never from engine text (SR-2). The link is now printed bare so a terminal makes it clickable; the Markdown form was for the retired chat skill.
- **Retirement.** `@modelcontextprotocol/sdk` is gone from `engine/package.json` and the lockfile (it stays listed only as an optional peer of the Agent SDK, not installed). `mcp-bundle.test.ts` now checks nothing from it is bundled. Removing the stdio server removes a component that read untrusted JSON from Claude Code (S8.1, S9.5).
- **No new dependency, file, port or permission.**
