# Feature: The engine acts on the owner's inbox answers and runs the readiness gate

- **Id:** F-016
- **Status:** Draft
- **Requested by / date:** Alex, 2026-11-13 ("what is the critical path until I
  can start onboarding some of my existing projects?"; chose to build engine
  increment 3 next, decision card)
- **Spec version:** 3

This is the rest of the engine's increment 3 ("Requirements to ready", F-007
section 13). F-008 built Security Gate 1 and said that reading inbox answers
and the full readiness gate "come in the next feature". F-011 (Approved v29)
says how inbox items are filed as GitHub issues and how the owner's actions
are read and recorded. It does not say what the engine then does with an
answer to an item the engine filed. This spec says that, and adds the
readiness gate (stage 4) and spec sign-off, so a feature can go from request
to `build_and_test_prep` with no step stuck.

ADR 0022 replaced the SSH-signed owner actions that F-007 section 13 planned
for this increment: owner actions on inbox items are proven by GitHub (F-011
SR-2). Nothing here signs anything.

## 1. Objective and business purpose
Today a feature stops for good at the first point it needs the owner outside
the interview: a Gate 1 finding that needs the owner's choice, a Gate 1
requirement the owner turned down, any engine Security item, or reaching
`readiness_gate`, where nothing runs. The owner can't move it on, because the
engine reads no inbox answer. The trial feature F-002 is in that state.

After this feature, the owner answers in the inbox (F-011), the engine
carries the answer out, the feature passes the readiness gate, the owner
signs the spec off, and the feature is handed to development
(`build_and_test_prep`, built in increment 4, F-015).

## 2. Expected behavior
1. **Inbox on issues.** The engine files every item it files today as an
   F-011 issue instead of a `.factory/inbox/` file, and reads the owner's
   actions every poll, as F-011 FR-1 to FR-8, FR-11 and FR-13 to FR-16 say.
2. **Gate 1 choice items.** When the owner chooses an option on a Gate 1
   choice item (F-008 FR-8), the finding is resolved by that decision. The
   feature goes back to the analyst, who records the chosen option in the
   spec's section 9 citing the finding and the item (OQ-2), and Gate 1's
   check (F-008 FR-9) then passes for it.
3. **Gate 1 risk items.** On a risk item (F-008 FR-13), "Accept the risk"
   resolves the finding as an accepted risk; "Send it back" returns the
   feature to the interview, where the analyst asks about the finding again.
4. **Other engine Security items** have a defined effect per item type
   (FR-6): some restart the stopped feature or project, some only record the
   answer.
5. **Readiness gate.** When a feature reaches `readiness_gate`, the engine
   runs the six readiness checks (`docs/development-workflow.md` stage 4):
   checks 5 and 6 as the interview checks run today, plus Gate 1 resolved,
   and checks 1 to 4 first as structural code checks and then, only if every code check passes, by an orchestrator agent session that judges them (OQ-1). A failure sends the feature back to
   the interview with each gap named; a pass files a **Spec sign-off** item.
6. **Spec sign-off.** Approve (a risky action, confirmed with 🚀 or
   `/confirm`, F-011 FR-6) moves the feature to `build_and_test_prep`.
   Request changes sends it back to the interview with the owner's note as
   data. Defer keeps it waiting.
7. Nothing here asks the owner in a plain log line: everything the owner must
   decide is an inbox item, and `engine.status` shows each feature's stage
   and what it waits on.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | The engine files every item through the F-011 issue store (F-011 H-0161, H-0162): the Security items of `alert` and the Gate 1 choice and risk items, with their current options. It writes no `.factory/inbox/` file. |
