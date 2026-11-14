# Feature: Answer interview questions in a terminal command

- **Id:** F-018
- **Status:** Approved (owner, 2026-11-14; readiness gate passed on v8); v10 (FR-15) awaiting the owner's approval
- **Requested by / date:** Alex, 2026-11-14 ("not the analyst, the agent
  that is presenting me the questions"; "Start F-018 option B")
- **Spec version:** 10
- **Depends on:** F-005 (interview channel and MCP mode), F-006 (advisor),
  F-009 (start from a document), F-016 (PR #60, engine increment 3)

## 1. Objective and business purpose
The owner answers the requirements analyst's questions through the
`spec-interview` skill: Claude, in the owner's Claude Code, relays each item
from the engine's interview tools to the owner. The relay depends on a model
following prose rules, and it kept hiding or skipping the item's text before
the Approve / Reject picker (issue #66, the 2026-11-14 F-002 trial; H-0188
was a stopgap). The owner decides on words he never saw.

The owner chose (2026-11-14, option B) to remove the model from the path: a
terminal command, `factory-engine interview`, that prints every item word for
word from code and reads the owner's answer from the keyboard. No model sits
between the analyst's text and the owner. It works in a terminal on the
owner's PC only, with no phone support; the owner accepted that.

## 2. Expected behavior
1. In a terminal, inside a repo or config repo that belongs to a running
   factory project, the owner runs `factory-engine interview` or
   `factory-engine interview F-012`.
2. The command finds the running engine the same way the MCP mode does
   (`.factory/engine.json` in the `factory/state` worktree) and connects. If
   the engine isn't running it says so and exits. There is no fallback.
3. With no feature id, it offers a numbered menu: request a new feature
   (described, or from a document), or detail an existing one from the list
   of features with an interview waiting.
4. It opens the feature's session. If GitHub approval is needed (SR-5 of
   F-005), it prints the link `https://github.com/login/device` and the code,
   and waits until the owner approves. If another session holds the feature,
   it says when that one started and asks whether to take it over.
5. For each item it prints the whole item first, exactly as the engine's
   tools render it today: the analyst's text, why it matters, the suggested
   answer, options, findings, advice and the advisor's limits. Only then does
   it print the choices, numbered:
   - **Question:** the suggested answer, then each option, then "Type my own
     answer", "More information", "Defer" and, when the engine has the
     advisor, "Ask the advisor".
   - **Assumption:** "Approve" and "Reject".
   - **Advisor proposal:** "Approve the advisor call" and "Decline".
   - **Source confirmation:** "Confirm the list" and "Reopen some lines".
6. The owner types a number, or types an answer. What is sent is the full
   text of the picked choice or the owner's own words, never anything the
   command composed.
7. After each reply it shows the next item, or says the analyst is still
   working (and offers "Check again" or "Stop"), or that the interview is
   finished and which stage the feature moved to.
8. Ctrl+C or "Stop" closes the session so the feature is free again.
   Answered items stay answered; the owner resumes later with the same
   command.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | A new `interview` subcommand of `factory-engine`: `factory-engine interview [<feature id>] [--project <path>]`. `--project` defaults to the current folder and is used only to find `engine.json` and to resolve a relative document path, as `CLAUDE_PROJECT_DIR` is for the MCP mode. |
| FR-2 | It calls the engine through the MCP mode's existing operations (`engine/src/mcp/operations.ts`, the `Interview` class) in the same process, so engine location, channel checks, input checks, token handling, error codes and item rendering are the code F-005, F-006 and F-009 already tested. No MCP server and no model are involved. |
| FR-3 | It covers every path the skill covers (F-005 steps 1 to 4, F-006 advisor calls and proposals, F-009 document start and source confirmation): status check and version match, new feature (describe or document, with the provenance pick and the F-009 warning text), list, open, device approval with polling, busy and takeover, next, reply of every kind, `waiting` research, `advice_running`, `advisor_started`, `stale`, `session_expired`, `kind_not_allowed`, `advisor_unsupported`, and close. |
| FR-4 | Every item is printed whole before its choices, from the operation's `display` text, every time it is shown, with nothing left out. There is no code path that asks for a choice on an item it hasn't just printed. |
| FR-5 | Choices are numbered. A question's answer choices are its `suggested` answer, then its `options` in order, skipping an option equal to `suggested`; the first is marked "(recommended)" only if it is `suggested`. A question with no `suggested` answer, or an empty one, has no such choice. Picking a number sends that choice's full text exactly as the item carries it: no escapes are interpreted, so a written `\n` stays two characters (increment 3 trial, Q-006 and Q-007). |
| FR-6 | Free-text input (an answer, a feature request, a document title, "more information" text, the spec refs to reopen) is read as the owner types it, over several lines, and sent unchanged. Enter on an empty line ends it (OQ-2), so a typed text can't hold a blank line; leading and trailing empty lines are dropped. A text that is only a number is treated as a pick, and "Type my own answer" lets the owner send a number as text. |
| FR-7 | It never sends `takeover`, `ask_advisor`, `approve_advisor`, `decline_advisor`, `confirm_sources` or any reply except from the owner's own keystrokes at that prompt. It never retries a reply on its own: after `connection_lost` or `timeout` it shows the item's state and asks; only on the owner's yes does it resend with the failed call's `reply_id` (F-005 FR-13). A lost `ask_advisor` is checked as the skill does (through `next`). |
| FR-8 | It never polls on its own except for the device approval (each wait up to 120 s, until approved, failed or expired), the `wait_s` the owner chose by waiting for research, and the live-status wait of FR-14. |
| FR-9 | On Stop, end of input, Ctrl+C or SIGTERM it calls `close` for the open feature before exiting; if that fails the engine still releases the lock after 30 minutes idle (F-005 SR-13). |
| FR-10 | At start it reminds the owner, once, not to type secrets into answers, because the transcript is committed to the config repo and sent to the model provider (F-005 SR-4). |
| FR-11 | Exit codes: 0 when the owner stopped or the interview finished, 1 when the engine couldn't be reached or refused, 2 on bad arguments. |
| FR-12 | The same build retires the `spec-interview` skill, the plugin's interview MCP server (`.mcp.json`, `engine_path` setting), `factory-engine mcp`, `engine/src/mcp/server.ts` and the `@modelcontextprotocol/sdk` dependency (OQ-1, ADR 0029). The MCP acceptance tests that drive the operations move to the command (AC-11); the operations code stays. The engine README and the root README describe the command in place of the skill. |
| FR-13 | While the project manifest's `maturity` is `rapid-prototype`, interview sessions open with no GitHub sign-in (owner, 2026-11-14, 08:11Z: "fall back to no sign-in during rapid prototype", replacing the earlier once-per-run choice). `interview.open` returns an approved session with no `approval` field, and the transcript records `session_opened_without_sign_in` instead of `session_approved`. At `alpha` or higher every session needs its own approval (F-005 SR-5). The rest of the session rules (lock, takeover, 30-minute idle end, 2-hour cap) are unchanged. FR-15 makes this configurable; what FR-13 describes is its default. |
| FR-14 | **Live status (owner, 2026-11-14).** Whenever nothing is waiting for the owner (after a reply with no next item, while research runs, after opening a feature with nothing waiting), the command waits on its own and shows what the factory is doing, one line per change, with the time: for example "Analyst is reviewing your answers", "Analyst is researching", "Analyst is writing the specification", "Security reviewer is reviewing the specification", "Checking readiness", "Advisor is working". It reads the feature's `activity` from `engine.status` every 2 seconds and asks `interview.next` when the activity changes or every 15 seconds. It stops waiting and shows the item as soon as one arrives, says so when the interview is finished, and offers "Keep waiting" or "Stop" after 30 minutes. Ctrl+C stops at any time. While it waits on the engine, for this or for any call that takes over a second (opening, approval, a reply, research), the current status line carries a spinner and the elapsed time, redrawn in place about 10 times a second (owner, 2026-11-14: "a progress bar, or spinning text widget"); a spinner, not a bar, because the engine can't say how long a step will take. Consoles without Unicode get `| / - \\`. The line is cleared before anything else is printed. The status text is the command's own, chosen from the fixed `activity` codes; no engine-written text is shown as status. |
| FR-15 | **Sign-in setting per project (owner, 2026-11-14: "setting the timeout and frequency of the sign-in should be a part of the setup process"; card "Per project, asked at setup").** The manifest's optional `settings.interview_sign_in` sets how often the owner signs in to GitHub to open interview sessions: `every: never` (no sign-in; allowed only at `rapid-prototype`), `every: engine_start` (the first session after the engine starts signs in; later sessions of that run, takeovers included, don't), `every: session` (each session and takeover signs in), or `every: hours` with `hours` 1 to 168 (after a sign-in, sessions opened within that many hours don't sign in; the first one after does). A failed or abandoned sign-in covers nothing. Without the key, the level's default applies: `never` at `rapid-prototype`, `session` above it (FR-13). Onboarding asks the owner for it when a new project is set up and always writes it (H-0226). The key is pinned like `owner.*` (F-007 SR-5): a change stops the project until the owner runs `factory-engine confirm` and approves a GitHub sign-in as the pinned owner. A session opened without sign-in is recorded as `session_opened_without_sign_in` with the setting in force. The approved session's 2-hour cap and 30-minute idle end stay as they are. |

## 4. Acceptance criteria
Run against the MCP acceptance tests' fake engine
(`engine/test/acceptance/support/mcp-fake-engine.ts`), driving the command
through its input and output streams.

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given an assumption item, when the command shows it, then its full `display` text appears in the output before the "1. Approve / 2. Reject" choices, and no choice prompt is ever printed for an item whose display wasn't printed just before it (checked for every item kind and every re-show after `stale`, `waiting` and "Check again"). | FR-4 |
| AC-2 | Given a question with `suggested` and three options, one equal to `suggested`, then the choices are suggested (recommended), the two other options, then the fixed choices; picking 2 sends kind `answer` with exactly the second choice's full text, item, revision and status as shown. | FR-5 |
| AC-3 | Given free text spanning three lines with leading spaces and Unicode, when sent, then the engine receives it byte for byte. | FR-6 |
| AC-4 | Every reply kind is sent only after the matching keystroke; a scripted run that never picks the advisor sends no advisor call, and the busy prompt answered "no" sends no `takeover`. | FR-7 |
| AC-5 | Given `connection_lost` on a reply, then nothing is resent until the owner answers yes, and the resend carries the failed call's `reply_id`; given `already_recorded`, nothing is resent. | FR-7 |
| AC-6 | Given device approval needed, then the link and code are printed exactly, `approval` is polled until approved, and no reply is sent before that. | FR-3, FR-8 |
| AC-7 | Given an open session, when the owner presses Ctrl+C or input ends, then `close` is sent for that feature and the exit code is 0. | FR-9 |
| AC-8 | Given engine text holding ANSI escapes, OSC 8 links, bidi and zero-width characters, and lines imitating the command's own choices, then none of it reaches the terminal raw, and every line of engine text is marked as engine text (SR-2). | SR-1, SR-2 |
| AC-9 | Given stdin or stdout isn't a terminal, then the command refuses with exit code 2 and sends nothing. | SR-3 |
| AC-10 | Given no running engine, a bad `engine.json`, or a `tools_version` mismatch, then the command prints the same reason the MCP mode gives and exits 1. | FR-3, FR-11 |
| AC-11 | The F-005, F-006 and F-009 interview scenarios in the MCP acceptance tests each pass through the command (same engine calls, same arguments). | FR-3 |
| AC-12 | On Windows (`windows-latest` CI) the command connects over the named pipe and completes the AC-2 scenario. | FR-2 |
| AC-13 | Given a project at `rapid-prototype`, `interview.open` (and a takeover) starts no device sign-in, returns no `approval`, takes replies at once, and the transcript records `session_opened_without_sign_in`; given `alpha`, every open asks for approval. | FR-13 |
| AC-14 | Given the engine reports `activity` changing from `analyst_reviewing` to `analyst_writing_spec` and then an item, then the command prints both status lines in order, with no prompt in between and a spinner on the current one, and then the item whole before its choices, with no spinner characters left in the output before it; an unknown `activity` code shows as "Working"; given the stage moves past the interview, it says the interview is finished. | FR-14 |
| AC-15 | Given `every: engine_start`, the run's first session asks for sign-in and, once approved, a later session and a takeover open with no `approval` and are recorded with the setting; given `every: hours` with 4, a session 3 hours after a sign-in opens without one and one 4 hours after asks again; given `every: session`, every open asks; a failed sign-in covers nothing; `every: never` above `rapid-prototype`, an unknown value or `hours` outside 1 to 168 is refused when the manifest is read; changing the key stops the project until it is confirmed. | FR-15 |

## 5. Constraints
- PC terminal only: Windows Terminal or PowerShell on the owner's Windows PC,
  and macOS/Linux terminals. No phone and no Remote Control support (owner's
  choice, 2026-11-14).
- No new dependency: Node's built-in `readline` reads input (Alex's rule:
  existing tools before our own; the standard library is enough for numbered
  menus, and a prompt library would need an S4.1 review).
