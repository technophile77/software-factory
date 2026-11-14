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

## Round 2

- **Feature:** F-016, spec v19 (FR-13 to FR-20, AC-15 to AC-22, SR-13, H-0185 to H-0189, H-0235, H-0236). Round 1's open lines are re-checked here.
- **Judge:** validation-judge
- **Date:** 2026-11-14
- **Round:** 2
- **Commit:** `d9de268` (`claude/project-thread-mszazz`). Its engine tree is the same as `origin/main` `e306c2c`; the branch adds only report changes (`git diff --stat e306c2c HEAD` touches only `F-016-dev-report.md` and `F-016-test-report.md`). The delta judged is `6246b09..d9de268` for F-016: PR #60 (`9ed861c`), then #75, #78, #80 and #81. The same range also holds F-018 and F-020 work, judged here only where F-016 depends on it.
- **Maturity level:** Rapid prototype. Any number of Major findings is allowed if each is logged; a Not met line or a Blocking finding fails.
- **Verdict:** **FAIL**
  - **Not met: 2 lines** (FR-15: B1; FR-20: M3). **Needs owner: 0.**
  - Blocking: 1 (B1). Major: 4 (M3 to M6). Minor: 13 (m2 to m7 and m9 carried; m10 to m15 new).
  - Round 1's list is done. AC-11 has the owner's live run. N1 is settled by spec v13 ("the project runs at the next engine start"). H-0185's approval is recorded. Gate 2 was re-reviewed. Round 1's m1 is fixed by the re-review's R2.
  - What fails now is new code from the trial fixes:
    - B1: a `gate1unresolved` item answered with option A never leads to another item, so the feature can get stuck.
    - M3: FR-20's level-change clause isn't implemented.
    - Both are reproduced below. Main's engine CI has also been red since the F-016 merge.

### My own run

On `d9de268`, Linux container, Node 22. Owner rule: only the suites for the changed areas.

| Step | Result |
|---|---|
| `cd engine && npx tsc --noEmit -p .` | Clean |
| `npx vitest run --maxWorkers=3 test/gate1.test.ts test/f016-run.test.ts test/f016-acceptance.test.ts test/spec-structure.test.ts test/readiness.test.ts test/interview.test.ts test/analyst-run.test.ts test/units.test.ts test/limits.test.ts` | **9 files passed. 213 tests: 211 passed, 2 skipped, 0 failed** (139 s). The two skips are `units.test.ts:141` and `:156`, which run only on Windows or macOS |
| `npx vitest run --project acceptance test/acceptance/mcp-f005.test.ts -t "F-016 AC-16\|nothing_waiting"` | 2 passed (the AC-16 test lives in the acceptance suite) |
| Python plugin tests (`factory_check.py`, H-0186) | Not run: gitleaks and zizmor aren't installed here. Not counted against F-016 |
| Probe 1 (scratch copy, AC-17 harness): option A on `gate1unresolved`, the analyst fails again, then an engine restart | Stage stays `security_gate_1`; still one item (`D-0001`); the transcript ends `gate1_resolved` false, twice; no job. **B1** |
| Probe 2 (scratch unit test): a High finding passed through `records(..., "rapid-prototype")`, then used at `alpha` | `recorded: true`; `analystGate1Turn(..., "alpha")` returns `null`; `gate1QuestionProblem` refuses the question as "below the project's level bar". **M3** |

### CI

