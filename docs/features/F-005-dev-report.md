# F-005 Developer completion report

- **Feature:** F-005 Answer spec questions from Claude Code, spec v5
- **Role:** software-developer
- **Date:** 2026-11-10
- **Deliverable:** `plugins/software-factory/skills/spec-interview/` (SKILL.md, `scripts/interview_client.py`, developer tests and fake engine), plugin 0.2.0
- **Contracts used:** Engine control channel v1.1 (H-0022), Role policy v2.2 (H-0023). Neither was changed.

## What changed

| File | Change |
|---|---|
| `plugins/software-factory/skills/spec-interview/SKILL.md` | New skill: relay rules (SR-2, SR-3, SR-9, SR-10), the client call pattern, new-feature and existing-feature flows, the reply loop, waiting on research, retry after a dropped connection |
| `plugins/software-factory/skills/spec-interview/scripts/interview_client.py` | New client, Python 3.10+ standard library only. Subcommands `status`, `start`, `list`, `next`, `reply`, `state`; request as one JSON object on stdin, result as one JSON object on stdout |
| `plugins/software-factory/skills/spec-interview/tests/fake_engine.py` | Fake engine: channel v1.1 on a Unix socket with the session lock per connection, revisions, `busy`, `stale`, reply ids recorded once, deferred items first, `interview.itemReady`, and switches to drop, stall or send oversized or broken answers |
| `plugins/software-factory/skills/spec-interview/tests/test_interview_client.py` | 53 developer tests |
| `plugins/software-factory/.claude-plugin/plugin.json` | Version 0.2.0; description mentions the interview |
| `.claude-plugin/marketplace.json` | Plugin description mentions the interview |
| `README.md` | New "Answer the analyst's spec questions" usage section |

## Requirement mapping

