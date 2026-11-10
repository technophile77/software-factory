# F-005 Test run report

- **Feature:** F-005 Answer spec questions from Claude Code, spec v6 (approved)
- **Tests written by:** test engineer, from the spec's acceptance criteria, section 6 edge cases and section 9 security requirements, plus Engine control channel v1.1 as amended by H-0025. I wrote my own fake engine from the contract. I did not read the developer's tests, their fake engine or `F-005-dev-report.md` before my tests were written (see "Developer's tests" below)
- **Commit tested:** `43772c5` (branch `claude/project-thread-g2huhl`), with my test files uncommitted on top. Product hashes (first 12 hex characters of the SHA-256): `interview_client.py` f2504ad9287a, `SKILL.md` da3e8317c096
- **Spec and contracts:** F-005 v6; Engine control channel v1.1 (H-0022, amended by H-0025); Role policy v2.2 (H-0023, nothing in it is client-side; see "Not run")
- **Environment:** Linux, root user, Python 3.11.18, 3.12.3 and 3.13.18, git 2.43.0, Claude Code CLI 2.1.322. No network use
- **Result:** **118 run, 112 passed, 6 failed, 0 skipped** on each of Python 3.11, 3.12 and 3.13, 3 runs each (9 runs). The same 6 tests (10 subtests) failed in all 9 runs, so none are flaky. All 6 are product failures (F1 to F4 below)

Commands, from `plugins/software-factory/skills/spec-interview`:
- mine: `python3 -m unittest discover -s tests -p 'test_acceptance.py' -v`
- developer's: `python3 -m unittest discover -s tests -p 'test_interview_client.py' -v`
- onboard-repo, from `plugins/software-factory/skills/onboard-repo`: `python3 -m unittest discover -s tests -v`

| Suite | Per run (each of 3.11, 3.12, 3.13, 3 runs) |
|---|---|
| F-005 acceptance and contract (`spec-interview/tests/test_acceptance.py`) | 118 run, 112 passed, **6 failed**, 0 skipped (about 170 s, of which 60 s is the real-time timeout test) |
| F-005 developer (`spec-interview/tests/test_interview_client.py`) | 61 run, 61 passed |
| onboard-repo, both suites (regression) | 260 run, 259 passed, 1 skipped (`AC15Portability.test_fr12_checker_runs_on_python_3_10`: python3.10 is not installed, as in F-003) |
| `python3 scripts/check_docs.py` | All docs checks passed |

## Failures

All four are product code. Each test is left failing as written.

| # | Test(s) | Spec | Expected | Actual | Cause |
|---|---|---|---|---|---|
| F1 | `SR09Ids.test_sr9_bad_feature_ids_refused` (subtests `open`, `state`, `reply` with `"F-1\n"`), `SR09Ids.test_sr9_bad_item_and_reply_ids_refused` (`item` and `reply_id` = `"F-1\n"`), `SR09Ids.test_sr9_bad_session_tokens_refused` (`next`, `close` with 32 hex characters + `"\n"`) | SR-9 ("ids must match `^[A-Za-z0-9_-]{1,64}$` or the script stops"); channel v1.1 ("Ids match `^[A-Za-z0-9_-]{1,64}$`") | An id with a trailing newline is refused before connecting, like every other bad id | The client connects and sends the id with the newline to the engine. `ID_RE` and `SESSION_RE` (`interview_client.py:48-49`) end in `$`, which in Python also matches before a final `\n`, and they are used with `.match`. Every other bad id in these tests is refused before connecting | Product. `re.fullmatch` or `\Z` fixes it. `PIPE_RE` (SR-7, line 54), `TIMESTAMP_RE` and `ENGINE_VERSION_RE` use the same pattern; engine-sent ids checked by `_id` accept a trailing newline too (not covered by a failing test, noted for the fix) |
| F2 | `SR09Ids.test_sr9_lone_surrogate_in_owner_text_fails_cleanly` | SR-16 (errors by code and message only), FR-13 (errors in plain words) | stdin `{"request": "half an emoji \ud83d here"}` gives a JSON error and a non-zero exit, with no traceback | Exit 1, empty stdout, and a Python traceback on stderr (`UnicodeEncodeError: 'utf-8' codec can't encode character '\ud83d'`, raised in `Channel.call` while encoding the request), after the client had already connected | Product. Low severity: Claude Code would rarely send a lone surrogate, but a truncated emoji in hand-escaped JSON produces one. Checking that every string encodes as UTF-8 in `_validate` would refuse it before connecting |
| F3 | `SR15Limits.test_sr15_client_never_sends_a_line_over_1_mib` | Channel v1.1 framing ("one JSON-RPC message per line … at most 1 MiB") | The client never sends a message over 1 MiB. A request that fits stdin's 1 MiB limit but not the framing limit is refused before sending | The client sent a 1,048,617-byte line for a `feature.start` with 1,048,536 characters of text. It checks the size of stdin, but not of the message it sends | Product |
| F4 | `SR16Errors.test_sr16_engine_error_quoting_multiline_reply_text_not_echoed` | SR-16 ("never echoes the owner's reply text in an error") | When the engine's error message quotes the owner's reply, the reply does not appear in the output | Output: `"message": "Refused reply: first private line about Acme Corp second private line about the March launch"`. The client redacts only when the raw reply text appears in the cleaned message. Cleaning turns the newline into a space, so a multi-line reply never matches and is shown. The single-line case (`test_sr16_engine_error_quoting_reply_text_not_echoed`) passes | Product. Comparing against the cleaned, single-line form of the text, or line by line, would catch it |

