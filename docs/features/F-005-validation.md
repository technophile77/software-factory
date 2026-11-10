# F-005 Validation report

- **Feature:** F-005 Answer spec questions from Claude Code, spec v6
- **Judge:** validation-judge
- **Date:** 2026-11-10
- **Commit:** `a2a4f26` (`claude/project-thread-g2huhl`). The F-005 diff is `origin/main...HEAD` (`origin/main` = `30b873f`). The local `main` (`6c3fdca`) is stale, so `git diff main...HEAD` also shows F-002 and F-003 work that is already merged. I judged only the F-005 range.
- **Contracts:** Engine control channel v1.1 (H-0022, amended by H-0025), Role policy v2.2 (H-0023), agent files (H-0024). All are owner-approved. None of the three changed after approval (`git log` on `docs/interface-contracts.md` and `agents/` ends at `125fbeb` and `30e129f`).
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Blocking finding or a Not met line still fails.
- **Verdict:** **NEEDS HUMAN REVIEW**
  - No line is Not met and nothing is Blocking. Every test suite passes on Python 3.11, 3.12 and 3.13 on `a2a4f26` in my own run, and both security gates pass.
  - Two lines are Needs owner:
    - **Interface contracts.** The client relies on three things the approved channel contract doesn't say: it shows `error.data.started_at` on `busy` (M1); it requires `engine.json`'s `pid` to be the socket's peer (M2); and it requires `.factory` and `engine.json` to have no group or other write bit (M3). M3 makes the skill refuse to run on any machine with the common umask 002, which I reproduced (probe p4).
    - **AC-7 and AC-8.** These readiness-gate rules (FR-8, FR-9, SR-11) have no test and are written nowhere the gate reads (M4).
  - The Windows transport has never run, and by reading it should deadlock on the second call of any run (M5). That needs no owner decision.
  - 5 Major and 15 Minor findings are logged.

## My own run (evidence source)

On `a2a4f26`, from the repo root. Product hashes (first 12 hex characters of SHA-256): `interview_client.py` 587541419b31, `SKILL.md` b5250eb6b4ce, `factory_check.py` 2d1307d71879.

| Step | Result |
|---|---|
| `cd plugins/software-factory/skills/spec-interview && python3.X -m unittest discover -s tests -p 'test_*.py' -v` on 3.11.18, 3.12.3 and 3.13.18 | **220 run, 220 passed** on each: the test engineer's 142 (`test_acceptance.py`) and the developer's 78 (`test_interview_client.py`). Includes the real 60 s timeout test |
| `cd plugins/software-factory/skills/onboard-repo && python3.X -m unittest discover -s tests -v` on 3.11, 3.12 and 3.13 | **266 run, 265 passed, 1 skipped** on each. The skip is `test_fr12_checker_runs_on_python_3_10`, because no python3.10 is installed |
| `ast.parse(src, feature_version=(3, 10))` on the client | Parses (Python 3.10+ constraint). No 3.10 interpreter is available |
| `python3 scripts/check_docs.py` | "All docs checks passed.", exit 0 (also after writing this report) |
| Coverage of the developer suite, in process (stdlib `trace`) | `_PipeTransport` (`interview_client.py:377-471`): 6 of 79 lines run, which are only the class and method definition lines (m3) |
| `git status` after all runs | Only this report is new. `__pycache__/` is ignored |

### Is the test engineer's run on `bc1af15` enough for `a2a4f26`?

Yes, for the acceptance criteria at Rapid prototype, as in F-003 re-validations 3 and 4.
- `SKILL.md` and `factory_check.py` are byte-identical to the re-test (same hashes as `F-005-test-report.md` "Re-test on bc1af15").
- `test_acceptance.py` hasn't changed since `e5064bc`.
- The product diff is three places in `interview_client.py`: `_INVISIBLE` (`:125-126`, R1-1), redacting only engine-answered errors (`:843`, R1-2), and the timeout wording (`:484-486`, `:532-540`). Each carries out a Gate 2 re-review 1 suggestion.
- The test engineer's unchanged file passes on all three Pythons in my run.