- No change to the Engine control channel or to the `Interview` class's
  behavior; the command is one more caller.
- Owner-facing wording only; no ids from the code beyond item and feature
  ids.

## 6. Edge cases
- Engine stops mid-interview: the next call fails with the engine's reason;
  the command says so and exits 1 after trying `close`.
- The analyst changes an item while it's on screen (`stale`): the command
  prints the new version whole and asks again; the old pick is never sent.
- A session times out after 30 minutes idle (`session_expired`): the command
  says so and offers to reopen the feature.
- Owner types a number outside the menu, or an empty line at a menu: asked
  again; nothing sent.
- A very long item (findings, advice): printed whole; the terminal scrolls.
  The command doesn't page or cut it.
- Terminal without Unicode or colour (older `cmd.exe`): text still prints;
  the engine-text marker uses plain ASCII.
- **Abuse:** engine text (from the analyst, the advisor, the web or a
  document) tries to look like the command's own prompt or a fake approval
  link, or carries terminal escapes that move the cursor, rewrite earlier
  lines, set the title or plant a clipboard (OSC 52). Handled by SR-1 and
  SR-2.
- **Abuse:** a program, or Claude through a shell tool, runs the command and
  types answers for the owner. Handled by SR-3 and F-005 SR-5/SR-14.

