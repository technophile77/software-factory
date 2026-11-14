# F-006 Developer completion report

- **Feature:** F-006 Advisor agent for hard questions, spec v5
- **Role:** software-developer
- **Date:** 2026-11-10
- **Deliverable:** the client side of the advisor in `plugins/software-factory/skills/spec-interview/` (SKILL.md, `scripts/interview_client.py`, fake engine and developer tests), plugin 0.3.0
- **Contracts used:** Engine control channel v1.2 (H-0063), Inbox item v1.1 (H-0062). In fix round 1 the developer drafted amendments H-0075 (channel) and H-0076 (Role policy) and agent-file item H-0077 at the orchestrator's request; all three await the owner (see "Fix round 1"). Inbox item v1.1 has no client in this repo yet (the VS Code extension doesn't exist), so only the channel is implemented.
- **Scope:** the engine doesn't exist yet (ADR 0001), so, as for F-005, this delivers the skill and client and tests them against the fake engine. The role file, policy and contract changes (FR-1, H-0060 to H-0064) were already approved and merged as hygiene items; the engine-side requirements are listed under "Deferred to the engine".

## What changed

| File | Change |
|---|---|
| `plugins/software-factory/skills/spec-interview/scripts/interview_client.py` | Channel v1.2. Reply kinds `ask_advisor`, `approve_advisor`, `decline_advisor`. Item kind `advisor_proposal` with `about`. A question's `advice` list (`call`, `status`, `text`, `web_queries`), parsed strictly by `parse_advice`, failing closed. `advice_display` shows each call under the client's own label, with the advisor's text and the engine's query log fenced. Outputs carry `advice_running` while a call runs |
| `plugins/software-factory/skills/spec-interview/SKILL.md` | "Ask the advisor" on every question; advisor proposals shown for Approve / Decline; two new rules: advisor replies only from the owner's own pick in the picker, and advice shown word for word through `display`, never summarized, untrusted data. Failed calls are shown and never asked again by the session (A-2). What to do while a call runs |
| `plugins/software-factory/skills/spec-interview/tests/fake_engine.py` | Channel v1.2: `proposal()` helper, reply kinds checked against item kind (-32005), `ask_advisor` and `approve_advisor` start one call each (recorded in `advisor_calls`), advice entries going `running` to `done` or `failed` (by timer or `finish_call`), a decided proposal refuses another approval as `stale`, stale revisions on proposals |
| `plugins/software-factory/skills/spec-interview/tests/test_interview_client.py` | 21 new developer tests (107 in all): classes `Advisor`, `AdviceDisplay`, `AdvisorFieldsFailClosed`, and `SkillText.test_f006_*` |
| `plugins/software-factory/.claude-plugin/plugin.json` | Version 0.3.0 |

## Requirement mapping

