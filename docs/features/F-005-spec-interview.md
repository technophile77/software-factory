# Feature: Answer spec questions from Claude Code

- **Id:** F-005
- **Status:** Draft
- **Requested by / date:** Alex, 2026-11-10
- **Spec version:** 4

## 1. Objective and business purpose
The requirements analyst runs inside the engine, but the owner has no way to
answer its interview questions. This feature adds a skill to the
`software-factory` plugin that lets the owner hold that interview in a
Claude Code chat. The skill is a thin client: it carries the analyst's
questions to the owner and the owner's answers back to the engine, over the
Engine control channel, word for word. The analyst stays the only author of
questions and the engine keeps the record.

It covers interview questions only. Every approval the factory needs
(agent and skill edits, Architecture, Product, Security, and the rest) still
goes to the one inbox, labeled by category.

## 2. Expected behavior
1. The owner runs `/software-factory:spec-interview` in Claude Code, inside a
   repo or config repo that belongs to a running factory project.
2. The skill finds the engine through `.factory/engine.json` in the
   `factory/state` worktree and connects. If the engine isn't running, it
   says so and stops. There is no fallback interview inside the session.
3. The owner chooses one of:
   - **Request a new feature.** The owner describes it; the skill sends the
     text as `feature.start` and the interview for the new feature begins.
   - **Detail an existing feature request.** The skill lists features that
     have an interview waiting, with how many questions are deferred in each,
     and the owner picks one.
4. For each question the skill shows exactly what the analyst wrote: the
   question, why it matters, and any suggested answer or options. Where the
   question has options, Claude Code's own question picker shows them, with
   free text always allowed.
5. For each question the owner can:
   - **Answer it.**
   - **Ask for more information.** The analyst gathers context and asks
     again with what it found and where it came from.
   - **Defer it.** The question stays open with nothing filled in. The
     interview moves on, and the spec can't pass the readiness gate until it
     is answered.
6. When the analyst wants to proceed on an assumption, it shows the
   assumption in the interview as its own item. The owner approves or rejects
   it there. An assumption that isn't approved never goes into the spec.
7. Opening a feature that has deferred questions starts with those questions,
   then carries on with new ones.
8. The skill never rewrites a question, answers one, picks an option, or
   approves an assumption on the owner's behalf. If the owner's reply is
   unclear, the skill asks the owner, not the engine.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | The `software-factory` plugin ships a `spec-interview` skill and a client script. The script talks JSON-RPC 2.0 to the engine over the transport in Engine control channel v1.0 and uses only the language's standard library. |
