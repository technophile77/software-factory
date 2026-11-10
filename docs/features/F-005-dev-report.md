# F-005 Developer completion report

- **Feature:** F-005 Answer spec questions from Claude Code, spec v6
- **Role:** software-developer
- **Date:** 2026-11-10
- **Deliverable:** `plugins/software-factory/skills/spec-interview/` (SKILL.md, `scripts/interview_client.py`, developer tests and fake engine), plugin 0.2.0
- **Contracts used:** Engine control channel v1.1 (H-0022, amended by H-0025), Role policy v2.2 (H-0023). Neither was changed by the developer.

## What changed

| File | Change |
|---|---|
| `plugins/software-factory/skills/spec-interview/SKILL.md` | New skill: relay rules (SR-2, SR-3, SR-9, SR-10), the client call pattern, keeping the session token between calls, new-feature and existing-feature flows, takeover only after the owner's yes, the reply loop, waiting on research with `wait_s`, retry after a dropped connection, closing the session |
| `plugins/software-factory/skills/spec-interview/scripts/interview_client.py` | New client, Python 3.10+ standard library only. Subcommands `status`, `start`, `list`, `open`, `next`, `reply`, `state`, `close`; request as one JSON object on stdin, result as one JSON object on stdout. One connection per run; the session is the engine's token |
| `plugins/software-factory/skills/spec-interview/tests/fake_engine.py` | Fake engine: channel v1.1 with H-0025 on a Unix socket: sessions by token with the per-feature lock and takeover, revisions, the five error codes, reply ids recorded once, each deferred item once per session, `interview.next` waiting up to `wait_s` for research, and switches to drop, stall, interleave notifications or send oversized or broken answers |
| `plugins/software-factory/skills/spec-interview/tests/test_interview_client.py` | 61 developer tests |
| `plugins/software-factory/.claude-plugin/plugin.json` | Version 0.2.0; description mentions the interview |
| `.claude-plugin/marketplace.json` | Plugin description mentions the interview |
| `README.md` | New "Answer the analyst's spec questions" usage section |

## Requirement mapping

