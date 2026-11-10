# F-005 first Windows run

The interview client's Windows transport (SR-7) had never run before this
(test report "Not run"; orchestrator review; Gate 2 #9; validation n5). This
is that run. There is still no engine, so stand-in engines served the pipe.

**Machine:** the owner's PC, Windows 11 (build 26200), Python 3.10.11,
Git for Windows 2.44, Node 24.15. Run 2026-11-10.

**Kit:** `plugins/software-factory/skills/spec-interview/tests/windows/`.
`win_check.py` runs 15 checks against two stand-in engines on real named
pipes: `pipe_engine.py` (Python, the developer fake engine's logic) and
`node_engine.js` (a Node `net` server, as the real engine will be). Run it
with `python win_check.py` on Windows; it writes `win_check_report.md`.

## Results

| Check | First run (7066f99) | After fixes (f815e70) |
|---|---|---|
| C01 Environment | Pass | Pass |
| C02 Win32 bindings load | Pass | Pass |
| C03 No engine: `engine_unreachable`, no hang | Pass | Pass |
| C04 Real pipe round trip (status, list, open, next, reply, close), owner SID check | Pass | Pass |
| C05 Answer near 1 MiB arrives whole | Pass | Pass |
| C06 Request near 1 MiB written whole | Pass | Pass |
| C07 Silent engine times out on time, never blocks (SR-15, M5) | Pass | Pass |
| C08 Engine drops the pipe: `connection_lost` | Pass | Pass |
| C09 End to end as SKILL.md runs it (`-I`, stdin, piped stdout, engine.json) | **Fail** | Pass |
| C10 engine.json pid is not the pipe server's | **Fail** | Pass |
| C11 No engine.json: `engine_not_running` | Pass | Pass |
| C12 Committed engine.json refused | Pass | Pass |
| C13 Through Git Bash with the heredoc | Skip (kit bug) | Pass |
| C14 End to end against a Node pipe server | **Fail** | Pass |
| C15 Existing suites on Windows (information only) | 78/86 and 123/154 error | 78/88 and 123/154 error |

## Defects found and fixed

1. **Output not UTF-8 on Windows (C09, C14).** Piped stdout uses the ANSI
   code page (cp1252), and `-I` ignores `PYTHONUTF8`. Accented text reached
   the skill garbled, and U+2713 crashed the run with a traceback and no
   JSON. The client now writes UTF-8 bytes to `stdout.buffer`.
2. **engine.json pid not checked on Windows (C10).** The contract says
   clients check `pid` against the peer where the OS reports one; Windows
   always does (`GetNamedPipeServerProcessId`). The pipe transport now
   refuses with `peer_not_engine`, as the socket transport does.
3. **No `python3` on Windows.** The owner's PC has `python` and `py` but no
   `python3`, so the command in SKILL.md would not run. SKILL.md now says to
   write `python` in its place on Windows.

## Not covered

- **The existing suites don't run on Windows (C15).** Both build their fake
  engines on Unix sockets and check Unix file modes, so most tests error on
  Windows. They pass on Linux (88 and 154). Making them skip cleanly on
  Windows is a follow-up; the Windows behaviour is covered by this kit.
- **A pipe server running as another user** (the negative SID check) needs a
  second account; only the positive case ran (C04).
- **The engine's own side of SR-7** (`FILE_FLAG_FIRST_PIPE_INSTANCE`, owner-only
  ACL, client SID check) belongs to the engine feature.
- **macOS** `getpeereid` is still unrun.