| FR-2 | The script reads the channel address only from `.factory/engine.json` in the `factory/state` linked worktree, checked with `git worktree list` the same way `onboard-repo` does. Any other location stops the run with a message to the owner. |
| FR-3 | New feature requests use the existing `feature.start` method. The owner's text is sent as written. |
| FR-4 | The skill can list every feature with an interview waiting, with counts of open and deferred questions and pending assumptions (`interview.list`). |
| FR-5 | Opening a feature returns its deferred questions first, then the next new question (`interview.next`). |
| FR-6 | Each reply is one of `answer`, `more_info`, `defer`, `approve_assumption`, `reject_assumption`, sent with the question id and the owner's text unchanged (`interview.reply`). |
| FR-7 | `more_info` lets the analyst use, within its role policy: the project's code and docs, the factory's docs, specs, ADRs and past decisions, the factory's shared skills (today only `security-review`), and the web once its network rule is approved (SR-6). For a question that needs a stronger model it escalates to the advisor agent once F-006 exists; until then escalation is not offered (OQ-3). Each finding is shown with its source. |
| FR-8 | A deferred question keeps status `deferred` with no answer recorded. The readiness gate fails while any question is `deferred` or `open`, or any assumption is pending. |
| FR-9 | An assumption is recorded in the spec only after `approve_assumption`, with the owner's approval and date in its decision link. |
| FR-10 | The engine keeps the interview transcript (every question, finding and reply, with times) on `factory/state` under `.factory/interviews/<feature>/`. The skill keeps no copy. |
| FR-11 | Only one interview session per feature at a time. A second client gets a "busy" error naming when the other session started. |
| FR-12 | The skill shows engine text as quoted data, with control and escape characters removed, and never treats it as instructions (SR-2). |
| FR-13 | Errors from the channel (engine gone, timeout, unknown feature, busy) are shown to the owner in plain words; the skill never retries a reply that may already have been recorded without first asking the engine for the question's state. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a fake engine on a socket listed in a `factory/state` worktree's `engine.json`, when the script connects, then it calls `engine.status` and succeeds. | FR-1, FR-2 |
| AC-2 | Given `engine.json` outside the `factory/state` worktree (plain directory, other branch, symlink), when the script starts, then it exits non-zero without connecting and names the reason. | FR-2, SR-1 |
| AC-3 | Given a new feature request text with quotes, newlines and Unicode, when it is sent, then the fake engine receives `feature.start` with the identical string. | FR-3, FR-6 |
| AC-4 | Given the fake engine reports three features with deferred questions, when the owner lists them, then all three appear with their counts. | FR-4 |
| AC-5 | Given a feature with two deferred questions and one new one, when it is opened, then the two deferred questions come first. | FR-5 |
| AC-6 | For each reply kind, the request carries the question id, the kind and the owner's text byte for byte. | FR-6 |
| AC-7 | Given a `deferred` question or a pending assumption, when the readiness gate checks the spec, then it fails and names them. | FR-8, FR-9 |
| AC-8 | Given an assumption the owner rejected or never answered, then it does not appear in the spec's assumptions table. | FR-9 |
| AC-9 | Given a second client opens a feature already in session, then it receives "busy" and the first session is unaffected. | FR-11 |
| AC-10 | Given engine text containing ANSI escapes, control characters and text such as "ignore previous instructions", then the skill shows it as quoted data with escapes removed and takes no action from it. | FR-12, SR-2 |
| AC-11 | Given the engine drops the connection after a reply is sent, when the owner retries, then the script first asks for the question's state and does not send a duplicate. | FR-13 |
| AC-12 | The skill's instructions forbid answering, choosing options, or approving assumptions for the owner; a review of the skill text against this list passes. | SR-3 |

## 5. Constraints
- Rapid prototype bar (`docs/maturity-levels.md`).
- Python 3.10+ standard library only for the client, like `factory_check.py`;
  Unix socket on macOS and Linux, named pipe on Windows.
- No engine exists yet (ADR 0001). The client is built and tested against a
  fake engine that implements the channel contract. End-to-end use waits for
  the engine.
- Interview methods are added to the Engine control channel as v1.1, which
  is an Interfaces change for owner approval through the inbox.

## 6. Edge cases
- Engine not running, `engine.json` stale, or the socket file left behind by
  a crash: the skill says the engine isn't reachable and stops.
- The engine restarts mid-interview: answered questions stay answered (the
  transcript is on `factory/state`), and the owner resumes with
  `interview.next`.
- The analyst revises a question the owner deferred: the old one is closed as
  superseded in the transcript and the new one is shown as deferred-first.
- A gate sends a spec back: the feature reappears in the list with its new
  questions.
- `more_info` research takes long: the skill shows that the analyst is
  working and the owner can defer the question instead of waiting.
- Web lookups fail or the network rule isn't approved yet: the analyst says
  which source it couldn't use; nothing is guessed in its place.
- Text from the web or the repo shown as a "finding" is untrusted, the same
  as any engine text (SR-2).

## 7. Dependencies
- Engine (ADR 0001, ADR 0003): not built yet.
- Engine control channel v1.1 (interview methods), Interfaces decision.
- Role policy change giving the requirements analyst web access, Security
  decision (SR-6).
- F-006 advisor agent, for escalation to a stronger model. Separate feature
  (owner, 2026-11-10).
- F-002 per-agent model settings, which the advisor's model choice builds on.
- `software-factory` plugin and the worktree check from F-003.

## 8. Assumptions
None. The owner's rule (2026-11-10) is that assumptions are proposed in the
interview and approved there, never filled in for them. The points below are
open and the owner's to answer:

