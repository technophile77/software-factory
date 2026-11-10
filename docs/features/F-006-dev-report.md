# F-006 Developer completion report

- **Feature:** F-006 Advisor agent for hard questions, spec v5
- **Role:** software-developer
- **Date:** 2026-11-10
- **Deliverable:** the client side of the advisor in `plugins/software-factory/skills/spec-interview/` (SKILL.md, `scripts/interview_client.py`, fake engine and developer tests), plugin 0.3.0
- **Contracts used:** Engine control channel v1.2 (H-0063), Inbox item v1.1 (H-0062). Neither was changed by the developer. Inbox item v1.1 has no client in this repo yet (the VS Code extension doesn't exist), so only the channel is implemented.
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

On Python 3 (container default):

- spec-interview, all suites (`python3 -m unittest discover -s plugins/software-factory/skills/spec-interview/tests`): 308 run, all pass. 107 are developer tests (86 from F-005, 21 new); `test_acceptance.py` and `test_acceptance_f006.py` are the test engineer's and were not edited. During one earlier run the test engineer was editing `test_acceptance_f006.py`, and two of its tests failed then. Both passed when that file was run again by itself, and in the final full run.
- onboard-repo, all suites: 288 run, all pass, 1 skipped (Python 3.10 not installed).
- `python3 scripts/check_docs.py`: passes.

## Deferred to the engine

Not built: they need the engine (ADR 0001), as the spec's constraint says.

| Id | What the engine must do |
|---|---|
| FR-2, AC-1 | Refuse advisor requests from any role but the analyst and orchestrator (`may_request`, role from the session) |
| FR-3 (engine) | Run a call only from `ask_advisor`, `approve_advisor` or an owner `advisor_requested` inbox action; at most one call per reply |
| FR-4, AC-6, SR-11 | Start the advisor on the pinned strongest model at high effort; record the rung |
| FR-5, AC-7 | Build the input without the caller's recommendation or reasoning |
| FR-6, AC-8, SR-7 | Enforce the advisor role policy; confine pointers; supply only the current feature's transcript |
| FR-7, SR-9 | No shell until the R2-1 sandbox and its own Security decision |
| FR-8, AC-9 (engine) | Check the four-section shape and size; mark the call `failed` otherwise |
| FR-10 | Record advice in the transcript and in inbox items |
| SR-1 (engine) | Log every address and search; write `web_queries` from that log |
| SR-3 (engine) | Ignore and file forged `advisor_requested` / `advisor_reason`; check proposal revisions; check reply kinds (-32005) |
| SR-4 | Engine-only advice file linked by SHA-256; caller changes shown as new revisions |
| SR-6 | Secrets scan on the advice before recording; hold the call on a hit |
| SR-8 | Per-call caps; one pending proposal per item; maximum advice size |
| SR-10 (engine) | Label advice untrusted and mark web-sourced findings from its log |
| SR-12, A-1 | Budget and `max_usd` checks; the over-budget warning |
| AC-11 (agents) | Fake analyst and orchestrator take no action from advice (H-0064 rules are in their AGENT.md files) |
| Inbox path (FR-3, FR-9, FR-10, AC-5) | "Ask the advisor first" and the Advisor section belong to the VS Code extension and the engine, which don't exist yet |

## Spec deviations

None.

## Not settled by the spec or the contract

These are readings the developer had to make, or gaps that need an owner or orchestrator decision before the engine is built. The client takes the safer reading in each case.

1. **Text on a `running` or `failed` call.** Channel v1.2 makes `text` optional on every advice entry. The client accepts text only on `done` and refuses the item if a `running` or `failed` entry carries any, because AC-9 says nothing is shown as advice for a failed call and a running call's output hasn't passed FR-8's check. If the engine is meant to send a failure reason, the contract needs a separate field for it (Interfaces).
2. **Fields on a proposal.** The contract's Item allows `suggested`, `options` and `findings` on every kind. The client refuses them, and `advice`, on an `advisor_proposal`, since beside the Approve / Decline choice they would read as choices. Say if the engine should be allowed to send them.
3. **Waiting for advice.** `interview.next`'s `wait_s` is defined as waiting for research (`researching`). The question stays `open` while the advisor works, so nothing says whether the engine waits for a running call. The skill doesn't rely on it: it tells the owner the call is running and runs `next` again only when the owner asks. If the engine should wait, the contract should say so (Interfaces).
4. **Which revision the advice was for.** Edge case "the advice is shown against the revision it was asked about" needs a revision on each advice entry, which channel v1.2 doesn't have. The client can't show it now (Interfaces).
5. **Approval prompt facts.** SR-8 (caps shown in the approval prompt) and A-1 (the prompt says when a call would go over budget) have no channel field, so the skill can only say that a call counts against the project budget. A field on `advisor_proposal` (and for `ask_advisor`, a way to show it before the owner picks) is needed (Interfaces).
6. **SR-4 hash in the interview.** The inbox contract links advice by SHA-256; the channel's advice entry has no hash, so the skill can't warn on a mismatch. The engine is the only writer of the channel's text, so this may be enough for interviews; the contract should say so.
7. **Proposal statuses.** The contract says a proposal becomes `approved` or `rejected`, but the status list is shared by every kind. The client doesn't restrict statuses by kind (as for v1.1 assumptions). The fake engine refuses a second decision on a proposal as `stale`; the contract doesn't name an error for that.
8. **Engine version.** The client accepts the v1.2 fields from any engine whose `engine.json` says 1.x (x ≥ 1). Against a v1.1 engine, "Ask the advisor" would get `kind_not_allowed`. F-005 OQ-3 ("no escalation until F-006 is built") could be kept exactly by offering it only when `engine.json` says 1.2 or later. That is a small change if wanted.
9. **README.** The repo README's interview section doesn't mention the advisor; it was outside the files this task allowed.