| Id | Where | Test (class.test) |
|---|---|---|
| FR-11 | SKILL.md step 4: "Ask the advisor" on every question, advisor proposals with Approve / Decline. Client sends the new kinds unchanged and shows proposals | `Advisor.test_fr11_*`, `test_approving_a_proposal_*`, `test_ac2_declining_*`, `SkillText.test_f006_*` |
| FR-3 (client part) | `ask_advisor` needs no second step; `approve_advisor` / `decline_advisor` only on a proposal. The engine starts the call | `Advisor.test_fr11_*`, `test_approving_*`, `test_ac2_*`, `test_a_decided_proposal_cannot_start_a_second_call` |
| FR-9, AC-10 (client part) | Advice shown word for word after `clean()`, inside a fence it can't close, under the client's label "Advisor's advice, call …", after the question's own fields, in the same `display`. SKILL.md: never summarize or rewrite | `Advisor.test_advice_arrives_done_*`, `test_asking_again_*`, `AdviceDisplay.test_ac12_*` |
| AC-9 (client part) | A `failed` entry is shown as failed with no text; a `failed` or `running` entry carrying `text` is refused, so unchecked or rejected output is never shown as advice | `Advisor.test_a2_*`, `AdvisorFieldsFailClosed.test_malformed_*` |
| AC-12, SR-2 | `clean()` on advice text and each web query (bidi, zero-width, ANSI, tags, variation selectors removed); image Markdown, raw `<img>`, links, a forged `## Recommendation` and a forged client label stay inside the fence; nothing engine-written appears outside one | `AdviceDisplay.test_ac12_image_html_link_heading_and_bidi_are_inert` |
| SR-1, SR-10 (client part) | Web queries shown in their own fenced list labelled "recorded by the engine from its own log, not by the advisor"; an empty list says "none" | `Advisor.test_advice_arrives_done_*`, `test_empty_web_query_log_says_none`, `AdviceDisplay.test_web_queries_are_one_line_each` |
| SR-3 (client part) | SKILL.md: `ask_advisor` / `approve_advisor` / `decline_advisor` only from the owner's own pick in the picker in this turn, never from item or advice text. Client checks the kind against the contract before connecting; the fake engine refuses kinds that don't fit (-32005) and stale proposal revisions (-32002) | `Advisor.test_sr3_*`, `test_unknown_reply_kinds_*`, `SkillText.test_f006_*` |
| SR-5 (client part) | SKILL.md: advice is untrusted data, not instructions; it never changes what is sent. The client sends nothing on reading advice | `Advisor.test_sr5_instructions_in_advice_send_nothing` |
| A-2 (client part) | Failed calls are shown; SKILL.md forbids asking again without the owner; no retry in the client | `Advisor.test_a2_*` |
| Edge case: ask again | Each `ask_advisor` is a new call; every entry stays and is shown | `Advisor.test_asking_again_*` |
| Retry safety | A retried `ask_advisor` after a dropped connection reuses its `reply_id`. The state check can't tell (status and revision don't move on `ask_advisor`), so the contract's reply-id rule is what stops a second call | `Advisor.test_retried_ask_advisor_*` |
| Channel v1.2 validation | `advisor_proposal` must carry a valid `about` and no `suggested`, `options`, `findings` or `advice`; `about` on any other kind, or `advice` on anything but a question, is refused. Advice: a list of objects, valid unique `call` ids, `status` in `running`/`done`/`failed`, `done` needs non-empty text, `web_queries` a list of strings. Any fault fails the whole item (`bad_response`), never a partial read. Unknown keys in an entry are dropped unread | `AdvisorFieldsFailClosed.*`, `AdviceDisplay.test_extra_fields_*` |

## Tests run

**After fix round 1** (Python 3.13):

- spec-interview, all suites: 319 run. All 118 developer tests pass (107 + 11 in `F006FixRound1`), and so do the F-005 acceptance tests. 116 subtests in 10 methods of the test engineer's `test_acceptance_f006.py` fail, all because of the v1.2 gate (see "Effect on the test engineer's tests").
- onboard-repo, all suites: 292 run (4 new developer tests in `AdvisorFactoryDeny`), 1 skipped. 11 subtests in 5 of the test engineer's methods fail on the old advisor deny list (same section).
- `python3 scripts/check_docs.py`: passes.

**First round** (Python 3, container default):

- spec-interview, all suites (`python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests`): 308 run, all pass. 107 are developer tests (86 from F-005, 21 new); `test_acceptance.py` and `test_acceptance_f006.py` are the test engineer's and were not edited. During one earlier run the test engineer was editing `test_acceptance_f006.py`, and two of its tests failed then. Both passed when that file was run again by itself, and in the final full run.
- onboard-repo, all suites: 288 run, all pass, 1 skipped (Python 3.10 not installed).
- `python3 scripts/check_docs.py`: passes.

## Deferred to the engine feature

Not built: each needs the engine (ADR 0001), as spec section 5 says. The
engine feature must pick up every line below and test it there; F-006 has
tested only the client, skill and policy halves (validation M3). "Client
half done" names the tests that cover what exists now.