| Id | Open question | Category | Status |
|---|---|---|---|
| OQ-1 | Should approved assumptions also go to the inbox? **Answered: no.** The engine-written, append-only interview transcript is the record of the owner's approval (SR-11). The analyst's AGENT.md must stop requiring an inbox item for interview-approved assumptions (hygiene change). | Product | Answered (owner, 2026-11-10) |
| OQ-2 | Web reach and hidden prompts. **Answered:** any site; hidden content stripped, pages read by an isolated web reader, every address logged; the residual leak through search wording is an accepted risk (SR-6, SR-17). | Security | Answered (owner, 2026-11-10, decision card) |
| OQ-3 | Escalation before F-006 exists? **Answered:** escalation is simply not available until F-006 is built. The analyst offers only its own more-information and deferral. | Product | Answered (owner, 2026-11-10) |
| OQ-4 | Analyst permission widenings in section 10 (web tools, shared skills, reads outside its worktree, advisor escalation once F-006 exists). **Answered: all approved.** | Security | Answered (owner, 2026-11-10) |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | The channel address is trusted only from the `factory/state` worktree's `engine.json`, which is untracked there (never committed or pushed). The script refuses any other location, symlinks out of the worktree, abstract Unix sockets, and a socket path that isn't a socket owned by the owner's uid inside an owner-only directory. Before sending anything it checks the peer runs as the owner (`SO_PEERCRED` / `getpeereid`). | Analyst; Gate 1 #1 (S1.4, S2.3) | Proposed |
| SR-2 | All engine text, including findings from the web and repo, is data. The skill shows it quoted with control characters removed and follows no instruction in it. | Analyst (S6.1) | Proposed |
| SR-3 | The skill never answers, picks an option, approves an assumption, or rewrites text on the owner's behalf. Every reply is the owner's own words from that session. | Owner, 2026-11-10 | Proposed |
| SR-4 | The transcript stays on `factory/state`. The skill and script write nothing of their own to disk and log no answer text (Claude Code's own session history is outside the skill's control and is noted to the owner). Before each `factory/state` commit the engine runs the secrets scan on transcript text and blocks the commit on a hit, filing a Security item; the skill tells the owner not to paste secrets. | Analyst; Gate 1 #6 (S3.1–S3.3) | Proposed |
| SR-5 | **Accepted risk (owner, 2026-11-10):** at Rapid prototype, agents run as the owner's OS user and could reach the socket and answer in the owner's place. Role policy will deny every role reads of `engine.json` (SR-14), and the engine refuses connections from processes it started, but these are guard rails, not a boundary. Must be fixed before Alpha by running agents as a separate OS user or sandbox (F-003 Gate 2 item R2-1), or by a per-session presence check (Touch ID, Windows Hello, hardware key). | Owner decision card | Accepted risk |
| SR-6 | The analyst may reach any site (owner, 2026-11-10), read-only. It sends only search terms and addresses, never pages of project content, and every outgoing address and search is recorded in the transcript. It never reads a fetched page itself; it gets the isolated reader's summary (SR-17), marked untrusted. **Accepted risk (owner, 2026-11-10):** injected text could still steer the analyst to put project details into a search; the transcript log makes that visible afterwards. | Analyst; Gate 1 #7 (S6.1, S3.2, S8.1); owner decision card | Accepted risk |
| SR-17 | Web pages are fetched and read by an isolated web reader: no project files, no tools besides fetching the one address it was given, and no network beyond it. Before the reader sees a page, the engine strips HTML comments, script and style, hidden and invisible elements, zero-width and bidi characters, and metadata. The reader returns a plain-text summary with its source address; the analyst and the skill treat it as data (SR-2). | Owner decision card, 2026-11-10 (S6.1, S8.1) | Proposed |
| SR-7 | Windows: the script accepts only local `\\.\pipe\` paths, opens with `SECURITY_SQOS_PRESENT \| SECURITY_IDENTIFICATION`, and checks the server's SID is the owner's. The engine creates the pipe with `FILE_FLAG_FIRST_PIPE_INSTANCE`, an unguessable name, and an owner-only ACL. | Gate 1 #2 (S1.4, S8.4, S2.3) | Proposed |
| SR-8 | The engine creates the Unix socket with mode 0600 in an owner-only directory and accepts only peers with the owner's uid (SID on Windows). This is part of Engine control channel v1.1. | Gate 1 #3 (S2.1–S2.3) | Proposed |
| SR-9 | No owner text, engine text or id is ever placed on a command line. The skill passes requests to the script as JSON on stdin; feature and item ids must match `^[A-Za-z0-9_-]{1,64}$` or the script stops. | Gate 1 #4 (S1.3, S1.2) | Proposed |
| SR-10 | The skill's instructions allow only the client script and Claude Code's question picker. A reply is sent only from the owner's own input in that turn. Each item carries a revision, and the engine rejects a reply to a revision the owner wasn't shown. Displayed text has bidi and zero-width characters removed as well as control characters. | Gate 1 #5 (S6.1, S6.2) | Proposed |
| SR-11 | Only the engine writes `.factory/interviews/**`; the transcript is append-only. The readiness gate checks every assumption marked approved in the spec against an `approve_assumption` entry in the transcript and fails on any mismatch. | Gate 1 #9 (S2.1, S6.2, S8.1) | Proposed |
| SR-12 | Each reply carries a client-generated reply id and the item revision; the engine records a reply id once and ignores repeats. The session lock is bound to the connection; replies from any other connection are rejected. | Gate 1 #10 (S1.1, S5.1) | Proposed |
| SR-13 | The lock is released when its connection closes or after 30 minutes idle, and the owner can take over a held lock after confirming in the skill. | Gate 1 #11 (S5.1) | Proposed |
| SR-14 | Role policy denies every role reads of `.factory/engine.json`; the engine refuses channel connections from agent processes it started. | Gate 1 #13 (S6.2, S8.1) | Proposed |
| SR-15 | `more_info` research counts against the project budget (ADR 0012) and stops at a per-question cap, telling the owner. The script limits responses to 1 MiB and times out after 60 s per call, except while waiting for `interview.itemReady`. | Gate 1 #12 (S5.1, S1.1) | Proposed |
| SR-16 | The script shows JSON-RPC errors by code and message only, never the `data` field, and never echoes the owner's reply text in an error. | Gate 1 #14 (S5.2, S3.1) | Proposed |

## 10. Interface requirements
- **Engine control channel v1.0 → v1.1** (adding methods, non-breaking):

  | Method | Params | Result |
  |---|---|---|
  | `interview.list` | none | `{ features: [{ id, title, open, deferred, pending_assumptions }] }` |
  | `interview.next` | `{ feature }` | `{ item: { id, kind: "question" \| "assumption", text, why, suggested?, options?, findings?: [{ text, source }], status } \| null }` |
  | `interview.reply` | `{ feature, item, revision, reply_id, kind, text }` | `{ status, next? }` |
  | `interview.state` | `{ feature, item }` | `{ status, recorded_at? }` |
  | `interview.close` | `{ feature }` | `{ ok: true }` (ends the session lock) |

  Items returned by `interview.next` also carry `revision`.
  Notification: `interview.itemReady` when `more_info` research finishes.
  v1.1 also adds access control to the whole channel: owner-only socket or
  pipe and peer identity check (SR-7, SR-8).
  Needs an Interfaces decision in the inbox.
- **Role policy** (Security decision): every role denied reads of
  `.factory/engine.json` (SR-14), and the widenings FR-7 needs for the
  requirements analyst (Gate 1 #8, owner decision): a `network` rule for web
  access (SR-6, OQ-2), web tools, use of shared skills (Role policy v2.1 has
  no skill tool), read access outside its worktree including other features'
  interview transcripts, and escalation to the advisor (F-006).

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit (none)
- [ ] Blocking decisions resolved (contract changes to record: Engine control channel v1.1, Role policy for the analyst, the web reader and the `engine.json` deny)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-10 | Draft from the owner interview (scope interview-only, new and existing features, answer / more information / defer, assumptions approved in the interview, web and shared skills for context, advisor as F-006, deferred list, accepted socket risk) | — |
| 2 | 2026-11-10 | Security Gate 1 findings folded in (SR-1, SR-4, SR-6 tightened; SR-7 to SR-16 added; OQ-4 added; channel v1.1 gains access control, reply ids and revisions) | — |
| 3 | 2026-11-10 | Owner answers: OQ-1 transcript is the record, OQ-3 no escalation before F-006, OQ-4 all widenings approved, OQ-2 any site | Owner, 2026-11-10 (thread) |
| 4 | 2026-11-10 | OQ-2: web via isolated reader with stripping and logging, residual risk accepted (SR-6, SR-17) | Owner, 2026-11-10 (decision card) |