Gate 2 re-review 1 ends at `bc1af15`. `a2a4f26` is not re-reviewed, but it only applies Gate 2's own suggested fixes, and it tightens. I log that as m4, not as a gap.

### Probes (scratch folder `/tmp/claude-0/.../scratchpad/judge/`, against the developer's `FakeEngine`)

| Probe | Result |
|---|---|
| p1: an engine that puts `started_at` only in the `busy` message (a literal reading of the contract) | Works. `display` shows "Another session holds this feature." and then the message fenced as data, so the owner still sees the time (FR-11) |
| p1b: `started_at` in `error.data` | `error.started_at` is set and `display` says "It started at …". `data` is read for this one key (M1) |
| p2: `engine.json` `pid` set to the launching process, not the listener | `peer_not_engine`, exit 2, nothing sent. An engine started through a wrapper (ADR 0003: the extension starts the engine) is refused (M2) |
| p3: `engine.json` `version` `"1.2"`, `"1.0"`, `"2.0"` | Accepted, refused, refused |
| p4: `umask 002` (the default for users on Ubuntu, Debian and Fedora with user-private groups), then `git worktree add .factory factory/state` and the engine writes `engine.json` | `.factory` is 0775 and `engine.json` is 0664. `status` gives `not_state_worktree` ("… .factory is not owned by you or others can write to it"). After `chmod 755 .factory` it gives `bad_engine_file`. Only after `chmod 644 engine.json` does it connect (M3) |
| p5: every code point through `clean()` | Everything Gate 2 named is removed. U+16FE4 KHITAN SMALL SCRIPT FILLER (Mn) is kept (m8). Visible combining marks are kept, as they should be |

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | Client `plugins/software-factory/skills/spec-interview/scripts/interview_client.py` (stdlib imports `:34-46`; JSON-RPC 2.0 `Channel` `:489-563`); skill `SKILL.md`. Tests: `AC01Connect.test_ac1_status_calls_engine_status_and_succeeds`, the stdlib and plugin checks in `AC01Connect`, `ContractChannel` (14). FR-1's "channel v1.0" is stale wording after H-0022 (m13) |
| FR-2 | Met (see M3) | `find_engine_file` `:196-240` (`git worktree list --porcelain -z`, the main worktree's `.factory` must be the `refs/heads/factory/state` worktree, no links, untracked by `ls-files` exit 1), `read_engine_address` `:243-274` (`O_NOFOLLOW`, `O_NONBLOCK`, `fstat`). This matches onboard-repo's `git worktree list` rule (`onboard-repo/SKILL.md:147`). Tests: `AC02PlainDirectory` (6), `AC02InsideStateWorktree` (3), `EngineJsonFormat`, `WhereEngineJsonComesFrom.*` |
| FR-3 | Met | `cmd_start` `:738-740`. Tests: `AC03FeatureStart.test_ac3_request_text_arrives_identical`, `test_ac3_framing_one_line_utf8` |
| FR-4 | Met | `cmd_list` `:743-766`. Tests: `AC04List.test_ac4_three_features_with_counts` and 3 more |
| FR-5 | Met | `cmd_open` `:769-779`, `cmd_next` `:792-793`; the order is the engine's. Tests: `AC05DeferredFirst.test_ac5_two_deferred_come_first_then_the_new_one`, `test_ac5_next_without_replies_shows_each_deferred_once_then_new` |
| FR-6 | Met | `cmd_reply` `:821-867`; the kinds `:77`; owner text never cleaned. Tests: `AC06Replies.test_ac6_each_kind_text_byte_for_byte` (5 kinds × 7 texts), `Display.test_owner_text_is_never_cleaned` |
| FR-7 | Met for the client and the analyst's instructions; the engine side waits for the engine (spec §5) | Findings are shown with their source and marked untrusted (`item_display` `:636-637`; `ContractChannel.test_contract_item_all_fields_shown`, `EdgeCases` more_info tests). The analyst's research sources, web only through the reader, and no escalation before F-006: `agents/requirements-analyst/AGENT.md:14-23` (H-0024). The skill offers no escalation (`SKILL.md:141-158`) |
| FR-8 | Met for the client; the gate side is **Needs owner** (M4) | The client sends `defer` and records nothing (`SKILL.md:159-160`; `AC06Replies`). The rule that the readiness gate fails on `open` or `deferred` interview questions and pending assumptions is not in `docs/development-workflow.md` stage 4 or `agents/orchestrator/AGENT.md:16-17` |
| FR-9 | Met for the analyst; the gate side is **Needs owner** (M4) | `requirements-analyst/AGENT.md:27-32,38-39`: only approved assumptions go in the spec, with the transcript as the record. Nothing tells the gate to check this |
| FR-10 | Met for the client (the engine keeps the transcript) | No writes and no logging: `SR04NoDisk.test_sr4_full_interview_writes_nothing_and_logs_nothing`, `NothingWritten.*` |
| FR-11 | Met (see M1) | `cmd_open` and `takeover` `:769-779`; busy handling `:553-559`, `error_display` `:907-914`. Tests: `AC09Busy.test_ac9_second_client_gets_busy_first_session_unaffected` and 5 more; probes p1 and p1b |
| FR-12 | Met (see m6, m8) | `clean` `:129-140`, `fence` `:143-147`, `item_display` `:622-638`. Tests: `AC10EngineTextIsData` (7), `Retest1` (invisible characters), `FixRound2.test_r1_1_mongolian_and_khmer_invisibles_are_removed` |
| FR-13 | Met | Plain-words errors (`ERROR_TEXT` `:71-75`). A retry asks `interview.state` first (`:822-833`), and the reply id is returned after a failure (`:845-846`, `:937-940`). Tests: `AC11Retry` (5), `FixRound2.test_r1_2_client_messages_are_never_redacted`. SKILL.md: `:179-187` |

### Acceptance criteria

| Id | Status | Evidence (test engineer's tests, passing in my run on `a2a4f26` and in the test engineer's run on `bc1af15`) |
|---|---|---|
| AC-1 | Met | `AC01Connect` (4) |
| AC-2 | Met | `AC02PlainDirectory` (6), `AC02InsideStateWorktree` (3) |
| AC-3 | Met | `AC03FeatureStart` (4) |
| AC-4 | Met | `AC04List` (4) |
| AC-5 | Met | `AC05DeferredFirst` (4) |
| AC-6 | Met | `AC06Replies` (8) |
| AC-7 | **Needs owner** (M4) | No test. The test engineer marks it out of scope because the engine and gate don't exist yet. The gate rule is also written nowhere |
| AC-8 | **Needs owner** (M4) | As AC-7 |
| AC-9 | Met | `AC09Busy` (6) |
| AC-10 | Met (see m6) | `AC10EngineTextIsData` (7), `Retest1` |
| AC-11 | Met | `AC11Retry` (5). O1 in the test report: a re-deferral relies on the engine's reply-id rule. That meets SR-12 |
| AC-12 | Met (test and my own reading) | `AC12SkillText` (11), `Retest1SkillText` (5 more). My reading of `SKILL.md:20-26,50-52,141-160` against the list: never answer, pick, approve or rewrite; ask the owner, never the engine; takeover only after a yes in this turn |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met (see M2, M3) | `:196-274`, `check_socket_path` `:284-304`, peer uid `:340-347`. Tests: `SR01Socket` (7), `AC02*`, `SocketChecks.*`, `FixRound1.test_gate2_8_*`. macOS `LOCAL_PEERCRED` untested (m9) |
| SR-2 | Met (see m6) | Fenced `display`; `SKILL.md:27-34`. `AC10EngineTextIsData`, `Retest1.test_sr2_*` |
| SR-3 | Met | `SKILL.md:20-26`; AC-12 |
| SR-4 | Met | No writes and no logs; secrets warning `SKILL.md:47-49`. `SR04NoDisk` |
| SR-5 | Accepted risk (owner) | Not re-opened. The pid match (`:348-356`) is a guard rail only (M2) |
| SR-6, SR-17 | Met for what exists now: the checker and the agent files | `"*"` only for a WebFetch/WebSearch-only role (`factory_check.py:1358-1361`); hosts validated (`:1251,1281-1287`); `agents/web-reader/AGENT.md`. Stripping, logging and isolation are the engine's. See m11 and m14 |
| SR-7 | Met by reading; **never run** (M5) | `_PipeTransport` `:377-471`: `PIPE_RE.fullmatch`, `SECURITY_SQOS_PRESENT \| SECURITY_IDENTIFICATION` (`:406`), server token SID compared by `EqualSid`. Only the name rule is tested (`SR07PipeNames`) |
| SR-8, SR-11, SR-14 (engine side) | The engine's | SR-14's role-policy part is Met: `factory_check.py:1213-1217` and the template's six roles deny `.factory/engine.json` (`RolePolicyV22`) |
| SR-9 | Met | Only the subcommand is an argument (`:921`); `_validate` `:677-712` (fullmatch ids, tokens, revisions, encodable text). Quoted heredoc in `SKILL.md:61-65`. `SR09Ids` (9), `Retest1` |
| SR-10 | Met (see m8) | Revision sent as shown (`AC06Replies.test_sr10_reply_sends_the_revision_the_owner_was_shown`); invisible characters removed; `disable-model-invocation: true` (`SKILL.md:4`) |
| SR-12 | Met | uuid4 reply ids; session token on every call. `AC06Replies`, `AC11Retry` |
| SR-13 | Met (client side) | Takeover only on request; `SKILL.md:50-52,125-129`. `AC09Busy`. The 30-minute idle release is the engine's |
| SR-15 | Met (client side) | 1 MiB both ways (`:497-508,526-528`); 60 s per call plus `wait_s`, inside the 150 s run limit (`:59-65,532`). `SR15Limits` (9), `FixRound1.test_gate2_6_*`. The research budget is the engine's. SR-15's wording still names `interview.itemReady` (m13) |
| SR-16 | Met, except `data.started_at` (M1) | `:544-560`; reply redaction `:806-818,843-844`. `SR16Errors` (5), `Retest1`, `FixRound2.test_r1_2_*`. Residual R1-3 (m7) |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Engine not running, stale `engine.json`, socket left behind | Yes: `EdgeEngineNotReachable` (4) |
| Engine restart mid-interview | Yes, client side: `EdgeCases` (session expired, reopen, resume) |
| A deferred question revised | Yes: `EdgeCases` (`stale`, revised item first, old `superseded`) |
| A gate sends a spec back | Yes: `AC04List` (the feature reappears) |
| Long `more_info` research | Yes: `waiting` plus defer (`EdgeCases`, `SKILL.md:167-170`) |
| Web lookups fail | The engine's and the analyst's; findings are shown as data with their source |
| Findings are untrusted | Yes: "(from research; untrusted)" and fenced (`:637`) |
| (Not in §6) A machine with umask 002 | **No**: refused (M3) |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD 1, 2) | Met | Spec v6 Approved (`F-005-spec-interview.md:4`); OQ-1 to OQ-4 answered; no assumptions |
| Architecture / ADRs | Met | ADR 0003: the skill is another front end on the engine's channel, and Inbox actions stay out of it. ADR 0004: Role policy v2.2 is enforced by the checker. ADR 0009: only the `factory/state` worktree is trusted, and the transcript lives there. ADR 0001: the engine is not built, and the spec (§5) says so. No conflict |
| Interface contracts | **Needs owner** (M1, M2, M3) | Contract tests pass (`ContractChannel` (14): exact params for all 8 methods, framing, notifications skipped, `Item` shape). No unapproved diff to `interface-contracts.md`. But the client goes beyond the contract in three ways, and an engine that follows the contract to the letter can be refused (M2, M3) or have its `data` shown (M1). The fix-round changes to the Role policy checker (`bc1af15`: host-name check, project policy checked on its own) carry out the contract's existing text ("`network.allow` lists host names") and only tighten. That is not a contract change |
| Code quality, readability, maintainability | Met, with findings | One 953-line file in clear sections. Validation is strict, done before connecting, and fails closed. Findings: M5 (Windows I/O design), m16 |
| Comments | Met (see m1) | Comments say why: `:115`, `:165`, `:215`, `:233-234`, `:340`, `:348-349`, `:403-404`, `:439`, `:527`, `:546`, `:554-556`, `:840-842`, `:854-855`, `:888`, `:938-939`, `:942-943`. One misleading: `:66` (m1). `SKILL.md:53-54` describes `display` wrongly (m1) |
| Test tools | Met (see m3) | Tool choice table in `F-005-test-report.md` "Tool choice": `unittest` for unit, acceptance, contract and regression, with a reason. Coverage.py is named best fit and left **open** rather than substituted, which is correct under H-0020. There is no branch figure, and the tool decision is still not filed (carried from F-003 m27) |
| Documentation | Met (see m12) | `README.md` "Answer the analyst's spec questions"; `plugin.json` 0.2.0 with the new description; `marketplace.json` description; `SKILL.md`; H-0024's `agents/requirements-analyst/AGENT.md` and the new `agents/web-reader/AGENT.md`, unchanged since drafted and approved (`30e129f`, `e144e2f`). Dev, test and gate reports are present. `check_docs.py` passes |
| Security | Met | Gate 1 (`F-005-security-gate1.md`) is present. Gate 2 (`F-005-security-gate2.md`) and re-review 1 (`6fdd048..bc1af15`) pass at Rapid prototype, with nothing Critical or High. Open: 5 Low (#3, #9, R1-1, R1-2, R1-3); `a2a4f26` fixes R1-1 and R1-2. So the remaining Lows are #3, #9 and R1-3 (m6, M5, m7) |
| Constraints (spec §5) | Met on Linux; unverified on macOS and Windows | Linux run on three Pythons. macOS peer check untested (m9). Windows never run and likely broken (M5) |

## Findings

### Blocking

None.

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `interview_client.py:553-559,934-935,912-913`; `docs/interface-contracts.md` (Engine control channel v1.1, "Errors carry `code` and `message`; clients don't show `data`") | **Needs owner (Interfaces).** On `busy` the client reads `error.data.started_at` and shows it, both in `error.started_at` and in `display`. The contract says clients don't show `data`, and it says `busy` comes "with `started_at`" without saying where. SR-16 says the same. The code is careful: it reads only for -32001 and only a full-matched ISO 8601 timestamp, and both independent fake engines put the time in `data`. But it is a reading the contract doesn't state, and an engine that puts the time in `message` (probe p1) also works. **Recommendation:** amend the contract (non-breaking, no engine exists yet): "`busy` carries `data: { started_at }` (ISO 8601). It is the only `data` field a client may show." Keep the client as it is. The alternative is for the engine to put the time in `message` and the client to drop `data` entirely, but then the owner gets the time only inside fenced engine text. |
| M2 | `interview_client.py:268-270,307-312,348-356` | **Needs owner (Interfaces).** On Linux the client refuses unless the `SO_PEERCRED` pid equals `engine.json`'s `pid` (`peer_not_engine`). The contract defines `pid` only as `<int>`. It doesn't say whose pid it is. ADR 0003 has the VS Code extension start the engine, and a launcher (`npm`, a Node wrapper, a supervisor) commonly writes its own pid. A conforming engine like that is refused (probe p2). The check is a guard rail under SR-5, added from a Gate 2 Info note, not something the spec requires. **Recommendation:** amend the contract: "`pid` is the pid of the process that listens on the channel". This is a tightening, non-breaking since no engine exists, and keeps the guard rail. The alternative is to drop the check. |
| M3 | `interview_client.py:213-217,254-257`; `onboard-repo/SKILL.md` step 5 (creates the worktree); contract `engine.json` | **Needs owner (Interfaces, or Security if relaxed).** The client refuses a `.factory` folder or `engine.json` that is group-writable (`st_mode & 0o022`). That came from Gate 2 #8(b). Neither the contract nor onboarding sets those modes. Under umask 002, the default for normal users on Ubuntu, Debian and Fedora (user-private groups), `git worktree add` makes `.factory` 0775, and a plainly written `engine.json` is 0664. So the skill refuses on those machines, and the first refusal comes as `not_state_worktree`, prefixed "The engine address is trusted only from .factory/engine.json in this repo's factory/state worktree", which points the owner at the wrong cause (probe p4). The tests run as root with umask 022, so none catches it. **Recommendation:** keep the client check (it is part of SR-1's trust in `engine.json`). Amend the contract: "the engine writes `engine.json` with mode 0600". Have onboard-repo create the `factory/state` worktree folder without group or other write (`chmod go-w`). Then the developer gives the refusal its own code and plain words ("`.factory` is group-writable; run `chmod go-w .factory`"). Relaxing the check to group-write would loosen a Gate 2 fix, so that would be a Security decision instead. |
| M4 | `docs/development-workflow.md` stage 4; `agents/orchestrator/AGENT.md:16-17`; spec FR-8, FR-9, SR-11, AC-7, AC-8 | **Needs owner (Product, plus a Configuration hygiene item).** FR-8 says the readiness gate fails while any interview question is `open` or `deferred` or any assumption is pending. SR-11 says the gate checks every approved assumption against an `approve_assumption` transcript entry. The gate is run by the orchestrator from its AGENT.md and the workflow doc, but neither says this. They speak only of deferred *inbox decisions*, and a deferred interview question is not one. H-0024 changed only the analyst's and web reader's files. So AC-7 and AC-8 have no test and no written rule. The test engineer marks them engine-only. **Recommendation:** approve a hygiene edit now (both files are change-controlled). Add to stage 4: "no interview question `open` or `deferred`, no pending assumption, and every approved assumption matches an `approve_assumption` entry in `.factory/interviews/<feature>/`". Then accept, as a Product call, that the AC-7 and AC-8 tests are carried to the engine feature and tracked there. |
| M5 | `interview_client.py:377-471` (`_PipeTransport`); spec §5 ("named pipe on Windows"), SR-7 | The Windows transport has never run (dev report, test report, Gate 2 #9). Reading it, I expect it to hang. The pipe is opened without `FILE_FLAG_OVERLAPPED`, so the handle is synchronous, and Windows lets only one I/O at a time on a synchronous handle. The reader thread starts in `__init__` and blocks in `os.read`, so `send()` (`os.write`) on the same handle waits behind it. The request is then never written, and the call ends in `timeout`. Even if the first write slips through before the read starts, the second call in a run blocks: `reply` with `reply_id` (`state` then `reply`), or `reply` with `more_info` and a wait (`reply` then `next`). I can't run this here, so the evidence is from reading the code and from Windows' documented behavior for synchronous handles. Gate 2 #9 also stands: the server is identified by pid, and `engine.json` gets no owner check on Windows. **Fix:** use overlapped I/O, or drop the reader thread and poll with `PeekNamedPipe` up to the deadline. Run `SR07` and a status/reply round trip once on Windows before any Windows owner uses the skill, and record that run as SR-7's test. No owner decision is needed. |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `interview_client.py:66`; `SKILL.md:53-54` | Misleading text. The comment says "the skill acts on the name, the owner sees both", but the owner sees `display`, which for the five channel codes has neither the code nor the name, only the client's sentence and the fenced message. SKILL.md says `display` "carries `error.code` and `error.message` in the client's words", which is wrong the same way. |
| m2 | `SKILL.md:32`, `:184` | Two fix-round edits left lines of about 130 characters in a file wrapped at about 75. Cosmetic. |
| m3 | `F-005-test-report.md` "Coverage" | The report says the developer's suite "drive[s] `_PipeTransport` with stand-ins for the Windows calls" and credits it with 94.5% line coverage. No test refers to `_PipeTransport`, and my trace shows only its definition lines run, so the figure overstates Windows coverage. Coverage was also not re-measured after `43772c5`. Branch coverage still waits on the coverage.py tool decision, which nobody has filed (as F-003 m27). The orchestrator should file it. |
| m4 | `a2a4f26` | Not covered by the test engineer's run or by Gate 2 re-review 1. It is narrow and tightens, so I accept my own run (see above). Optionally, the test engineer adds one line to the report confirming `a2a4f26`. |
| m5 | `docs/features/` | No orchestrator review note for F-005 (DoD 6, workflow stage 6). F-003 has one. It is needed before the PR. |
| m6 | `interview_client.py:715-867` (outputs); Gate 2 #3 | Known Low, carried. Cleaned raw engine fields (`item.text`, `options`, `findings`, `error.message`, `features[].title`) stay in the output because the test engineer's tests read them. The only control is the SKILL.md rule to show only `display`. Before Alpha, move those tests to `display` and drop the raw text fields. |
| m7 | `interview_client.py:810-818`; Gate 2 R1-3 | Known Low, carried. A quote shorter than 8 characters, wrapped differently, can pass the reply redaction. |
| m8 | `interview_client.py:122-126` | `clean()` is still a deny list, so new invisible characters can slip through. Probe p5: U+16FE4 KHITAN SMALL SCRIPT FILLER (Mn) is kept. That is one character, and it is low risk. Gate 2's sturdier rule (drop any `Mn` with `combining() == 0` that has no glyph, or keep an allow-list) would close the class. |
| m9 | `interview_client.py:319-326` | macOS `LOCAL_PEERCRED` path is untested. By reading, the layout is right and errors fail closed. Carried from the dev report and Gate 2 Info. |
| m10 | `SKILL.md:146-155`; spec behavior 4 | With more than four options, the owner reads them numbered in the fenced `display` and types a choice, instead of using the picker. That is a fair reading of the picker's four-choice limit, and the test engineer's O2 is resolved by it. Paging (three options plus "More options") would meet behavior 4 literally. Optional. |
| m11 | `factory_check.py:1251`; Role policy v2.2 | Carried Gate 2 Info: `network.allow` accepts IP literals and single-label names (`localhost`, `169.254.169.254`). The contract doesn't say the engine matches hosts exactly, never as globs (Gate 2 #2's last suggestion). Take both up with the next Role policy change or the engine design. |
| m12 | `docs/agent-responsibilities.md:3,7-15`; `docs/architecture.md:13` | The new `web-reader` role (H-0024) is not in the role summary or the authority matrix, and architecture still counts "two advisory support roles". Both files are change-controlled, so this is a hygiene item. |
| m13 | `F-005-spec-interview.md` FR-1, SR-15 | The spec text is stale after H-0022 and H-0025. FR-1 says "Engine control channel v1.0", and SR-15 makes an exception "while waiting for `interview.itemReady`", where the client now uses `wait_s`. The v6 change log updated FR-11, SR-12 and SR-13 only. Fix this in the next spec revision. |
| m14 | `F-005-spec-interview.md` SR-17; `agents/web-reader/AGENT.md:16-17`; Role policy v2.2 | SR-17 says the reader has "no tools besides fetching the one address it was given". The approved agent file and policy also allow a given search and the result pages it needs. The owner approved both, so this is a wording mismatch to fix in the spec, not a gap. |
| m15 | `interview_client.py:162-170` | Carried Gate 2 Info: `git` runs with the owner's `GIT_*` environment. Bounded by the socket owner, folder mode and peer uid checks. |

## Counts

- Blocking: 0.
- Major: 5 (M1 to M5). M1 to M4 need the owner.
- Minor: 15 (m1 to m15).
- Lines: 0 Not met. 2 lines are Needs owner (Interface contracts; AC-7 and AC-8 with FR-8, FR-9 gate side).

## To reach PASS at Rapid prototype

1. **Owner, one Interfaces decision card for channel v1.1 (M1 to M3).** Recommended: approve all three as clarifications. They are non-breaking, and no engine exists yet.
   - `busy` carries `data.started_at`, the only `data` a client may show.
   - `pid` is the listening process's.
   - The engine writes `engine.json` with mode 0600.

   The orchestrator records the approval in `interface-contracts.md`. Then the developer gives the folder-mode refusal its own wording, and onboard-repo creates `.factory` with `go-w`.
2. **Owner, M4.** Approve a hygiene edit adding the interview rules (FR-8, FR-9, SR-11) to the readiness gate in `development-workflow.md` and the orchestrator's AGENT.md. Accept, as a Product call, that the AC-7 and AC-8 tests move to the engine feature.
3. **Not needed for PASS, but before any Windows use:** the developer fixes M5, and someone runs the Windows path once.
4. Before the PR: the orchestrator review note (m5).
