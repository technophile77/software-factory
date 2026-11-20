# Feature: Windowed console with an agent transcript

- **Id:** F-024
- **Status:** In development (approved: owner sign-off 2026-11-20 18:58Z, decision card; readiness gate passed on v1)
- **Requested by / date:** Alex, 2026-11-20 ("add a -v (verbose) option to
  the inbox that will show the current session transcript"; "organized into
  different view sections using ascii art to define 'windows' ... detect the
  terminal type and size ... updates when the window is resized. The
  transcript should be one of the windows"; "if multiple agents are running
  ... I want to be able to select which one to view")
- **Spec version:** 1
- **Depends on:** F-018 (`factory-engine interview`), F-021 (`factory-engine
  inbox`, console answers, reconnect FR-16, interview questions in the
  inbox FR-17)

## 1. Objective and business purpose

The console is the owner's preferred way to work with the factory (owner,
2026-11-14). Today it prints one line after another, so status, items and
questions scroll past each other, and there is no way to see what an agent
is actually doing. This feature gives both console commands a full-screen
layout of tabbed windows, and lets the owner follow one running agent's
messages and tool calls live.

## 2. Expected behavior

`factory-engine inbox` and `factory-engine interview` open a full-screen
console. A title line at the top shows the project, the engine connection
and a summary ("2 features running, 1 item waiting"). Below it is a row of
tabs, the selected tab's window, and at the bottom an answer bar with the
current prompt and key hints.

The windows (owner, 2026-11-20 18:56Z):

1. **Status**: one row per feature: project, feature, stage, what it is
   doing and for how long.
2. **Inbox**: items and interview questions waiting for the owner, blocking
   first. Enter opens one; it is shown whole and answered in the answer bar.
3. **Agents**: each running agent session: feature, role, how long it has
   run, and its spend when the engine knows it. Up and Down select one;
   the selected agent is the one the Transcript shows.
4. **Transcript**: only when switched on, with `-v` or from inside the
   console. The selected agent's messages and tool calls, live, scrollable.
5. **Log**: what happened, with times: stage changes, items opened and
   answered, pull requests, reconnects, errors.
6. **Answer bar**: always visible; it asks, the owner types or picks.

`--plain` gives today's line-by-line output instead, for both commands.

## 3. Functional requirements

| Id | Requirement |
|---|---|
| FR-1 | **Windowed by default.** Both `factory-engine inbox` and `factory-engine interview` open the windowed console unless given `--plain`, which keeps today's line-by-line behaviour exactly (F-018, F-021). Both refuse unless stdin and stdout are terminals, as now (F-018 SR-3). |
| FR-2 | **Layout.** Title line (project, engine state, summary), tab row, the selected window, answer bar. Tabs are switched with Tab and Shift+Tab, or the number keys 1 to 5 while no text is being typed. Each tab shows a count when it has something new (for example "Inbox (2)"). |
| FR-3 | **Terminal size and type.** The layout uses the terminal's columns and rows and redraws when the terminal is resized. Borders use box-drawing characters where the terminal can draw them (Windows Terminal, and any terminal on macOS or Linux) and plain ASCII (`+`, `-`, `\|`) in the old Windows console, as the console decides today. Below 60 columns or 16 rows the screen says "Make the window at least 60 by 16" and keeps everything it receives until the window is large enough; nothing is answered or lost meanwhile. |
| FR-4 | **Status window.** One row per feature from `engine.status`, with the activity words of F-018 FR-14 and F-021 FR-12, refreshed every 5 seconds. |
| FR-5 | **Inbox window.** The project's open inbox items (F-021 FR-2 order) and the features whose analyst waits for the owner's answer (F-021 FR-17). Enter on an item shows it whole in the window and offers its actions in the answer bar (F-021 FR-3 to FR-8: notes, confirm codes and lost-answer handling unchanged). Enter on a question opens that feature's interview and shows each waiting item as F-018 does. |
| FR-6 | **Agents window.** One row per running agent session of the project: feature, role, run time, and spend when the engine reports it. Up and Down move the selection; the selected agent stays selected until it ends or the owner picks another. When it ends, its row reads "ended" for 60 seconds and the selection stays on it, so its last lines can still be read. With nothing selected, the newest agent is selected. |
| FR-7 | **Transcript window (owner, 2026-11-20 18:56Z: only when switched on).** Hidden unless the command was given `-v` / `--verbose`, or the owner switched it on from inside the console (the `v` key, or "Show the transcript" in the answer bar's menu); `v` switches it off again. It shows one agent at a time, the one selected in Agents: each message's text in full, and one line per tool call naming the tool and its target (the file path, search pattern or URL, or the first 200 characters of a command). Tool output is never shown. It follows the newest line unless the owner has scrolled up (Up, Down, Page Up, Page Down, Home, End). Lines missed because the engine's buffer moved on are counted ("(37 earlier lines not shown)"). The transcript is read about once a second while the window is shown, and not at all otherwise. |
| FR-8 | **Log window.** The console's own record of what happened while it ran, newest last, each with the time: feature stage and activity changes, items that opened or were answered, engine disconnects and reconnects (F-021 FR-16), and errors. The last 1000 lines are kept in memory for the life of the command; nothing is written to disk. |
| FR-9 | **Answer bar.** Shows the current prompt (a pick, typed text, a confirm code) and the keys that work now. Typed answers keep F-018's rules: multi-line text ends on an empty line; a numbered pick needs Enter. While the owner types, the number keys and `v`, `q` type text and don't switch tabs. |
| FR-10 | **Interview command.** `factory-engine interview [<feature>]` opens the same console with the feature's interview in the Inbox window: its waiting item shown whole and answered in the answer bar, the analyst's activity in the title line while it works, and the feature's waiting decisions offered as F-021 FR-11. |
| FR-11 | **Reconnect.** When the engine is away, the title line shows "Engine away: reconnecting in <n>s (attempt <k>)" with the countdown of F-021 FR-16; the windows keep their last content, marked "(stale)", until the engine answers. |
| FR-12 | **Leaving.** `q` (while not typing) or Ctrl+C ends the command with F-021 FR-14's exit codes; the console session is closed and the terminal restored (cursor shown, the screen's previous contents back). |
| FR-13 | **The engine's transcript (H-0265).** For every agent session it runs, the engine keeps each assistant message's text and each tool call's name and target, never tool output, in memory only: the last 500 entries per run, dropped 60 seconds after the run ends. `engine.transcript` returns them to an approved console session of the project, with the running agents, so the console can show Agents and Transcript. |
| FR-14 | The engine README and the root README describe the windows, the keys, `-v` and `--plain`; `--help` lists both flags. |