| Run | Head | Result |
|---|---|---|
| `engine` 43584675396 | `e306c2c` (main, the final engine tree) | **Failure.** Linux 1/2 and 2/2, checks and supply-chain pass. Windows 1/6, 2/6 and 3/6, and macOS 2/3 and 3/3, fail. The F-016 tests among the failures: `f016-acceptance` "AC-1 …" (afterEach hook timeout in `engine.stop()`) and "section 6: two items …" (timed out waiting for both effects); `f016-run` "chain, option A …" (60 s timeout), "gate1cap, option A …" (its regex for `limits.yaml` expects LF line endings) and "SR-9 …" (hook timeout). Also `notify.test.ts` on macOS (300 ms wait) and F-018 terminal tests |
| `engine` 43576251696 to 43582800746 | `9ed861c` to `cf6e75c` (every main push since PR #60) | **Failure**, with the same F-016 tests failing on the full Windows shards, plus "SR-8" and "OQ-3" on `cf6e75c`. The PR runs only the platform subset on Windows and macOS, so these first showed on main |
| `engine` 43555390470 | `7d3c54d` (before PR #60) | Success on every shard |
| `codeql`, `docs-checks` | `e306c2c` | Success |

### Evidence checklist

Only lines that changed or were open after round 1. `run` is `engine/test/f016-run.test.ts`; `acc` is `engine/test/f016-acceptance.test.ts`. Line numbers are at `d9de268`. Every test named here passed in my run.

#### Functional requirements

| Id | Status | Evidence |
|---|---|---|
| FR-6 (round 1 N1) | Met | Spec v13 rewords the `pins` effect: "re-pins the changed keys, and the project runs at the next engine start". The code matches: `engine.ts:1673-1686` pins the named manifest commit, only from the pinned owner, and notifies "Restart the engine to run the project." Test: run "F-016 OQ-3 …" (`:618`). For the `gate1unresolved` row of FR-6's resume rule, see B1 |
| FR-13 | Met | `engine.ts:1041-1064` (a stopped run files `analyststop` through `offerRerun`; a breach or a secret keeps its own item, `:1053`); `:1724-1731` (option A: one `launchAnalyst` if still in the interview with no job, SR-13); `:2188-2192` (filed at start for a failed last run); `:908-910` (the new run gets the transcript summary). Tests: run "AC-15, AC-16 …" (`:792`), "AC-15: an engine start files the item once …" (`:833`). See m10 |
| FR-14 | Met | `engine.ts:1513` (`active_agents` from `jobs`); `mcp/operations.ts:338-358` (`whereIs`: names only ids that match `INBOX_ID_RE`). Tests: run `:792`; `acceptance/mcp-f005.test.ts` "F-016 AC-16 …" |
| FR-15 | **Not met** | The first send-back and the first item work: `engine.ts:1159-1175`; run "AC-17 …" (`:873`). After option A, `engine.ts:1717-1721` appends a `returned` that carries `item`. `model.ts:258` counts only returns without `item`, so `unresolvedSent` stays 1. The key `gate1unresolved:<f>:<reportAt>:1` (`engine.ts:1168`) is already in `record.alert`, so the next failure files nothing. Probe 1 shows the feature stuck, also after a restart. See B1 |
| FR-16 | Met | `interview/readiness.ts:126` (either title); `engine.ts:1091-1092` (a blocked feature is checked again at start); `:1127-1133` (open `gate1_risk` items withdrawn). Test: run "FR-16, AC-18 …" (`:371`) |
| FR-17 | Met | `interview/structure.ts` reads `docs/features/feature-template.structure.json`; `interview/readiness.ts:198` (`spec_structure`); `engine.ts:907` (`structureText()` in the analyst's first turn); `branchSpec` runs the checks before Gate 1 resolution and readiness (`engine.ts:1110-1112`). Tests: `spec-structure.test.ts` (4) |
| FR-18 | Met | `gate1/flow.ts:205` (`same`). Test: `gate1.test.ts:319` "FR-18, AC-20 …" |
| FR-19 | Met | `gate1/flow.ts:84-114` (`blocksAt` from `security-blocking.json`; an unknown level or severity blocks); `gate1/render.ts:28` (known issues); `engine.ts:1366` (`validateReport` with maturity). Tests: `gate1.test.ts:368`, `:384`, `:399` (Markdown table and JSON agree); run `:305`, `:321` |
| FR-20 | **Not met** (one clause) | Met for a report without `recorded` flags and for the question check: `flow.ts:105`, `:212-222`; `interview/tools.ts:204`, `:230`. Tests: `gate1.test.ts:335`, `:356`. Not met: "or before the project's level changed, follows the bar for the project's current maturity". `belowBar` returns true for any `recorded` finding whatever the current level (probe 2). See M3 |

#### Acceptance criteria

| Id | Status | Evidence |
|---|---|---|
| AC-11 | **Met** (from recorded evidence) | Test report § "AC-11 live trial": the owner's PC (Windows), engine at `51b6e7f` (same tree as `cf6e75c`; `git diff --stat cf6e75c 51b6e7f` is empty). It differs from the final engine tree only in PR #81's `gate1cap` wording (`engine.ts:1214-1216`). Timeline: Gate 1 resolved 10:12; `gate1cap` D-0004 (issue #7) answered A 10:22; readiness passed and S-0001 filed (issue #8) 10:24; confirmed Approve gives `build_and_test_prep` 10:33. I can't reach `technophile77/factory-e2e-trial` and judge from the record only. Under FR-19 the final round's Gate 1 items were answered in the terminal interview, not as inbox choice or risk items. The inbox path that ran live is a Security item (`gate1cap`) and the sign-off. Earlier trial rounds filed risk items (FR-16). The choice and risk effects are covered by AC-1 to AC-5's tests |
| AC-15 | Met | run `:792`, `:833`. See m10 |
| AC-16 | Met | `acceptance/mcp-f005.test.ts` "F-016 AC-16 …"; run `:792` (`active_agents` 0, then 1, then 0; `waiting_on: ["D-0001"]`). The "interview skill" is now F-018's terminal command, which prints the same operation's `display` (m12) |
| AC-17 | Met | run `:873`. Probe 1 shows option A sends the feature back with an analyst run. What follows a later failure is B1, which AC-17 doesn't state |
| AC-18 | Met | run `:371` |
| AC-19 | Met | `spec-structure.test.ts` (4 tests) |
| AC-20 | Met | `gate1.test.ts:319` |
| AC-21 | Met | run `:305`; `gate1.test.ts:384` (a reviewer report without `blocks` is valid; the reviewer's own value is ignored) |
| AC-22 | Met | `gate1.test.ts:335`, `:356`; the refusal is wired at `tools.ts:204-205` and `:230-231` before `f.create`. See m11 |

#### Other lines

| Area | Status | Evidence |
|---|---|---|
| Change-controlled files (round 1 M1) | Met | H-0185's approval is recorded (spec section 10, `:210-213`: "owner, 2026-11-14 02:26Z, decision card"; dev report line 8). H-0186 to H-0189, H-0235 and H-0236 are each recorded with the owner's approval (`:214-249`). Change log v12 to v19 names the owner's approval for each version. The touched files (`plugins/…/security-blocking.json`, `factory_check.py`, both AGENT.md files, `security-standards.md`, `interface-contracts.md:243`) match those entries |
| Security (round 1 M2) | Met, with finding | Gate 2 re-review at `3bfa23a` (PASS; R1 and R2 Medium, R3 and R4 Low). R1 to R3 fixed in `e8fa693`; R4 logged. My reading of `Inbox.verify` (`inbox/store.ts:283-321`) agrees: current revision only, markers checked on GitHub, replays refused, and the confirm window measured from GitHub's own time. That closes round 1's m1. No gate covers the v13 to v19 code (M5) |
| Code quality | Met, with findings | New effects follow the round 1 pattern (one `done(...)` commit each). Findings: B1, M3, m6, m14, m15 |
| Comments | Met, with finding | New comments say why and cite the rule (`engine.ts:910`, `:1091`, `:1127`, `:1159`, `:1725`, `:2190`; `flow.ts:201-204`, `:207-211`). One misplaced and outdated doc comment (m13) |
| Test tools | Met | New tests use Vitest 5.1.0 and the engine harness, as the test report's tool choice table says |
| Documentation | Met, with findings | Dev report "Live trial fixes" table; test report AC-11 section. Stale parts: m7, m9, m12; no test engineer coverage of the new ACs (M4) |
| CI | Met, with finding | Advisory at Rapid prototype (ADR 0030), but red on main since `9ed861c` (M6) |

### Findings

#### Blocking

| # | Location | Finding |
|---|---|---|
| B1 | `engine/src/engine.ts:1159-1175`, `:1717-1721`; `engine/src/interview/model.ts:258` | **After option A on a `gate1unresolved` item, the feature can get stuck again with no item.** Option A appends `{why: "gate1_unresolved", item}`. `model.ts:258` counts only returns without `item`, so `unresolvedSent` stays 1, and the key at `:1168` repeats and is deduped by `record.alert`. When the analyst again fails to take the findings up, `resolveGate1` logs "not resolved again" and returns. The feature then sits at `security_gate_1` with no analyst and no item, and it stays there after a restart (probe 1). This is the dead end FR-15 was added to remove ("Before this, the engine recorded 'not resolved' and stopped with no analyst and no item"). It breaks FR-6's resume rule ("if the check fails again, a new item is filed"). The trial showed analysts do skip these findings. Fix (developer): make the key change on every send-back, for example count option A's returns too or key on the item count, and add probe 1 as a test |

#### Major (allowed at Rapid prototype; logged)

| # | Location | Finding |
|---|---|---|
| M3 | `engine/src/gate1/flow.ts:105` (`belowBar`) | **A finding recorded at a lower level stays below the bar after the level rises.** `belowBar` is `!!f.recorded \|\| …`, so the flag set when the report was written wins over the current `maturity`. FR-20 says a report "written … before the project's level changed, follows the bar for the project's current maturity". Probe 2: a High finding recorded at `rapid-prototype` is neither asked nor needed once the project is `alpha`. Partly offset because known issues must be fixed before promotion, but nothing enforces that here. Fix (developer): decide from severity and current maturity only, and treat `recorded` as history. Add a test |
| M4 | `docs/features/F-016-test-report.md` | **No test engineer coverage of AC-15 to AC-22.** The report's AC table stops at AC-14, its final commit is still `ee52303`, and every test for the new ACs is the developer's own. They pass in my run, and I read each against its AC, but no tests were written independently from the spec. m10 and m11 are the gaps that leaves, and B1 sits in one of them. Fix (test engineer): tests from the spec for AC-15 to AC-22, and a run on the final commit |
| M5 | `F-016-security-gate1.md`, `F-016-security-gate2.md` | **No security review covers the v13 to v19 code.** That code adds two resume effects that start agent runs (`analyststop`, `gate1unresolved`), SR-13 (owner-written, not through Gate 1), code deciding what blocks (FR-19), automatic withdrawal of risk items (FR-16), and the `interview_ask` refusal (FR-20). The developer's R1 to R3 fixes (`e8fa693`) weren't re-reviewed either. Not required at Rapid prototype. Fix (security reviewer): a Gate 2 pass on `6246b09..e306c2c -- engine/src` before Alpha, or before more trial runs if the owner wants |
| M6 | CI `engine` on main, runs 43576251696 to 43584675396 | **Main has been red since the F-016 merge, with F-016 tests failing on Windows and macOS.** The full Windows shards fail several F-016 tests:<br>- f016-run "chain, option A" (60 s timeout)<br>- f016-run "gate1cap, option A" (its regex expects LF line endings, a test defect)<br>- f016-run "SR-9", "SR-8" and "OQ-3"<br>- f016-acceptance "AC-1" (afterEach `engine.stop()` hook timeout)<br>- f016-acceptance "section 6" (effects timeout)<br>macOS fails `notify.test.ts` (300 ms wait). PR runs use only the platform subset, so this first showed on main. CLAUDE.md rule 7 says to fix forward or revert at once; seven merges have gone in since. The owner runs the engine on Windows. The `engine.stop()` hook timeouts may come from `stop` waiting for OS notifications (`e8fa693`), so they may not be test-only. Fix (orchestrator): classify each failure per `testing-strategy.md`, then fix forward |

#### Minor (logged; never block)

| # | Location | Finding |
|---|---|---|
| m2 | `engine/src/readiness/checks.ts:70` | Carried. "When" isn't required, but the evidence says "Given/When/Then" |
| m3 | `engine/src/agent/reviewer.ts` (`reportOnlyPolicy`) | Carried. An orchestrator role without `Write` isn't refused up front |
| m4 | `engine/src/gate1/flow.ts:165` | Carried. The framing line still calls reviewer labels and orchestrator evidence "the owner's own words and the engine's checks" |
| m5 | `docs/interface-contracts.md:159` | Carried. "carried out when the engine next starts, once" no longer matches the code |
| m6 | `engine/src/engine.ts` (2,198 lines; `onAnswer` `:1585-1741`) | Carried and growing: `gate1unresolved` and `analyststop` were added to the same switch |
| m7 | `docs/features/F-016-dev-report.md`, Tests | Carried. "19 tests" in `f016-run.test.ts`; there are 25 |
| m9 | `docs/features/F-016-test-report.md:5`, "What didn't run" | Carried. The final commit is still `ee52303`, and the report still says `chain` and `gate1cap` have no test; they do (run `:480`, `:528`) |
| m10 | `engine/test/f016-run.test.ts:792`, `:873` | The AC-15 test stops the run with `error_max_turns`, not the wall-time cap AC-15 names, and doesn't check that undelivered replies reach the new run (FR-13). The AC-17 test covers only option B and a skipped question, not "taken up only as assumptions" or option A (B1) |
| m11 | `engine/src/interview/tools.ts:204-205`, `:230-231` | AC-22's "refused with `invalid` and nothing is recorded" is tested only through `gate1QuestionProblem`. No test calls `interview_ask` or `interview_revise` |
| m12 | F-016 spec: header Status, section 11, FR-14, AC-16, H-0187, H-0188, section 9 | Status and section 11 still say v10 and AC-1 to AC-14. FR-14, AC-16 and H-0188 name the `spec-interview` skill F-018 retired. H-0187's Markdown link was replaced by a bare URL (`mcp/operations.ts:141`). SR-13 sits between SR-11 and SR-10. Fixing these is a spec edit and needs the owner's OK |
| m13 | `engine/src/gate1/flow.ts:191-198` | `gate1Resolution`'s doc comment is now detached above `same`, and says a Security item decision is something "this engine can't read yet", which F-016 changed |
| m14 | `engine/src/engine.ts:1168-1170`; `engine/src/state/inbox.ts:20-21` | The `gate1unresolved` item's Context includes Gate 1 evidence, which can quote a reviewer's option label (`flow.ts:249`), in an engine-text section. `fileSecurityItem` promises engine text only. Same class as Gate 2 L5. Reasoned, not reproduced |
| m15 | `plugins/software-factory/skills/onboard-repo/scripts/security-blocking.json` | A policy table with `version` but no versioned `schema` field or JSON Schema (CLAUDE.md rule 9, H-0240). Possibly left for F-020 |

Round 1's m1 is fixed (Gate 2 re-review R2). m8 is replaced by M6. Carried from Gate 2 and not graded again: L5 and L7 (logged) and R4 (logged).

### Counts

- Blocking: 1 (B1). Major: 4 (M3 to M6). Minor: 13 (m2 to m7, m9 to m15).
- Lines: 2 Not met (FR-15: B1; FR-20: M3). 0 Needs owner.
- Round 1: AC-11 Met; N1 closed (FR-6 Met); M1 closed; M2 closed (re-review done; M5 covers what came after); m1 fixed.

### To pass round 3

1. **Developer (B1):** file a new `gate1unresolved` item whenever the check fails after a send-back, option A included. Add probe 1 (option A, fail again, restart) as a test.
2. **Developer (M3):** apply FR-20's bar from severity and the current `maturity`, whatever `recorded` says, and add a test. The other way out is the owner rewording FR-20, which is a spec change.
3. **Orchestrator (M6):** classify and fix forward the Windows and macOS failures on main (rule 7).
4. **Test engineer (M4):** tests for AC-15 to AC-22 from the spec, including option A for AC-17 and the refusal through `interview_ask` for AC-22; update the report's final commit and counts.
5. **Security reviewer (M5):** a Gate 2 pass on the v13 to v19 engine code and `e8fa693`, before Alpha or sooner if the owner wants.
6. **Optional (m2 to m15).** Any code change after this verdict needs the affected suites run again.

### After round 2 (developer, 2026-11-14)

- **B1:** fixed in `0c758eb`. The `gate1unresolved` key counts every send-back since the report, option A included (`unresolvedRounds`), so each later failure files its own item. Test: `f016-run.test.ts` "FR-15 (validation round 2 B1) …", which fails without the fix.
- **M3:** fixed in `0c758eb`. `belowBar` decides from severity and the current level whenever the level is known; the stored `recorded` flag is used only when it isn't. Test: `gate1.test.ts` "FR-20 (validation round 2 M3) …".
- **M6:** being fixed forward on the same branch.