| Id | Where | Test (class.test) |
|---|---|---|
| FR-1 | Client and skill in the plugin; JSON-RPC 2.0, stdlib only | `Connect.test_ac1_*` |
| FR-2 | `find_engine_file`: `<main worktree>/.factory` must be the `refs/heads/factory/state` linked worktree in `git worktree list --porcelain -z`, not a link; `engine.json` a regular, untracked file owned by the user, opened with `O_NOFOLLOW`, and in the H-0025 format `{version: "1.x" (x ≥ 1), path, pid > 0}` | `WhereEngineJsonComesFrom.*` |
| FR-3 | `start` sends `request` unchanged | `Requests.test_ac3_*` |
| FR-4 | `list` | `Requests.test_ac4_*` |
| FR-5 | `open` then `next`; order is the engine's (deferred first, once per session) | `Requests.test_ac5_*` |
| FR-6 | `reply` sends session, item, revision, reply id, kind and text unchanged | `Requests.test_ac6_*`, `Display.test_owner_text_is_never_cleaned` |
| FR-7 | Engine side. The skill offers more information and shows each finding with its source | `Sessions.test_more_info_*` |
| FR-8, FR-9, FR-10 | Engine and readiness gate; the client keeps no copy | `NothingWritten.*` (FR-10 client side only) |
| FR-11, SR-13 | `open` returns the session token; `busy` (-32001) is shown with the engine's message and `started_at`; `takeover` is sent only when the request asks for it, and SKILL.md asks the owner first; `close` releases the lock | `Sessions.test_ac9_*`, `test_takeover_*`, `test_open_without_takeover_*`, `test_close_*`, `Requests.test_each_call_is_its_own_connection_*` |
| FR-12, SR-2, SR-10 | `clean()` removes ANSI CSI/OSC sequences, Cc, Cf (bidi, zero-width), surrogates, U+2028/2029; `item_display()` fences each engine field with a fence longer than any backtick run in it; labels come from the script | `Display.*` |
| FR-13, SR-12 | Reply ids generated client-side (uuid4); on `connection_lost` or `timeout` the output carries `reply_id` and `reply_sent`; a retry with that id calls `interview.state` first and resends only if revision and status are unchanged. Never retried automatically. Error codes -32001 to -32005 get a `name` the skill acts on | `Sessions.test_ac11_*`, `test_retry_*`, `test_duplicate_reply_id_*`, `test_stale_revision`, `Requests.test_reply_kind_not_allowed`, `test_unknown_feature` |
| SR-1 | Abstract (`@`, NUL), relative, symlinked, non-socket and foreign-owned sockets refused; the socket's folder must be owned by the user with no group or other bits; peer uid via `SO_PEERCRED` (Linux) or `LOCAL_PEERCRED` xucred (macOS) before anything is sent; other platforms refused | `SocketChecks.*` |
| SR-3 | SKILL.md rules section | `SkillText.*` (developer check for AC-12) |
| SR-4 | No file writes, no logging; SKILL.md warns about secrets and Claude Code's own history | `NothingWritten.*` |
| SR-7 | `_PipeTransport`: local `\\.\pipe\` names only, `CreateFileW` with `SECURITY_SQOS_PRESENT \| SECURITY_IDENTIFICATION`, server process token SID compared with ours (`GetNamedPipeServerProcessId`, `OpenProcessToken`, `EqualSid`) | `SocketChecks.test_windows_pipe_names` (name check only) |
| SR-9 | Only argument is the subcommand; ids checked against `^[A-Za-z0-9_-]{1,64}$` and session tokens against `^[0-9a-f]{32}$` before connecting, including values from the engine; revisions must be non-negative integers; unknown fields refused; SKILL.md uses a quoted heredoc with one-line JSON | `Inputs.*` |
| SR-15 | One message per line, 1 MiB each, 60 s per call; `interview.next` with `wait_s` (0 to 600, the contract's cap) gets 60 s plus `wait_s`; a `more_info` reply can wait in the same run; notifications are skipped; JSON nesting bombs fail closed | `Limits.*`, `Sessions.test_more_info_*`, `Requests.test_notifications_*` |
| SR-16 | Errors carry only code, the client's name for the code, and message; stdin decode errors use a fixed message; an engine message quoting the reply text is replaced. `data` is never shown, with one exception: see below | `Limits.test_error_data_*`, `test_busy_started_at_*`, `test_engine_message_quoting_*`, `Inputs.test_stdin_*` |

AC-7 and AC-8 (readiness gate and the spec's assumptions table) are engine and analyst behavior; the client has no part in them and they are not tested here.

## Tests run

- `python3.11`, `python3.12`, `python3.13 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests`: 61 tests, all pass on each.
- `python3 scripts/check_docs.py`: passes.
- `claude plugin validate` on the plugin and the marketplace: passes.
- onboard-repo tests: 260 run, 1 skipped, **1 fails**: `test_acceptance.AC20Plugin.test_ac20_claude_plugin_validate_and_install` asserts `Skills \(1\)\s+onboard-repo`, and the plugin now has two skills (`Skills (2)  onboard-repo, spec-interview`). It passes with the new skill removed. This is the test engineer's test, so I did not edit it; it needs to accept more than one skill.

## Spec deviations

None.

**One reading of the contract to check at Gate 2.** H-0025 says a second `interview.open` gets `busy` "with `started_at`", but not where. FR-11 needs the owner to see it and SR-16 forbids showing `data`. The client reads `data.started_at` on a -32001 error only, and only if it is a plain ISO 8601 timestamp (`TIMESTAMP_RE`); everything else in `data`, and `data` on every other error, is dropped unread. If the engine puts the time in `message` instead, this path is unused.

## Open problems from the first report: resolved by H-0025

The owner approved H-0025 (2026-11-10), amending Engine control channel v1.1. The client, skill, fake engine and tests now follow it.

| # | Problem | Resolution in H-0025 | Client change |
|---|---|---|---|
| 1 | Session lock bound to a connection, but the skill runs the script once per call | Lock belongs to a session token from `interview.open`; `next`, `reply` and `close` take it; takeover with `takeover: true`; deferred items once per session | New `open` and `close` subcommands; `next` and `reply` take `session`; `reply` no longer calls `interview.next` to take the lock; SKILL.md keeps the token and asks the owner before a takeover. Per-call connections kept |
| 2 | `engine.json` format | `{version, path, pid}` | Version must be 1.x with x ≥ 1, pid a positive integer |
| 3 | Framing | One message per line, UTF-8, at most 1 MiB | Already so |
| 4 | Error codes | -32001 busy, -32002 stale, -32003 unknown feature or item, -32004 unknown or expired session, -32005 kind not allowed | Integer codes only; output adds `name`; the skill acts on the name |
| 5 | `interview.itemReady` payload | Item id, for long-lived clients; per-call clients use `interview.next` with `wait_s` (≤ 600) | itemReady handling removed; waiting is `wait_s` on `next` and after a `more_info` reply |
| 6 | Revision type | Non-negative integer | Strings refused, from the skill and from the engine |

## Not done or not tested

- **Windows (SR-7).** `_PipeTransport` is written but never run: no Windows machine here. Only the pipe-name check is tested. It is isolated in one class; Gate 2 and the test engineer should treat it as untested.
- **macOS peer check.** The `LOCAL_PEERCRED` path is written from the xucred layout but only Linux was run.
- **End to end.** There is no engine (ADR 0001); everything ran against the fake engine.
- **AskUserQuestion behavior** (picker limits, free text) is described in SKILL.md and was not exercised; the skill text itself is the owner-facing part to review.
- Tests ran as root in the container, so real cross-user cases (another uid's socket or peer) are simulated by patching the uid functions.
