# F-006 Validation report

- **Feature:** F-006 Advisor agent for hard questions, spec v5
- **Judge:** validation-judge
- **Date:** 2026-11-10
- **Commit:** `8abb039` (`claude/project-thread-95vuv4`). The F-006 range is `7066f99..8abb039`. It holds the interview and spec commits, the five hygiene items H-0060 to H-0064 (drafts `6651fe7`, `2ec5e02`, `1d6412f`, `c78c785`, all approved as drafted in `7e4fb0c`), and the developer's and test engineer's work (`8abb039`).
- **Contracts:** Engine control channel v1.2 (H-0063), Inbox item v1.1 (H-0062), Role policy v2.3 (H-0061). All are owner-approved in `7e4fb0c`. `git diff 7e4fb0c..8abb039` doesn't touch `docs/interface-contracts.md`, `agents/` or `docs/spec/`. `7e4fb0c` changed only the status and approval lines of the drafts.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Blocking finding or a Not met line still fails.
- **Scope:** as in F-005, the engine doesn't exist yet (ADR 0001). Spec §5 says this feature delivers the role, its policy, the contract changes and the F-005 skill change, tested against a fake engine. I judged the engine-side halves of the acceptance criteria as deferred by §5, as F-005 was judged. I did not read `F-006-security-gate2.md`, on instruction: Gate 2 is running in parallel.
- **Verdict:** **NEEDS HUMAN REVIEW**
  - No line is Not met and nothing is Blocking. Every suite passes on Python 3.11, 3.12 and 3.13 in my own run on `8abb039`.
  - Two related lines are Needs owner, both about the approved channel contract (Interfaces):
    - **M1.** The client refuses things that Engine control channel v1.2 allows. An engine that follows the contract to the letter can leave the owner stuck on an unreadable item (probe p2).
    - **M2.** On the interview path, SR-8 (caps shown in the approval prompt) and A-1 (the prompt says when a call would go over budget) can't be met by any engine under v1.2. The channel has no field to carry those facts, and `ask_advisor` has no prompt before the call starts. The section 6 edge case "advice shown against the revision it was asked about" has the same gap.
  - The Security line waits for Gate 2. Gate 1 is present and has no blocking finding.
  - 3 Major and 9 Minor findings are logged.

## My own run (evidence source)

On `8abb039`, from the repo root. Product hashes (first 12 hex characters of SHA-256): `interview_client.py` 89c274a55e0a, spec-interview `SKILL.md` 84060a666aff, `factory_check.py` d78b6fca7b97. These are the same as the test engineer's final run (`F-006-test-report.md` header).

| Step | Result |
|---|---|
| `python3.X -m unittest discover -s plugins/software-factory/skills/spec-interview/tests` on 3.11, 3.12 and 3.13 | **308 run, 308 passed** on each: the F-005 `test_acceptance.py` (unchanged in this range), the test engineer's 47 in `test_acceptance_f006.py` with their own fake `fake_engine_f006.py`, and the developer's 107 |
| `python3.X -m unittest discover -s plugins/software-factory/skills/onboard-repo/tests` on 3.11, 3.12 and 3.13 | **288 run, 287 passed, 1 skipped** on each. The skip is `test_fr12_checker_runs_on_python_3_10`, because no python3.10 is installed (as in F-003 and F-005) |
| `ast.parse(..., feature_version=(3, 10))` on the client and the checker | Both parse |
| `python3 scripts/check_docs.py` | "All docs checks passed.", exit 0 |
| `git status` | Clean before this report. This report is the only file I wrote in the repo |

### Probes (scratch folder `/tmp/claude-0/.../scratchpad/judge/`, in-process on the real client and checker)

| Probe | Result |
|---|---|
| p1: a question with three advice entries. The `done` one has a Markdown image, raw `<img>`, a line of three backticks, a forged `## Recommendation`, "Approve A-1", an RLO-wrapped line, `~~~` and a run of 7 backticks. Its `web_queries` entry contains a newline | The advice sits inside an 8-backtick fence under the client's label "Advisor's advice, call A-0001". Nothing engine-written is outside a fence. The RLO/PDF marks are removed. The query becomes one line, fenced, labelled "recorded by the engine from its own log". `running` and `failed` are each shown in the client's own words. `advice_running` is true |
| p1b: `failed` with `text`, `done` with whitespace-only text, a non-string web query, a call id with a space | Each refused as `bad_response` |
| p2: an `advisor_proposal` with `options: []`, `findings: []`, `advice: []` or `suggested: ""`; a `question` with `about`; a `running` entry with `text: ""` | **Each refused as `bad_response`** for the whole item. The approved `Item` makes `suggested`, `options` and `findings` optional on every kind, and `text` optional on every advice entry (M1) |
| p3: advisor `read.allow` globs against an analyst allowing `docs/**`, `src/**` | `docs/a.md` and `src/**` accepted. `docsx/a` and `**` refused. `docs/../secret` passes `_check_advisor`, but the general worktree rule in `_check_role` (`factory_check.py:1246-1255`) refuses it in `validate_policy`, as the test engineer's `F006AdvisorGlobsInside` checks |

