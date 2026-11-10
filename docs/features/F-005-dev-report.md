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
| `plugins/software-factory/skills/spec-interview/tests/test_interview_client.py` | 78 developer tests (after fix round 2) |
| `plugins/software-factory/skills/onboard-repo/scripts/factory_check.py` | Fix round 1: `network.allow` host validation; project-level policy checked on its own |
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

After fix round 2, on each of `python3.11`, `python3.12` and `python3.13`:

- spec-interview, both suites (`python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests`): 220 run, all pass (78 developer tests; the rest are the test engineer's as of e5064bc).
- onboard-repo, both suites: 266 run, 265 pass, 1 skipped (Python 3.10 not installed).
- `python3 scripts/check_docs.py`: passes.

## Fix round 1 (test report and Gate 2)

Inputs: `F-005-test-report.md` (af53d11, failures F1 to F4, observation O2) and `F-005-security-gate2.md` (6fdd048). The test engineer's tests were not edited. New developer tests are in `test_interview_client.py` class `FixRound1`, and in onboard-repo `test_factory_check.py` class `F005GateRegressions`.

| Item | Fix | Test |
|---|---|---|
| F1: ids with a trailing newline accepted (`$` with `.match`) | Every pattern (`ID_RE`, `SESSION_RE`, `TIMESTAMP_RE`, `ENGINE_VERSION_RE`, `PIPE_RE`, `VERSION_RE`) is used with `fullmatch` | `test_f1_*`; test engineer's `SR09Ids` |
| F2, Gate 2 #7: lone surrogate gave a traceback after connecting | `_validate` refuses any string that won't encode as UTF-8, before connecting; `main` turns any unexpected exception into a fixed `internal_error` JSON object, never a traceback | `test_f2_*`, `test_gate2_7_*`; `SR09Ids.test_sr9_lone_surrogate_*` |
| F3: outgoing message over 1 MiB | `Channel.call` measures the encoded line and refuses (`request_too_large`, exit 2) before sending | `test_f3_*`; `SR15Limits.test_sr15_client_never_sends_*` |
| F4, Gate 2 #4: multi-line or partial quotes of the reply shown | `quotes_reply`: both texts cleaned, lower-cased and whitespace-collapsed; any shared 8-character run (or the whole reply, if shorter, from 4 characters) replaces the engine's message with a fixed one. Applies to every error on a reply | `test_f4_*`; `SR16Errors` |
| Gate 2 #1 (Medium): invisible characters kept | `clean` drops whole categories Cc, Cf, Co, Cn, Cs, Zl, Zp (except `\n`, `\t`), plus variation selectors (U+FE00–FE0F, U+E0100–E01EF), U+034F, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0, and U+2800 | `test_gate2_1_*` |
| Gate 2 #2 (Medium): `network.allow` values unchecked | `factory_check._check_role` requires every entry to be a lower-case DNS host name (labels `a-z0-9` with inner `-`, at most 63 characters, 253 in all) or exactly `"*"`, and `"*"` alone in its list; `"*"` stays limited to roles with no file tools | `F005GateRegressions.test_network_*`, `test_any_host_must_stand_alone` |
| Gate 2 #10: project policy checked only through repo overrides | `validate_policy` checks the project policy on its own (`effective_policy(data, None)` now returns it unmerged) as well as each repo's | `F005GateRegressions.test_project_policy_*` |
| Gate 2 #3: engine text outside the fence | Every output now has a `display`, and SKILL.md says to show the owner only `display` and treat the other fields as data to read ids and statuses from. An engine error's `display` is the client's own sentence for the code (with `started_at` for busy), then the engine's message fenced as data. `version` is kept only if it is a plain version number, and `recorded_at` only if it is a strict timestamp | `test_gate2_3_*` |
| Gate 2 #5: model could invoke the skill | SKILL.md front matter has `disable-model-invocation: true`; the description says it is owner-run only | `SkillText.test_frontmatter` |
| Gate 2 #6: time limits longer than the Bash call | The whole run has a 150 s limit (`RUN_LIMIT`) covering git, connect and every call; the `wait_s` sent to the engine is cut so its answer can arrive within the run (15 s margin). SKILL.md uses `wait_s: 60` and a Bash timeout of 180 000 ms. A client-side timeout after a reply was sent reports `reply_id` and `reply_sent`, so the skill calls `state` before any retry. SKILL.md: a `reply` with no JSON output at all means run `state` and ask the owner before sending anything | `test_gate2_6_*` |
| Gate 2 #8: `engine.json` checked by path, git errors read as untracked | Opened with `O_NOFOLLOW` and `O_NONBLOCK`, then `fstat` on the descriptor: regular file, small, owned by the euid, no group or other write. `.factory` must be owned by the euid with no group or other write. `ls-files --error-unmatch` exit 1 is "untracked"; any other result refuses | `test_gate2_8_*` |
| Gate 2 Info: engine pid unused | On Linux the `SO_PEERCRED` pid must equal `engine.json`'s `pid` (`peer_not_engine`), before anything is sent. It's a guard rail under SR-5, not a boundary | `test_engine_pid_must_match_the_peer` |
| Test report O2: options don't fit the picker | SKILL.md step 4 asks in two steps: first Answer / More information / Defer (Approve / Reject for assumptions), then up to four options in the picker, labels copied character for character and the reply text always the full option; more than four are numbered in the fenced display and the owner types a choice (a bare number is confirmed first). Free text is always allowed. The product behavior is unchanged | text (AC-12 suites) |

**Gate 2 #3 and the test engineer's tests.** The coordinator asked for engine strings to reach the session only inside the fenced `display`. The test engineer's suite requires the raw fields: `error.message` equal to the engine's message (`SR16Errors.test_sr16_each_contract_code_*`), and `item.text`, `item.options` and `findings` in the output (`AC06`, `ContractChannel`, `EdgeCases`). Those fields are still there, cleaned. The control is the SKILL.md rule plus the fenced `display`. Removing the raw fields needs the test engineer's tests to change first. That is a decision for the orchestrator.

**Known issues kept from Gate 2.** #9: the Windows server check goes through `GetNamedPipeServerProcessId`; on Windows there is no pipe-owner SID or `engine.json` owner check. The Windows class has still never run. Info notes: `data.started_at` is still read for busy (the contract should say where the time goes), the macOS peer check is still untested, and `run_git` still keeps the owner's `GIT_*` environment.

## Fix round 2 (Gate 2 re-review 1)

Tests are in `test_interview_client.py` class `FixRound2`.

| Item | Fix | Test |
|---|---|---|
| R1-1: Mongolian free variation selectors and Khmer inherent vowels kept | `_INVISIBLE` also drops U+180B–180D, U+180F, U+17B4 and U+17B5. U+115F, U+1160, U+3164, U+FFA0 and U+2800 are still covered | `test_r1_1_*` |
| R1-2: the client's own error messages could be replaced by "The engine refused the reply." | Reply redaction runs only on engine-written (answered) errors; `connection_lost`, `timeout` and the other client messages are left as they are | `test_r1_2_*` |
| Info: timeout message always said "60 seconds" | The message gives the limit that actually applied to the call: 60 s plus any `wait_s`, or less when the 150 s run limit cut it short | `test_timeout_message_states_the_limit_that_applied` |

**Known Lows kept open** (orchestrator's decision): R1-3 (a quote shorter than 8 characters, wrapped differently, can still pass the redaction), #3 (raw cleaned engine fields stay in the output because the independent tests require them; SKILL.md tells the session to show only `display`), and #9 (Windows server check by pipe PID, no Windows `engine.json` owner check, Windows code never run). Info notes still open: IP literals and single-label host names pass the `network.allow` check; the contract should say the engine writes the pid of the process that listens on the socket, since the client refuses any other pid.

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