## 4. Acceptance criteria

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given `factory-engine inbox` in a 100 by 30 terminal, then the screen shows the title line, the tabs Status, Inbox, Agents, Log (no Transcript), the Status window and the answer bar, all inside 100 columns and 30 rows. With `--plain`, the output is the same as before this feature (the existing F-021 tests pass unchanged against `--plain`). | FR-1, FR-2 |
| AC-2 | Given the terminal resized from 100x30 to 70x20, then the next frame fits 70x20; resized to 50x12, the screen shows only "Make the window at least 60 by 16"; an item that opened meanwhile is in the Inbox once the window is 80x24 again. | FR-3 |
| AC-3 | Given the old Windows console (no `WT_SESSION`), then no box-drawing character is written; given Windows Terminal, borders use box-drawing characters. | FR-3 |
| AC-4 | Given a Decision item, when the owner opens it from the Inbox, then every body section is shown before the actions, engine text marked and cleaned, and picking an action records it as F-021 AC-1. | FR-5, SR-1 |
| AC-5 | Given two running agents (F-003 analyst, F-007 developer), then Agents lists both; with `-v`, Transcript shows only the selected one's lines; Down then Enter switches the Transcript to the other agent. No tool output appears. | FR-6, FR-7 |
| AC-6 | Given no `-v`, then there is no Transcript tab and no `engine.transcript` call; pressing `v` adds the tab and starts reading; pressing `v` again removes it and the reads stop. | FR-7 |
| AC-7 | Given more than 500 entries since the last read, then the Transcript shows "(<n> earlier lines not shown)". | FR-7, FR-13 |
| AC-8 | Given the engine restarts, then the title line counts down, windows are marked "(stale)", and after the reconnect they refresh and the Log has both events. | FR-8, FR-11 |
| AC-9 | Given `factory-engine interview F-1` with an assumption waiting, then the Inbox window shows it whole and the answer bar offers Approve, Reject and Stop for now; the reply is sent as F-018 AC-1. | FR-10 |
| AC-10 | Given `q`, then the console session is closed, the cursor is shown and the alternate screen is left; exit code 0. | FR-12 |
| AC-11 | Given an analyst session that writes a message, reads a file and runs a command whose output holds a secret-looking string, then `engine.transcript` returns the message, "Read <path>" and "Bash <command>" and not the output; an unapproved or unknown session gets the session error; entries of another project are never returned. | FR-13, SR-2, SR-3 |
| AC-12 | Given engine text holding ANSI escapes, OSC 8 or OSC 52 sequences or a line imitating the answer bar, in an item, a status row or a transcript line, then no escape reaches the terminal and the text is drawn inside its window with the engine-text marker. | SR-1 |

## 5. Constraints

- Node 22 and the engine's single-file bundle (esbuild), on Windows 11 in
  Windows Terminal and the old console, and on macOS and Linux terminals.
