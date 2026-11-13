# Feature: Answer spec questions from Claude Code

- **Id:** F-005
- **Status:** Approved (readiness gate passed 2026-11-10; v10 passed 2026-11-13, ADR 0025)
- **Requested by / date:** Alex, 2026-11-10
- **Spec version:** 10

## 1. Objective and business purpose
The requirements analyst runs inside the engine, but the owner has no way to
answer its interview questions. This feature adds a skill to the
`software-factory` plugin that lets the owner hold that interview in a
Claude Code chat. The skill is a thin client: it carries the analyst's
questions to the owner and the owner's answers back to the engine, word for
word. Since v10 (ADR 0025) it does so through interview tools that the
engine's own `mcp` mode serves to Claude Code, which forward each call over
the Engine control channel. The analyst stays the only author of
questions and the engine keeps the record.

It covers interview questions only. Every approval the factory needs
(agent and skill edits, Architecture, Product, Security, and the rest) still
goes to the one inbox, labeled by category.

## 2. Expected behavior
1. The owner runs `/software-factory:spec-interview` in Claude Code, inside a
   repo or config repo that belongs to a running factory project.
2. The skill calls the plugin's interview tools, served by the engine's
   `mcp` mode, which finds the running engine through `.factory/engine.json`
   in the `factory/state` worktree and connects. If the engine isn't running, it
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
| FR-1 | The `software-factory` plugin ships the `spec-interview` skill and an MCP server entry (`.mcp.json`) that starts the engine's `mcp` subcommand as a stdio MCP server (ADR 0025). The MCP mode exposes each interview operation as a typed tool and forwards it as JSON-RPC 2.0 over the Engine control channel, using the engine's own framing and peer-check code. The Python client script is removed once the MCP mode passes this spec's acceptance tests. |
| FR-2 | The MCP mode reads the channel address only from `.factory/engine.json` in the `factory/state` linked worktree, checked with `git worktree list` the same way `onboard-repo` does. Any other location stops the run with a message to the owner. |
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
| FR-14 | The plugin declares a required `engine_path` setting (Claude Code plugin `userConfig`, type `file`) that Claude Code asks the owner for when the plugin is enabled and shows in `/config`. Its value is saved in the owner's own Claude Code settings, never in a repo. `.mcp.json` starts `node` with `${user_config.engine_path}` and `mcp` as arguments (OQ-5). If the setting is empty or the file isn't the engine, the plugin's MCP server fails to start and the skill tells the owner, in one sentence, to set `engine_path` in `/config`. |
| FR-15 | The MCP mode serves one tool per operation the client script has today, with the same inputs and results, including `display`: `interview_status`, `interview_start`, `interview_list`, `interview_open`, `interview_approval`, `interview_next`, `interview_reply`, `interview_state` and `interview_close`. Tool names, inputs and results are described in the skill. |
| FR-16 | The interview session token stays inside the MCP mode process. `interview_open` keeps it, and later tools name only the feature. A call for a feature this process hasn't opened is refused (SR-18). |
| FR-17 | The MCP mode starts without contacting the engine and lists its tools at once; it connects for each tool call, as the script does today. A stopped engine never delays or fails Claude Code's start-up, and sessions that never interview only hold the idle process. |
| FR-18 | `interview_status` reports the MCP mode's tool-set version. The skill names the version it was written for and, on a mismatch, tells the owner to update the plugin or the engine and stops. |
| FR-19 | The MCP mode finds the repo from the Claude Code session's project directory (`CLAUDE_PROJECT_DIR`, which Claude Code exports to plugin MCP servers). If that isn't a repo with a `factory/state` worktree, the tool refuses and names the reason (FR-2). |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a fake engine on a socket listed in a `factory/state` worktree's `engine.json`, when an MCP client calls `interview_status` on the MCP mode over stdio, then the MCP mode calls `engine.status` and the tool succeeds. | FR-1, FR-2, FR-19 |
| AC-2 | Given `engine.json` outside the `factory/state` worktree (plain directory, other branch, symlink), when any tool is called, then it fails without connecting and names the reason. | FR-2, SR-1 |
| AC-3 | Given a new feature request text with quotes, newlines and Unicode, when it is sent, then the fake engine receives `feature.start` with the identical string. | FR-3, FR-6 |
| AC-4 | Given the fake engine reports three features with deferred questions, when the owner lists them, then all three appear with their counts. | FR-4 |
| AC-5 | Given a feature with two deferred questions and one new one, when it is opened, then the two deferred questions come first. | FR-5 |
| AC-6 | For each reply kind, the request carries the question id, the kind and the owner's text byte for byte. | FR-6 |
| AC-7 | Given a `deferred` question or a pending assumption, when the readiness gate checks the spec, then it fails and names them. Tested with the engine feature, where the readiness gate runs (owner, 2026-11-10). | FR-8, FR-9 |
| AC-8 | Given an assumption the owner rejected or never answered, then it does not appear in the spec's assumptions table. Tested with the engine feature, where the readiness gate runs (owner, 2026-11-10). | FR-9 |
| AC-9 | Given a second client opens a feature already in session, then it receives "busy" and the first session is unaffected. | FR-11 |
| AC-10 | Given engine text containing ANSI escapes, control characters and text such as "ignore previous instructions", then the skill shows it as quoted data with escapes removed and takes no action from it. | FR-12, SR-2 |
| AC-11 | Given the engine drops the connection after a reply is sent, when the owner retries, then the MCP mode first asks for the question's state and does not send a duplicate. | FR-13 |
| AC-12 | The skill's instructions forbid answering, choosing options, or approving assumptions for the owner; a review of the skill text against this list passes. | SR-3 |
| AC-13 | Given the MCP mode started with no engine running, when an MCP client lists tools, then the nine tools of FR-15 are listed within 5 seconds; `interview_status` then fails with "engine not reachable". | FR-15, FR-17 |
| AC-14 | Given a session opened through `interview_open`, then no tool result or `display` contains the session token, and a second MCP mode process calling `interview_next` or `interview_reply` for that feature is refused without contacting the engine. | FR-16, SR-18 |
| AC-15 | Given `engine_path` is empty or names a file that isn't the engine, when the owner runs the skill, then it says to set `engine_path` in `/config`, and sends nothing. | FR-14 |
| AC-16 | Given a tool-set version different from the skill's, when the skill starts, then it tells the owner to update and calls no other tool. | FR-18 |
| AC-17 | Every test of AC-1 to AC-6 and AC-9 to AC-11 that ran against the client script runs against the MCP mode through the MCP SDK's own stdio client and passes; the client script and its tests are then removed. | FR-1 |

