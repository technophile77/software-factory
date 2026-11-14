# Feature: The engine acts on the owner's inbox answers and runs the readiness gate

- **Id:** F-016
- **Status:** Approved (owner, 2026-11-13; spec v10 signed off; readiness gate passed)
- **Requested by / date:** Alex, 2026-11-13 ("what is the critical path until I
  can start onboarding some of my existing projects?"; chose to build engine
  increment 3 next, decision card)
- **Spec version:** 19

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
| FR-6 | Engine Security items (`alert`) get one of three effects, fixed per item type in code (table in section 10, H-0182): **record only** (the answer is recorded and the issue closes; the engine re-checks the condition on its own next check, as today); **resume** (option A clears the stop it reported and restarts the stopped feature from its last good commit, re-running the check that stopped it; if the check fails again, a new item is filed); **owner keys** (OQ-3: a confirmed choice of option A, from the previously pinned owner's GitHub id, re-pins the changed keys, and the project runs at the next engine start, as with `factory-engine confirm` with a device sign-in does today; the CLI path stays). Option B always leaves things stopped and closes the issue. |
| FR-7 | Readiness gate: when a feature enters `readiness_gate`, the engine runs, at the spec commit that passed: the interview checks of F-007 (checks 5 and 6, transcript intact, spec version), F-008 FR-9 (Gate 1 resolved), and the structural checks for 1 to 4: sections 1 to 5 present and not empty, every FR covered by at least one AC's Covers column, every AC in Given/When/Then form, every AC's Covers naming an existing FR. Only if every code check passes, the engine starts one orchestrator session (OQ-1) on that commit: read-only worktree, the spec and the six checks in its first turn, its only write its report `.factory/runs/<feature>/readiness_gate/orchestrator-<n>.json`; it judges checks 1 to 4 (clear, consistent, testable) and the engine validates the report as F-008 FR-5 does for the reviewer (one correction turn). The result, with each check's name, passed flag and evidence, is recorded on the feature's chain and in an Agent report with the `orchestrator` body (`gate`, `checks`). |
| FR-8 | Readiness failed: the feature returns to `requirements_interview`; the analyst's next session gets the failed checks' evidence as data and fixes the spec through the interview. Readiness passed: the engine files one Spec sign-off item (kind `spec`, sections Summary, Readiness, Open items, F-011 Inbox item v3.0) naming the feature, spec path, version and commit, and the feature waits at `readiness_gate` with `waiting_on` the item. |
| FR-9 | Spec sign-off Approve, confirmed per F-011 FR-6 at the same revision: the engine checks that the feature branch head still equals the signed-off spec commit, then records `spec_signed_off` (item id, spec version, commit) and the stage `build_and_test_prep`. If the branch moved, nothing is recorded: the item is revised to the new commit (F-011 FR-8) and the readiness gate runs again first. Request changes: the feature returns to `requirements_interview` with the note as data. Defer: it keeps waiting. |
| FR-10 | `engine.status` shows, per feature, the stage and, when it waits on the owner, the open item ids (Engine control channel minor change, H-0183). |
| FR-11 | Effects and the structural checks are code (owner rule, 2026-11-13: tools, not tokens); only the judgment of checks 1 to 4 is an agent session, and only after the code checks pass (OQ-1). No agent reads issue comments or records. The orchestrator session's model and limits come from the master's `models.yaml` and `limits.yaml` (H-0184); a project's `limits:` may only lower them; without an `orchestrator` entry, or without the role in the project's policy, no session starts and the transcript and engine log say why. |
| FR-13 | Analyst run stopped (issue #64): when an analyst run ends failed for any reason other than a rules breach or a secrets-scan refusal (those file their own items), for example a turn, token, dollar or wall-time cap, the worktree size cap, or a session error, the engine files one Security item `analyststop` for that run (section 10, H-0182) and the transcript says the run stopped and why. Option A starts one new analyst run for the feature, at its branch head, whose first turn carries the transcript summary; replies the owner recorded but no analyst received follow as turns. Option B leaves the feature stopped. At start, the engine files the item for an interview-stage feature whose latest analyst run is failed (for any of those reasons) and has no item yet, so features stopped before this change aren't left stuck. |
| FR-14 | `engine.status` reports `active_agents` as the number of agent sessions running for the feature (0 or 1 in this increment), no longer always 0. When the interview has nothing waiting and no analyst is running, the interview skill says so and names any inbox items the feature waits on, instead of saying the analyst is still working (issue #65). |
| FR-15 | Gate 1 findings not resolved after the interview, with none waiting on the owner and none refused (so no risk item is filed): the feature returns to `requirements_interview` and the analyst gets a return `gate1_unresolved` with the check's evidence as data, telling it to take up each named finding as an interview question with the suggested requirement. This happens once per Gate 1 report. If the check fails the same way again, the engine files a Security item `gate1unresolved` (section 10, H-0182) instead: option A sends the feature back to the analyst again, option B leaves it at Security Gate 1. Before this, the engine recorded "not resolved" and stopped with no analyst and no item. |
| FR-16 | The engine reads the spec's section 9 table under either title, "Security considerations" (the template's) or "Security requirements", for Gate 1 (F-008 FR-9) and the readiness gate. A feature blocked at Security Gate 1 is checked again at engine start; when Gate 1 passes, the engine withdraws (closes, with a comment saying why) that feature's open Gate 1 risk items, since the spec now takes their findings up. |
| FR-17 | The spec's exact structure is defined in `docs/features/feature-template.structure.json`: the twelve level-2 headings of the template, word for word and in order, each once, and the header row of the first table in sections 3, 4, 8, 9 and 12. Any other level-2 section goes after section 12; level-3 and lower headings may appear inside any section. The engine states this structure in the analyst's first turn, and `interview_spec_ready` adds a `spec_structure` check that fails on any difference, naming each missing, repeated, misplaced or unknown heading and each wrong header row by line number and the template's exact text (never spec text). The readiness gate and Gate 1's resolution run the same check, so FR-16's second title no longer passes; the engine's table reader still accepts it. |
| FR-18 | When Gate 1 matches the owner's answer, the finding's suggested requirement and the spec's section 9 row word for word (F-008 FR-9, FR-15), a written escape `\n`, `\t` or `\r` counts as whitespace, the same as a real line break, tab or space. Any other difference still fails. |
| FR-19 | Gate 1 decides what blocks in code, never the reviewer. Each finding's `blocks` is set by the engine from its severity and the project's `maturity`, using `plugins/software-factory/skills/onboard-repo/scripts/security-blocking.json`, the one copy of security-standards.md's "What blocks a PR, by maturity level" table (H-0235), which the onboarding checker also reads. A reviewer's own `blocks` value is ignored, and its instructions no longer ask for one. A finding that doesn't block at the project's level, including one framed as the owner's choice, is recorded as a known issue in the Gate 1 report ("open until fixed before promotion"); it is neither asked in the interview nor filed to the inbox, and Gate 1 resolution doesn't need it in the spec. When no finding blocks, the feature goes on to the readiness gate. An unknown level or severity blocks. |
| FR-20 | The severity bar (FR-19) applies whenever Gate 1 uses a finding: when it builds the analyst's findings turn, when it checks a "Gate 1 #n:" question, and when it resolves Gate 1. A report written before FR-19, or before the project's level changed, follows the bar for the project's current `maturity`. `interview_ask` and `interview_revise` refuse a question whose text starts with "Gate 1 #n" unless finding n is in the latest report, isn't the owner's inbox choice, is at or above the bar, and the question's `suggested` is the finding's requirement word for word (FR-18 matching). When no finding is left to ask, the analyst gets no findings turn. |
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
| AC-15 | Given an analyst run that stops at its wall-time cap, then one `analyststop` Security item is filed for the feature; given option A confirmed, then one new analyst run starts whose first turn has the transcript summary and which receives the owner's undelivered replies; given option B, nothing starts. Given an engine start with an interview-stage feature whose latest analyst run is failed at a cap and has no item, then the item is filed once, also across restarts. | FR-13 |
| AC-16 | Given a feature in the interview with no analyst session running and nothing waiting for the owner, then the interview skill's "nothing waiting" answer says no analyst is running and names the items in `waiting_on`; given a running analyst session, then `engine.status` shows `active_agents` 1 and the answer says the analyst is working. | FR-14 |
| AC-17 | Given a spec whose Gate 1 findings were taken up only as assumptions, when the interview checks pass, then the feature returns to the interview, the analyst's first turn names the unresolved findings as data, and no item is filed; given the same result a second time for the same report, then one `gate1unresolved` item is filed; option A sends the feature back with an analyst run, and option B leaves it at Security Gate 1. | FR-15 |
| AC-18 | Given a spec whose section 9 has an Approved row citing a Gate 1 finding and the owner's answer, then Gate 1 passes; given such a feature already blocked on a risk item for that finding, then at the next engine start it reaches `readiness_gate` and the risk item and its issue are closed with the engine's reason. | FR-16 |
| AC-19 | Given a spec whose security table sits under "## 6. Security and privacy" / "### Security requirements", then `interview_spec_ready` fails `spec_structure`, its evidence names the missing "## 9. Security considerations" heading and the unknown heading's line, and the feature stays in the interview; given the same spec with the template's headings and header rows, the check passes; extra sections after section 12 and level-3 headings inside a section pass. | FR-17 |
| AC-20 | Given a finding whose suggested requirement contains the written escape `\n`, and an owner answer with a real line break in its place, then the answer counts as the suggestion word for word and an Approved row with the written escape resolves the finding; an answer that drops the escape and its whitespace still fails. | FR-18 |
| AC-21 | Given a project at `rapid-prototype` and a Gate 1 report with Low and High findings, then none is asked or filed, both are recorded as known issues in the rendered report, and the feature reaches `readiness_gate`; given the same at `alpha`, then only the High finding goes to the interview; a reviewer report without `blocks` is valid. | FR-19 |
| AC-22 | Given a Gate 1 report written without `recorded` flags, holding a Low and a Critical finding, at `rapid-prototype`, then Gate 1 resolution and the analyst's turn need only the Critical finding; given an `interview_ask` for "Gate 1 #n:" whose `suggested` isn't finding n's requirement, or for a finding below the bar or in the inbox, then the call is refused with `invalid` and nothing is recorded. | FR-20 |
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
- F-011 A-2 spike (GitHub Mobile push): done 2026-11-13, the owner got the push for an issue opened by `github-actions[bot]` in the trial config repo.
- F-008 (Gate 1 flow and FR-9), F-007 (interview, chain, runs).
- F-015 (increment 4) takes features from `build_and_test_prep`, and builds
  F-011's PR parts (FR-9 evidence comment, `/changes` on PRs, FR-10 hygiene
  auto-merge), since no PR exists before it (agreed with the F-015 thread).
- F-003 amendment: install the inbox workflow, `FACTORY_OWNER_LOGIN` and the
  token's Issues permission in a project's config repo.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | The trial project's config repo gets the F-011 workflow and `FACTORY_OWNER_LOGIN` by hand for AC-11, until the F-003 amendment installs them. | Owner, 2026-11-13 (decision card) | Approved |

## 9. Security considerations
SR-1 to SR-5 drafted by the analyst; SR-6 to SR-10 from Security Gate 1 (`F-016-security-gate1.md`, 0 Critical, 0 High, 2 Medium, 3 Low).

| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | An effect runs only for an action recorded under F-011 SR-2 (owner's GitHub id, current revision) and, for risky actions, confirmed under F-011 SR-3. No other input moves a feature's stage forward. | Analyst (S2.1, S6.2) | Approved (owner, 2026-11-13) |
| SR-2 | Owner notes (`/changes`, `/research`, Reject reasons) and reviewer text reach agents only as quoted data in a labelled block, never as instructions (S6.1, F-011 SR-4). | Analyst | Approved (owner, 2026-11-13) |
| SR-3 | Spec sign-off binds to the spec commit: Approve counts only if the feature branch head equals the commit named in the item at that revision (FR-9). | Analyst (S2.1) | Approved (owner, 2026-11-13) |
| SR-4 | Effects per Security item type are fixed in code; an item's text or options can't choose its effect. An unknown type gets "record only". | Analyst (S6.2) | Approved (owner, 2026-11-13) |
| SR-5 | Effects are idempotent and keyed on the record entry, so a re-read or restart never carries out an action twice. | Analyst | Approved (owner, 2026-11-13) |
| SR-6 | A Gate 1 choice is resolved only by an Approved section 9 row whose source cites `Gate 1 #<n>; <item id>` and whose text contains the chosen option's label word for word (normalized whitespace); otherwise the check names the finding. | Gate 1 #1 (S2.1, S6.2) | Approved (owner, 2026-11-13) |
| SR-7 | The stage change and the `effect_done` entry are one commit on the feature's chain, after the inbox record; a failed effect leaves the stage unchanged and is retried next poll; after 3 failed tries a Notice is filed and the feature stays where it is. | Gate 1 #2 (S2.1, S5.1) | Approved (owner, 2026-11-13) |
| SR-8 | A resume restart counts against the feature's run caps (F-007 `MAX_RESUMES`, F-008 SR-11); at a cap, option A files a Notice and restarts nothing. | Gate 1 #3 (S6.1, S6.2) | Approved (owner, 2026-11-13) |
| SR-9 | The factory token's added permission is Issues read and write on the config repo only, to file and read inbox items (F-011 SR-1); managed code repos get no Issues permission in this increment. The engine checks it at start and reports a missing permission instead of filing. | Gate 1 #4 (S8.5, S8.2) | Approved (owner, 2026-11-13) |
| SR-11 | The orchestrator readiness session runs under the same session rules as the security reviewer: its own engine worktree, tools Read, Grep, Glob and Write only (no Bash, no web tools), it may write only its named report (file-tool rules plus the end-of-session write check), and no other files are committed. Spec and transcript reach it as data (S6.1). A pass from it never skips a failed code check. Until Beta (per the containers ADR, ADR 0026) it runs on the owner's PC with no container, so network and CPU/memory limits aren't enforced. This is an accepted risk. | Analyst; OQ-1; ADR 0026 | Approved (owner, 2026-11-14, v11) |
| SR-13 | An `analyststop` item starts at most one analyst run per confirmed option A, and each new run has the full per-run limits; the item is the owner's approval for that run, so it doesn't count against `MAX_RESUMES`. Stops for a rules breach or a secret keep their own items and SR-8. | Owner, 2026-11-14 (issue #64) | Approved (owner, 2026-11-14, in thread) |
| SR-10 | The analyst records each accepted risk in section 9 with status `Accepted risk`, citing `Gate 1 #<n>; <item id>`; the readiness gate fails if a recorded accepted risk has no such row. | Gate 1 #5 (S7.1, S3.2) | Approved (owner, 2026-11-13) |
| SR-12 | An owner answer the engine didn't read from GitHub itself in the same run (for example one found in a record at start) has an effect only after the engine checks it on the item's issue: the pinned owner's 👍 on the bound action comment or the owner's command comment, and for a risky action its confirmation. One that fails gets effect `unverified` and a Security item. The engine refuses to adopt remote changes to `inbox/` on `factory/state`, as it does for `interviews/`. | Gate 2 M1 (S2.1, S7.1) | Approved (owner, 2026-11-14, Gate 2 decision) |

## 10. Interface requirements
H-0180, H-0182, H-0183 approved (owner, 2026-11-13, decision card); H-0184 approved separately. All are applied in the build PR, each as its own commit with its id.
- **H-0180 (Interfaces):** Inbox item v3.1 (minor): record history actions
  `effect_done` (engine, with the effect name and the stage it set) and
  Gate 1 state `accepted_risk`.
- **H-0181:** reserved (folded into H-0180).
- **H-0182 (Security):** the per-type effect table for engine Security
  items (FR-6). Option B always records only.

  | Item type (engine `alert` key) | Option A effect |
  |---|---|
  | `pins` (owner keys changed, new project path; F-007 SR-5) | owner keys: re-pin; the project runs at the next engine start (OQ-3), only from the previously pinned owner id |
  | `chain` (transcript changed outside the engine) | resume: re-read the transcript; if the chain is intact again, reopen the feature, else file anew |
  | `breach` (analyst or reviewer wrote outside its rules) | resume, within the run caps (SR-8) |
  | `gate1cap` (Gate 1 run limit) | resume: the feature's Gate 1 run cap rises by one for this approval only (the owner's explicit override of F-008 SR-11); the next limit files a new item |
  | `gate1unresolved` (Gate 1 findings still not taken up after one send-back; FR-15) | resume: the feature returns to the interview and an analyst run starts |
  | `analyststop` (an analyst run stopped at a cap or on an error; FR-13) | resume: one new analyst run with the transcript summary (SR-13) |
  | `sources`, `manifest`, `auth`, `fetch`, `dup`, `additions`, `secret` | record only (the owner fixes the cause; the engine re-checks at its next check) |
  | Gate 1 choice and risk items | FR-3 to FR-5 |
  | Spec sign-off | FR-9 |
  | anything else | record only (SR-4) |
- **H-0183 (Interfaces):** Engine control channel v1.5 (minor):
  `engine.status` features gain `waiting_on: [<item id>]`.
- **H-0184 (Hygiene), approved (owner, 2026-11-13, decision card: Sonnet 5.5, limits as drafted):** an `orchestrator` model in `engine/config/models.yaml`
  and `orchestrator` and `readiness_gate` sections in `engine/config/limits.yaml`
  (draft: model `claude-sonnet-5-5`; turns 40, output_tokens 60000, dollars 2,
  wall_time_minutes 20, cpus 1, memory_mib 1024, pids 128, tmp_mib 256;
  `readiness_gate: runs_per_feature: 5, report_kib: 64`). A project runs it
  only with an `orchestrator` role in its manifest policy: tools Read, Grep,
  Glob, Write; write `.factory/runs/**/orchestrator-*.json`; no commands, no
  network (Role policy v2.6 as is, no contract change). Until Beta (ADR 0026)
  the container limits (cpus, memory_mib, pids, tmp_mib) stay in
  `limits.yaml` but go unused; the turn, token, dollar and wall-time limits
  still apply (owner, 2026-11-14).
- **H-0185 (Hygiene), approved (owner, 2026-11-14 02:26Z, decision card):** the
  onboarding checker (`plugins/software-factory/skills/onboard-repo/scripts/factory_check.py`,
  `LIMIT_KEYS`) accepts the `orchestrator` and `readiness_gate` limit sections
  H-0184 adds, so a project's manifest may lower them. Applied in `6627209`.
- **H-0186 (Hygiene), approved (owner, 2026-11-14, in thread):** the
  onboarding checker's secret-scan property test
  (`plugins/software-factory/skills/onboard-repo/tests/test_factory_check.py`)
  starts each generated line with a fixed word. A random word starting with
  `MZ` made gitleaks skip the file as binary, so the test failed about once in
  50 runs (PR #60 CI, seed 266426694). It also draws the fake key's 16
  characters without repeats, since a key under gitleaks' entropy floor of 3
  isn't a finding (seed 897027674). Test only.
- **H-0187 (Hygiene), approved (owner, 2026-11-14, in thread):** the
  interview's GitHub approval text writes the device login link as a Markdown
  link, so every chat surface shows it clickable (issue #63;
  `engine/src/mcp/operations.ts`). The skill still shows `approval_display`
  unchanged.
- **H-0188 (Hygiene), approved (owner, 2026-11-14, card and in thread):**
  the interview skill's picker question quotes the item word for word, so
  the owner sees what they approve even when the skill's message before the
  picker is missing (issue #66;
  `plugins/software-factory/skills/spec-interview/SKILL.md`). Skill only.

- **H-0189 (Hygiene), approved (owner, 2026-11-14, card and in thread):**
  the spec's structure is defined in JSON beside the template
  (`docs/features/feature-template.structure.json`, FR-17), and the
  requirements analyst's AGENT.md says the engine states it and refuses a
  spec that differs (issue #67).

- **H-0235 (Hygiene), approved (owner, 2026-11-14, card and in thread):**
  the blocking table becomes data in
  `plugins/software-factory/skills/onboard-repo/scripts/security-blocking.json`, read by the engine's
  Gate 1 and by `factory_check.py`; `docs/security-standards.md` points to it;
  the security reviewer's AGENT.md no longer asks it to say whether a finding
  blocks; the Agent report contract notes the engine sets `blocks`.

- **H-0236 (Hygiene), approved (owner, 2026-11-14, card and in thread):**
  `security-blocking.json` moves from the plugin root into the onboard-repo
  skill's `scripts/` folder, next to `gitleaks-pins.json`, so a skill copied
  into a repo's `.claude/skills/` still finds it. It stays the one copy.

## 11. Readiness gate
Checked 2026-11-13 against spec v10.

- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable (AC-1 to AC-14; AC-11 is the end-to-end trial)
- [x] Constraints documented
- [x] Assumptions explicit (A-1 approved)
- [x] Blocking decisions resolved (OQ-1 to OQ-3 decided; SR-1 to SR-11 approved; H-0180, H-0182 to H-0184 approved)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft from F-007 section 13, F-008 and F-011 v29, before the owner's answers | — |
| 2 | 2026-11-13 | Security Gate 1: SR-6 to SR-10 proposed | — |
| 3 | 2026-11-13 | OQ-1 decided (c): structural code checks, then an orchestrator session judges checks 1 to 4 only if they pass (FR-7, FR-11, AC-13, AC-14, SR-11, H-0184 drafted) | Owner, 2026-11-13 (decision card) |
| 4 | 2026-11-13 | OQ-2 decided (a): the analyst writes the owner's Gate 1 choice into section 9; F-011 A-2 confirmed by the Mobile push spike (owner got the push) | Owner, 2026-11-13 (decision cards) |
| 5 | 2026-11-13 | OQ-3 decided (a): a confirmed inbox choice from the previously pinned owner id re-pins owner keys, CLI path kept (replaces F-007 SR-5's confirm-only path); H-0182 effect table drafted | Owner, 2026-11-13 (decision card) |
| 6 | 2026-11-13 | H-0184 approved: orchestrator on `claude-sonnet-5-5`, limits as drafted | Owner, 2026-11-13 (decision card) |
| 7 | 2026-11-13 | SR-6 to SR-10 approved | Owner, 2026-11-13 (project chat) |
| 8 | 2026-11-13 | H-0180, H-0182, H-0183 approved | Owner, 2026-11-13 (decision card) |
| 9 | 2026-11-13 | SR-1 to SR-5 and SR-11 approved | Owner, 2026-11-13 (decision card) |
| 10 | 2026-11-13 | A-1 approved; readiness gate passed | Owner, 2026-11-13 (decision card); orchestrator (gate) |
| 10 | 2026-11-13 | Spec v10 signed off; status Approved | Owner, 2026-11-13 (decision card) |
| 11 | 2026-11-14 | SR-11 reworded and H-0184 container limits unused until Beta, after the owner dropped agent containers until Beta (ADR 0026) | Owner, 2026-11-14 (in chat, after a decision card) |
| 12 | 2026-11-14 | H-0185 approved and applied (onboarding checker limit keys). SR-12 added for Gate 2 M1, after the owner chose both fixes | Owner, 2026-11-14 (decision cards) |
| 13 | 2026-11-14 | FR-13, FR-14, AC-15, AC-16, SR-13 and the `analyststop` row in H-0182 added after the live trial found a feature stuck after an analyst cap stop (issues #64, #65). Pins effect reworded: re-pins; the project runs at the next engine start. H-0186, H-0187 and H-0188 approved | Owner, 2026-11-14 (in thread) |
| 14 | 2026-11-14 | FR-15, AC-17 and the `gate1unresolved` row in H-0182 added after the live trial stopped at Security Gate 1 with findings taken up only as assumptions | Owner, 2026-11-14 (decision card and in thread) |
| 15 | 2026-11-14 | FR-16 and AC-18 added after the live trial filed risk items for findings the spec took up under the title "Security requirements" | Owner, 2026-11-14 (decision card and in thread) |
| 16 | 2026-11-14 | FR-17, AC-19 and H-0189 added after the live trial's analyst put the security table under its own headings: the spec's structure is defined in JSON and checked exactly (option A), so FR-16's second title no longer passes and AC-18 drops it | Owner, 2026-11-14 (decision card and in thread) |
| 17 | 2026-11-14 | FR-18 and AC-20 added after the live trial's interview skill turned a written `\n` in a Gate 1 suggestion into a real line break, so the owner's word-for-word answer didn't match (option A) | Owner, 2026-11-14 (decision card and in thread) |
| 18 | 2026-11-14 | FR-19, AC-21 and H-0235 added after the live trial's Gate 1 asked the owner about Low findings that the approved standards never block: code applies the approved severity bar per maturity level from one JSON file (option A) | Owner, 2026-11-14 (decision cards and in thread) |
| 19 | 2026-11-14 | FR-20 and AC-22 added after the live trial re-asked Gate 1 findings: the analyst filed Gate 1 questions with placeholder suggestions, and Low findings in a report written before FR-19 still blocked. The bar now applies at use time and Gate 1 questions are checked when asked | Owner, 2026-11-14 (decision card and in thread) |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Who judges readiness checks 1 to 4 (clear objective, behavior, testable ACs, constraints)? (a) Engine code: structural checks (each section present and filled, every FR covered by an AC, every AC in Given/When/Then form); the owner's spec sign-off is the human judgment of clarity. No tokens. (b) An orchestrator agent session reads the spec and judges each check; needs a model and limits (H-0184) and costs one session per gate. (c) Code first, then the agent only if code passes. Recommended: (a). | Architecture | Decided (owner, 2026-11-13, decision card): (c), code first, then the agent only if code passes |
| OQ-2 | After the owner chooses an option on a Gate 1 choice item, how does it reach the spec? (a) The feature goes back to the analyst, who records the choice as an Approved SR citing the finding and item; the engine checks the row matches the recorded choice. (b) The decided item alone resolves the finding; the spec doesn't mention it. Recommended: (a), so the spec stays the single source a developer reads. | Product | Decided (owner, 2026-11-13, decision card): (a) |
| OQ-3 | "Pinned owner keys changed" and "New project path" items (F-007 SR-5) today need `factory-engine confirm` plus a device sign-in as the previously pinned owner. Should a confirmed Approve on the inbox issue replace that? (a) Yes: the action counts only from the **previously pinned** owner id, read from the API, and is confirmed with 🚀 (ADR 0022); the CLI command stays as a second way. Risk, stated: anyone holding your GitHub session or token could confirm a change to the owner keys from any device; today the confirm also needs someone at your PC. Both prove the same GitHub account. (b) No: keep the CLI command and device sign-in only; the issue just tells you to run it, and closes when the engine sees the confirm. Recommended: (a), since both check the same account and you favor usability; your PC is trusted either way. | Security | Decided (owner, 2026-11-13, decision card): (a), with the stated risk accepted |