| Id | Deferred part (engine, or VS Code extension for the inbox) | Client or policy half done now |
|---|---|---|
| FR-2 | Refuse an advisor request from any role but the analyst and orchestrator, taking the role from the engine's own session | Checker: `may_request` (H-0061) |
| FR-3 | Start a call only from `ask_advisor`, `approve_advisor` or an owner `advisor_requested` inbox action; at most one call per reply; "Ask the advisor first" on inbox items | Client sends the three kinds only from the skill's picker; `Advisor.*` |
| FR-4 | Run the advisor on the pinned strongest model at high effort; record the rung in the agent report | — |
| FR-5 | Build the advisor's input without the caller's recommendation or reasoning | Client sends only the reply fields |
| FR-6 | Enforce the advisor's tools and read rules at run time; confine pointers; supply only the current feature's transcript | Checker and template (H-0061, H-0076) |
| FR-7 | No shell until the R2-1 sandbox and its own Security decision | Checker refuses any shell or command |
| FR-8 | Check the four sections, option count and size; mark the call `failed` with a `reason` otherwise | Client refuses text on a running or failed call; shows the reason |
| FR-9 (inbox) | Show the advice in the inbox item, labelled and encoded | Interview display done |
| FR-10 | Record the advice in the transcript and in the inbox item's history and body | — |
| FR-11 | — | Done in the skill |
| AC-1 | Engine refusal of a request from another role | Policy half |
| AC-2, AC-3, AC-4 | Exactly one (or no) advisor session starts; the transcript records the approval and the reason | Client half: `Advisor.*`, test engineer's `V12ReplyKinds` |
| AC-5 | The inbox path, end to end | — |
| AC-6 | Top rung at high effort whatever the manifest or evaluator say; agent report records it | — |
| AC-7 | Input built without the recommendation or reasoning | — |
| AC-8 | Write, shell and denied reads refused at run time | Policy half |
| AC-9 | Malformed output rejected and the call marked failed | Client half: failed shown, no advice |
| AC-10, AC-12 (inbox) | Inbox rendering of the advice | Interview half done |
| AC-11 | Fake analyst and fake orchestrator make no state change after reading injected advice | Client half: `Advisor.test_sr5_*`; agent rules H-0064, H-0077 |
| SR-1 | Log every address and search against the call; write `web_queries` from that log | Display of the list, and of "not reported" |
| SR-3 | Requester role from the session; ignore and file forged `advisor_requested` and out-of-role `advisor_reason`; check proposal revisions and reply kinds; refuse a decided proposal (`stale`, H-0075) | Client and skill half |
| SR-4 | Engine-only advice file; SHA-256 in the item and the channel (H-0075); caller changes after advice shown as new revisions | Client compares the hash with the text and warns |
| SR-6 | Secrets scan on the advice before recording; hold the call on a hit | — (advisor AGENT.md line, H-0077) |
| SR-7 | Pointer confinement; transcript supply | Policy half |
| SR-8 | Per-call caps enforced; one pending proposal per item; maximum advice size; `advisor_call` limits sent (H-0075) | Client shows the limits |
| SR-9 | The shell grant as its own Security decision | — |
| SR-10 | Label advice untrusted; mark web-sourced findings from the log | Client labels the advice untrusted |
| SR-11 | Model and effort pinned in change-controlled config | — |
| SR-12, A-1 | Budget, `max_usd` and billing-mode checks; `over_budget` sent (H-0075) | Client shows the warning |
| A-2 | Never retry a failed call without a new approval | Skill and client never retry |
| Edge cases | Advice still recorded when the feature is deferred or closed during a call; `revision` on each advice entry (H-0075) | Client shows the revision |
| Engine Code Review note | Enforce each role's tool list as a hard limit, so a skill's `allowed-tools` can't widen a read-only role (Code Review info) | — |

## Spec deviations

None.

## Not settled by the spec or the contract

These are readings the developer had to make, or gaps that need an owner or orchestrator decision before the engine is built. The client takes the safer reading in each case.

Items 1 to 8 below are from the first round. H-0075 (draft) settles 1 to 7,
and the v1.2 gate settles 8, once the owner approves; the client already
follows them. Item 9 is done.

1. **Text on a `running` or `failed` call.** Channel v1.2 makes `text` optional on every advice entry. The client accepts text only on `done` and refuses the item if a `running` or `failed` entry carries any, because AC-9 says nothing is shown as advice for a failed call and a running call's output hasn't passed FR-8's check. If the engine is meant to send a failure reason, the contract needs a separate field for it (Interfaces).
2. **Fields on a proposal.** The contract's Item allows `suggested`, `options` and `findings` on every kind. The client refuses them, and `advice`, on an `advisor_proposal`, since beside the Approve / Decline choice they would read as choices. Say if the engine should be allowed to send them.
3. **Waiting for advice.** `interview.next`'s `wait_s` is defined as waiting for research (`researching`). The question stays `open` while the advisor works, so nothing says whether the engine waits for a running call. The skill doesn't rely on it: it tells the owner the call is running and runs `next` again only when the owner asks. If the engine should wait, the contract should say so (Interfaces).
4. **Which revision the advice was for.** Edge case "the advice is shown against the revision it was asked about" needs a revision on each advice entry, which channel v1.2 doesn't have. The client can't show it now (Interfaces).
5. **Approval prompt facts.** SR-8 (caps shown in the approval prompt) and A-1 (the prompt says when a call would go over budget) have no channel field, so the skill can only say that a call counts against the project budget. A field on `advisor_proposal` (and for `ask_advisor`, a way to show it before the owner picks) is needed (Interfaces).
6. **SR-4 hash in the interview.** The inbox contract links advice by SHA-256; the channel's advice entry has no hash, so the skill can't warn on a mismatch. The engine is the only writer of the channel's text, so this may be enough for interviews; the contract should say so.
7. **Proposal statuses.** The contract says a proposal becomes `approved` or `rejected`, but the status list is shared by every kind. The client doesn't restrict statuses by kind (as for v1.1 assumptions). The fake engine refuses a second decision on a proposal as `stale`; the contract doesn't name an error for that.
8. **Engine version.** The client accepts the v1.2 fields from any engine whose `engine.json` says 1.x (x ≥ 1). Against a v1.1 engine, "Ask the advisor" would get `kind_not_allowed`. F-005 OQ-3 ("no escalation until F-006 is built") could be kept exactly by offering it only when `engine.json` says 1.2 or later. That is a small change if wanted.
9. **README.** The repo README's interview section doesn't mention the advisor; it was outside the files this task allowed.

