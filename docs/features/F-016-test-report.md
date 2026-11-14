# F-016 Test report

- **Feature:** F-016 The engine acts on the owner's inbox answers and runs the readiness gate, spec v11 (plus SR-12, Code Review M1)
- **Date:** 2026-11-14
- **Final commit tested:** engine code at `ee52303`; the commit that adds this report adds tests only
- **Environment:** Linux 6.18, Node 22.23.4, git 2.43.0. Fake GitHub issues (`test/inbox-fake.ts`), fake Docker, scripted agent sessions, fake clock. No Windows or macOS run here.
- **Written by:** the test engineer, from the spec, `docs/interface-contracts.md` (Inbox item v3.1, Engine control channel v1.5) and the F-011 parts the spec cites. The developer's report and the Code Review report were not read.

## Tool choice

| Test type | Best fit and why | Tool used | Owner decision |
|---|---|---|---|
| Unit | Vitest, the engine's runner; tests call `structuralChecks`, `validateReadinessReport` and `stReviewResolution` directly | `vitest` 5.1.0 | OQ-9 (F-007) |
| Acceptance | Vitest with the F-008/F-016 engine harness (`test/agents-harness.ts`): the engine runs in-process, driven over its channel and the fake issues API | `vitest` 5.1.0 | OQ-9 (F-007) |
| Contract | Vitest: issue body, labels, action comment markers and record fields checked against Inbox item v3.1; `engine.status` against channel v1.5 | `vitest` 5.1.0 | OQ-9 (F-007) |
| Stochastic | Not required at Rapid prototype | None | None |

## Runs

| Run | Commit | Result |
|---|---|---|
| New file `test/f016-acceptance.test.ts` alone | `ee52303` + tests | 30 tests: 27 passed, 3 failed (product), 72 s |
| Existing `test/f016-run.test.ts` alone | `ee52303` | 16 passed, 0 failed, 93 s |
| Full engine suite (`npx vitest run --maxWorkers=3`) | `ee52303` + tests | 67 files, 1,596 tests: 1,573 passed, 3 failed, 20 skipped (576 s). The 3 failures are the product failures below. The 20 skips are existing platform and real-service tests (real Docker, real Claude binary, LiteLLM conformance, Windows-only checks) that skip themselves on this machine; none is an F-016 test |

## Failures (product)

Each failing test is kept as it is. None was weakened or skipped.

### 1. Security and Testability Review choice item: the issue body doesn't list the options

- **Test:** `f016-acceptance.test.ts:213`, "Inbox item v3.1 (decision body): the Options section lists the reviewer's options, numbered".
- **Spec:** Inbox item v3.1, decision body: "Context, Options (numbered, with pros and cons), …". AC-1: the issue carries "the reviewer's options and recommendation".
- **Expected:** the `## Options` section names option A "Export in the browser" and option B "Export on the server".
- **Actual:** the section says only "Each option is an action comment below." The option labels are on the action comments, so the owner can still choose. Only the body is short of the contract. Minor.

### 2. Spec sign-off: a moved branch files a second item instead of revising the first

- **Test:** `f016-acceptance.test.ts:551`, "FR-9: when the branch moved, the same sign-off item is revised to the new commit (F-011 FR-8), not replaced by a second item".
- **Spec:** FR-9: "If the branch moved, nothing is recorded: the item is revised to the new commit (F-011 FR-8) and the readiness gate runs again first."
- **Expected:** one Spec sign-off item, `S-0001`, revised to the new branch head; its issue stays open.
- **Actual:** `S-0001`'s record shows status `approved`, its issue is closed, and its history is `filed, confirm_requested, approved, closed, effect_done: signoff_stale`. The gate runs again and files a new item `S-0002` (issue 2) at the new commit. The stage and the sign-off are right (AC-9 passes): nothing reaches `build_and_test_prep`. But the old item reads as "approved" and closed, and the owner gets a new issue instead of a revision.

### 3. A readiness report invalid twice: the engine log says nothing

