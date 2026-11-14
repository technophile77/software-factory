# F-016 Validation report

## Round 1

- **Feature:** F-016 The engine acts on the owner's inbox answers and runs the readiness gate, spec v11 plus SR-12 (Gate 2 M1, owner decision 2026-11-14). The F-011 engine side built in the same branch is judged only where F-016 depends on it.
- **Judge:** validation-judge
- **Date:** 2026-11-14
- **Round:** 1
- **Commit:** `6246b09` (`claude/project-thread-mszazz`, PR #60). The diff is `git diff origin/main...HEAD -- engine/ docs/interface-contracts.md plugins/` against the merge base `781ba92` (`main` with ADR 0026 merged): 41 files, +4,770 / -352. The last product change is `5740e0c` (fixes for the test engineer's three failures, and tests for the `chain` and `gate1cap` effects).
- **Contracts:** Inbox item v3.1 (H-0180, `d15e0ed`), Engine control channel v1.5 (H-0183, `79478bb`). Role policy v2.7 came from `main` (ADR 0026), not from this branch.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged. A Not met line or a Blocking finding still fails.
- **Verdict:** **FAIL**
  - **Not met: 1 line** (AC-11, the live trial: it has not run). **Needs owner: 1 line** (FR-6, the `pins` effect: the spec says it "starts the project"; the code pins and asks the owner to restart the engine).
  - Blocking: 0. Major: 2 (M1, M2). Minor: 9 (m1 to m9).
  - The engine code is in good shape. Every test passes in my runs on this commit (typecheck, the eight F-016 files, and the full suite), and CI on `6246b09` is green in every job. The three product failures the test engineer found are fixed and their tests pass unchanged. What stops a PASS is evidence and one spec reading, not a defect found in the code: AC-11 needs the owner's live run, and the `pins` start needs the owner's call.

### My own run

On `6246b09`, Linux container, Node 22, git 2.43.0.

| Step | Result |
|---|---|
| `npm run -s typecheck` | Clean, exit 0 |
| `npx vitest run --maxWorkers=2 test/f016-run.test.ts test/f016-acceptance.test.ts test/inbox.test.ts test/migrate-inbox.test.ts test/inbox-calls.test.ts test/remote.test.ts test/gate1.test.ts test/limits.test.ts` | **8 files passed. 136 tests: 136 passed, 0 failed** (111 s). This includes the test engineer's three tests that failed on `ee52303` (`f016-acceptance.test.ts:209`, `:543`, `:599`) and the new `chain` and `gate1cap` tests (`f016-run.test.ts:368`, `:411`) |
| `npx vitest run --maxWorkers=3` (full engine suite) | **64 files passed, 3 skipped. 1,598 tests: 1,578 passed, 20 skipped, 0 failed** (583 s). The 20 skips are the existing platform and real-service tests the test report lists. The "Channel error: The secrets scan failed" lines in the output come from the deliberate secrets-scan failure tests |

### CI

| Run | Head | Result |
|---|---|---|
| `engine` 43554150392 | `6246b09` | **Success, every job**: checks, supply-chain, Linux full 1/2 and 2/2, Windows platform 1/2 and 2/2, macOS platform 1/1. The Windows and macOS jobs run the platform subset, not the whole suite |
| `codeql` 43554150379, `plugin-tests` 43554150372, `docs-checks` 43554150370 | `6246b09` | Success: CodeQL (javascript-typescript, python, actions), `onboard-repo` (green now that `6627209` is in), `spec-interview`, `docs-checks` |
| `engine` 43552395580 | `90e7b4b` | **Failed**: Linux 1/2 failed `f016-acceptance.test.ts:618` (no engine log line, AC-14) and Linux 2/2 failed `:213` (Options not in the body) and `:551` (a second sign-off item). These are the test engineer's three product failures, fixed in `5740e0c` |
| `engine` 43550948041 | `f228e83` | Failed, for the same three tests |
| `codeql`, `docs-checks`, `plugin-tests` | `90e7b4b` | Success |

A Windows `EBUSY` in an acceptance test's temp-folder cleanup was seen once on `6627209`, a commit that changes only a Python file. It is not an F-016 symptom; it is logged as m8 for classification if it comes back.

### Evidence checklist

`run` is `engine/test/f016-run.test.ts`; `acc` is `engine/test/f016-acceptance.test.ts`. Line numbers are at `6246b09`. Every test named here passed in my run.

#### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-1 | Met | `state/inbox.ts:25` (`fileSecurityItem`), `:57` (`fileDecisionItem`) file through `inbox/store.ts:152` (`Inbox.file`); no code writes `.factory/inbox/` (searched `engine/src`). Options numbered in the body (`inbox/render.ts`). Tests: acc "AC-1 (FR-1, Inbox item v3.1) …" (`:185`), acc "Inbox item v3.1 (decision body) …" (`:209`), run "AC-1, AC-12, AC-2 …" (`:122`) |
| FR-2 | Met | `engine.ts:1891` (`applyAnswers`, every poll and at start), `:1934` (`pollInbox`), `inbox/store.ts:238` (`pendingEffects`), `:220` (`effectChange`). Tests: run "AC-7 …" (`:203`), acc "section 6: two items answered in one poll …" (`:332`) |
| FR-3 | Met | `engine.ts:1543-1582` (`gate1_decided` and `returned` entries, back to the interview once nothing else waits, `gate1Waiting` `:1508`); `gate1/flow.ts:109` (`analystReturnTurn`), `:172-190` (`gate1Resolution` checks the decided item and label). Tests: run "AC-1, AC-12, AC-2 …", run "AC-3 …" (`:163`), acc unit SR-6 tests (`:743`, `:748`, `:763`) |
| FR-4 | Met | `engine.ts:1564-1570` (re-ask with the note), `:1540` (Defer keeps waiting). Tests: acc "FR-4, SR-2, AC-3: /research …" (`:241`), acc "FR-4, SR-7: Reject …" (`:265`), run "AC-5 …" (`:185`) |
| FR-5 | Met | `engine.ts:1558-1563` (`gate1_risk_accepted`), `interview/model.ts` (`accepted` map), `gate1/flow.ts:172-178`. Tests: run "AC-4: … Accept the risk …" (`:267`), run "AC-4: Send it back …" (`:301`), acc "AC-5: Defer on a Gate 1 risk item …" (`:295`) |
| FR-6 | **Needs owner** (the `pins` start); the rest Met | `breach`: `engine.ts:1640-1653`, within `MAX_RESUMES` (run "AC-6" `:334`, acc "AC-6" `:368`, run "F-016 SR-8" `:461`). `chain`: `:1626-1639` (run "chain, option A …" `:368`). `gate1cap`: `:1655-1658`, `:1158` (run "gate1cap, option A …" `:411`). Record only for option B and other types: `:1610`, `:1660` (acc "SR-12, SR-4 …" `:404`). **`pins`:** `:1611-1625` pins the manifest commit the item named, from the previously pinned owner id only (run "F-016 OQ-3 …" `:501`), then notifies "Restart the engine to run the project." FR-6 and the H-0182 table both say option A "re-pins … and starts the project". The project stays stopped until the owner restarts the engine. FR-6 also says "as `factory-engine confirm` … does today", and today's command only pins too (`cli.ts:136-156`), so the spec can be read either way. See N1 |
| FR-7 | Met | `engine.ts:1705-1855` (`runReadiness`): interview checks, `gate1Resolution`, `readiness/checks.ts` `structuralChecks`; one orchestrator session only if all pass (`:1720`), read-only worktree (any change rejected, `:1793-1800`), report validated with one correction (`readiness/report.ts:42`, `:51`); result on the chain (`readiness_result`) and in an Agent report with `gate` and `checks`. Tests: run "AC-13, AC-8, AC-9 …" (`:534`), "AC-13: an FR no criterion covers …" (`:574`), "AC-8, AC-13 …" (`:597`), acc structural and report unit tests (`:654-722`). The AC form check accepts "Given … Then" without "When" (m2) |
| FR-8 | Met | `engine.ts:1690` (`readinessFailed`, evidence as data), `:1857` (`fileSignoff`: kind `spec`, Summary, Readiness, Open items, feature, path, version, commit), `waiting_on` via `Inbox.waitingOn`. Tests: run "AC-8, AC-13 …", acc "AC-8, FR-8 …" (`:513`) |
| FR-9 | Met | `engine.ts:1584-1608`: Approve checks the branch head against the chain's sign-off commit; a moved branch records `signoff_withdrawn`, reopens the same item and reruns the gate, which revises it (`:1879-1883`); changes go back with the note; Defer waits. Confirm required by the store (`inbox/model.ts:81` `isRisky`). Tests: run "AC-13, AC-8, AC-9", acc "AC-9, SR-3 …" (`:529`), acc "FR-9: … the same sign-off item is revised …" (`:543`), acc "AC-9, FR-9: Defer …" (`:557`), run "AC-10" (`:617`) |
| FR-10 | Met | `engine.ts:1454-1456`, `inbox/store.ts:124`. Tests: run "AC-1, AC-12, AC-2" (`waiting_on: ["D-0001"]`, then left out), run "AC-13, AC-8, AC-9" (`["S-0001"]`) |
| FR-11 | Met | Effects and structural checks are code (`engine.ts:1523`, `readiness/checks.ts`). Model and limits from `models.yaml`/`limits.yaml` (`config/models.ts:11`, `config/limits.ts:203-207`), optional sections; a missing entry logs and records why (`engine.ts:1728-1735`). `orchestratorPolicy` (`agent/reviewer.ts:27`) refuses extra tools, commands or network. Tests: acc "FR-11: a factory version with no orchestrator model …" (`:637`), acc "SR-11: an orchestrator role that also allows Bash …" (`:621`), `limits.test.ts` "F-016 H-0184 …". See m3 for a role with no `Write` |
| FR-12 | Met | `engine/scripts/migrate-inbox-once.ts`; engine Gate 1 and pins items keep their effect. Tests: `migrate-inbox.test.ts` (3 tests) |

#### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-1 | Met | acc `:185`, `:209`; run `:122` |
| AC-2 | Met | run "AC-1, AC-12, AC-2 …" (`:122`): option B as data with finding, label and item id; an Approved SR citing `Gate 1 #1; D-0001` reaches `readiness_gate` |
| AC-3 | Met | run "AC-3" (`:163`); acc `:241`; acc unit `:763` |
| AC-4 | Met | run `:267`, `:301` |
| AC-5 | Met | run `:185` (choice item); acc `:295` (risk item) |
| AC-6 | Met | run `:334`; acc `:368` |
| AC-7 | Met | run "AC-7" (`:203`): once after the restart, not again on a third start |
| AC-8 | Met | run `:534`, `:597`; acc `:513` |
| AC-9 | Met | run `:534` (confirmed Approve; Approve without confirm changes nothing); acc `:529`, `:543`, `:557` |
| AC-10 | Met | run "AC-10" (`:617`); acc `:241` (an injected instruction stays inside the data block) |
| AC-11 | **Not met** (not run) | No evidence. It needs the trial project's private config repo, the inbox workflow and `FACTORY_OWNER_LOGIN` installed by hand (A-1), the owner's token, and his 👍 and 🚀 on real issues. The test report and the developer both leave it for the owner's PC. No test in the repo stands in for it. See "To pass round 2", step 1 |
| AC-12 | Met | run `:122`, `:534` |
| AC-13 | Met | run `:534`, `:574`, `:597`; acc `:654-690` |
| AC-14 | Met | acc "AC-14: a session that writes outside its report …" (`:570`), acc "AC-14: a report invalid twice … the engine log says why" (`:599`), run "AC-14 …" (`:641`, now with a fake that survives the correction and a check of the reason). Log line at `engine.ts:1817` |

#### Security requirements

| Id | Status | Evidence |
|---|---|---|
| SR-1 | Met | Answers read live need the pinned owner's id and, for risky actions, a confirm within 15 minutes at the same revision (`inbox/store.ts` poll, `:552`); answers not read in this run are checked first (SR-12). Tests: acc "SR-1 …" (`:217`); `inbox.test.ts` AC-4, AC-5 |
| SR-2 | Met | `gate1/flow.ts:109-135`: notes, labels and evidence as a JSON block after the engine's instructions. Tests: run "AC-10", run `:122`, acc `:241`. The framing line overstates who wrote the data (m4) |
| SR-3 | Met | `engine.ts:1584-1596`. Test: acc "AC-9, SR-3" (`:529`) |
| SR-4 | Met | Effect set by code at filing (`state/inbox.ts:31`, `:64`); unknown type records only (`engine.ts:1660`). Tests: acc `:404`; `migrate-inbox.test.ts` "an item not filed by the engine gets no effect …" |
| SR-5 | Met | `effect_done` in the record, `pendingEffects` skips done ones. Test: run "AC-7" |
| SR-6 | Met | `gate1/flow.ts:146` (`citesItem`, whole ids), `:188`. Tests: acc `:743`, `:748`; `gate1.test.ts` "citesItem (F-016 SR-6, Gate 2 L6)" |
| SR-7 | Met | One commit for entries and `effect_done` (`engine.ts:1531-1538`); retried every poll, Notice after 3 (`:1885`, `:1917-1929`). Tests: acc `:265`, `:458`, `:477` |
| SR-8 | Met | `engine.ts:1640-1650`. Test: run "F-016 SR-8" (`:461`) |
| SR-9 | Met | `engine.ts:362-374` (one issues read at connect; a refusal turns the inbox off, logs and notifies). Test: run "F-016 SR-9" (`:446`). The token's scope on GitHub is the owner's setup, not engine behavior |
| SR-10 | Met | `gate1/flow.ts:172-178`; analyst told to add the row (`:114-116`). Tests: run `:267`; acc `:769` |
| SR-11 | Met | Tools Read, Grep, Glob, Write only (`agent/reviewer.ts:15`, `:27`); write only the report, any other file rejected and a Security item filed (`engine.ts:1793-1808`); code checks first. Tests: run `:534`, `:574`; acc `:570`, `:621`. Still runs in a container (stricter than v11; see Architecture) |
| SR-12 | Met | `engine.ts:1898-1916` (an answer not recorded in this run is checked with `Inbox.verify`, `inbox/store.ts:260`; a failure records `unverified` and files a Security item; an unreachable GitHub leaves it waiting); `engine.ts:599-607` refuses remote `inbox/` changes. Tests: run "Gate 2 M1" (`:228`), acc "SR-12, SR-4" (`:404`), `remote.test.ts` "sync(): refuses a remote change to inbox records …". See m1 for what `verify` doesn't check |

#### Edge cases (spec section 6)

| Item | Status | Evidence |
|---|---|---|
| Answer on an old revision records nothing | Met | F-011 store; `inbox.test.ts` AC-7 |
| Two items in one poll: record order, one stage change | Met | acc `:332` |
| Analyst records another option | Met | AC-3 |
| Sign-off approved, then the branch moves | Met | acc `:529`, `:543` |
| Confirm older than 15 minutes refused | Met | acc `:217`; `inbox.test.ts` AC-5 |
| Reviewer text that looks like a command | Met | F-011 SR-10, SR-17, SR-18 in `inbox.test.ts`; options fenced as the reviewer's text |
| Unmigrated item file never read | Met | No code reads `.factory/inbox/`; migration script |

#### Other lines

| Area | Status | Evidence |
|---|---|---|
| Spec approval | Met | Spec v11, Approved; SR-12 approved by the owner (Gate 2 decision, 2026-11-14) |
| Architecture / ADRs | Met | ADR 0022 (inbox on issues): followed. ADR 0009 (`factory/state`): records and bodies on it, compare-and-swap commits. ADR 0026 (agents on the host until Beta): this branch still runs the orchestrator in a container through the Gate 1 runner; the runner switch belongs to another PR, and the dev report says so. A container is stricter than SR-11 v11 asks, so this is no conflict. When the runner moves, SR-11's file-tool rules and end-of-session check must carry the guarantees alone (Gate 2 Info) |
| Interface contracts | Met, with finding | Inbox item v3.1 and Engine control channel v1.5 applied as approved (H-0180, H-0183), each in its own commit. Contract tests pass (acc `:185`, `:513`; run `:122`). One sentence in v3.1 no longer matches the code (m5) |
| Change-controlled files | Met, with finding | `docs/interface-contracts.md`, `engine/config/*.yaml` (H-0184) and the spec carry recorded approvals. `plugins/…/factory_check.py` (`6627209`, "H-0185") has no recorded approval anywhere in the repo, and the dev report still says H-0185 "is waiting on the owner" (M1) |
| Code quality, readability, maintainability | Met, with findings | Effects are a small switch on a code-set type, each ending in one `done(...)` commit, which makes SR-5 and SR-7 easy to see. The readiness gate mirrors the Gate 1 runner closely. Findings: m1, m3, m6 |
| Comments | Met, with finding | New comments mostly say why and cite the rule (`engine.ts:1516-1522`, `:1554`, `:1588`, `:1618`, `:1641`, `:1830`, `:1878`, `:1910`; `gate1/flow.ts:174`, `:186`). One overstates (m4) |
| Test tools | Met | Test report tool choice table: unit, acceptance and contract on Vitest 5.1.0 with the engine harness (F-007 OQ-9); stochastic not required at Rapid prototype |
| Documentation | Met, with findings | Spec v11, both gate reports, dev report, test report with the developer's "After the report". Findings: m7, m9 (and M2 for the Gate 2 fixes table) |
| Security | Met | Gate 1 (0 Critical, 0 High) and Gate 2 (PASS, 0 Critical, 0 High) present. Gate 2 M1 and M2 fixed (M1 by the owner's decision, now SR-12), L1 to L4 and L6 fixed, L5 and L7 logged. Gate 2 reviewed `204502f`; the M1 fix (`ee52303`) and `5740e0c` were not re-reviewed by the security reviewer (M2). My reading of the M1 fix agrees with it, with m1 |

### Findings

#### Blocking

None.

#### Needs owner

| # | Location | Finding |
|---|---|---|
| N1 | `engine/src/engine.ts:1611-1625`; spec FR-6, H-0182 table | **The `pins` approval doesn't start the project.** FR-6 and H-0182 say option A "re-pins the changed keys and starts the project". The code pins (bound to the manifest commit, from the previously pinned owner only) and notifies "Restart the engine to run the project." So after a confirmed approval in the inbox, the project stays stopped until the owner restarts the engine on his PC. FR-6 also says "as `factory-engine confirm` … does today", and that command only pins too, so the spec can be read as parity with today. The owner's call: (a) accept a restart as the way it starts, and reword FR-6 and H-0182 (spec change), or (b) the engine starts the project in-process after the pin (developer, then tests and a Gate 2 look, since it runs the start path under a just-changed owner key set). Recommended: (a) for Rapid prototype; a pins change is rare and the engine already tells the owner what to do |

#### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M1 | `plugins/software-factory/skills/onboard-repo/scripts/factory_check.py:1223-1225` (`6627209`); `docs/features/F-016-dev-report.md:8`, `:72` | **H-0185 has no recorded approval.** `plugins/` is change-controlled (CLAUDE.md rule 3). The commit carries the hygiene id the way approved items are applied, but no doc records the owner's approval, and the dev report still says H-0185 "is waiting on the owner". If the owner approved it, record it (where H-items are recorded: the spec's section 10 or the dev report). If not, the edit must come out, and this becomes Blocking. Fix (orchestrator) |
| M2 | `docs/features/F-016-security-gate2.md` § Fixes after the review | **The Gate 2 M1 fix wasn't re-reviewed by the security reviewer.** Gate 2 reviewed `204502f`. The SR-12 fix (`ee52303`: `Inbox.verify`, the `inbox/` refusal in `checkRemote`) is new trust code that decides whether a recorded answer is genuine; it was added and described by the developer. Not required at Rapid prototype, but this is the code that makes SR-1 hold, and I found two gaps in it (m1). Fix (security reviewer): a short re-review of `ee52303` and `5740e0c` before Alpha, or before merge if the owner wants |

#### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m1 | `engine/src/inbox/store.ts:260-287` (`verify`) | `verify` takes the action comment from any revision of the item (`r.revisions.flatMap(…)`), and doesn't check the confirm's 15-minute window. So a forged record could reuse a genuine 👍 the owner gave on an earlier revision, which the live reader refused as stale. For a sign-off this is still caught by SR-3 (the commit on the chain); for a Gate 1 choice it could replay an earlier revision's option. Needs write access to `factory/state`, the same as Gate 2 M1. Suggest: accept only the entry's own revision's comments, and the confirm window |
| m2 | `engine/src/readiness/checks.ts:70` | FR-7 says "every AC in Given/When/Then form"; the code requires "Given" and "Then" only. F-016's own approved ACs mostly have no "When", so the reading matches the owner's practice, and the test engineer read it the same way. The evidence string still says "not in Given/When/Then form". Worth one line in the spec (or the feature template) saying "When" is optional |
| m3 | `engine/src/agent/reviewer.ts:31-41` (`reportOnlyPolicy`) | H-0184 says a project runs the orchestrator "only with an `orchestrator` role … tools Read, Grep, Glob, Write; write `.factory/runs/**/orchestrator-*.json`". The code refuses extra tools but doesn't require `Write` or the write rule; it replaces the role's write rule with the report path. A role without `Write` starts a session that can't write its report and fails closed after a correction, spending a session. Suggest refusing up front with a reason |
| m4 | `engine/src/gate1/flow.ts:130` | "The notes, labels and evidence below are … the owner's own words and the engine's checks." Option labels come from the security reviewer and `readiness_failed` evidence from the orchestrator agent, so the line overstates their trust (Gate 2 Info, not changed). Suggest "the owner's notes, the reviewer's labels and the readiness gate's evidence" |
| m5 | `docs/interface-contracts.md`, Inbox item v3.1 engine history paragraph | "An owner action with no later `effect_done` is carried out when the engine next starts, once." Since the L2 and M1 fixes it is carried out at the next poll, after a GitHub check when it wasn't read in this run, and an unverified one gets `effect_done: unverified`. The sentence is change-controlled; a wording fix needs the owner's OK |
| m6 | `engine/src/engine.ts` (2,109 lines; `onAnswer` `:1523-1662`) | The engine file keeps growing; `onAnswer` holds nine effect branches in one function. Readable today, but the effects would be easier to test and review as one small function per effect type in their own module, before F-015 adds more |
| m7 | `docs/features/F-016-dev-report.md:66-72`; spec section 10 | Dev report counts are stale (12 tests in `f016-run.test.ts`, now 18; full suite at `d344b9d`), and it still says `onboard-repo` fails until H-0185. Spec section 10 says H-0180, H-0182 and H-0183 are each applied "as its own commit with its id"; there is no H-0182 commit (the table is built in `3638ce6`) |
| m8 | CI, `6627209` | A Windows `EBUSY` in an acceptance test's temp-folder cleanup, seen once, on a commit that changed only Python. Not reproduced on this head. Classify per `testing-strategy.md` if it recurs |
| m9 | `docs/features/F-016-test-report.md:5`, "After the report" | The test report's final commit is `ee52303`. The developer's fixes (`5740e0c`) and the new `chain` and `gate1cap` tests came after, and the only record of them passing in the report is the developer's own line. My runs on `6246b09` and CI cover it (all pass). Fix (test engineer, optional): name the final commit and counts |

Carried from Gate 2, not graded again: L5 (agent-chosen paths and manifest text unfenced in Security item contexts) and L7 (a secret-flagged owner note retried every poll), both logged by the developer.

### Counts

- Blocking: 0. Major: 2 (M1, M2). Minor: 9 (m1 to m9).
- Lines: 1 Not met (AC-11). 1 Needs owner (FR-6, the `pins` start: N1).

### To pass round 2

1. **Owner (AC-11):** run the live trial on the PC: install the inbox workflow and `FACTORY_OWNER_LOGIN` in the trial config repo (A-1), migrate F-002's open items, answer its Gate 1 items in the inbox, and confirm the Spec sign-off; F-002 must reach `build_and_test_prep`. The alternative is the owner's decision to move AC-11 after the merge, which is a spec change.
2. **Owner (N1):** decide the `pins` start (restart, recommended, or start in-process).
3. **Orchestrator (M1):** record H-0185's approval, or take the edit out.
4. **Security reviewer (M2):** re-review the Gate 2 M1 fix (`ee52303`) and `5740e0c`.
5. **Optional (m1 to m9).** Any code change after this verdict needs the suites re-run.