| FR-2 | The engine reads and records actions per F-011 FR-5 to FR-8 for every open item of every running project, each poll, and then carries out the action by the item's **effect** (FR-3 to FR-8). An effect runs once per recorded action; a restarted engine runs effects recorded but not yet carried out, and none twice (the record's history holds `effect_done`, H-0181). |
| FR-3 | Gate 1 choice item (F-008 FR-8), option chosen: the finding is resolved by decision. The feature returns to `requirements_interview` if no other finding of the report still waits on an item; the analyst's next session gets each decided finding as data (finding ref, chosen option label, item id) and records it in section 9 as an SR with source `Gate 1 #<n>; <item id>` and status Approved (OQ-2). F-008 FR-9 then treats the finding as resolved when such a row exists and the item's record says that option was chosen. |
| FR-4 | Gate 1 choice item, Reject / Request changes / Ask for more research: the feature returns to `requirements_interview` and the analyst asks the owner about the finding again in the interview, with the owner's note as data. Defer: the feature stays `blocked`. |
| FR-5 | Gate 1 risk item (F-008 FR-13): option A "Accept the risk" records the finding as `accepted_risk` (item id, time) in the feature's Gate 1 state, and F-008 FR-9 counts it resolved; option B "Send it back" returns the feature to `requirements_interview` and the analyst asks about it again. Reject and Request changes act as B; Defer keeps it `blocked`. |
| FR-6 | Engine Security items (`alert`) get one of three effects, fixed per item type in code (table in section 10, H-0182): **record only** (the answer is recorded and the issue closes; the engine re-checks the condition on its own next check, as today); **resume** (option A clears the stop it reported and restarts the stopped feature from its last good commit, re-running the check that stopped it; if the check fails again, a new item is filed); **owner keys** (OQ-3). Option B always leaves things stopped and closes the issue. |
| FR-7 | Readiness gate: when a feature enters `readiness_gate`, the engine runs, at the spec commit that passed: the interview checks of F-007 (checks 5 and 6, transcript intact, spec version), F-008 FR-9 (Gate 1 resolved), and the structural checks for 1 to 4: sections 1 to 5 present and not empty, every FR covered by at least one AC's Covers column, every AC in Given/When/Then form, every AC's Covers naming an existing FR. Only if every code check passes, the engine starts one orchestrator session (OQ-1) on that commit: read-only worktree, the spec and the six checks in its first turn, its only write its report `.factory/runs/<feature>/readiness_gate/orchestrator-<n>.json`; it judges checks 1 to 4 (clear, consistent, testable) and the engine validates the report as F-008 FR-5 does for the reviewer (one correction turn). The result, with each check's name, passed flag and evidence, is recorded on the feature's chain and in an Agent report with the `orchestrator` body (`gate`, `checks`). |
| FR-8 | Readiness failed: the feature returns to `requirements_interview`; the analyst's next session gets the failed checks' evidence as data and fixes the spec through the interview. Readiness passed: the engine files one Spec sign-off item (kind `spec`, sections Summary, Readiness, Open items, F-011 Inbox item v3.0) naming the feature, spec path, version and commit, and the feature waits at `readiness_gate` with `waiting_on` the item. |
| FR-9 | Spec sign-off Approve, confirmed per F-011 FR-6 at the same revision: the engine checks that the feature branch head still equals the signed-off spec commit, then records `spec_signed_off` (item id, spec version, commit) and the stage `build_and_test_prep`. If the branch moved, nothing is recorded: the item is revised to the new commit (F-011 FR-8) and the readiness gate runs again first. Request changes: the feature returns to `requirements_interview` with the note as data. Defer: it keeps waiting. |
| FR-10 | `engine.status` shows, per feature, the stage and, when it waits on the owner, the open item ids (Engine control channel minor change, H-0183). |
| FR-11 | Effects and the structural checks are code (owner rule, 2026-11-13: tools, not tokens); only the judgment of checks 1 to 4 is an agent session, and only after the code checks pass (OQ-1). No agent reads issue comments or records. The orchestrator session's model and limits come from the master's `models.yaml` and `limits.yaml` (H-0184); a project's `limits:` may only lower them; without an `orchestrator` entry, or without the role in the project's policy, no session starts and the transcript and engine log say why. |
| FR-12 | Existing open item files on `factory/state` are moved to issues by F-011's one-time migration script (F-011 FR-16); an item whose effect is defined here gets that effect when answered on its issue. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given the engine files a Gate 1 choice item, then it is an F-011 issue with the reviewer's options and recommendation, and no file appears under `.factory/inbox/`. | FR-1 |
| AC-2 | Given the owner chooses option B on a Gate 1 choice item, when it is recorded, then the feature returns to `requirements_interview`, the analyst's input names the finding, option B and the item id as data, and once the spec has an Approved SR citing `Gate 1 #<n>; <item id>`, F-008 FR-9 passes for that finding and the feature reaches `readiness_gate` after the interview checks. | FR-3 |
| AC-3 | Given an Approved SR citing a choice item whose record shows a different option, or no recorded choice, then FR-9 fails naming the finding. | FR-3 |
| AC-4 | Given "Accept the risk" on a risk item, then the finding is recorded `accepted_risk` and no longer blocks; given "Send it back", the feature returns to the interview and the analyst asks about the finding again. | FR-5 |
| AC-5 | Given Defer on any Gate 1 item, then the feature stays `blocked` and the issue stays open with the lowered priority. | FR-4, FR-5 |
| AC-6 | Given option A on a "resume" item (for example "Analyst wrote outside its rules"), then the feature restarts from its last good commit; given the same violation again, then a new item is filed and the feature stops again. Given option B, nothing restarts. | FR-6 |
| AC-7 | Given an engine restart between recording an action and carrying out its effect, then the effect runs exactly once after the restart. | FR-2 |
| AC-8 | Given a feature at `readiness_gate` whose spec passes every check, then one Spec sign-off item is filed and the feature waits on it; given one failing check, then no item is filed, the feature is back at `requirements_interview`, and the analyst's input names the failed check and its evidence. | FR-7, FR-8 |
| AC-9 | Given a confirmed Approve on the Spec sign-off item, then the feature's stage is `build_and_test_prep` with a `spec_signed_off` entry; given Approve without the confirm, or a confirm after the branch moved, then the stage does not change. | FR-9 |
| AC-10 | Given `/changes <note>` on the Spec sign-off item, then the feature returns to the interview and the analyst gets the note as data, never as instructions. | FR-9, SR-2 |
| AC-11 | Given F-002 in the end-to-end trial project, when the owner answers its open Gate 1 items in the inbox, then F-002 reaches the Spec sign-off item, and after the owner's confirmed Approve, `build_and_test_prep`. | FR-1 to FR-9 |
| AC-13 | Given a spec with an FR that no AC covers, then the readiness gate fails naming it and no orchestrator session starts; given a spec passing every code check, then exactly one orchestrator session runs, and its failed check sends the feature back to the interview with the evidence as data. | FR-7, FR-11 |
| AC-14 | Given an orchestrator report that is invalid twice, or a session that writes outside its report, then the gate fails closed, nothing is committed from it, and the transcript and engine log say why (the write case also files a Security item, as for the reviewer). | FR-7, SR-11 |
| AC-12 | Given a feature waiting on items, then `engine.status` lists its stage and the open item ids. | FR-10 |