## 7. Dependencies
- `engine/src/mcp/operations.ts`, `items.ts`, `text.ts`, `locate.ts`,
  `client.ts` (F-005 v10, ADR 0025), unchanged.
- PR #60 (F-016) changes `operations.ts` slightly; the build starts from main
  after PR #60 merges, or merges main in then. The increment 3 trial keeps
  using the skill until then.
- Node's `readline` (standard library).

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | The owner runs the command from a terminal on the same PC as the engine, as the same OS user, in a folder inside the project's repo or config repo (the same place the skill needed). | Owner, 2026-11-14 (decision card) | Approved |
| A-2 | Printing the existing `display` text, with Markdown emphasis shown as plain text and fenced engine text shown with a margin marker, is enough for the owner to read items in a terminal; no new rendering of items is needed. | Owner, 2026-11-14 (decision card) | Approved |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | Engine text reaches the terminal only after `clean()` (`engine/src/mcp/text.ts`): ANSI CSI/OSC sequences (including OSC 8 links and OSC 52 clipboard writes), C0/C1 controls, bidi, zero-width, tag and variation-selector characters removed. The command's own colours and bold are added after cleaning and only around its own text. | Analyst (S6.1); Gate 1 #1 | Approved (owner, 2026-11-14, decision card) |
| SR-2 | Every line of engine-written text is printed with a fixed margin marker (`│ `, or `| ` without Unicode) that the command's own prompts never use, so text in an item can't pass for a menu, a link the command printed, or an approval prompt. The device approval link and code are printed by the command from the checked values only (F-005 `approval()`), never from engine text. | Analyst (S6.1); Gate 1 #2 | Approved (owner, 2026-11-14, decision card) |
| SR-3 | The command refuses to run unless stdin and stdout are both terminals (TTY), so a script or a model's shell tool can't drive it by piping answers. This narrows, and doesn't replace, F-005 SR-5 (GitHub approval per session) and SR-14 (the engine refuses agent processes it started). **Residual risk, accepted by the owner (2026-11-14):** a program the owner runs could still open a pseudo-terminal; the same residual as F-005 SR-5. | Analyst (S1.1); Gate 1 #3 | Approved (owner, 2026-11-14, decision card) |
| SR-4 | The session token stays inside the `Interview` object in this process and is never printed, logged or put in an error (F-005 SR-18 holds unchanged). The command writes nothing to disk, keeps no history of answers, and doesn't write to the shell's history (answers are read by the command, never passed as arguments). | Analyst (S3.1); F-005 SR-4, SR-9, SR-18 | Approved (owner, 2026-11-14, decision card) |
| SR-5 | Only the feature id and `--project` come from the command line; the feature id must match `^[A-Za-z0-9_-]{1,64}$`. Owner text and engine text never go on a command line or through a shell (F-005 SR-9). | Analyst (S1.3) | Approved (owner, 2026-11-14, decision card) |
| SR-6 | Errors are shown by the operation's `display` only, never the JSON-RPC `data` or the owner's reply text (F-005 SR-16). | F-005 SR-16 | Approved (owner, 2026-11-14, decision card) |
| SR-7 | Typing a reply that the engine records can't be undone in the transcript. A numbered pick is sent on Enter, not on a single keypress, so a stray key doesn't approve anything. | Analyst (S5.1); Gate 1 #4 | Approved (owner, 2026-11-14, decision card) |
| SR-8 | **Accepted risk until Alpha (owner, 2026-11-14: card on the risk, then "fall back to no sign-in during rapid prototype"):** at `rapid-prototype` there is no sign-in at all, so any program running as the owner that reaches the engine's socket or pipe can open an interview and answer, approve assumptions or confirm sources in the owner's name, at any time the engine runs. That includes agents with a shell on the PC (ADR 0026), since F-005 SR-14's protection relied on containers. SR-3's terminal check doesn't close it: a program can open a pseudo-terminal. Such answers are recorded as the owner's, and the transcript marks each such session as opened without sign-in. The risk ends when the project's maturity is raised to `alpha`. With FR-15 the same risk applies, for shorter windows, while a sign-in covers later sessions (`engine_start`, `hours`). `settings.interview_sign_in` is pinned, so an agent can't loosen it unseen; `maturity` is not, so lowering it in the config repo of a project without the key restores the no-sign-in default, which is why onboarding always writes the key. | Owner request, 2026-11-14 (S2.1, S6.2) | Accepted risk (FR-15 windows pending the owner's approval of v10) |

All of F-005 SR-1, SR-5, SR-7, SR-8, SR-10 to SR-16 and F-006/F-009 security
requirements stay in force through the shared `Interview` code; this spec
adds no new channel, file, network or permission.

## 10. Interface requirements
- **Engine control channel:** unchanged.
- **Command line:** new `factory-engine interview [<feature id>] [--project <path>]`
  (owner-facing; documented in `engine/README.md`). Not a contract between
  components, so no Interfaces decision is needed.
- **Plugin and MCP tool set (tools_version 1):** retired (OQ-1, ADR 0029).
  The change-controlled edits, one hygiene item each, applied with the build:

| Id | File(s) | Change | Status |
|---|---|---|---|
| H-0215 | `plugins/software-factory/skills/spec-interview/` (removed), `plugins/software-factory/.mcp.json` (removed), `plugins/software-factory/.claude-plugin/plugin.json` | Skill and MCP server removed; `userConfig.engine_path` removed; description names onboarding only; version 0.5.0 to 0.6.0 | Approved (owner, 2026-11-14, decision card) |
| H-0216 | `agents/requirements-analyst/AGENT.md` | "The owner answers through the engine, often from the `spec-interview` skill in Claude Code (F-005)" becomes "The owner answers through the engine, in the `factory-engine interview` terminal command (F-018)" | Approved (owner, 2026-11-14, decision card) |
| H-0217 | `.github/workflows/plugin-tests.yml` | The `spec-interview` job (skill-text tests) removed; header comment updated | Approved (owner, 2026-11-14, decision card) |
| H-0218 | `docs/adr/0029-interview-in-a-terminal-command.md` (new), ADR 0025 status, `docs/adr/README.md`, `README.md`, `engine/README.md`, a version note in F-005, F-006 and F-009 pointing their skill steps to F-018 | Record the decision and describe the command in place of the skill | Approved (owner, 2026-11-14, decision card) |
| H-0225 | `docs/interface-contracts.md` (Engine control channel, `engine.status` row) | Each feature in `engine.status` gains `activity?`, one of `analyst_reviewing`, `analyst_researching`, `analyst_writing_spec`, `security_reviewing`, `readiness_check`, `advisor_working`, `waiting_for_owner`, `paused`, `idle` (F-018 FR-14). Clients ignore codes they don't know and treat a missing `activity` as unknown | Approved (owner, 2026-11-14, decision card) |
| H-0219 | `docs/interface-contracts.md` (Engine control channel, "Owner approval" and the `interview.open` row), `docs/adr/0014-owner-approval-github-device-flow.md` (amendment note) | `interview.open` returns no `approval` when the project is at `rapid-prototype` and an earlier session of this engine run was approved (F-018 FR-13); clients treat a missing `approval` as an approved session, as with v1.1. ADR 0014 gains an amendment line pointing to F-018 FR-13 and SR-8 | Approved (owner, 2026-11-14, decision card); replaced by H-0228 |
| H-0226 | `plugins/software-factory/skills/onboard-repo/SKILL.md` (step 3), `templates/factory-project.yaml` | Onboarding asks a new project's owner for the sign-in setting, offering the level's default first, and writes `settings.interview_sign_in` (FR-15) | Drafted |
| H-0227 | `docs/interface-contracts.md` (Project manifest v1.8) | Optional `settings.interview_sign_in: { every, hours? }` as in FR-15; pinned (F-007 SR-5) | Drafted |
| H-0228 | `docs/interface-contracts.md` ("Owner approval", `interview.open` row), ADR 0014 amendment line | Replace H-0219's once-per-run text: sign-in follows the project's `settings.interview_sign_in`; `interview.open` returns no `approval` when the setting covers the session | Drafted |

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit (A-1, A-2 approved)
- [x] Blocking decisions resolved (OQ-1, OQ-2, SR-1 to SR-8, FR-14, H-0215 to H-0219, H-0225)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-14 | Draft from the owner's choice of option B | — |
| 2 | 2026-11-14 | Security Gate 1 ([F-018-security-gate1.md](F-018-security-gate1.md)): 5 findings (0 Critical, 0 High, 3 Medium, 2 Low), none blocking; SR-1 to SR-3 and SR-7 sharpened from it | — |
| 3 | 2026-11-14 | OQ-1 decided (a): retire skill, plugin MCP server, `mcp` mode and MCP SDK in this build; ADR 0029 supersedes 0025; FR-12 and section 10 rewritten, H-0215 to H-0218 drafted. OQ-2 decided (a): Enter on an empty line ends a typed answer (FR-6). A-1, A-2 and SR-1 to SR-7 approved, SR-3 residual accepted | Owner, 2026-11-14 (decision cards; recording confirmed in the thread) |
| 4 | 2026-11-14 | H-0215 to H-0218 approved; readiness gate passed; status Approved | Owner, 2026-11-14 (decision card) |
| 5 | 2026-11-14 | FR-13, AC-13, SR-8 (accepted risk) from the owner's choice "Once per engine start" for GitHub approval until Alpha; H-0219 drafted | Owner, 2026-11-14 (decision card, choice and risk); H-0219 pending |
| 6 | 2026-11-14 | H-0219 approved and applied; readiness gate passed | Owner, 2026-11-14 (decision card) |
| 7 | 2026-11-14 | FR-14 and AC-14 (live status while waiting, owner's request), FR-8 widened for it; H-0225 drafted | Owner, 2026-11-14 (decision card) |
| 8 | 2026-11-14 | FR-14 (with the spinner) and H-0225 approved; H-0225 applied; readiness gate passed | Owner, 2026-11-14 (decision card) |
| 8 | 2026-11-14 | FR-5 clarified from the increment 3 trial (no accept choice without a suggestion; exact text, no escape handling); no behaviour change beyond the approved FR-5 | — |
| 9 | 2026-11-14 | FR-13, AC-13, SR-8: no sign-in at Rapid prototype (owner's message 08:11Z), replacing once per engine run; H-0219's doc text needs a new version (H-0228) | Owner, 2026-11-14 (in words); doc text pending |
| 10 | 2026-11-14 | FR-15, AC-15: per-project sign-in setting chosen at setup (owner's card "Per project, asked at setup"); SR-8 widened; H-0226 to H-0228 drafted | Placement: owner, 2026-11-14 (decision card); FR-15 text, SR-8 and H-0226 to H-0228 pending |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | What happens to the `spec-interview` skill, the plugin's interview MCP server and the engine's `mcp` mode? (a) **Retire all of it** in the F-018 build, once PR #60 has merged and the command passes its tests: skill, `.mcp.json`, `engine_path` setting, `factory-engine mcp`, `engine/src/mcp/server.ts` and the `@modelcontextprotocol/sdk` dependency; the operations code stays as the command's engine client. ADR 0029 supersedes ADR 0025. (b) Retire the skill only; keep the `mcp` mode and plugin server unused. (c) Keep the skill beside the command as a fallback (for the phone through Remote Control), with issue #66's risk. **Recommended: (a)**: one way to answer, no model relay left to skip text, one dependency fewer to review and pin. | Architecture | Decided (owner, 2026-11-14, decision card): (a); ADR 0029 |
| OQ-2 | How does the owner finish a typed answer? (a) **Enter on an empty line** ends it, so answers can have several lines; a single-line answer is two Enters. (b) Enter sends; one line only. (c) Opens the owner's editor (Notepad on Windows) for each typed answer. **Recommended: (a)**: answers often run to a few lines, and it needs no editor setup. | Product | Decided (owner, 2026-11-14, decision card): (a) |