- **Test:** `f016-acceptance.test.ts:618`, "AC-14: a report invalid twice leaves the branch as it was and the engine log says why".
- **Spec:** AC-14: "the gate fails closed, nothing is committed from it, and the transcript and engine log say why".
- **Expected:** an engine log line naming the feature and that its readiness report was refused.
- **Actual:** the transcript says why ("The readiness session failed: its report was still invalid after one correction."), the branch is unchanged and no item is filed. The engine log has no line about it at any level; its last line is "F-001: Security and Testability Review run … filed 0 finding(s); the feature is at readiness_gate."

## After the report (developer, 2026-11-14)

The developer fixed all three product failures. The test engineer's tests are unchanged, and all 30 now pass.

| # | Fix |
|---|---|
| 1 | A decision item's body lists its options, numbered, before the action comments. A Security and Testability Review choice item's labels come from the reviewer, so they are fenced as the reviewer's text (F-011 SR-10). |
| 2 | FR-9: when the branch moved, the engine reopens the same sign-off item, on GitHub too, and the next readiness pass revises it to the new commit (F-011 FR-8) instead of filing a second one. |
| 3 | AC-14: a refused readiness report writes a warning to the engine log naming the feature and the reason. |

Test code note: the developer's `f016-run.test.ts` AC-14 fake now keeps the commit across the correction, and the test checks the reason. The `chain` and `streviewcap` effects now have tests in `f016-run.test.ts` ("F-016 H-0182: chain and Security and Testability Review run limit items").

## AC-11 live trial (2026-11-14)

Run on the owner's PC (Windows) with the engine at `51b6e7f` (the tree of `main` at `cf6e75c`), project `factory-e2e-trial` at `maturity: rapid-prototype`, the inbox on that repo's issues.