- The screen library is **Ink** (React for terminals) with React, versions
  pinned exactly (ADR 0035, proposed). The console's state is kept in plain
  TypeScript (no React) so it is tested without a terminal; Ink only draws
  it.
- The windowed console must not slow the engine: the console's reads are
  the same calls as today plus one `engine.transcript` a second while the
  Transcript is shown.
- No change to what is recorded: answers, sign-in, the first-answer rule
  and reply ids are F-018's and F-021's.

## 6. Edge cases

- The engine isn't running at start or restarts: F-021 FR-16, shown in the
  title line (FR-11).
- No agents are running: Agents says "No agents are running" and the
  Transcript says the same.
- The selected agent ends: its lines stay readable for 60 seconds (FR-6).
- The terminal is too small, or resized while the owner types: what was
  typed is kept (FR-3, FR-9).
- Output piped or stdin not a terminal: refused as now (FR-1).
- An engine without the `transcript` capability: Agents and Transcript say
  "This engine can't show agents; update it", the rest works.
- **Abuse:** engine or agent text imitates the answer bar, a menu or a
  confirm code, or carries terminal escapes (SR-1).
- **Abuse:** an agent prints a secret it read in a message or a command line
  (SR-2, accepted risk).

## 7. Dependencies

- F-018 and F-021 (merged).
- New libraries: `ink` 8.0.0 and `react` (exact versions pinned at build),
  reviewed under S4.1 with a CVE check before they are added.

## 8. Assumptions

| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | "Window mode by default with a flag for the old mode" applies to both commands, and the flag is `--plain`. | Owner, 2026-11-20 18:56Z (point 5) | Approved (sign-off 18:58Z) |
| A-2 | Ink is the screen library (owner left it to the recommendation, 18:56Z point 4). | ADR 0035 | Approved (sign-off 18:58Z) |

## 9. Security considerations

| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | All engine and agent text (item sections, private detail, status words from the engine, transcript lines) is cleaned of escape and control sequences before it is drawn (as F-018 SR-1) and drawn with the engine-text marker inside its window; the title line, tabs and answer bar are drawn only from the command's own words and checked ids (F-018 SR-2). | analyst | Approved (owner, 2026-11-20 18:58Z) |
| SR-2 | The transcript holds assistant text and tool names with targets only, never tool output, and lives only in the engine's memory and the console's screen: never on disk, in a repo, on GitHub or in a log. **Residual risk to accept:** an agent's own message, or a command line it runs, may quote a secret it saw; that would be shown in the console on this PC. | analyst | Approved (owner, 2026-11-20 18:58Z), residual risk accepted |
| SR-3 | `engine.transcript` answers only an approved console session of the same project (F-021 SR-3, FR-13 sign-in setting), and returns only that project's runs. | analyst | Approved (owner, 2026-11-20 18:58Z) |
| SR-4 | The new libraries are pinned exactly and pass the S4.1 review and CVE check before they are added; the bundle stays a single file with no install step on the owner's PC. | analyst | Approved (owner, 2026-11-20 18:58Z) |

## 10. Interface requirements

| Id | Where | Change | Status |
|---|---|---|---|
| H-0265 | `docs/interface-contracts.md` (Engine control channel v1.7) | New method `engine.transcript { session, after?: int }` returning `{ agents: [{ run, feature, role, started_at, ended?: bool, cost_usd? }], entries: [{ seq, at, run, feature, role, kind: "text" \| "tool", text (at most 8000 chars) }], next, skipped }`. Needs an approved console session (`inbox.open`); `after` is the last call's `next` (absent: the newest 50 entries); `skipped` counts entries dropped from a run's 500-entry buffer before this client read them. `kind: "tool"` text is the tool's name and target, never its output. `engine.json` capabilities gain `"transcript"`. Adding the method is non-breaking. | Approved (owner, 2026-11-20 18:58Z); applied |
| H-0266 | `docs/adr/0035-ink-for-the-windowed-console.md` (new), `docs/adr/README.md` | Record Ink as the console's screen library (options: Ink, blessed / neo-blessed, terminal-kit, hand-written ANSI). | Approved (owner, 2026-11-20 18:58Z); applied |
| H-0267 | `README.md`, `engine/README.md` | FR-14. | Approved (owner, 2026-11-20 18:58Z); applied with the build |

## 11. Readiness gate

- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit
- [x] Blocking decisions resolved (approved, not deferred)

## 12. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-20 | Draft from the owner's requests 18:42Z and 18:47Z and his answers 18:56Z (six windows, transcript only when switched on, tabs, one agent at a time, windows by default with a flag for the old mode). F-021's `-v` proposal (v10 draft) folded in here. | Owner, 2026-11-20 18:58Z (decision card, approved as written, incl. A-1, A-2, SR-1 to SR-4 with the SR-2 risk, H-0265 to H-0267) |
