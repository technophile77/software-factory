# F-024 Developer completion report

- **Feature:** F-024 Windowed console with an agent transcript, spec v2
- **Role:** software-developer
- **Date:** 2026-11-20
- **Branch:** `claude/project-thread-fm0oxt`
- **Contracts used:** Engine control channel v1.7 (H-0265, `engine.transcript`)
- **New dependencies:** `ink` 8.0.0, `react` 19.3.1 (runtime), `@types/react` 19.3.0 (dev); S4.1: `npm audit` 0 vulnerabilities on 2026-11-20, about 50 packages in the tree, all pinned by the lockfile (SR-4, ADR 0035).

## What changed

- `engine/src/agent/live-transcript.ts`: the in-memory buffer (500 entries per run, dropped 60 s after the run ends, tool name and target only) and `toolLine` (FR-13, SR-2).
- `engine/src/agent/session.ts`: `runSession` reports each assistant text and tool call through `onEntry`; the analyst, reviewer and worker runners pass it to their group.
- `engine/src/engine.ts`: every run's agent group feeds the buffer (`liveGroup`) and lets go of it when the group closes; the project channel answers `transcript` with the spend each run has reported.
- `engine/src/channel/methods.ts`, `constants.ts`: `engine.transcript` behind an approved session of the project; capability `transcript` (H-0265).
- `engine/src/mcp/operations.ts`: the `transcript` operation; every entry and agent field is checked, anything else is dropped.
- `engine/src/terminal/console-model.ts`: the console's state, layout and keys in plain TypeScript (FR-2 to FR-9, FR-12).
- `engine/src/terminal/windowed.ts`: the `TerminalIo` that puts the command's text in the Inbox window and its prompts in the answer bar, and the poller for Status, Agents and Transcript.
- `engine/src/console-ui/screen.ts`: the Ink screen, bundled as `dist/console.mjs` (SR-4); React DevTools are replaced by a stand-in so the bundle has no missing import.
- `engine/src/terminal/interview.ts`: in the windowed console the watch leaves the status to its window; `sessionKey()` for the poller.
- `engine/src/cli.ts`: windows by default, `--plain`, `-v`; a failure's last lines are printed after the screen closes.
- `README.md`, `engine/README.md`: H-0267.

## Interpretations

1. **Agents window reads the transcript call too.** The engine lists running agents only in `engine.transcript`, so the console reads it while the Agents or the Transcript window is shown, and never otherwise (AC-6 holds: no call without `-v` unless the owner opens Agents).
2. **The console starts on Status, also with `-v`.** `-v` adds the Transcript tab; the owner switches to it.
3. **An answer prompt brings the Inbox window forward**, so the question is next to the answer bar.
4. **When the console is at a prompt and the engine goes away**, the title says "engine away" (the poller's view); the countdown of F-021 FR-16 shows once the command itself calls the engine again.
5. **AC-10 (alternate screen restored)** is Ink's `alternateScreen` option; it is checked by hand in a pseudo-terminal, not by a test, because Ink disables it when it detects CI.

## Spec v3 (owner's ask 2026-11-20 19:45Z)

- `console-model.ts`: the side pane (FR-15), a 32-column column from 100 columns wide, a strip of 2 or 4 lines under the window below that, with "+<n> more" where things don't fit; Status rows name the stage (FR-4).
- `interview.ts`: stage words (`STAGE`), `featureRows`, and a `status` hook the windowed console uses, so every status the command itself reads (the watch, a reconnect) updates the windows and clears "(stale)" at once (FR-11, AC-14). Before, only the poller cleared it.
- `windowed.ts`: the transcript is also read with each 5-second status, for the side pane's agents (FR-7, AC-6).
- Tests: `console-model.test.ts` (+3: FR-15 layouts, "+<n> more", FR-11), `console-screen.test.ts` (+1: AC-13), `terminal-f021.test.ts` (AC-4 stage rows, AC-6 reworked, AC-14 in AC-8).

## Tests run locally (affected suites only, owner's rule 2026-11-14)

- `test/console-model.test.ts` (6), `test/console-screen.test.ts` (4: AC-1, AC-2, AC-3, AC-6 keys), `test/live-transcript.test.ts` (4), `test/analyst-run.test.ts` (9, one new: FR-13, AC-11), `test/acceptance/terminal-f021.test.ts` (20, five new: AC-4, AC-5, AC-6, AC-8, AC-9, AC-12), `test/acceptance/terminal-f018.test.ts` (35): 78 passed.
- `npm run typecheck` clean; `npm run build` produces `dist/engine.js`, `dist/console.mjs` and `dist/proxy.js`; the built `inbox` command drew the windows in a 90 by 26 pseudo-terminal and printed the failure reason after `q`.