| Time (UTC) | Event |
|---|---|
| 10:11 | The owner answered Q-012 (Security and Testability Review #1) in the terminal interview (F-018) with the suggested requirement; spec v10 passed the interview checks |
| 10:12 | Security and Testability Review resolved: every blocking finding taken up by an Approved requirement; the Low findings were skipped under FR-20 |
| 10:12 | Readiness gate code checks failed (AC-8 named no requirement in Covers); back to the interview as Q-013; the owner's answer added FR-4; spec v11 passed |
| 10:14 | The changed spec went back to Security and Testability Review, which had used its 3 runs; the engine filed D-0004 (issue #7, `streviewcap`) |
| 10:22 | The owner chose A on D-0004; one extra Security and Testability Review run: 5 Low findings, all recorded as known issues, none asked |
| 10:24 | Readiness gate passed (code checks and the orchestrator session); S-0001 filed as issue #8 |
| 10:33 | The owner's confirmed Approve on S-0001; F-002 at `build_and_test_prep` |

Earlier rounds of the same trial found the faults fixed in spec v13 to v19 and the bug fixes listed in the dev report. The `streviewcap` effect, which had only a unit-level test, also ran live here.

## Test code note

`f016-run.test.ts` "AC-14: a report invalid twice fails closed" passes, but not for the reason it states. Its fake orchestrator reads `at commit <sha>` from every session's first turn. The engine's one correction comes as a resumed session whose first turn has no commit, so the fake throws and the session fails. The transcript then reads "the session failed (Cannot read properties of null (reading '1'))", not "still invalid after one correction". The test checks only that the run failed, so it passes. The new test (`f016-acceptance.test.ts:599`) uses a fake that survives the correction and checks the reason. I did not edit the developer's test; the orchestrator decides.

## Acceptance criteria

`run` is `test/f016-run.test.ts`; `acc` is `test/f016-acceptance.test.ts`.

| AC | Tests | Judgment |
|---|---|---|
| AC-1 | run "AC-1, AC-12, AC-2: …"; acc "AC-1 (FR-1, Inbox item v3.1): …" (body markers, sections, labels, action comments, record fields, no old-layout file); acc "Inbox item v3.1 (decision body) …" | Covered. The body Options check **fails** (failure 1) |
| AC-2 | run "AC-1, AC-12, AC-2: …" (option B as data, Approved SR citing `Security and Testability Review #1; D-0001`, reaches `readiness_gate`) | Covered |
| AC-3 | run "AC-3: an SR citing the item with another option's label …"; acc "FR-4, SR-2, AC-3: /research …" (no recorded choice, end to end); acc unit "AC-3: an Approved row citing the item while the item's record shows no choice …" | Covered |
| AC-4 | run "AC-4: a declined requirement files a risk item; Accept the risk …", "AC-4: Send it back …" | Covered |
| AC-5 | run "AC-5: Defer keeps the feature blocked …" (choice item); acc "AC-5: Defer on a Security and Testability Review risk item …" | Covered |
| AC-6 | run "AC-6: option A on a write-outside-the-rules item …"; acc "AC-6: … restarts the analyst from the last good commit …" (outside write gone, branch head unchanged, no new item) | Covered |
| AC-7 | run "AC-7: an action recorded before a crash has its effect once after the restart" | Covered |
| AC-8 | run "AC-13, AC-8, AC-9: …", "AC-8, AC-13: an orchestrator check that fails …", "AC-13: an FR no criterion covers …"; acc "AC-8, FR-8 (Inbox item v3.1): the sign-off item names …" | Covered |
| AC-9 | run "AC-13, AC-8, AC-9: …" (confirmed Approve; Approve without confirm); acc "AC-9, SR-3: a confirmed Approve after the branch moved …"; acc "AC-9, FR-9: Defer on the sign-off item …" | Covered. FR-9's revision rule **fails** (failure 2) |
| AC-10 | run "AC-10: /changes on the sign-off item sends the note to the analyst as data" | Covered |
| AC-11 | Live trial on the owner's PC (see "AC-11 live trial" below) | **Met**: F-002 reached `build_and_test_prep` after a confirmed Approve on S-0001 |
| AC-12 | run "AC-1, AC-12, AC-2: …" (`waiting_on: ["D-0001"]`, then left out), "AC-13, AC-8, AC-9: …" (`waiting_on: ["S-0001"]`) | Covered |
| AC-13 | run "AC-13, AC-8, AC-9: …", "AC-13: an FR no criterion covers …", "AC-8, AC-13: an orchestrator check that fails …"; acc unit "F-016 FR-7: structural readiness checks" (4 tests) | Covered |
| AC-14 | run "AC-14: a report invalid twice …" (see test code note); acc "AC-14: a session that writes outside its report fails closed …"; acc "AC-14: a report invalid twice leaves the branch as it was and the engine log says why"; acc unit "the orchestrator's report is validated" (3 tests) | Covered. The engine log part **fails** (failure 3) |

Other requirements with tests of their own:

| Req | Tests |
|---|---|
| FR-4 | acc "FR-4, SR-2, AC-3: /research …", acc "FR-4, SR-7: Reject returns the feature …" |
| FR-11 | acc "FR-11: a factory version with no orchestrator model …"; `limits.test.ts` "F-016 H-0184: readiness limits …" (a project may only lower them) |
| FR-12 | `migrate-inbox.test.ts` AC-13 (a migrated Security and Testability Review item keeps its effect), "an item not filed by the engine gets no effect, whatever its title says" |
| Section 6, two answers in one poll | acc "section 6: two items answered in one poll take effect in record order, and the feature changes stage once" |
| Section 6, confirm older than 15 minutes | acc "SR-1: …" (last step); `inbox.test.ts` "AC-5: 🚀 confirms; after 15 minutes nothing is recorded" |

## Security requirements

| SR | Tests | Judgment |
|---|---|---|
| SR-1 | acc "SR-1: a 👍 from another account, the owner's 👍 with no confirm, and a confirm after 15 minutes carry out nothing"; run "AC-13, AC-8, AC-9" (Approve without confirm); `inbox.test.ts` AC-4, AC-5 | Covered |
| SR-2 | run "AC-1, AC-12, AC-2" (choice as data), "AC-10" (`/changes` note); acc "FR-4, SR-2, AC-3: /research …" (note with an injected instruction stays inside the data block) | Covered |
| SR-3 | acc "AC-9, SR-3: a confirmed Approve after the branch moved …" | Covered |
| SR-4 | acc "SR-12, SR-4: …" (option A on an item type outside H-0182's table only records); run "AC-6" (option B records only); `migrate-inbox.test.ts` "an item not filed by the engine gets no effect" | Covered |
| SR-5 | run "AC-7" (effect once after a restart, not again on a third start) | Covered |
| SR-6 | run "AC-3"; acc unit "SR-6: the chosen option's label word for word, with whitespace normalized …", "SR-6: another label, other words, another item, no finding ref, or a status other than Approved fails …"; `stReview.test.ts` "citesItem (F-016 SR-6, Code Review L6)" | Covered |
| SR-7 | acc "FR-4, SR-7: Reject …" (stage change and `effect_done` in one commit, after the record commit); acc "SR-7: a failed effect changes nothing and is tried again at the next poll"; acc "SR-7: after 3 failed tries a Notice is filed …" | Covered |
| SR-8 | run "F-016 SR-8: after MAX_RESUMES restarts, option A files a Notice and restarts nothing" | Covered |
| SR-9 | run "F-016 SR-9: a token GitHub refuses issues to turns the inbox off …" | Covered for a missing permission. Untestable here: that the token holds Issues on the config repo only and no Issues on managed code repos. That is the owner's token setup (F-003), not engine behavior |
| SR-10 | run "AC-4: … Accept the risk … a spec row citing it reaches readiness_gate"; acc unit "SR-10: an accepted risk resolves only with an Accepted risk row citing the finding and the item" | Covered |
| SR-11 | run "AC-13, AC-8, AC-9" (tools Read, Grep, Glob, Write; model; read-only worktree); run "AC-13: an FR no criterion covers …" (a failed code check starts no session); acc "AC-14: a session that writes outside its report …"; acc "SR-11: an orchestrator role that also allows Bash starts no session" | Covered. Untestable here: "no network, CPU or memory limits until Beta" is an accepted risk, not a behavior to test |
| SR-12 | run "Code Review M1: a recorded answer GitHub doesn't show is not carried out after a restart"; acc "SR-12, SR-4: a recorded risky choice whose confirmation isn't on GitHub is not carried out …"; `remote.test.ts` "sync(): refuses a remote change to inbox records and files a Security item (F-016 Code Review M1)" | Covered |

## What didn't run, and why

- **FR-11, "without the orchestrator role in the project's policy"**: not reachable as a black-box test. `orchestrator` is a core role in Role policy v2.6, and every session (the analyst's too) refuses a policy without it, so no feature can reach `readiness_gate` in such a project. The "no orchestrator model" case is tested instead.
- **H-0182 `chain`, `streviewcap` and `pins` re-pin effects**: `pins` is covered by `f016-run.test.ts` "F-016 OQ-3 …" and by the two SR-7 tests above. `chain` (transcript changed outside the engine, option A) and `streviewcap` (Security and Testability Review run limit, option A) have no test. Each needs a long setup (a forged transcript, or several Security and Testability Review runs to reach the cap) that this round didn't build. Open gap.
- **Windows and macOS**: not run here; CI runs them.

## Notes for the orchestrator

- FR-7 asks that every AC be "in Given/When/Then form". The engine requires "Given" and "Then" but not "When". F-016's own approved ACs (AC-1, AC-3 to AC-9, AC-12 to AC-14) have no "When", so I read the owner's intent as Given and Then. The tests don't require "When". If the spec means all three, that's a spec change.
- In the test world, the default core `orchestrator` role has only `Read` and no write rule, and the engine still starts the session and lets it write its report. H-0184 says a project runs it "only with an `orchestrator` role in its manifest policy: tools Read, Grep, Glob, Write; write `.factory/runs/**/orchestrator-*.json`". A role without `Write` can't write the report, so the gate fails closed. No test was written for this; it is a question for the analyst, not a failure.
