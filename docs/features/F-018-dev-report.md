# F-018 Developer completion report

- **Feature:** F-018 Answer interview questions in a terminal command, spec v10
- **Role:** software-developer
- **Date:** 2026-11-14
- **Branch:** `claude/project-thread-rnlxi6` (PR #68)
- **Contracts used:** Engine control channel (`engine.status` `activity`, H-0225; owner approval, H-0228), Project manifest v1.8 (H-0227)
- **New dependencies:** none. One removed: `@modelcontextprotocol/sdk`.

## What changed

- `engine/src/terminal/interview.ts` (new): the command's flow. It picks or starts a feature, opens the session, prints each item's `display` whole before its numbered choices, and reads answers (Enter on an empty line ends typed text). It also handles lost replies, stale items and expired sessions only on the owner's word, and the live status wait with a spinner (FR-1 to FR-14).
- `engine/src/cli.ts`: `factory-engine interview [<feature id>] [--project <path>]`, which refuses unless stdin and stdout are terminals; readline with no history; the spinner. The `mcp` command is removed.
- `engine/src/mcp/operations.ts`: kept as the command's engine client; status returns each feature's `activities`; the device link is printed bare.
- `engine/src/interview/activity.ts` (new) and `engine.ts`: `engine.status` reports a fixed `activity` code per feature (H-0225).
- `engine/src/channel/sessions.ts`, `config/manifest.ts`, `config/pins.ts`, `config/confirm.ts`, `engine.ts`: the per-project sign-in setting `settings.interview_sign_in` (never, engine_start, session, hours), pinned; sessions opened without sign-in are recorded as `session_opened_without_sign_in` (FR-13, FR-15).
- Retired (H-0215 to H-0218): `engine/src/mcp/server.ts`, the plugin's `spec-interview` skill and `.mcp.json`, the `engine_path` setting, the `spec-interview` CI job; plugin 0.6.0; README, engine README, analyst AGENT.md line and notes in F-005, F-006 and F-009.
- Onboarding (H-0226): step 3 asks for the sign-in setting; the manifest template carries it.

## Interpretations

1. **"Writing the specification".** The engine has no explicit "writing" phase, so an analyst run that is still going with nothing left for the owner reports `analyst_writing_spec`; with an open item it reports `analyst_reviewing`. `advisor_working` is in the contract but not reported yet, because the advisor runs inside the analyst's turn.
2. **Sign-in windows.** `engine_start` and `hours` count from the last successful sign-in in this engine run; a restart asks again, which errs towards signing in.
3. **MCP suites (AC-11).** The F-005, F-006 and F-009 suites now drive the same operations in-process, as the command does. The checks that only made sense for an MCP server (tool listing, annotations, the server process's sockets) were removed with it; the operation inputs check now reads `FIELDS`.

## Tests run locally (affected suites only, owner's rule 2026-11-14)

- Unit: `test/units.test.ts` (sign-in setting, pins, manifest, activity codes), `test/mcp-bundle.test.ts`, `test/terminal-pipe.test.ts` (AC-12), and `test/engine.test.ts`, `readiness.test.ts`, `gate1-run.test.ts`, `interview.test.ts`, `f016-run.test.ts` (status assertions): all pass.
- Acceptance: `terminal-f018` (30), `approval`, `sessions`, `pinning`, `channel`, `features`, `interview-tools`, and the ported `mcp-tools`, `mcp-f005`, `mcp-f006`, `mcp-f009`, `mcp-e2e`, `mcp-f005-timing`: all pass.
- `npm run typecheck`, `python3 scripts/check_docs.py`: pass.
- Not run here: the onboarding skill's Python tests (no pytest in this container; CI runs them) and Windows (CI runs `terminal-pipe.test.ts` in the platform suite).