## 5. Constraints
- TypeScript in `engine/`, reusing F-007's and F-008's chain, run, report
  and secrets-scan code, and the F-011 issue store built in the same PR.
- GitHub only, through the calls F-011 SR-1 lists, with the project's
  factory token, which needs Issues read and write in the config repo (the
  owner adds it to his fine-grained token; onboarding, F-003, says so).
- Rapid prototype maturity, as the engine is.
- No owner-specific value in the master repo; the owner's GitHub id comes
  from the manifest's pinned `owner.github_id`.

## 6. Edge cases
- The owner answers an item after the feature moved on for another reason
  (for example the spec changed): the item was revised (F-011 FR-8), so an
  answer on the old revision records nothing.
- Two items of one feature answered in one poll: effects run in record
  order; the feature's stage changes once per poll.
- A Gate 1 choice decided, but the analyst records another option in the
  spec: FR-9 fails naming the finding (AC-3).
- Spec sign-off approved, then the analyst session that was still running
  commits: the branch moved, so FR-9 refuses and the gate runs again.
- The engine is stopped when the owner acts: actions are read at start; a
  confirm older than 15 minutes is refused (F-011 section 6).
- Item text from the reviewer tries to look like a command: F-011 SR-10,
  SR-17, SR-18 apply.
- An item filed before this feature as a file and never migrated: the engine
  never reads it (F-011 FR-16); the feature stays blocked until the
  migration script runs.