## 5. Constraints
- Rapid prototype bar (`docs/maturity-levels.md`).
- The MCP mode is part of the engine (TypeScript, the engine's build and
  Node version). Its only new dependency is `@modelcontextprotocol/sdk`,
  pinned exactly after an S4.1 review (H-0174); only its stdio server
  transport is used (ADR 0025). Unix socket on macOS and Linux, named pipe
  on Windows. The `onboard-repo` skill's Python checker is not affected.
- The MCP mode is tested against a fake engine that implements the channel
  contract, as the client was, and end to end with the real engine.
- Interview methods are added to the Engine control channel as v1.1, which
  is an Interfaces change for owner approval through the inbox.

## 6. Edge cases
- Engine not running, `engine.json` stale, or the socket file left behind by
  a crash: the skill says the engine isn't reachable and stops.
- Claude Code started outside a factory repo: the plugin's MCP server still
  starts (FR-17); its tools refuse with the FR-19 reason.
- The owner updates the plugin but not the engine, or the other way round:
  FR-18 stops the skill with what to update.
- Claude calls an interview tool outside the skill (the plugin's tools are
  loaded in every session). Claude Code's normal permission prompt applies;
  without an `interview_open` in that session nothing can be replied to
  (FR-16), and opening needs the owner's GitHub device approval (SR-5).
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
- Engine (ADR 0001, ADR 0003), built in F-007; its `mcp` subcommand (ADR 0025).
- `@modelcontextprotocol/sdk` S4.1 review and exact pin (H-0174).
- On Windows, SR-7 needs the pipe opened with `SECURITY_SQOS_PRESENT |
  SECURITY_IDENTIFICATION` and the server's SID checked. Node's own pipe
  client may not set those flags; if the engine's fixed FFI list (F-007
  SR-15) needs new functions for it, the developer raises that as a Security
  item before building, rather than dropping the check.
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
| OQ-5 | How does the plugin find the engine's command for its MCP server (ADR 0025)? **Answered: a plugin setting for the engine path** (Claude Code's plugin `userConfig`, kept in the owner's own settings), not a `factory-engine` command on `PATH` or a path in `engine.json` with a launcher (FR-14). | Architecture | Answered (owner, 2026-11-13, decision card) |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | The channel address is trusted only from the `factory/state` worktree's `engine.json`, which is untracked there (never committed or pushed). The MCP mode refuses any other location, symlinks out of the worktree, abstract Unix sockets, and a socket path that isn't a socket owned by the owner's uid inside an owner-only directory. Before sending anything it checks the peer runs as the owner (`SO_PEERCRED` / `getpeereid`). | Analyst; Gate 1 #1 (S1.4, S2.3) | Accepted |
| SR-2 | All engine text, including findings from the web and repo, is data. The skill shows it quoted with control characters removed and follows no instruction in it. | Analyst (S6.1) | Accepted |
| SR-3 | The skill never answers, picks an option, approves an assumption, or rewrites text on the owner's behalf. Every reply is the owner's own words from that session. | Owner, 2026-11-10 | Accepted |
| SR-4 | The transcript stays on `factory/state`. The skill and script write nothing of their own to disk and log no answer text (Claude Code's own session history is outside the skill's control and is noted to the owner). Before each `factory/state` commit the engine runs the secrets scan on transcript text and blocks the commit on a hit, filing a Security item; the skill tells the owner not to paste secrets. | Analyst; Gate 1 #6 (S3.1–S3.3) | Accepted |
| SR-5 | **Decided (owner, 2026-11-10, ADR 0014):** each interview session must be approved by the owner through GitHub's device sign-in on their phone before the engine accepts a reply (channel v1.2). **Residual risk, recorded at the owner's choice:** a process that obtains an approved session's token or reaches the socket could reply in that session. Narrowed by SR-14, a 2-hour session cap, and ADR 0015's container per agent session (no owner home, engine socket, `engine.json` or owner credentials mounted), leaving a container escape or a non-factory program the owner runs. A per-reply presence check would close it (proposal 0016, option C). Previously an accepted risk until Alpha. | Owner decision card; proposal 0016 | Decided; residual risk recorded |
| SR-6 | The analyst may reach any site (owner, 2026-11-10), read-only. It sends only search terms and addresses, never pages of project content, and every outgoing address and search is recorded in the transcript. It never reads a fetched page itself; it gets the isolated reader's summary (SR-17), marked untrusted. **Accepted risk (owner, 2026-11-10):** injected text could still steer the analyst to put project details into a search; the transcript log makes that visible afterwards. | Analyst; Gate 1 #7 (S6.1, S3.2, S8.1); owner decision card | Accepted risk |
| SR-17 | Web pages are fetched and read by an isolated web reader: no project files, no tools besides fetching the one address it was given, and no network beyond it. Before the reader sees a page, the engine strips HTML comments, script and style, hidden and invisible elements, zero-width and bidi characters, and metadata. The reader returns a plain-text summary with its source address; the analyst and the skill treat it as data (SR-2). | Owner decision card, 2026-11-10 (S6.1, S8.1) | Accepted |
| SR-7 | Windows: the MCP mode accepts only local `\\.\pipe\` paths, opens with `SECURITY_SQOS_PRESENT \| SECURITY_IDENTIFICATION`, and checks the server's SID is the owner's. The engine creates the pipe with `FILE_FLAG_FIRST_PIPE_INSTANCE`, an unguessable name, and an owner-only ACL. | Gate 1 #2 (S1.4, S8.4, S2.3) | Accepted |
| SR-8 | The engine creates the Unix socket with mode 0600 in an owner-only directory and accepts only peers with the owner's uid (SID on Windows). This is part of Engine control channel v1.1. | Gate 1 #3 (S2.1–S2.3) | Accepted |
| SR-9 | No owner text, engine text or id ever goes through a shell or onto a command line. Claude passes them as typed MCP tool arguments over stdio; the MCP mode's command line holds only the fixed arguments in the plugin's `.mcp.json`. Feature and item ids must match `^[A-Za-z0-9_-]{1,64}$` or the tool refuses. | Gate 1 #4 (S1.3, S1.2); reworded for ADR 0025 (v10) | Accepted (v10 wording approved by the owner, 2026-11-13, decision card) |
| SR-10 | The skill's instructions allow only the plugin's interview tools and Claude Code's question picker. A reply is sent only from the owner's own input in that turn. Each item carries a revision, and the engine rejects a reply to a revision the owner wasn't shown. Displayed text has bidi and zero-width characters removed as well as control characters. | Gate 1 #5 (S6.1, S6.2) | Accepted |
| SR-11 | Only the engine writes `.factory/interviews/**`; the transcript is append-only. The readiness gate checks every assumption marked approved in the spec against an `approve_assumption` entry in the transcript and fails on any mismatch. | Gate 1 #9 (S2.1, S6.2, S8.1) | Accepted |
| SR-12 | Each reply carries a client-generated reply id and the item revision; the engine records a reply id once and ignores repeats. The session lock is bound to the connection; replies from any other connection are rejected. | Gate 1 #10 (S1.1, S5.1) | Accepted |
| SR-13 | The lock is released when its connection closes or after 30 minutes idle, and the owner can take over a held lock after confirming in the skill. | Gate 1 #11 (S5.1) | Accepted |
| SR-14 | Role policy denies every role reads of `.factory/engine.json`; the engine refuses channel connections from agent processes it started. | Gate 1 #13 (S6.2, S8.1) | Accepted |
| SR-15 | `more_info` research counts against the project budget (ADR 0012) and stops at a per-question cap, telling the owner. The MCP mode limits responses to 1 MiB and times out after 60 s per call, plus the `wait_s` it asks `interview.next` to wait for research (channel v1.1, H-0025), and every tool returns within 150 s. | Gate 1 #12 (S5.1, S1.1) | Accepted |
| SR-16 | The MCP mode shows JSON-RPC errors by code and message only, never the `data` field except a well-formed `busy` `data.started_at` (H-0026), and never echoes the owner's reply text in an error. | Gate 1 #14 (S5.2, S3.1) | Accepted |
| SR-18 | The session token never leaves the MCP mode process: no tool result, `display` or error carries it, and each process accepts `next`, `reply` and `close` only for features it opened itself. Another Claude Code session, or a tool call in this one made before `interview_open`, can't reply in the owner's approved session. | Analyst, v10 (S1.1, S6.2) | Approved (owner, 2026-11-13, decision card) |
| SR-19 | `@modelcontextprotocol/sdk` is pinned exactly in the engine's lockfile after an S4.1 review (H-0174). Only the stdio server transport is imported; the MCP mode opens no network port. | ADR 0025 (S4.1) | Approved (owner, 2026-11-13, decision card) |
| SR-20 | Only `interview_status`, `interview_list` and `interview_state` carry the MCP `readOnlyHint` annotation. No tool carries `idempotentHint`, so Claude Code never repeats a `start` or `reply` on its own after a lost connection (code.claude.com/docs/en/mcp, "Mark tools that are safe to call twice"); FR-13 governs retries. | Analyst, v10 (S5.1) | Approved (owner, 2026-11-13, decision card) |

## 10. Interface requirements
Approved by the owner as drafted, 2026-11-10 (decision card):
- **H-0022, Engine control channel v1.1** (Interfaces, non-breaking): the
  `interview.list`, `interview.next`, `interview.reply`, `interview.state`
  and `interview.close` methods, the `Item` shape with revisions, reply ids,
  the per-feature session lock, the `interview.itemReady` notification, and
  owner-only access on both ends (SR-7, SR-8, SR-10 to SR-13).
- **H-0023, Role policy v2.2** (Security, loosening approved in substance as
  OQ-2 and OQ-4): the `Skill` tool for the requirements analyst; the optional
  `web-reader` role with `WebFetch` and `WebSearch` only, no reads, and any
  host (`"*"`), which the validator allows only for a role with no file tools
  (SR-17); every role denied `.factory/engine.json` (SR-14). Other features'
  specs and transcripts and advisor escalation are engine-mediated, so no new
  read globs. Checker, template and tests updated with it.
- **H-0024, agent files:** the requirements analyst's AGENT.md (answer, more
  information or defer; assumptions approved in the interview with the
  transcript as record; web only through the web reader; no escalation
  before F-006) and a new `agents/web-reader/AGENT.md`.

For v10 (ADR 0025). The Engine control channel, Role policy and the
analyst's Interview tools are unchanged. Change-controlled work, each for
owner approval when drafted during development:
- **H-0174:** S4.1 review of `@modelcontextprotocol/sdk` and its exact pin
  in the engine (SR-19).
- **H-0175:** the engine's `mcp` subcommand (FR-1, FR-15 to FR-19), and the
  engine README's command line.
- **H-0176:** the plugin's `.mcp.json` and any `plugin.json` setting OQ-5
  needs, the `spec-interview` skill rewritten for the tools (FR-14, FR-18,
  SR-10), and the plugin version bump.
- **H-0177:** the acceptance tests moved to the MCP mode (AC-17), the client
  script and its tests removed, and `.github/workflows/plugin-tests.yml` and
  the engine CI updated to match.

The MCP tool set is the interface between the plugin's skill and the engine
build. It is versioned (FR-18) and described in the skill, not added to
`docs/interface-contracts.md`, because both ends ship from this repo.

## 11. Readiness gate
- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit (none)
- [x] Blocking decisions resolved (OQ-1 to OQ-4 answered; H-0022, H-0023, H-0024 approved)

v10:
- [x] OQ-5 answered (plugin setting)
- [x] SR-9 v10 wording and SR-18 to SR-20 approved by the owner
- [x] Owner approves v10 as a whole (2026-11-13, decision card)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-10 | Draft from the owner interview (scope interview-only, new and existing features, answer / more information / defer, assumptions approved in the interview, web and shared skills for context, advisor as F-006, deferred list, accepted socket risk) | — |
| 2 | 2026-11-10 | Security Gate 1 findings folded in (SR-1, SR-4, SR-6 tightened; SR-7 to SR-16 added; OQ-4 added; channel v1.1 gains access control, reply ids and revisions) | — |
| 3 | 2026-11-10 | Owner answers: OQ-1 transcript is the record, OQ-3 no escalation before F-006, OQ-4 all widenings approved, OQ-2 any site | Owner, 2026-11-10 (thread) |
| 4 | 2026-11-10 | OQ-2: web via isolated reader with stripping and logging, residual risk accepted (SR-6, SR-17) | Owner, 2026-11-10 (decision card) |
| 5 | 2026-11-10 | H-0022 (channel v1.1), H-0023 (Role policy v2.2), H-0024 (agent files) approved; readiness gate passed | Owner, 2026-11-10 (decision card) |
| 6 | 2026-11-10 | Channel v1.1 amended by H-0025: sessions by token (`interview.open`, takeover, `wait_s`), line framing, `engine.json` format, error codes. FR-11 and SR-12/SR-13 now read against the session token, not the connection | Owner, 2026-11-10 (decision card) |
| 7 | 2026-11-10 | Wording only, to match approved channel v1.1 (FR-1, SR-15); no requirement changed | — (wording) |
| 8 | 2026-11-10 | H-0026 (channel details) and H-0027 (readiness-gate interview rules, web reader in the role docs) approved; AC-7 and AC-8 tests move to the engine feature | Owner, 2026-11-10 (decision card) |
| 9 | 2026-11-10 | Wording only: SR-16 names the `busy` exception H-0026 approved | — (wording) |
| 10 | 2026-11-13 | For ADR 0025: interview tools from the engine's `mcp` mode instead of the Python client (FR-1, FR-2, FR-14 to FR-19, AC-1, AC-2, AC-11, AC-13 to AC-17, constraints, edge cases, dependencies, SR-9 reworded, SR-18 to SR-20, OQ-5, H-0174 to H-0177) | — (draft) |
| 10.1 | 2026-11-13 | OQ-5: the plugin finds the engine through a required `engine_path` plugin setting (FR-14, AC-15) | Owner, 2026-11-13 (decision card) |
| 10.2 | 2026-11-13 | SR-9 v10 wording and SR-18 to SR-20 approved as written | Owner, 2026-11-13 (decision card) |
| 10.3 | 2026-11-13 | v10 approved as a whole; readiness gate passed; development (H-0174 to H-0177) may start | Owner, 2026-11-13 (decision card) |
| 10.4 | 2026-11-13 | H-0174 (SDK review, three conditions) approved; H-0175 to H-0177 approved as built in PR #56 | Owner, 2026-11-13 (decision cards) |
| 10.5 | 2026-11-13 | Security: the engine's FFI list gains `CreateFileW` and `GetNamedPipeServerProcessId` for the MCP mode's pipe client (SR-7), approved on condition of a real Windows run; met by `test/mcp-pipe.test.ts` on the windows-latest CI runners | Owner, 2026-11-13 (decision card) |
