# Feature: Answer factory decisions in the console

- **Id:** F-021
- **Status:** In development (approved: owner sign-off 2026-11-14 10:31Z, decision card; readiness gate passed on v6)
- **Requested by / date:** Alex, 2026-11-14 ("the console is actually the
  better method of communicating with the factory"; "the console app should
  also say when a decision is pending, not just factory is idle"); v7:
  Alex, 2026-11-15 ("when there is nothing waiting for a decision leave it
  connected, so I can watch the status of the factory there"); v8: Alex,
  2026-11-20 ("try and reconnect to the factory if it restarts instead of
  giving up ... with an exponential backoff countdown timer"); v9: Alex,
  2026-11-20 (decision card "Yes, answer them in the inbox", after the inbox
  showed "Getting your next question" while F-003's Q-002 waited unseen);
  v10: Alex, 2026-11-25 (decision card "Yes, serve held items", after the
  inbox waited forever for a mesbot held on a `mcp_servers` change and
  D-0018 could not be answered there)
- **Spec version:** 10
- **Depends on:** F-011 (inbox on GitHub issues, ADR 0022), F-016 (answers
  and their effects, Code Review M1 check), F-018 (`factory-engine interview`,
  live status), F-020 (inbox records as JSON, `inbox-record/4.0`)

## 1. Objective and business purpose
Every decision the engine needs from the owner (a Security item, a Security and Testability Review
risk, the Security and Testability Review run limit of trial issue #7, a spec sign-off) is posed only
as a GitHub issue in the project's config repo. The owner often has just
finished an interview in `factory-engine interview` and has his attention
in that terminal, but has to go to GitHub to carry the feature on. Two more
gaps:

- An issue can only hold what may be shown on GitHub, so it can't carry
  private detail (a Security item's real subject, the engine log lines
  behind a failure). Today it says "the engine log has the reason", and the
  owner has to dig.
- While a feature waits on an inbox item, the terminal's live status says
  "The factory is idle", which is wrong: it is waiting for him.

The owner wants every such decision posed in the console as well as in the
issue. The issue stays, so the phone and GitHub keep working, and the first
answer from either path is the one recorded.

## 2. Expected behavior
1. When the engine files an inbox item, it opens the GitHub issue exactly as
   today. If the item has private detail (FR-4), the detail stays on the PC
   and the issue carries one fixed line: "More detail is on the PC that runs
   the factory: run `factory-engine inbox <id>` there."
2. In a terminal on that PC the owner runs `factory-engine inbox`. It lists
   the project's open items: id, kind, title, feature, priority, and whether
   it blocks. Security items show their own title here (the issue's title
   stays the fixed "needs your decision", F-011 SR-19). `factory-engine
   inbox D-0012` goes straight to one item.
3. The command prints the item whole (every section of the issue body, then
   the private detail under its own heading), and only then the numbered
   actions, the same ones the issue's action comments offer: options,
   Approve, Reject, Request changes, Ask for more research, Defer, Restore
   priority, Dismiss, testing steps.
4. The owner types a number and Enter. For "Request changes" and "Ask for
   more research" the command then reads the note. For a risky action
   (F-011 FR-11: Approve on hygiene, maturity and spec sign-off; any option
   of a Security decision) the command prints the confirm line, with the
   same fixed words as the GitHub confirm comment and a 4-character code,
   and the owner types the code within 15 minutes.
5. The engine records the answer, carries it out as it would a GitHub
   answer, and posts one comment on the issue: "Recorded from the console:
   <action>." It closes the issue as it would after a GitHub answer (an
   issue stays open after Defer, Restore and research, F-011 FR-7).
6. If the owner answered on GitHub first, the console shows "Already
   answered on GitHub: <action>" and offers the next item. An answer on
   GitHub after a console answer finds the issue closed and the record no
   longer open, and has no effect.
7. In `factory-engine interview`, when the interview has nothing for the
   owner and the feature waits on inbox items (Security and Testability Review risks, the run limit,
   spec sign-off), the command shows them one by one as in steps 3 to 6,
   without the owner leaving the terminal. The owner can also pick "Not
   now"; the items stay open on GitHub and in `factory-engine inbox`.
8. The live status says "Waiting for your decision on D-0012" (with every
   waiting id) whenever a feature waits on an inbox item, and "The factory
   is idle" only when nothing waits on the owner and no work is running or
   queued for the feature.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | Every inbox item stays a GitHub issue, filed and read exactly as F-011 and F-016 say. The console is a second way to answer it; nothing is filed only in the console. |
| FR-2 | A new subcommand, `factory-engine inbox [<item id>] [--project <path>]`, finds the running engine as `interview` does (F-018 FR-1, FR-2) and lists the project's open items (status `open`, which includes deferred items), blocking first, then by effective priority, then by id. Each line: id, kind, the item's own title, feature, effective priority, "blocking" when blocking. Picking one, or naming it on the command line, shows it (FR-3). With no open items it says so and stays open, watching (v7): every 5 seconds it reads `engine.status` and the open items, prints one line per feature the engine runs (FR-12) whenever those lines change, with the time, and lists the items as above as soon as one opens. Its calls keep the console session alive. Ctrl+C ends the command. |
| FR-3 | An item is printed whole before its actions: the kind's sections from the current revision's rendered body, then, when the item has private detail, a "Detail on this PC" section. Then its actions, numbered, in the order `actionsFor` gives them, labelled with `actionLabel`. There is no code path that asks for an action on an item it hasn't just printed (as F-018 FR-4). |
| FR-4 | **Private detail.** The engine may attach private detail to an item when filing or revising it: text that must not go to GitHub. It is kept on the PC only, in the engine folder (`<engine home>/private/<project>/<id>.rev<n>.json`, schema `inbox-private/1.0`, owner-only like the rest of the folder), never committed to `factory/state`, never pushed, never sent to a model. The issue body gets the fixed line of section 2 step 1 in its Context section. This build attaches private detail to: (a) every Security item, its own title; (b) every item filed because a run failed or hit a limit (the Security and Testability Review run limit, F-016 SR-7's "couldn't be carried out" notice, agent run failures), the engine's own log lines for that run, at most 200 lines; (c) items about a secret the scan found, the file and line (never the matched text). Other private detail needs a spec change. |
| FR-5 | **Answering.** The owner picks an action by number and Enter. `changes` and `research` read a note as F-018 FR-6 reads text (Enter on an empty line ends it; at most 4,000 characters, as `/changes`). The command sends the item id, the revision it printed, the action and the note; it never sends anything the owner didn't pick at that prompt, and never retries on its own (as F-018 FR-7). |
| FR-6 | **Risky actions.** For an action `isRisky` marks, the engine answers with a confirm: the same words as the GitHub confirm comment (`Confirm: <action> <target>.`) and a fresh 4-character code (`confirmCode`). The command prints them and reads the code; the engine records the action only if the code matches, at the same revision, within 15 minutes of the confirm. A wrong code ends the attempt with nothing recorded. |
| FR-7 | **First answer wins.** Console answers and the GitHub poll go through one lock per project, so one item's record is never changed by both at once. The console's answer is recorded only if, under the lock, the record is still `open` and at the revision the command printed; otherwise the command shows what happened instead: "Already answered on GitHub: <action>", "Changed since you opened it" (it prints the new revision whole and asks again), or "Withdrawn by the engine". A GitHub answer made after a console answer finds the record not open and is never read (F-011 FR-5 reads open items only). |
| FR-8 | **Recording.** A console answer is recorded in the item's record like a GitHub answer: `by: owner`, the same action names, `rev`, `source: console`, `console_answer` (FR-10's hash), `confirmed_by: {source: console}` for risky actions, and no comment, reaction or actor ids. Then the engine posts one fixed comment on the issue, `Recorded from the console: <action words>.`, adds its id to `engine_comments`, and closes the issue or updates its labels as F-011 FR-7 does for the same action. If GitHub can't be reached, the answer still stands; the comment and close happen at the next poll, which closes the issue of any record that isn't open. |
| FR-9 | **Effects.** A console answer is carried out by the same code as a GitHub answer (F-016 `onAnswer`), at once, not at the next poll. |
| FR-10 | **Proof of a console answer (F-016 Code Review M1).** When the engine records a console answer, it also writes a local answer file, `<engine home>/answers/<project>/<id>.<n>.json` (schema `console-answer/1.0`: item, rev, action, note, at, session, and the sha256 of the history entry), never committed or pushed. A console answer in `factory/state` that this run didn't record is carried out only if its local answer file exists and its hash matches the entry; otherwise it is treated as F-016 treats an unverified GitHub answer (not carried out; Security item filed). |
| FR-11 | **In the interview command.** When `factory-engine interview` has no interview item for the owner and `engine.status` lists inbox items the feature waits on (`waiting_on`), the command prints "The factory needs your decision on <ids>" and shows each item as FR-3 to FR-8, with one more choice, "Not now", which leaves the items open and returns to the live status. After the owner answers, the live status carries on. |
| FR-12 | **Live status says when the owner is needed (owner, 2026-11-14 10:23Z).** `engine.status` gives a feature the new `activity` code `waiting_for_decision` whenever `waiting_on` is not empty and no agent is running for it. `idle` is reported only when the feature has no open interview item, no open inbox item, and no job running or queued. The interview and inbox commands show `waiting_for_decision` as "Waiting for your decision on <ids>", with the ids from `waiting_on`. A stage the engine is about to start work on (queued) shows as "Working", not idle. **v7:** a feature in a build stage reports what its build is doing, from the build machine's state, never `idle`: `waiting_on_dependency`, `developer_working`, `test_engineer_working`, `merging`, `resolving_conflicts`, `tests_running`, `classifying_failures`, `code_reviewing`, `validating`, `opening_pr`, `waiting_for_ci`, `pr_ready`, `build_stopped`, `merged`, `closed`; `waiting_for_decision` still comes first when no agent runs and an inbox item waits. The commands show each code in their own fixed words, and an unknown code as "Working". |
| FR-13 | **Sign-in (OQ-2 (a)).** Console answers follow the project's existing sign-in setting, `settings.interview_sign_in` (F-018 FR-15): `inbox.open` opens a console session that needs a GitHub device sign-in exactly when an interview session would (never at `rapid-prototype` by default; once per engine start; every session; or every so many hours). The same sign-in covers both: a sign-in for an interview session counts for a console session under the setting, and the other way round. The record of each console answer says whether its session signed in. |
| FR-14 | Exit codes as F-018 FR-11: 0 when the owner stopped or nothing was left, 1 when the engine refused or failed for a reason other than being away (an engine that is away is waited for, FR-16), 2 on bad arguments. |
| FR-15 | The engine README and the root README describe the command beside `interview`; the engine's `--help` lists it. |
| FR-16 | **Waits for the engine and reconnects after a restart (v8).** Both `factory-engine inbox` and `factory-engine interview` treat a call that finds the engine away (not running, unreachable, connection dropped, or timed out) as something to wait out, not a reason to exit. At start the command prints the time and "The engine isn't running. Waiting for it to start; press Ctrl+C to stop."; later it prints the time and "Lost the connection to the engine. Reconnecting until it is back; press Ctrl+C to stop.". It then tries `engine.status` again after 1 s, doubling the wait each time up to 60 s, without limit. While it waits, one line redrawn in place counts down each second: "Reconnecting in <n>s (attempt <k>)". When `engine.status` answers, it prints the time and "Connected to the engine." (at start) or "Reconnected to the engine.", and carries on. The inbox opens a new console session if the engine no longer knows the old one, prints the status lines again and lists any open items. The interview opens the feature again without asking if the engine no longer knows its session, and goes on waiting for or showing the next item. The project's sign-in setting applies to a new session (FR-13). Any other failure ends the command as FR-14. Nothing is resent on its own: a reply or answer that was in flight is handled as F-018 FR-13 (the command says it may be recorded and asks). For an engine that is away, this replaces F-018 FR-11's exit code 1 and F-018 AC-10. |
| FR-17 | **The inbox console answers waiting interview questions too (v9).** The `waiting_for_owner` activity reads "Waiting for your answer" in both commands (it read "Getting your next question"). While `factory-engine inbox` watches (FR-2), a feature whose activity is `waiting_for_owner` is offered once: "<feature> has a question waiting for you." with "Answer it here" and "Not now". Answer it here opens the feature's interview session, as `factory-engine interview <feature>` does (FR-13 sign-in applies), and shows and sends each waiting item as F-018 does; as soon as no item is waiting (the analyst is working, researching, or the interview is done) it closes that session, says "Nothing more is waiting for you on <feature>; back to watching the factory.", and the watch carries on with the status printed again. Not now sends nothing; the feature isn't offered again until its activity has changed and it waits again. |
| FR-18 | **A project on hold for a pinned-key change still answers its hold item in the console (v10).** When the engine holds a project because a pinned key changed (F-007 SR-5; F-023 FR-4: the project is stopped and the "Pinned owner keys changed" Security item is filed), it still serves that project's channel, restricted to the hold. In that state: `engine.status` answers with no features and `held: { reason }`, the engine's own words for the hold (for example "a change to mcp_servers"); `inbox.open`, `inbox.list`, `inbox.show`, `inbox.answer`, `inbox.confirm` and `inbox.close` work, and `inbox.list` shows only the open hold item; every other method is refused with `project_held`. The inbox command prints the time and "This project is on hold: <reason>. Answer <item> to confirm the change, or press Ctrl+C and run `factory-engine confirm --project <path>`." and lists the item as FR-2 to FR-3. The console session for a held project always needs a GitHub device sign-in as the previously pinned owner, whatever `settings.interview_sign_in` says (SR-8). Answering the item is a risky action (FR-6). A confirm recorded from such a session pins the manifest commit the item names, exactly as a GitHub answer does (F-016 `pins` effect); the engine then starts the project (F-023 FR-5), and the console reconnects to the full channel as FR-16 says. Keep the project stopped, or any other answer, leaves it held. A project stopped for any other reason serves no channel, as today, and the console says the project is stopped and names `factory-engine confirm`. |

## 4. Acceptance criteria
Run against a test engine with a fake GitHub (as the F-016 inbox tests),
driving the command through its input and output streams.

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a Decision item with options A to C, an open issue and no private detail, when the owner runs `factory-engine inbox`, then the list shows it, and picking it prints every body section before the numbered actions, in `actionsFor` order. | FR-2, FR-3 |
| AC-2 | Given the owner picks "Option B" on a non-Security decision, then the record gets one `chosen` entry with `source: console`, the issue gets exactly `Recorded from the console: Option B: <label>.` and is closed, and the effect runs before the command returns. | FR-5, FR-8, FR-9 |
| AC-3 | Given a Security decision, when the owner picks an option, then the confirm words match the GitHub confirm comment's; a wrong code records nothing; the right code within 15 minutes records the choice with `confirmed_by.source: console`; the right code after 15 minutes records nothing. | FR-6 |
| AC-4 | Given the owner answered on GitHub and the poll recorded it while the console showed the item, when the owner picks an action in the console, then nothing more is recorded and the console says "Already answered on GitHub: <action>". Given the console answered first, a 👍 on GitHub afterwards records nothing. Run with the poll and the console answer started together 100 times: exactly one answer is recorded each time. | FR-7 |
| AC-5 | Given the engine revised the item after the console printed it, when the owner picks an action, then nothing is recorded and the new revision is printed whole before its actions. | FR-7 |
| AC-6 | Given the Security and Testability Review run-limit item, then the issue body holds the fixed "More detail" line and none of the log lines; the console shows the log lines under "Detail on this PC"; nothing under `private/` is in any `factory/state` commit or in any request to GitHub or a model. | FR-4 |
| AC-7 | Given a Security item, the issue title is the fixed SR-19 title and the console list shows the item's own title. | FR-4, FR-2 |
| AC-8 | Given a console answer in `factory/state` from an earlier run, when the engine starts, then it is carried out once if its local answer file matches; given a forged entry with no answer file, or a file whose hash differs, it is not carried out and a Security item is filed. | FR-10 |
| AC-9 | Given GitHub can't be reached when the owner answers in the console, then the answer is recorded and carried out, and at the next poll that reaches GitHub the comment is posted and the issue closed. | FR-8 |
| AC-10 | Given `factory-engine interview` on a feature at Security and Testability Review with a Security and Testability Review risk item open, then the command prints "The factory needs your decision on D-…", shows the item whole, and the owner can answer it or pick "Not now", which sends nothing. | FR-11 |
| AC-11 | Given a feature with no running agent and an open inbox item it waits on, `engine.status` reports `waiting_for_decision` and the command prints "Waiting for your decision on <id>"; given no open items and no job running or queued, it reports `idle`; given a queued stage with no agent yet, it doesn't report `idle`. | FR-12 |
| AC-12 | Given engine or outside text in a body or in private detail holding ANSI escapes, OSC 8 or OSC 52 sequences, or lines imitating the command's menu or confirm line, then none of it reaches the terminal raw and every such line carries the engine-text margin marker. | SR-1 |
| AC-13 | Given stdin or stdout isn't a terminal, then `factory-engine inbox` refuses with exit code 2 and sends nothing. | SR-3 |
| AC-14 | On Windows (`windows-latest` CI) the command connects over the named pipe and completes the AC-2 scenario. | FR-2 |
| AC-15 | Given `factory-engine inbox` with no open items, then the command stays open, prints "F-002: Tests are running" (one line per feature) once and again only when it changes, and when an item opens it lists it and the owner can answer it; Ctrl+C ends it with exit 0. Given a build feature whose tests are running, `engine.status` reports `tests_running`, not `idle`. | FR-2, FR-12 |
| AC-16 | Given `factory-engine inbox` watching with no open items, when the engine stops, then the command prints "Lost the connection to the engine", counts down "Reconnecting in 1s (attempt 1)", then waits 2 s, 4 s and so on up to 60 s between attempts; when an engine is running again it prints "Reconnected to the engine.", opens a new console session, prints the status lines again and lists an item that opened meanwhile. Given no running engine at start, it prints "The engine isn't running. Waiting for it to start" and counts down the same way. Ctrl+C during a countdown ends the command with exit 0. | FR-16, FR-14 |
| AC-17 | Given `factory-engine interview` waiting for the analyst, when the engine restarts, then the command counts down as AC-16, says "Reconnected to the engine.", opens the feature again without asking, and shows the item the restarted engine has. Given no running engine at start, it waits as AC-16 and, once one starts, says "Connected to the engine." and runs the interview. | FR-16 |
| AC-18 | Given `factory-engine inbox` watching with no inbox item open and a feature whose analyst waits for the owner's answer, then the status line reads "<feature>: Waiting for your answer" and the console offers the question; Answer it here shows the item, sends the pick, and once the analyst is working again the console says it is back to watching and prints the new status. Not now sends nothing and doesn't offer the same wait again. | FR-17 |
| AC-19 | Given a project held after a change to `mcp_servers`, when the owner runs `factory-engine inbox`, then the command connects, prints "This project is on hold: a change to mcp_servers", lists only the hold item, and asks for a GitHub device sign-in before showing it. Signed in as the pinned owner, picking "Confirm the change if you made it" and typing the confirm code pins the manifest commit the item names, and the project starts and serves its full channel within FR-5's time. Signed in as another GitHub account, the sign-in is refused and nothing is recorded. `interview.open` and `feature.start` on the held project are refused with `project_held`. A project stopped for an invalid manifest serves no channel. | FR-18, SR-8 |

## 5. Constraints
- PC terminal only, as F-018. The phone keeps answering through GitHub
  issues.
- No new dependency: the command reuses F-018's terminal code (rendering,
  cleaning, margin marker, numbered menus, spinner) and the inbox's own
  `actionsFor`, `actionLabel`, `isRisky` and confirm texts, so both paths
  offer the same actions with the same words.
- One engine code path carries out an answer, whichever way it came.
- The inbox record format is the one F-020 sets (`inbox-record/4.0`, JSON);
  this feature adds optional fields only. The build starts after F-020's
  record change is on `main`.

## 6. Edge cases
- The engine isn't running when the command starts, or stops or restarts
  later: the command waits for it with a countdown (FR-16); an engine that
  comes back still holding the old session needs no new one.
- An item is withdrawn by the engine while on screen: "Withdrawn by the
  engine: <reason>"; nothing is sent.
- The issue was never opened (GitHub down when filed): the item is still
  listed and can be answered in the console; when the issue is opened later
  it is closed at once with the "Recorded from the console" comment.
- The owner closes the issue by hand after a console answer: nothing
  happens; the record is already answered.
- Two consoles answer the same item: the lock lets the first through; the
  second gets "Already answered in the console".
- Private detail file missing (engine folder cleaned): the item shows "No
  detail is kept on this PC for this item" and stays answerable.
- A risky action's code is typed after the owner answered on GitHub: FR-7
  wins; nothing more is recorded.
- **Abuse:** text in an item (a reviewer's quote, a log line, a web finding)
  imitates the command's menu, confirm line or code, or carries terminal
  escapes. Handled by SR-1 and SR-2.
- **Abuse:** a program running as the owner (an agent with a shell, ADR
  0026) answers or confirms in the owner's name through the channel.
  Handled by SR-3 and FR-13; the residual is stated in SR-4.
- **Abuse:** someone with push access to the config repo writes a console
  answer into `factory/state` to get an effect run. Handled by FR-10.
- **Abuse:** private detail leaks to GitHub through a revision, an engine
  comment, a log the engine commits, or a model prompt. Handled by SR-5.

## 7. Dependencies
- `engine/src/inbox/` (store, model, render, commands), `engine/src/engine.ts`
  (`onAnswer`, `applyAnswers`, the poll), F-016's verify path.
- `engine/src/terminal/interview.ts` and `engine/src/mcp/operations.ts`
  (F-018), shared with the new command.
- `engine/src/interview/activity.ts` (FR-12).
- F-020's record move to JSON (`inbox-record/4.0`): this build follows it.
  The "Make JSON the default format for agent data" thread is told.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | The owner runs `factory-engine inbox` on the PC that runs the engine, as the same OS user, from a folder inside the project's repo or config repo (as F-018 A-1). | Owner, 2026-11-14 10:29Z (decision card) | Approved |
| A-2 | The engine folder on the PC is a safe place for private detail: owner-only, not synced to a cloud drive by the owner, and kept as long as the items are open. | Owner, 2026-11-14 10:29Z (decision card) | Approved |

## 9. Security considerations
| Id | Requirement | Source (analyst / Security and Testability Review) | Status |
|---|---|---|---|
| SR-1 | Everything the command prints from an item (body sections, labels, private detail, log lines) goes through `clean()` and carries the engine-text margin marker, as F-018 SR-1 and SR-2. The command's own menu, confirm line and code are printed only by the command, from engine values checked against the patterns the inbox already uses (ids, option ids A to D, the confirm code alphabet). | Analyst (S1.2, S6.1); Security and Testability Review #1 | Approved (owner, 2026-11-14 10:29Z, decision card) |
| SR-2 | The confirm code and words come from the engine's answer to the action, never from item text. A code is good for one action, one item, one revision and 15 minutes; a wrong code ends the attempt (no retry against the same code). | Analyst (S2.1, S5.1); Security and Testability Review #2 | Approved (owner, 2026-11-14 10:29Z, decision card) |
| SR-3 | The command refuses unless stdin and stdout are terminals (F-018 SR-3). The engine refuses console calls from agent processes it started (F-005 SR-14). The item id comes from the command line only if it matches the inbox id pattern; answers, notes and codes are read at prompts, never from arguments (F-018 SR-4, SR-5). | Analyst (S1.1, S1.3) | Approved (owner, 2026-11-14 10:29Z, decision card) |
| SR-4 | **Accepted risk until the setting asks for sign-in (owner, 2026-11-14 10:28Z, OQ-2 (a)):** without a sign-in, any program running as the owner that reaches the engine's socket or pipe can answer inbox items in the owner's name, including Security decisions and spec sign-off, which today need the owner's GitHub account. That includes agents with a shell on the PC (ADR 0026), and a pseudo-terminal gets past SR-3. The record marks each such answer `source: console` with the session's sign-in state. The risk ends when the project moves to `alpha` (sign-in every session by default) or the owner raises the setting. | Analyst (S2.1, S6.2, S8.5); Security and Testability Review #3 | Accepted risk (owner, 2026-11-14 10:28Z, decision card) |
| SR-5 | Private detail never leaves the PC: it is never written to `factory/state` or any repo, never sent to GitHub (bodies, comments, titles, labels, workflow dispatch), never in a model prompt, never in the engine log beyond the lines it was taken from. A test checks every GitHub request and every `factory/state` commit in the AC-6 run for the detail text. Private detail is passed through the secrets scan before it is stored, and any finding is replaced by "[secret removed by the engine]", so the console never shows a secret value. | Analyst (S3.1, S3.2, S9.4); owner rule 2026-11-12 (sensitive info never in a public repo); Security and Testability Review #4 | Approved (owner, 2026-11-14 10:29Z, decision card) |
| SR-6 | Local answer files (FR-10) and private detail files are created owner-only (as the engine folder, `ensureOwnerDir`), written atomically, read with a size limit and checked against their JSON Schemas; a file that fails is treated as missing. | Analyst (S1.1, S8.4); Security and Testability Review #5 | Approved (owner, 2026-11-14 10:29Z, decision card) |
| SR-7 | The issue comment for a console answer is a fixed text built from engine values and `actionWords` (already plain text); it starts with a word that is not a command (F-011 SR-17). Notes typed in the console are recorded in the record as today's `/changes` notes are, and are not posted to the issue. | Analyst (S1.2, S6.1) | Approved (owner, 2026-11-14 10:29Z, decision card) |
| SR-8 | A held project's console can only confirm the change if the owner signs in. Its session always needs a GitHub device sign-in as the owner pinned before the change (the same proof `factory-engine confirm` and the GitHub answer ask for), even at `rapid-prototype` and with `interview_sign_in: never`. A console confirm counts only when its record holds that signed-in session and the pinned owner's GitHub id. While held, the channel serves only the hold item and refuses everything else, so a held project starts no agent and opens no interview. | Analyst (S2.1, S8.5), F-007 SR-5 | Proposed |

## 10. Interface requirements
The change-controlled edits, one hygiene item each, applied with the build
after the owner approves their text:

| Id | File(s) | Change | Status |
|---|---|---|---|
| H-0245 | `docs/interface-contracts.md` (Engine control channel v1.6) | Replace "Inbox actions do **not** go through this channel" with: from v1.6 the owner can also answer inbox items here; the issue stays the record of what was asked. New methods: `inbox.open` (a console session per OQ-2, no feature lock), `inbox.close`, `inbox.list` (`{ session }` → `{ items: [{ id, kind, title, feature?, priority, blocking, rev }] }`), `inbox.show` (`{ session, item }` → `{ id, rev, kind, sections, private?, actions: [{ action, label }] }`), `inbox.answer` (`{ session, item, rev, action, note?, reply_id }` → `{ recorded: true }` or `{ confirm: { words, code, expires_at } }` or `{ already: { by: "github" \| "console" \| "engine", action? } }` or `{ changed: { rev } }`), `inbox.confirm` (`{ session, item, rev, code }` → `{ recorded: true }` or a refusal). Sessions per OQ-2. `activity` gains `waiting_for_decision` (FR-12). Adding methods is non-breaking. | Approved (owner, 2026-11-14 10:30Z, decision card; text in the thread's file f021/hygiene-text.md); applied |
| H-0246 | `docs/interface-contracts.md` (Inbox item, minor version on top of F-020's v4.0) | Owner history entries may have `source: console` with `console_answer` (sha256) and no comment, reaction or actor ids; `confirmed_by.source` may be `console`. New engine comment `Recorded from the console: <action>.` New optional Context line `More detail is on the PC that runs the factory: run factory-engine inbox <id> there.` Private detail and answer files (`inbox-private/1.0`, `console-answer/1.0`) live in the engine folder, never on `factory/state`. | Approved (owner, 2026-11-14 10:30Z, decision card; text in the thread's file f021/hygiene-text.md); applied |
| H-0247 | `docs/adr/0033-answer-inbox-items-in-the-console.md` (new), `docs/adr/README.md`, a note in ADR 0022 | Records the decision: the console is a second answer path for every inbox item, first answer wins, private detail stays on the PC. | Approved (owner, 2026-11-14 10:30Z, decision card; text in the thread's file f021/hygiene-text.md); applied |
| H-0251 | `docs/interface-contracts.md` (Engine control channel, `engine.status` row) | `activity` gains the build codes of FR-12 (v7): `waiting_on_dependency`, `developer_working`, `test_engineer_working`, `merging`, `resolving_conflicts`, `tests_running`, `classifying_failures`, `code_reviewing`, `validating`, `opening_pr`, `waiting_for_ci`, `pr_ready`, `build_stopped`, `merged`, `closed`; a building feature never reports `idle`. Non-breaking: clients ignore codes they don't know. | Approved (owner, 2026-11-15 04:46Z, decision card); applied |
| H-0252 | `README.md`, `engine/README.md` | Say that `factory-engine inbox` stays open with the factory's status when nothing waits (FR-2 v7). | Approved (owner, 2026-11-15 04:46Z, decision card); applied |
| H-0248 | `README.md`, `engine/README.md` | Describe `factory-engine inbox` and the console answers (FR-15). | Approved (owner, 2026-11-14 10:30Z, decision card; text in the thread's file f021/hygiene-text.md); applied |
| H-0277 | `docs/interface-contracts.md` (Engine control channel v1.10) | A project held for a pinned-key change keeps its channel and `engine.json`. `engine.status` returns `{ version, capabilities, uptime_s, features: [], held: { reason } }`; the `inbox.*` methods work as in v1.6, with `inbox.list` showing only the hold item, and `inbox.open` always asking for a sign-in; every other method returns the error -32010 `project_held`. The new capability `held` says an engine does this. Non-breaking: older clients see an engine with no features. | Proposed |

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit (A-1, A-2 approved)
- [x] Blocking decisions resolved (OQ-1, OQ-2 decided; SR-1 to SR-7 approved or accepted; H-0245 to H-0248 approved)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-14 | Draft from the owner's request (console as a second answer path, private detail in the console only) | — |
| 2 | 2026-11-14 | FR-12 and AC-11 from the owner's message 10:23Z (status says when a decision is pending; idle only with nothing pending); Security and Testability Review ([F-021-security-testability-review.md](F-021-security-testability-review.md)): 5 findings (0 Critical, 0 High, 3 Medium, 2 Low), none blocking, covered by SR-1, SR-2, SR-4 to SR-6 | — |
| 3 | 2026-11-14 | OQ-1 decided (a): both the new `inbox` command and the interview command (FR-2, FR-11 stand as written) | Owner, 2026-11-14 10:27Z (decision card) |
| 4 | 2026-11-14 | OQ-2 decided (a): console answers follow `settings.interview_sign_in`; FR-13 written out; SR-4 accepted risk | Owner, 2026-11-14 10:28Z (decision card) |
| 5 | 2026-11-14 | A-1, A-2, SR-1 to SR-3 and SR-5 to SR-7 approved as written; H-0245 names `inbox.open` and `inbox.close`; exact H-0245 to H-0248 text drafted | Owner, 2026-11-14 10:29Z (decision card) |
| 6 | 2026-11-14 | H-0245 to H-0248 approved as written; readiness gate passed (all six checks); spec signed off, status Approved | Owner, 2026-11-14 10:30Z and 10:31Z (decision cards) |
| 7 | 2026-11-15 | From the owner's request 04:37Z: the inbox console stays open with the factory's status when nothing waits (FR-2); build-stage activity codes, so a building feature is never shown as idle (FR-12); AC-15; H-0251, H-0252 | Owner, 2026-11-15 04:46Z (decision card) |
| 8 | 2026-11-20 | From the owner's request 18:20Z: the inbox and interview commands wait for the engine at start and reconnect after a restart, with a backoff countdown (FR-16, AC-16, AC-17; FR-14 and the edge case follow) | Owner, 2026-11-20 18:26Z (in thread: approved, also wait at start and also in the interview command) |
| 10 | 2026-11-25 | From the owner's card "Yes, serve held items": a project held for a pinned-key change serves a restricted channel so its hold item can be answered in the console, with a required sign-in as the pinned owner (FR-18, AC-19, SR-8, H-0277) | — |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Where does the console pose decisions? (a) **Both**: a new `factory-engine inbox` command for every open item, and the interview command shows the feature's waiting items when the interview has nothing for the owner (FR-11). (b) Only the new `inbox` command. (c) Only inside the interview command. **Recommended: (a)**: after an interview the decision appears where his attention already is, and any item, including ones with no interview behind them, can be answered from the terminal. | Product | Decided (owner, 2026-11-14 10:27Z, decision card): (a) both places |
| OQ-2 | Does answering in the console need a GitHub sign-in? (a) **Follow the project's existing sign-in setting** (`settings.interview_sign_in`, F-018 FR-15; at Rapid prototype that means none) for console answers too, so one setting covers the whole console, with SR-4's risk accepted until the setting asks for sign-in. (b) Always sign in for Security decisions and spec sign-off, whatever the setting; other items follow it. (c) Always sign in for every console answer. **Recommended: (a)**: same trust as interview answers, which already shape the spec, and no extra step at Rapid prototype; the risk ends when the project moves to Alpha or the setting is raised. | Security | Decided (owner, 2026-11-14 10:28Z, decision card): (a), SR-4 risk accepted |