| Id | Where | Test (class.test) |
|---|---|---|
| FR-1 | Client and skill in the plugin; JSON-RPC 2.0, stdlib only | `Connect.test_ac1_*` |
| FR-2 | `find_engine_file`: `<main worktree>/.factory` must be the `refs/heads/factory/state` linked worktree in `git worktree list --porcelain -z`, not a link; `engine.json` a regular, untracked file owned by the user, opened with `O_NOFOLLOW` | `WhereEngineJsonComesFrom.*` |
| FR-3 | `start` sends `request` unchanged | `Requests.test_ac3_*` |
| FR-4 | `list` | `Requests.test_ac4_*` |
| FR-5 | `next`; order is the engine's | `Requests.test_ac5_*` |
| FR-6 | `reply` sends feature, item, revision, reply id, kind and text unchanged | `Requests.test_ac6_*`, `Display.test_owner_text_is_never_cleaned` |
| FR-7 | Engine side. The skill offers more information and shows each finding with its source | `Sessions.test_more_info_*` |
| FR-8, FR-9, FR-10 | Engine and readiness gate; the client keeps no copy | `NothingWritten.*` (FR-10 client side only) |
| FR-11 | `busy` shown with the engine's message, including when the session started | `Sessions.test_ac9_*` |
| FR-12, SR-2, SR-10 | `clean()` removes ANSI CSI/OSC sequences, Cc, Cf (bidi, zero-width), surrogates, U+2028/2029; `item_display()` fences each engine field with a fence longer than any backtick run in it; labels come from the script | `Display.*` |
| FR-13, SR-12 | Reply ids generated client-side (uuid4); on `connection_lost` or `timeout` the output carries `reply_id` and `reply_sent`; a retry with that id calls `interview.state` first and resends only if revision and status are unchanged. Never retried automatically | `Sessions.test_ac11_*`, `test_retry_*`, `test_duplicate_reply_id_*` |
| SR-1 | Abstract (`@`, NUL), relative, symlinked, non-socket and foreign-owned sockets refused; the socket's folder must be owned by the user with no group or other bits; peer uid via `SO_PEERCRED` (Linux) or `LOCAL_PEERCRED` xucred (macOS) before anything is sent; other platforms refused | `SocketChecks.*` |
| SR-3 | SKILL.md rules section | `SkillText.*` (developer check for AC-12) |
| SR-4 | No file writes, no logging; SKILL.md warns about secrets and Claude Code's own history | `NothingWritten.*` |
| SR-7 | `_PipeTransport`: local `\\.\pipe\` names only, `CreateFileW` with `SECURITY_SQOS_PRESENT \| SECURITY_IDENTIFICATION`, server process token SID compared with ours (`GetNamedPipeServerProcessId`, `OpenProcessToken`, `EqualSid`) | `SocketChecks.test_windows_pipe_names` (name check only) |
| SR-9 | Only argument is the subcommand; ids checked against `^[A-Za-z0-9_-]{1,64}$` before connecting, including ids from the engine; unknown fields refused; SKILL.md uses a quoted heredoc with one-line JSON | `Inputs.*` |
| SR-13 | Lock is per connection, so it ends when the script exits | (see open problem 1) |
| SR-15 | 1 MiB per message, 60 s per call; waiting for `interview.itemReady` uses the skill's `wait_s` instead; JSON nesting bombs fail closed | `Limits.*`, `Sessions.test_more_info_waits_past_the_call_timeout_for_item_ready` |
| SR-16 | Errors carry only code and message; `data` is never read; stdin decode errors use a fixed message; an engine message quoting the reply text is replaced | `Limits.test_error_data_*`, `test_engine_message_quoting_*`, `Inputs.test_stdin_*` |

AC-7 and AC-8 (readiness gate and the spec's assumptions table) are engine and analyst behavior; the client has no part in them and they are not tested here.

## Tests run

- `python3.11`, `python3.12`, `python3.13 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests`: 53 tests, all pass on each.
- `python3 scripts/check_docs.py`: passes.
- `claude plugin validate` on the plugin and the marketplace: passes.
- onboard-repo tests: 260 run, 1 skipped, **1 fails**: `test_acceptance.AC20Plugin.test_ac20_claude_plugin_validate_and_install` asserts `Skills \(1\)\s+onboard-repo`, and the plugin now has two skills (`Skills (2)  onboard-repo, spec-interview`). It passes with the new skill removed. This is the test engineer's test, so I did not edit it; it needs to accept more than one skill.

## Spec deviations

None intended. The points below are where the contract is silent and I chose the smallest workable reading; each needs confirming (Interfaces) before the engine is built.

## Open problems (need a decision)

1. **Session lock vs. a per-call client (Interfaces/Architecture).** Channel v1.1 binds the lock, `interview.itemReady` and "deferred first" to one long-lived connection. The skill can only run the script once per tool call, so each call is a new connection, and the lock ends when the call ends. What I built: `reply` calls `interview.next` on its own connection to take the lock, then sends the reply, which the contract allows. Consequences: (a) between calls another client can take the session; (b) "deferred first" restarts on every connection, so the engine must tell "opened" from "already shown in this session" by feature, not by connection, or a deferred question can reappear once; (c) SR-13's owner takeover of a held lock has no channel method. The alternative is a local helper process that holds the connection between calls, which adds a second local socket or pipe to secure. That is an architecture choice I did not make.
2. **`engine.json` format (Interfaces).** The contract says the path is written to `engine.json` but not how. The client reads `{"path": "<socket path or \\\\.\\pipe\\ name>"}`.
3. **Framing (Interfaces).** JSON-RPC 2.0 has no framing over a stream. The client uses one JSON message per line (UTF-8, `\n`).
4. **Error codes (Interfaces).** The contract names errors `busy`, `stale` and "unknown feature", but JSON-RPC codes are integers. The client passes the engine's code and message through and does not branch on them; the skill reacts to the words. The contract should fix numeric codes.
5. **`interview.itemReady { feature, item }`.** The client accepts `item` as a full Item or an id (then calls `interview.next`). Which one it is should be stated.
6. **Revision type.** Not stated; the client accepts a non-negative integer or an id-shaped string.

## Not done or not tested

- **Windows (SR-7).** `_PipeTransport` is written but never run: no Windows machine here. Only the pipe-name check is tested. It is isolated in one class; Gate 2 and the test engineer should treat it as untested.
- **macOS peer check.** The `LOCAL_PEERCRED` path is written from the xucred layout but only Linux was run.
- **End to end.** There is no engine (ADR 0001); everything ran against the fake engine.
- **AskUserQuestion behavior** (picker limits, free text) is described in SKILL.md and was not exercised; the skill text itself is the owner-facing part to review.
- Tests ran as root in the container, so real cross-user cases (another uid's socket or peer) are simulated by patching the uid functions.