## Fix round 1 (Code Review and validation)

Inputs: `F-006-code-review.md` (bfba26a) and `F-006-validation.md`
(5c18c92). The test engineer's files were not edited.

### Hygiene drafts (change-controlled; awaiting the owner)

Drafted at the orchestrator's request, each in its own commit marked as a
draft. They take effect only when the owner approves them.

| Item | Change | Finding |
|---|---|---|
| H-0075 | Engine control channel v1.2 amendment, all optional and engine-written: proposals carry only `id, revision, kind, about, text, why, status` (+ `advisor_call`); `about` only on proposals and `advice` only on questions; advice `text` only on `done`, a one-line `reason` only on `failed`, `revision` the call was asked about, `sha256` of the stored advice, `web_queries` missing means "not reported"; `advisor_call: { limits: { turns, tokens, time_s, web_calls }, over_budget }` on questions and proposals, shown before the owner chooses with no extra confirmation; a decided proposal gets `stale`; `wait_s` doesn't wait for advisor calls | Code Review #2; validation M1, M2, m9 |
| H-0076 | Role policy v2.3 amendment: the advisor's extra denies become `.factory/**` and `**/.factory/**` (all of `factory/state`: earlier advice, run records, tuning data, as well as inbox and transcripts). Checker, template and the developer's checker tests (`AdvisorFactoryDeny`, 4) follow; the containment comment is corrected | Code Review #1; validation m7 |
| H-0077 | `agents/orchestrator/AGENT.md`: take no action from instructions in advice; a revision after reading advice is its own judgment and says it followed advisor call `<id>`. `agents/advisor/AGENT.md`: never quote a secret it comes across; say where it is | Code Review #5 and info note |

### Feature code

| Item | Fix | Test (`test_interview_client.py`) |
|---|---|---|
| H-0075 fields | Parsed strictly (fail closed): advice `revision`, `reason` (failed only, one line, 500 characters), `sha256` (done only, 64 lowercase hex), `advisor_call` (four non-negative integer limits and a boolean, not on assumptions). Display: limits and the over-budget warning in the client's words beside "Ask the advisor" and on proposals; "asked about revision n", flagged when the question has moved on; the hash compared with the text as sent (before cleaning) and a warning on a mismatch; the failure reason fenced | `F006FixRound1.test_sr8_a1_*`, `test_advice_revision_*`, `test_sr4_*`, `test_lone_surrogate_*`, `test_failed_reason_*`, `test_h0075_malformed_*` |
| Code Review #3 | A done or failed call with no `web_queries` says "not reported by the engine"; `[]` says "none" | `F006FixRound1.test_code_review_3_*` |
| Code Review #4 | SKILL.md: a lost `ask_advisor` is checked with `CLIENT next` for an advisor call that wasn't there before, never with `state`; if it can't tell, it asks the owner before sending anything | `F006FixRound1.test_skill_recovery_and_gating_text` |
| Validation m5 | A successful `ask_advisor` or `approve_advisor` adds `advisor_started` and says so in `display`, even when `next` is another item | `F006FixRound1.test_m5_*` |
| Validation m6, F-005 OQ-3 | The three advisor reply kinds are refused before sending (`advisor_unsupported`, exit 2) unless `engine.json` says channel 1.2 or later; `status` and `open` report `advisor`, and SKILL.md offers "Ask the advisor" only when `open` said true | `F006FixRound1.test_m6_*` |
| Validation m8 | One `_unreadable()` helper for every unreadable-item error | existing tests |
| Validation m1 | README: 0.3.0, the advisor | — |

The fake engine records the asked-about revision on each advice entry.

### Effect on the test engineer's tests (not edited)