To re-check these, run `python3 -m unittest test_acceptance.SR09Ids test_acceptance.SR15Limits test_acceptance.SR16Errors -v` from `spec-interview/tests`.

## Criteria-to-test map

All tests are in `plugins/software-factory/skills/spec-interview/tests/test_acceptance.py`. Every client run goes through the real script as a subprocess (`python3 -I interview_client.py <sub>` with JSON on stdin, as SKILL.md runs it), from a git repo whose `.factory` is a real `factory/state` linked worktree, against `FakeEngine` on a Unix socket in an owner-only folder. Only the three timeout tests call `main()` in-process, with the 60 s limit shortened.

| Criterion | Tests | Result |
|---|---|---|
| AC-1 (FR-1, FR-2) | `AC01Connect` (4): `status` calls `engine.status` once, over one connection, and succeeds; works from a subfolder and from another linked worktree of the repo; the client imports only the standard library and parses as Python 3.10; the plugin ships the skill and script | Pass |
| AC-2 (FR-2, SR-1) | `AC02PlainDirectory` (6), `AC02InsideStateWorktree` (3): a plain `.factory` folder, a tracked `.factory/engine.json`, a worktree of another branch, `.factory` as a symlink to a real `factory/state` worktree, a symlink to another repo's `factory/state` worktree, a folder that isn't a git repo, `engine.json` as a symlink, a committed `engine.json` on `factory/state`, and an `engine.json` in some other folder of the repo. Each exits non-zero with a message naming the reason, and the engine sees no connection | Pass |
| SR-1 (socket) | `SR01Socket` (7): abstract sockets (`@…`, `\0…`); relative, `..`, Windows pipe and remote pipe paths; a regular file; a symlink to the socket; the socket's folder at 0755, 0711, 0770 or 0777; the socket or its folder owned by another uid. Each is refused with no connection. **Peer check:** a listener bound by root that drops to uid 65534 before `listen()` passes every path check, and the client refuses it before sending a byte (`SO_PEERCRED`) | Pass |
| Channel `engine.json` format | `EngineJsonFormat` (2): `{version: "1.1", path, pid}` is accepted. Empty, not JSON, an array, a string, missing or non-string `path`, missing `version`, invalid UTF-8 and nesting 100,000 deep are refused without a traceback and without connecting | Pass |
| AC-3 (FR-3, FR-6) | `AC03FeatureStart` (4): a request with quotes, newlines, CRLF, tabs, backslashes, `$(…)`, backticks, the heredoc end marker, CJK, Greek, Hebrew, emoji with ZWJ, a combining accent, bidi and zero-width characters and trailing spaces arrives in `feature.start` identical, byte for byte, as one UTF-8 line. Text on the command line, an empty request and a non-string request are refused before connecting | Pass |
| AC-4 (FR-4) | `AC04List` (4): three features with different open, deferred and pending-assumption counts all appear with their counts and titles in `features` and `display`; the empty list; a feature sent back by a gate reappears once it has new questions; malformed list results (not a list, bad id, negative, boolean or missing count, non-string title) fail cleanly | Pass |
| AC-5 (FR-5) | `AC05DeferredFirst` (4): with Q1 deferred, Q2 new and Q3 deferred, the owner sees Q1 and Q3 (deferred) before Q2; `next` alone shows each deferred item once per session; the display shows the deferred status; nothing waiting gives `item: null` with a message | Pass |
| AC-6 (FR-6) | `AC06Replies` (8): for each of the 5 reply kinds and 7 texts (including the AC-3 text, `""`, whitespace only, CR/CRLF, DEL and U+2028), `interview.reply` carries exactly `session, item, revision, reply_id, kind, text`, with the item id, kind and text byte for byte. Invalid kinds and non-string text are refused before sending. The engine's `kind_not_allowed` (-32005) is passed through and changes nothing. The reply's `next` item is shown | Pass |
| AC-7, AC-8 | Not tested here: the readiness gate and the spec's assumptions table belong to the engine and the gate (FR-8, FR-9, SR-11), which don't exist yet (ADR 0001). The client keeps no state, so there is nothing client-side to test. The client half (deferring sends `defer` and records nothing else; assumptions go only through `approve_assumption`/`reject_assumption`) is covered by AC-6 and the section 6 tests | Out of scope (engine) |
| AC-9 (FR-11) | `AC09Busy` (6): a second `open` gets `busy` (-32001) with the first session's `started_at`, and sends no `takeover`. The first session can still read and reply, and still holds the lock. Unknown feature gives -32003 | Pass |
| SR-13 (takeover) | `AC09Busy`: `takeover: true` is sent only when given, starts a new session and ends the old one (`session_expired`); `takeover: false` is not a takeover; a non-boolean `takeover` is refused; `close` releases the lock. SKILL.md: takeover only after the owner's yes (`AC12SkillText`) | Pass |
| AC-10 (FR-12, SR-2, SR-10) | `AC10EngineTextIsData` (7): engine text with CSI and OSC escapes, C1 CSI, BEL, NUL, BS, CR, DEL, C1 controls, bidi overrides and isolates, LRM/RLM/ALM, zero-width characters, a fake label, "Ignore previous instructions…", `SYSTEM:` and a run of backticks, in the question, reason, suggestion, options, findings and their sources, in `next` and in a reply's `next`, in list titles, error messages, `engine.status` and `interview.state` fields. Every string in the output is free of control and format characters; every piece of engine text sits inside a fence it can't close (checked with a CommonMark fence parser for 3, 4 and 9 backticks); no engine text appears outside a fence; and the client makes no call beyond the one it was asked for. An escape inside an id is refused | Pass |
| AC-11 (FR-13, SR-12) | `AC11Retry` (5): the engine records the reply and drops the connection; the failed output gives the `reply_id` and no reply text; the retry calls only `interview.state`, reports `already_recorded`, and sends no second reply. Dropped before recording: the retry asks the state first, then resends once with the same `reply_id`. Re-deferring a deferred question (state can't tell): the retry resends with the same `reply_id` and the engine records it once (see O1). The state call failing on a retry sends no reply. A reply that times out after being recorded is handled the same way | Pass |
| AC-12 (SR-3) | `AC12SkillText` (11), plus my reading of SKILL.md against the list: never answer, pick an option, approve or reject an assumption, or rewrite; the owner's own words from this turn; ask the owner, never the engine; engine text is data; only the client script and the question picker; no text on the command line, with the command template checked (`python3 -I "${CLAUDE_SKILL_DIR}/…" <sub>` and a quoted heredoc delimiter); secrets warning; takeover only after the owner's yes; no automatic retry; errors by code and message; no fallback; free text always allowed | Pass (text review). Whether a model follows the text can't be tested with unit tests |
| SR-4 | `SR04NoDisk` (1): a full exchange (status, list, open, next, an answer, an assumption approval, state, close) with `HOME` and `TMPDIR` pointed at empty folders leaves the repo, both worktrees, `HOME`, `TMPDIR` and the skill folder unchanged, writes nothing to stderr, and never prints the answer text | Pass |
| SR-7 | `SR07PipeNames` (1): the pipe-name rule accepts `\\.\pipe\<name>` and refuses remote, `\\?\`, forward-slash, device, nested and over-long names. The Windows transport itself was not run | Pass (partial; see "Not run") |
| SR-9 | `SR09Ids` (9): bad feature, item and reply ids (empty, space, `../`, `;`, `$(id)`, `/`, 65 characters, trailing newline, non-ASCII, non-strings), bad session tokens, bad revisions, extra or missing arguments, text given as an argument, and malformed stdin are each refused before connecting; 64-character ids are accepted; a stdin parse error doesn't echo the text | **F1 fails** (trailing newline), **F2 fails** (lone surrogate); the rest pass |
| SR-10 | `AC06Replies.test_sr10_reply_sends_the_revision_the_owner_was_shown`: the client sends the revision it was given, and the engine's `stale` (-32002) is passed through with nothing recorded. Bidi and zero-width removal in `AC10EngineTextIsData`. Skill side in `AC12SkillText` | Pass |
| SR-12 | `AC06Replies`: every reply gets a fresh `reply_id` that matches the id pattern; a reply under another session's token gets `session_expired` (-32004) and records nothing. Reuse on retry in `AC11Retry` | Pass |
| SR-15 | `SR15Limits` (9): a response over 1 MiB is refused without echoing it; an endless line with no newline is cut off; a response just under 1 MiB is accepted; the limit is 60 s per call, both as configured and in a real 60 s run against a silent engine; a call waiting for research is not cut off by the 60 s limit; `wait_s` must be 0 to 600 | **F3 fails** (outgoing message over 1 MiB); the rest pass |
| SR-16 | `SR16Errors` (5): each of -32001 to -32005 is shown with its code, name and message, and never its `data`; other codes and malformed errors (error as a string, non-integer code, no result, JSON-RPC 1.0, not JSON, an array) fail cleanly without showing `data`; an engine message quoting a single-line reply is redacted; `busy` shows the start time | **F4 fails** (multi-line reply echoed); the rest pass |
| Channel v1.1 contract | `ContractChannel` (14): every request is one JSON-RPC 2.0 line with an id and method, under 1 MiB; each of the 8 methods gets exactly the contract's params (`engine.status` and `interview.list` with none); `next` without `wait_s`; `interview.state` results and unknown items; a response sent one byte at a time; notifications (`interview.itemReady`, `feature.stageChanged`, `agent.started`) before the answer, and a notification and an answer in one chunk; a connection closed mid-line; invalid `open`, item, `reply` and `start` results fail cleanly; every `Item` field is shown, with findings marked untrusted and their source shown; closing an unknown session | Pass |
| Section 6 | `EdgeEngineNotReachable` (4): no `engine.json`, a stale `engine.json` whose socket is gone, a socket file left by a crash, and an engine that dies mid-call each say the engine can't be reached. `EdgeCases` (4): an engine restart mid-interview (session expired, reopen, answered questions stay answered, resume with `next`); the analyst revising a deferred question (old reply gets `stale`, the revised question comes first as deferred, the old one is `superseded`); `more_info` research that finishes within `wait_s` (the revised question returns with its finding and source); research that takes too long (`waiting`, the item shows as researching, and the owner can defer it). Failed web lookups and untrusted findings are shown as quoted data with their source (`ContractChannel.test_contract_item_all_fields_shown`, AC-10) | Pass |

AC-13: spec v6 has no AC-13; its criteria are AC-1 to AC-12.

## Developer's tests

After my tests were written I read the developer's test names (not their reasoning or the dev report). They have a Windows pipe-name test, which led me to add `SR07PipeNames`. I found nothing else they cover that mine don't. Their 61 tests pass on all three Python versions; none of them catch F1 to F4.

## Not run, and why

- **AC-7, AC-8 and the engine-side requirements** (SR-5, SR-6, SR-8, SR-11, SR-14, SR-17, the SR-15 research budget and per-question cap, SR-13's 30-minute idle release, FR-7, FR-10's transcript): no engine exists yet (ADR 0001). The client's handling of what the engine sends back (`session_expired`, `stale`, `waiting`, findings) is tested against the fake engine. Role policy v2.2 has no client-side part.
- **Windows (SR-7 named pipe, SID check, `SECURITY_SQOS_PRESENT`) and macOS (`getpeereid` via `LOCAL_PEERCRED`):** no Windows or macOS machine. Only the pipe-name rule was tested.
- **Python 3.10:** not installed. The client parses with `ast.parse(feature_version=(3, 10))`.
- **The skill in a live Claude Code session** (the AskUserQuestion picker, the model following SKILL.md, `${CLAUDE_SKILL_DIR}`): reviewed as text (AC-12). `claude plugin details` lists both skills (AC-20 regression below).

## onboard-repo regression (AC-20 test update)

`AC20Plugin.test_ac20_claude_plugin_validate_and_install` required `Skills (1)  onboard-repo`. The plugin now ships two skills (`onboard-repo, spec-interview`). The test now reads the skill list from `claude plugin details`, requires `onboard-repo` in it, and checks the count matches the names listed. It passes on all three Python versions. Nothing else in onboard-repo changed.

## Coverage (Rapid prototype bar: "Reported")

How measured: the standard library's `trace` on Python 3.13. Client subprocesses ran under `python3 -m trace --count` (set `SFI_TRACE_COUNTS=<counts file>`), and the in-process tests under `python3 -m trace --count --module unittest`; the counts were added together. Executable lines come from `trace._find_executable_linenos`. Line coverage only: no branch figure, so none for security-critical code either.

| Scope | Line coverage of `scripts/interview_client.py` |
|---|---|
| My acceptance suite | **82.5% (496 of 601 lines)**. Without the Windows pipe transport (`_PipeTransport`, lines 304-397), which can't run on Linux: 94.0% (490 of 521) |
| Developer's suite | 94.5% (568 of 601). Their tests drive `_PipeTransport` with stand-ins for the Windows calls |
| Both suites | **96.7% (581 of 601)** |

Not reached by my suite, apart from the pipe transport: the macOS peer check (lines 255-263), `git` failing to start (137-138), a bare main worktree (169), `engine.json` owned by another user (191), an `os.lstat` error other than "not found" on the socket (238-239), `getsockopt` failing (279-280), a send failing (288-289), a socket read error (297-298), the `os.name == "nt"` branch (402), and the "research was recorded but waiting failed" path (`wait_failed`, 737-739). Under `trace` the client's exit code is always 0 (the `trace` runner swallows `sys.exit`), so the test verdicts of the coverage run were not used; the counts were.

## Tool choice (testing-strategy.md § Test tools, H-0020)

Required at Rapid prototype: unit tests on core logic, acceptance tests (every AC), contract tests, a regression test for each fixed bug, and coverage reported (line and branch). Stochastic and integration aren't required at this level.

| Test type | Best-fit tool and why | Tool used | Substitute / decision |
|---|---|---|---|
| Unit, acceptance, contract, regression | Python's `unittest` (stdlib). The client is standard-library Python (FR-1, section 5), and `unittest` gives subtests, mocks and explicit skip reasons. A real Unix-socket fake engine in a thread needs nothing else | `unittest` | None needed |
| Coverage (line and branch) | **coverage.py**: the standard Python coverage tool, and it measures branches, which the bar asks for | stdlib `trace`, line only | **Open**, as in F-003: coverage.py isn't approved. The tool decision (Architecture, with an S4.1 review) is still for the orchestrator to file. There is no branch figure until the owner decides |
| Integration (not required at this level) | The real host: Claude Code CLI (`claude plugin validate/install/details`) | Claude Code CLI 2.1.322, through the onboard-repo AC-20 test | None needed |
| Stochastic (not required at this level) | Hypothesis | None | Not required at Rapid prototype |

## Observations (not failures)

- **O1, AC-11 with a re-deferral.** When the owner re-defers a question that was already deferred, its status and revision don't change, so `interview.state` can't show that the first attempt was recorded. The retry then resends the reply with the same `reply_id`, and only the engine's reply-id rule (SR-12) stops a duplicate. That meets the contract, but it means AC-11's "does not send a duplicate" depends on the engine honoring reply ids.
- **O2, options in the picker (expected behavior 4).** SKILL.md step 4 puts options in the picker only for questions with two options or fewer (the picker takes four choices, and "More information" and "Defer" use two). With three or more options, the owner reads them in the display and types the answer. Behavior 4 says the picker shows the options wherever a question has them. This may be an acceptable reading of the picker's limit, but it's the owner's call (Product).
- **O3, change control.** `plugins/` is change-controlled (CLAUDE.md rule 3). My files there are F-005 test work and the AC-20 test update the orchestrator asked for.