## 7. Dependencies
- F-011 v29 (issue store, action reader, records, workflow template,
  migration script), built in the same PR (H-0161 to H-0163).
- F-011 A-2 spike (GitHub Mobile push), before build.
- F-008 (Gate 1 flow and FR-9), F-007 (interview, chain, runs).
- F-015 (increment 4) takes features from `build_and_test_prep`, and builds
  F-011's PR parts (FR-9 evidence comment, `/changes` on PRs, FR-10 hygiene
  auto-merge), since no PR exists before it (agreed with the F-015 thread).
- F-003 amendment: install the inbox workflow, `FACTORY_OWNER_LOGIN` and the
  token's Issues permission in a project's config repo.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | The trial project's config repo gets the F-011 workflow and `FACTORY_OWNER_LOGIN` by hand for AC-11, until the F-003 amendment installs them. | — | Pending |

## 9. Security considerations
SR-1 to SR-5 drafted by the analyst; SR-6 to SR-10 from Security Gate 1 (`F-016-security-gate1.md`, 0 Critical, 0 High, 2 Medium, 3 Low).

| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | An effect runs only for an action recorded under F-011 SR-2 (owner's GitHub id, current revision) and, for risky actions, confirmed under F-011 SR-3. No other input moves a feature's stage forward. | Analyst (S2.1, S6.2) | Proposed |
| SR-2 | Owner notes (`/changes`, `/research`, Reject reasons) and reviewer text reach agents only as quoted data in a labelled block, never as instructions (S6.1, F-011 SR-4). | Analyst | Proposed |
| SR-3 | Spec sign-off binds to the spec commit: Approve counts only if the feature branch head equals the commit named in the item at that revision (FR-9). | Analyst (S2.1) | Proposed |
| SR-4 | Effects per Security item type are fixed in code; an item's text or options can't choose its effect. An unknown type gets "record only". | Analyst (S6.2) | Proposed |
| SR-5 | Effects are idempotent and keyed on the record entry, so a re-read or restart never carries out an action twice. | Analyst | Proposed |
| SR-6 | A Gate 1 choice is resolved only by an Approved section 9 row whose source cites `Gate 1 #<n>; <item id>` and whose text contains the chosen option's label word for word (normalized whitespace); otherwise the check names the finding. | Gate 1 #1 (S2.1, S6.2) | Proposed |
| SR-7 | The stage change and the `effect_done` entry are one commit on the feature's chain, after the inbox record; a failed effect leaves the stage unchanged and is retried next poll; after 3 failed tries a Notice is filed and the feature stays where it is. | Gate 1 #2 (S2.1, S5.1) | Proposed |
| SR-8 | A resume restart counts against the feature's run caps (F-007 `MAX_RESUMES`, F-008 SR-11); at a cap, option A files a Notice and restarts nothing. | Gate 1 #3 (S6.1, S6.2) | Proposed |
| SR-9 | The factory token's added permission is Issues read and write on the config repo only, to file and read inbox items (F-011 SR-1); managed code repos get no Issues permission in this increment. The engine checks it at start and reports a missing permission instead of filing. | Gate 1 #4 (S8.5, S8.2) | Proposed |
| SR-11 | The orchestrator readiness session runs under the same container, proxy and policy rules as the security reviewer (F-008 FR-2): worktree read-only, tools Read, Grep, Glob and Write, only write its named report, no network but the model API; spec and transcript reach it as data (S6.1). A pass from it never skips a failed code check. | Analyst; OQ-1 | Proposed |
| SR-10 | The analyst records each accepted risk in section 9 with status `Accepted risk`, citing `Gate 1 #<n>; <item id>`; the readiness gate fails if a recorded accepted risk has no such row. | Gate 1 #5 (S7.1, S3.2) | Proposed |

## 10. Interface requirements
Drafts, for the owner's approval:
- **H-0180 (Interfaces):** Inbox item v3.1 (minor): record history actions
  `effect_done` (engine, with the effect name and the stage it set) and
  Gate 1 state `accepted_risk`.
- **H-0181:** reserved (folded into H-0180).
- **H-0182 (Security):** the per-type effect table for engine Security
  items (FR-6), to be drafted with OQ-3's answer.
- **H-0183 (Interfaces):** Engine control channel v1.5 (minor):
  `engine.status` features gain `waiting_on: [<item id>]`.
- **H-0184 (Hygiene):** an `orchestrator` model in `engine/config/models.yaml`
  and `orchestrator` and `readiness_gate` sections in `engine/config/limits.yaml`
  (draft: model `claude-sonnet-5-5`; turns 40, output_tokens 60000, dollars 2,
  wall_time_minutes 20, cpus 1, memory_mib 1024, pids 128, tmp_mib 256;
  `readiness_gate: runs_per_feature: 5, report_kib: 64`). A project runs it
  only with an `orchestrator` role in its manifest policy: tools Read, Grep,
  Glob, Write; write `.factory/runs/**/orchestrator-*.json`; no commands, no
  network (Role policy v2.6 as is, no contract change).

## 11. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft from F-007 section 13, F-008 and F-011 v29, before the owner's answers | — |
| 2 | 2026-11-13 | Security Gate 1: SR-6 to SR-10 proposed | — |
| 3 | 2026-11-13 | OQ-1 decided (c): structural code checks, then an orchestrator session judges checks 1 to 4 only if they pass (FR-7, FR-11, AC-13, AC-14, SR-11, H-0184 drafted) | Owner, 2026-11-13 (decision card) |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Who judges readiness checks 1 to 4 (clear objective, behavior, testable ACs, constraints)? (a) Engine code: structural checks (each section present and filled, every FR covered by an AC, every AC in Given/When/Then form); the owner's spec sign-off is the human judgment of clarity. No tokens. (b) An orchestrator agent session reads the spec and judges each check; needs a model and limits (H-0184) and costs one session per gate. (c) Code first, then the agent only if code passes. Recommended: (a). | Architecture | Decided (owner, 2026-11-13, decision card): (c), code first, then the agent only if code passes |
| OQ-2 | After the owner chooses an option on a Gate 1 choice item, how does it reach the spec? (a) The feature goes back to the analyst, who records the choice as an Approved SR citing the finding and item; the engine checks the row matches the recorded choice. (b) The decided item alone resolves the finding; the spec doesn't mention it. Recommended: (a), so the spec stays the single source a developer reads. | Product | Open |
| OQ-3 | "Pinned owner keys changed" and "New project path" items (F-007 SR-5) today need `factory-engine confirm` plus a device sign-in as the previously pinned owner. Should a confirmed Approve on the inbox issue replace that? (a) Yes: the action counts only from the **previously pinned** owner id, read from the API, and is confirmed with 🚀 (ADR 0022); the CLI command stays as a second way. Risk, stated: anyone holding your GitHub session or token could confirm a change to the owner keys from any device; today the confirm also needs someone at your PC. Both prove the same GitHub account. (b) No: keep the CLI command and device sign-in only; the issue just tells you to run it, and closes when the engine sees the confirm. Recommended: (a), since both check the same account and you favor usability; your PC is trusted either way. | Security | Open |