- **spec-interview `test_acceptance_f006.py`:** the v1.2 gate (m6) refuses
  the advisor reply kinds because that harness writes `engine.json` with
  version "1.1". Ten test methods fail (116 subtests, most in
  `Properties.test_property_advisor_reply_text_byte_for_byte`). With the
  gate disabled for a check run, all 47 tests in that file pass, so the
  gate is the only cause. Fix on their side: write version "1.2" for the
  advisor tests.
- **onboard-repo `test_acceptance.py` and `test_acceptance_f006.py`:** they
  hard-code the old four advisor denies (`test_acceptance.py:1071`
  `ADVISOR_EXTRA_DENY`, read by both files). H-0076 replaces them with
  `.factory/**` and `**/.factory/**`, so five test methods fail (11
  subtests): `RolePolicyV23.test_template_advisor_is_the_contract_policy`,
  `test_advisor_lists_match_the_contract_text`,
  `test_advisor_denied_inbox_transcripts_and_the_analysts_denies`, and
  `F006AdvisorRepoOverrides.test_sr7_analyst_override_deny_must_reach_the_advisor_in_that_repo`,
  `test_sr7_project_advisor_checked_on_its_own`. Fix on their side: the
  constant becomes `[".factory/**", "**/.factory/**"]`.

## Merge with main (renumbering)

`main` had already used both version numbers F-006 took: Engine control
channel v1.2 is H-0051 there (owner approval of interview sessions through
GitHub, ADR 0014, approved), and Role policy v2.3 is H-0040 there (project
evaluator and context hygiene roles, a draft). The merge keeps `main`'s
numbers, so F-006's become **Engine control channel v1.3** (H-0063, H-0075)
and **Role policy v2.4** (H-0061, H-0076, on top of `main`'s v2.3 roles).
The owner's approvals are unchanged; only the numbers moved. Inbox item v1.1
(H-0062) keeps its number, beside `main`'s ADR 0015 signed-commit rule.
Everything in this report above, and in the Code Review, test and validation
reports, that says channel v1.2 or Role policy v2.3 for the advisor means
v1.3 and v2.4 now.

| Where | Resolution |
|---|---|
| `docs/interface-contracts.md` | Both sides kept. The status paragraph lists `main`'s v1.2, v2.3 and Agent report v1.2 and F-006's v1.3 and v2.4. Channel: `main`'s v1.2 text (session approval, `awaitApproval`, -32006/-32007) plus the advisor text, now marked v1.3. Role policy: `main`'s evaluator and hygiene roles, its glob dialect and container text, and the advisor role and `may_request`, now marked v2.4 |
| `factory_check.py` | `SUPPORT_AGENTS` has all four optional roles; `EVALUATOR_HIDDEN` and the advisor constants both kept |
| `templates/factory-project.yaml` | `project-evaluator`, `context-hygiene` and `advisor` all present; the template validates |
| `onboard-repo/tests/test_acceptance.py` | `SUPPORT_ROLES` has all four roles; the advisor constants kept; the contract-text check reads `**Advisor (v2.4` |
| `interview_client.py` | The advisor gate is now channel 1.3 or later (a v1.2 engine has only H-0051's approval); `main`'s Windows fixes kept. The docstring says H-0051's session approval is not handled by the client yet |
| `SKILL.md` | Channel v1.3; `main`'s Windows `python` note kept |
| Developer tests and fake engine | Version strings to 1.3; a v1.2 engine is checked to have no advisor |
| F-006 spec | v8: FR-11's check is 1.3; section 10 names v1.3 and v2.4 |

**Test engineer's files: version strings only.** At the orchestrator's
request, as a mechanical merge fix:
- spec-interview `test_acceptance_f006.py`: `v1.2` to `v1.3` in eight
  comments and docstrings, `engine_version = "1.2"` to `"1.3"` (line 73),
  and the regex `Engine control channel \(?v1\.2` to `v1\.3` (line 750).
  `engine_version = "1.1"` (the old-engine test) and the class and method
  names that contain `V12`/`v12` are unchanged.
- spec-interview `fake_engine_f006.py`: `v1.2` to `v1.3` in three comments.
- onboard-repo `test_acceptance_f006.py`: `Role policy v2.3` to `v2.4` in six
  docstrings.
- onboard-repo `test_acceptance.py`: the conflict resolution above
  (`SUPPORT_ROLES`, a comment, and the `Advisor \(v2\.4` regex).

**Tests after the merge** (Python 3.13): spec-interview 358 run, all pass;
onboard-repo 306 run, all pass, 1 skipped (no Python 3.10);
`check_docs.py` passes.