### Is the test engineer's run enough for `8abb039`?

Yes, for the acceptance criteria. Their run was on `7e4fb0c` plus the uncommitted F-006 changes. The three product files have the same hashes at `8abb039`. The template and checker changes come from `c78c785`, which is inside that base. Their test files are committed unchanged in `8abb039`, and I ran them on that commit. I log the commit wording as m4.

## Evidence checklist

### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `agents/advisor/AGENT.md` (H-0060): advises only, never changes code, specs, transcripts, inbox items or any file. Role policy: template `onboard-repo/templates/factory-project.yaml` `advisor` entry, with no write, commands or network. Checker `factory_check.py:1221-1226,1322-1341`. Tests: `RolePolicyV23.test_template_advisor_is_the_contract_policy`, `test_advisor_gets_no_write_shell_or_web_tool`, `F006AdvisorRepoOverrides` (8) |
| FR-2 | Met for the policy; engine refusal deferred (§5) | `MAY_REQUEST` `:1226`, `_check_may_request` `:1305-1313`, project-only rule `:1395-1397`. Tests: `F006MayRequestSpelling` (2), `RolePolicyV23`. The refusal at run time is the engine's |
| FR-3 | Met for the client; engine and inbox halves deferred (§5) | Reply kinds `interview_client.py:77-79`. SKILL.md `:30-35` (the advisor kinds only from the owner's own pick), `:174-180` (proposals), `:196-198` (`ask_advisor`, no further approval). Tests: `V12ReplyKinds.test_ac2_*`, `test_ac3_*`, `test_ac4_*`, `test_sr3_*`, `SkillTextF006.test_sr3_*`. See M2 for the approval-prompt facts |
| FR-4 | Deferred (§5) | No model pin exists anywhere yet. The engine and F-002 ladder aren't built. See M3 |
| FR-5 | Deferred (§5) | The engine builds the input. The client sends only `session, item, revision, reply_id, kind, text` (`interview_client.py:969-972`; `V12ReplyKinds.test_ac4_*` checks the exact params) |
| FR-6 | Met for the policy; enforcement deferred (§5) | `_check_advisor` `:1322-1341` (tools within `Read, Grep, Glob, Skill`; reads within the analyst's; analyst denies plus `ADVISOR_EXTRA_DENY`; checked per effective policy `:1407-1410`). Tests: `F006AdvisorRepoOverrides`, `F006AdvisorGlobsInside` (3, including a seeded 100-glob check), probe p3 |
| FR-7 | Met (no shell granted) | No `Bash` in `ADVISOR_TOOLS`. `commands.allow` must be empty. AGENT.md "Run commands" in "must not". `F006AdvisorRepoOverrides.test_fr7_*` (2) |
| FR-8 | Met for the client; shape check deferred (§5) | A `failed` entry is shown as failed with no text. `running` or `failed` with text is refused (`parse_advice` `:650-678`). `AC10AdviceShown.test_ac9_*` (2). AGENT.md lists the four sections |
| FR-9 | Met in interviews; inbox deferred (§5) | `advice_display` `:751-771` labels it as the advisor's, fences it, and puts it after the question in the same `display`. SKILL.md `:36-43` says never summarize or rewrite. Tests: `AC10AdviceShown` (12), `AC12InertAdvice` (3), `Properties.test_property_advice_always_quoted_and_word_for_word`, probe p1 |
| FR-10 | Deferred (§5) | The engine keeps the transcript and the inbox history. The client writes nothing (F-005 `SR04NoDisk` still passes) |
| FR-11 | Met | SKILL.md `:169-198`: "Ask the advisor" on every question (four picker choices, which is AskUserQuestion's limit), and proposals with Approve and Decline. `item_display` `:728-734`. Tests: `FR11Proposals` (4), `SkillTextF006.test_fr11_*` (2), the developer's `Advisor.test_fr11_*` |

### Acceptance criteria

The tests named are the test engineer's. They pass in their run and in mine on `8abb039`.

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met (policy half); engine refusal deferred (§5) | `F006MayRequestSpelling` (2), `RolePolicyV23` |
| AC-2 | Met (client half) | `V12ReplyKinds.test_ac2_decline_advisor_starts_nothing_and_leaves_the_question` |
| AC-3 | Met (client half); the transcript record is deferred | `V12ReplyKinds.test_ac3_approve_advisor_on_a_proposal`, `V12AtMostOneCall.test_approve_recorded_then_dropped_retry_sends_nothing` |
| AC-4 | Met (client half) | `V12ReplyKinds.test_ac4_ask_advisor_sent_with_contract_params_byte_for_byte`, `V12AtMostOneCall.test_ask_recorded_then_dropped_retry_starts_no_second_call` |
| AC-5 | Deferred (§5: engine and VS Code extension) | No test. Inbox item v1.1 has no client in this repo. See M3 |
| AC-6 | Deferred (§5: engine) | No test. See M3 |
| AC-7 | Deferred (§5: engine) | No test. The client half (nothing but the reply fields is sent) is covered by AC-4's exact-params test. See M3 |
| AC-8 | Met (policy half); runtime refusal deferred | `F006AdvisorRepoOverrides` (8), `F006AdvisorGlobsInside` (3) |
| AC-9 | Met (client half); the shape check is the engine's | `AC10AdviceShown.test_ac9_failed_call_shown_as_failed`, `test_ac9_text_on_a_failed_call_is_not_shown_as_advice` |
| AC-10 | Met in interviews | `AC10AdviceShown` (12), probe p1 |
| AC-11 | Met (client half); the fake analyst and orchestrator are deferred | `AC11AdviceChangesNothing.test_ac11_instruction_in_advice_only_shown` (exactly one `interview.next`, no reply, no call), `V12ReplyKinds.test_sr3_showing_items_never_sends_a_reply`. H-0064's analyst and orchestrator rules (`agents/requirements-analyst/AGENT.md`, `agents/orchestrator/AGENT.md`) |
| AC-12 | Met | `AC12InertAdvice` (3): ten cases quoted, no remote lookup under an audit hook, no web module imported. Probe p1 |

### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met for the client; the engine's log is deferred | `web_queries` shown fenced under a client label (`:762-768`). `AC10AdviceShown.test_sr1_web_queries_shown_as_quoted_data`. AGENT.md: query terms only, no page reads |
| SR-2 | Met | `clean()` and `fence()` on advice text and queries. `AC12InertAdvice`, probe p1 |
| SR-3 | Met for the client and policy; engine half deferred | SKILL.md `:30-35`; the revision is sent with the reply; near-miss kinds are refused before connecting. `V12ReplyKinds.test_contract_near_miss_kinds_refused_before_sending`, `test_sr3_*`; `may_request` only in the project policy (`:1395-1397`) |
| SR-4 | Engine; see M2 for the interview path | The advice file and hash are the engine's. The channel has no hash, so in an interview nothing can show a mismatch |
| SR-5 | Met | SKILL.md `:39-43`; H-0064 rules in both caller AGENT.md files. `AC11AdviceChangesNothing`, `SkillTextF006.test_sr5_advice_is_data` |
| SR-6, SR-10 (labelling), SR-11, SR-12 | Deferred (§5: engine) | None of these exist yet |
| SR-7 | Met | Template policy and checker as in FR-6. The A-3 narrowing is the inbox and interview denies (`ADVISOR_EXTRA_DENY`) |
| SR-8 | **Needs owner** (M2) | Per-call caps and the one-pending-proposal rule are the engine's. But "shown in the approval prompt" has no channel field, and the skill can only say a call "counts against the project budget" (SKILL.md `:176-178`) |
| SR-9 | Met | No shell. Its grant is a future Security decision (AGENT.md; Role policy v2.3 text) |
| A-1 | **Needs owner** (M2) | As SR-8: the over-budget warning can't reach the interview prompt, and `ask_advisor` has none |
| A-2 | Met (client half) | SKILL.md `:33-34`; `V12AtMostOneCall.test_a2_failed_ask_is_not_retried_by_the_client`, `SkillTextF006.test_a2_*` |
| A-3 | Met (policy) | As SR-7 |

### Edge cases (spec §6)

| Edge case | Handled? |
|---|---|
| Asking again on the same question | Yes: `V12ReplyKinds.test_edge_asking_again_keeps_both_answers` (both calls are kept and shown) |
| A call fails or times out | Yes, client side: shown as failed and never retried (A-2 tests) |
| The question changes revision while the advisor runs | **No**: advice entries carry no revision, so the client can't show which revision the advice was for (M2) |
| Planted text in a file or page | Client side: AC-11 tests. The advisor's own behavior is the engine's |
| The feature is deferred or closed during a call | The engine's |

### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval (DoD 1, 2) | Met | Spec v5 Approved; readiness gate passed in `7e4fb0c`; Q1 to Q9 answered; A-1 to A-3 and the owner SR decisions approved |
| Architecture / ADRs | Met | ADR 0001: the engine isn't built, and §5 says so. ADR 0003: the skill stays a front end on the channel. ADR 0004: the advisor policy is in the manifest and checked by the checker. No conflict. The checker code for H-0061 landed in the hygiene draft `c78c785`, before the readiness gate, and was approved as drafted. That follows the F-005 precedent (`9a4ab75`), so I don't log it |
| Interface contracts | **Needs owner** (M1, M2) | The contract tests pass (`V12ReplyKinds`, `AC10AdviceShown.test_contract_*`, `FR11Proposals.test_contract_*`). There is no unapproved diff to `interface-contracts.md`. But the client is stricter than v1.2 in places a conforming engine can hit (M1), and v1.2 can't carry what SR-8, A-1 and one edge case need (M2) |
| Code quality, readability, maintainability | Met, with findings | The new parsing is strict, done in one place (`parse_advice`) and fails closed. The display keeps every engine string in a fence. The checker additions are small and refuse what they can't prove. Findings: m7, m8 |
| Comments | Met (see m7) | New comments say why: `interview_client.py:651-653`, `:671-672`, `:695-697`, `:752-754`; `factory_check.py:1218-1225`. One is inaccurate: `factory_check.py:1317` (m7) |
| Test tools | Met (see m2) | `F-006-test-report.md` "Tool choice" names `unittest` with a reason. Coverage.py is named best fit and left open, not substituted. The seeded `random` checks are correctly not counted as property tests (H-0020) |
| Documentation | Met (see m1) | H-0060 to H-0064 are all in place: `agents/advisor/AGENT.md`, spec §2.9, `docs/agent-responsibilities.md`, `docs/architecture.md`, the contracts, and the analyst and orchestrator AGENT.md files. SKILL.md and `plugin.json` 0.3.0 are updated. The repo README is not (m1). The dev and test reports are present |
| Security | **Pending Gate 2** | Gate 1 (`F-006-security-gate1.md`) is present, with nothing blocking at Rapid prototype. I didn't read Gate 2, on instruction. This line becomes Met only if Gate 2 has no Critical finding |

## Findings

### Blocking

None.

### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `interview_client.py:694-703` (proposal fields, `about`), `:664-672` (`text` on `running`/`failed`); Engine control channel v1.2 `Item` | **Needs owner (Interfaces).** The approved `Item` makes `suggested`, `options` and `findings` optional on every kind, and `advice[].text` optional on every status. The client refuses the whole item when an `advisor_proposal` carries any of those fields, even `options: []` or `advice: []`. It also refuses `about` on any other kind and `text` (even `""`) on a `running` or `failed` call (probe p2). Each choice has a safety reason: options beside Approve and Decline would read as choices, and failed text must not show (AC-9). But an engine that always writes empty lists, or a failure reason in `text`, follows the contract and gets `bad_response`. Then the owner can't see, answer or decline that item, and `next` keeps returning it. The developer flags this (dev report items 1, 2). **Recommendation:** amend v1.2 as a clarification. It is non-breaking because no engine exists. The amendment says: "an `advisor_proposal` carries only `id, revision, kind, about, text, why, status`; `about` appears only on proposals; `advice[].text` is present only when `status` is `done`". Keep the client as it is. Optionally, the developer could let the client treat empty lists as absent. |
| M2 | Engine control channel v1.2 (`Item`, reply kinds); spec SR-8, A-1, SR-4, §6 revision edge case; `SKILL.md:176-178` | **Needs owner (Interfaces, plus one Product point).** In an interview, the "approval prompt" is the skill showing an `advisor_proposal`, or the question picker for the owner's own `ask_advisor`. Channel v1.2 carries no per-call caps (SR-8) and no over-budget flag (A-1), so no engine can put them in front of the owner there. The engine can't put them in `why` either, because that text is labelled as the analyst's. `ask_advisor` starts the call with no prompt at all (FR-3, AC-4). The skill can only say a call "counts against the project budget". Two more gaps sit in the same place. Advice entries have no `revision`, so the §6 case "shown against the revision it was asked about" can't be met. Interview advice has no hash, so SR-4's "a mismatch is shown" can't happen in an interview. **Recommendation:** one Interfaces card with optional, non-breaking v1.2 fields: `advisor: { limits: { turns, tokens, time_s, web_calls }, over_budget }` on every question and every proposal, so the owner sees them before picking; `revision` on each advice entry; and either a hash or a contract sentence that the engine checks the SHA-256 before sending and marks a mismatch. The Product point: should an over-budget `ask_advisor` need a confirming step? I recommend no, to keep AC-4 as written, with the warning shown on the question beforehand. The developer then shows the new fields in `display`. |
| M3 | Spec §4 AC table; spec §5 | Spec §5 defers the engine side, so this is no gap in this feature. But three acceptance criteria have no test anywhere (AC-5, AC-6, AC-7), six more are tested only on the client or policy side (AC-1, AC-2, AC-3, AC-8, AC-9, AC-11), and FR-4 to FR-8, FR-10, SR-4, SR-6, SR-8, SR-11 and SR-12 are engine-only. Nothing tracks this list for the engine feature, which has no spec yet. F-005 marked its deferred ACs in the spec ("Tested with the engine feature", v8). **Recommendation:** the orchestrator records the deferred list where the engine feature will pick it up: the dev report's "Deferred to the engine" table is a good start. It can also propose a spec v6 that marks the engine half of each AC row. That is a wording change, but spec edits go through the owner, so it can ride on the M2 card. |

### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `README.md:29-43` | The interview section still says "version 0.2.0 or later" and doesn't mention asking the advisor or approving its proposals. The developer notes this (dev report item 9). |
| m2 | `F-006-test-report.md` "Coverage" | Coverage was not reported. The bar at Rapid prototype is "Reported". The coverage.py tool decision has been open since F-003 (m27) and F-005 (m3), and still nobody has filed it. The orchestrator should file it. |
| m3 | `docs/features/` | There is no `F-006-orchestrator-review.md` (DoD 6). It is needed before the PR, not for this verdict. |
| m4 | `F-006-test-report.md` header | "Commit tested: `7e4fb0c` with uncommitted changes" is not the final commit. The product hashes match `8abb039`, and I re-ran their files there, so I accept it. A one-line confirmation on `8abb039` would close DoD 5 cleanly. |
| m5 | `interview_client.py:853-860` (`_shown`); `SKILL.md:213-217` | `advice_running` reflects only the item returned. After `ask_advisor`, the contract doesn't say whether `next` is the same question. If the engine moves on to another item, the owner isn't told that the call is running on the earlier question. Settle this with M2, or have the skill say that the call started after any successful `ask_advisor` or `approve_advisor`. |
| m6 | `SKILL.md:169-198`; dev report item 8 | The skill offers "Ask the advisor" against any engine whose `engine.json` says 1.x. A v1.1 engine answers `kind_not_allowed`. To keep F-005 OQ-3 ("no escalation until built") exactly, offer it only when the engine reports 1.2 or later. |
| m7 | `factory_check.py:1317` | The comment says glob containment "is undecidable here". It is decidable, just not worth implementing for this check. Say "is hard to prove in general" so the reason stays true. |
| m8 | `interview_client.py:642,708,712` | Three inline copies of the "item the client can't read" error remain beside the new `_unreadable()` helper. Use the helper everywhere. |
| m9 | Engine control channel v1.2, `interview.next` `wait_s` | `wait_s` is defined only for `researching`. Whether the engine waits for a running advisor call is unstated (dev report item 3). The skill doesn't depend on it. Clarify it with M2. |

## Counts

- Blocking: 0.
- Major: 3 (M1 to M3). M1 and M2 need the owner.
- Minor: 9 (m1 to m9).
- Lines: 0 Not met. 2 lines are Needs owner (Interface contracts; SR-8 and A-1 with the §6 revision case). The Security line waits for Gate 2.

## To reach PASS at Rapid prototype

1. **Owner, one Interfaces card on channel v1.2 (M1, M2).** Recommended: approve all of it as optional, non-breaking clarifications, since no engine exists yet.
   - State the proposal's fields, where `about` goes, and that advice `text` comes only with `done` (M1).
   - Add the call limits and over-budget flag on questions and proposals (M2).
   - Add a revision on each advice entry (M2).
   - Add a hash, or the engine-side hash check (M2).
   - Product point: no extra confirm for an over-budget `ask_advisor` (M2).

   The orchestrator records the approval. The developer then shows the new fields in `display` and the test engineer adds tests.
2. **Gate 2** must have no Critical finding. If it does, this becomes FAIL.
3. Before the PR: the orchestrator review note (m3), and the deferred-AC list recorded for the engine feature (M3).
