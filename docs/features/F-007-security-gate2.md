# F-007 Security Gate 2 (implementation review)

- **Feature:** F-007 Engine increment 1 (interviews), spec v32
- **Gate:** 2, implementation review against `docs/security-standards.md` (S1 to S9), spec SR-1 to SR-23 and the 23 findings in `F-007-security-gate1.md`
- **Code reviewed:** `engine/` (`src/`, `docker/`, `config/`, `test/`), `engine/.npmrc`, `engine/package-lock.json`, `.github/workflows/engine.yml`, and the manifest v1.3/v1.4 rules in `plugins/software-factory/skills/onboard-repo/scripts/factory_check.py`, at `a3a2294` on `claude/project-thread-xnrw8z` (draft PR #26). Read against `F-007-dev-report.md`.
- **Reviewer role:** security-reviewer
- **Date:** 2026-11-11
- **Maturity level:** Rapid prototype (only Critical blocks)
- **Result:** PASS with conditions. There are no Critical findings, so nothing blocks at this level. There are 2 High, 4 Medium and 7 Low findings, plus Info notes. Both High findings block promotion to Alpha and should be recorded as known issues now. The condition: until H2 is fixed, run the engine only against config repos where the owner alone can push to `main`. Seven items need an owner decision (listed at the end).

Tests, run on Linux (Node 22): `npm ci --ignore-scripts` succeeded; `npm run typecheck` passed; `npx vitest run` passed 26 files with 1 skipped (452 tests passed, 6 skipped); `npm audit` reported 0 vulnerabilities. The lockfile has an `integrity` hash for every registry package. Real-environment evidence from the developer: AC-8 and AC-14 to AC-16 passed 4 of 4 on Windows at `12ffb06`, and a real model turn went through the credential gateway with a subscription token (the proxy saw only `POST /v1/messages`, 200).

Throwaway probes in a scratch folder (none in the repo):

1. **Permission gate (H1).** The pinned Agent SDK (0.3.311) and its real Claude Code binary, run against a local fake API server that scripted tool calls. Session options were the engine's: `permissionMode: "default"`, the engine's `canUseTool`, `hooks: {}`.
2. **PreToolUse hook (H1 fix).** The same run with a `PreToolUse` hook callback in place of `canUseTool`.
3. **AC-17.** `settingSources: []` against a worktree with a `CLAUDE.md` and a `.claude/settings.json` hook, plus a control run without it.
4. **Spawn (SR-10).** `strace` of a session through a custom `spawnClaudeCodeProcess`.
5. **SDDL parser (M2).** `src/os/sddl.ts` bundled and called on crafted descriptors.
6. **Worktree population (H2).** `populateWorktree` on a crafted tree.

"Reproduced" below means one of these probes showed it.

## Findings

| # | Criterion | Severity | Blocks? | Location (file:line) | Finding | Suggested fix |
|---|---|---|---|---|---|---|
| H1 | S6.2, S8.1, S7.1 (FR-9, SR-10, SR-12) | High | No (blocks Alpha) | `src/agent/session.ts:132-134` (`permissionMode: "default"`, `canUseTool: toolGate(...)`, `hooks: {}`); `session.ts:68-97` (`toolGate`), `:43` (`SHELL_SYNTAX`) | The role policy's read denies (including the `SECRET_DENIES` list) and the Bash `commands` allow list are enforced only in `canUseTool`. In `default` mode, Claude Code approves reads inside the working directory by itself and **never calls `canUseTool`** for them. Reproduced with the real binary: `Read`, `Grep` and `Glob` inside the cwd, and read-only Bash such as `cat <file>`, ran without a `canUseTool` call, and the content of a file matching a deny (a stand-in `.env` secret) went back to the model. `canUseTool` was called for `Write`, Bash `touch`, Bash `find -exec`, and `Read` outside the cwd. So every per-role read deny, and every command restriction for read-only commands, is advisory today. The container mounts limit the blast radius (no host home, no credential), but an analyst or web-reader session can read anything in its worktree, including denied paths such as `.factory/**` copies and secret-pattern files, and send it to the model and so to the transcript or an outbound fetch. The developer's noted residual (Grep/Glob given a directory) is part of this. The unit tests call `toolGate` directly, so they pass while the gate is bypassed. | Enforce the gate in an engine `PreToolUse` hook callback (`hooks: { PreToolUse: [{ hooks: [gate] }] }`), which Claude Code calls for every tool, including auto-approved ones. Reproduced: such a hook fired for `Read` and `Grep` and its `deny` stopped them. Keep `canUseTool` as a second layer. Add a gated test that runs the real binary (as the AC-17 probe did) and asserts a denied `Read`, `Grep`, `Glob` and `cat` all fail. |
| H2 | S1.4, S8.4 (SR-11, SR-12) | High | No (blocks Alpha) | `src/agent/runtime.ts:78` (loop over `git.lsTree`), `:80` (lexical `dest.startsWith(wt + path.sep)` only), `:85-87` (`symlinkSync` and `writeFileSync(dest, …)`) | `populateWorktree` writes the config repo's tree into the worktree on the host, as the owner. The only guard is a string prefix check. It never checks whether a parent of `dest` is a symlink it wrote earlier. Reproduced: a tree with a symlink `docs` pointing outside the worktree, followed by a blob `docs/evil.txt`, wrote `evil.txt` into the outside directory. Git refuses to build such a tree in normal use, but a crafted tree object can be pushed. On case-insensitive file systems (macOS default, Windows) a well-formed tree is enough: a symlink `Docs` and a blob `docs/x` (by analysis, not run). Result: anyone who can push to the config repo's `main` gets an arbitrary file write on the host as the owner (for example a shell profile or a launch agent), so code execution outside every container. This is the "nothing from the worktree runs on the host" boundary of SR-11. | Before each write, `lstat` every parent segment from the worktree root down and refuse if any is a symlink or not a directory (or compare `realpath` of the parent with the worktree root). Refuse entries whose case-folded path collides with an earlier one, and any entry under a path written as a symlink. Open files with `O_CREAT \| O_EXCL \| O_NOFOLLOW`. Add tests for the crafted tree and the case-fold pair. Until fixed: only config repos where the owner alone can push to `main`. |
| M1 | S8.1, S9.4 (SR-9, F-005 SR-17) | Medium | No | `src/proxy/server.ts:208` (path allow list), `:224` (forwards every client header except hop-by-hop, `x-api-key`, `authorization`) | The credential gateway restricts the path but forwards the request body and the `anthropic-beta` header unchanged. A process in any agent container (including one running a project's code under a future role) can send a Messages request that asks for Anthropic's server-side tools: `web_fetch`, `web_search`, code execution, or `mcp_servers` with an arbitrary URL. Anthropic's servers then fetch from any address, outside the proxy's SR-8 rules and the role's network allow list, and the call is billed to the owner's credential. It also bypasses SR-21 (fetch only through `fetch_page`). | Parse the JSON body at the gateway. Refuse `mcp_servers`, and any `tools` entry with a server-tool `type`, except `web_search` for a web-reader grant if the owner wants it. Forward only an allow-listed set of `anthropic-beta` values. Cap the body size. (Owner decision 1.) |
| M2 | S5.1 (SR-15, SR-13) | Medium | No | `src/os/sddl.ts:84-85` (unanchored owner and DACL regexes) | The SDDL check that guards the Windows pipe and the paths file fails open. Reproduced: a NULL DACL (`D:NO_ACCESS_CONTROL`) passed the file check; a conditional `XA` ACE granting Everyone was dropped by the parser, so both the file and the pipe checks returned true; text after an unparsable section was ignored. Each is "everyone may access" read as "owner only". | Parse the whole string with an anchored grammar. Refuse `NO_ACCESS_CONTROL`, `P`/`AI` flags it doesn't know, and any ACE type other than plain `A` and `D`. Add the three probe cases as tests. |
| M3 | S8.4, S5.1 (SR-14, SR-15, G1 #14, #15) | Medium | No | `src/fsutil.ts:25` (`ensureOwnerDir` returns early on Windows); `src/docker/cli.ts:28` (pipes `dockerDesktopLinuxEngine`, `docker_engine` accepted by a successful connect), `:53` (`WIN_PLUGIN_VARS`: `ProgramData` before `ProgramFiles`) | On Windows the local-user boundary isn't checked. (a) The engine home's ACL is never read, so on a multi-user host its `DOCKER_CONFIG`, `cli-plugins`, `pins.json` and `record.json` (the SR-5 pins) may be writable by others if the parent is. (b) The Docker named pipe is accepted by name. Another local user who creates it first (pipe squatting, when Docker isn't running) receives every Docker command, including the proxy's stdin, which carries the model credential. (c) `%ProgramData%\Docker\cli-plugins` is searched first, and `ProgramData` is user-writable by default on some hosts. On Unix the socket's owner uid isn't checked either. Single-user hosts are not affected. | Read back the engine home's SDDL with the M2 parser and refuse unless only the owner (and SYSTEM/Administrators) has access. Check the pipe server's identity (`GetNamedPipeServerProcessId`, then its token's user is the owner, SYSTEM or the Docker service) before sending anything. Search only `ProgramFiles` for plugins, or check the directory's ACL. On Unix, `stat` the socket and require uid 0 or the owner. (Owner decision 4.) |
| M4 | S4.4, S4.3 (SR-19, G1 #18) | Medium | No | `.github/workflows/engine.yml:28,31` (`actions/checkout@v4`, `actions/setup-node@v4`); no OSV step | SR-19 requires OSV-Scanner on the lockfile and the built image on every change. Neither runs. `npm audit` covers the lockfile today (0 found), but the image's Debian packages are never checked for CVEs. Actions are pinned by mutable tag, not SHA. The job does have `contents: read`, no secrets and a timeout. | Add OSV-Scanner for `engine/package-lock.json` and for the built image (image mode needs the S4.1 re-review SR-19 names), and pin actions by commit SHA. `engine.yml` is change-controlled. (Owner decision 2.) |
| L1 | S8.1 (SR-7, SR-21) | Low | No | `src/agent/sandbox.ts:277` (`allow: policy.network`) | The web reader's proxy grant is its role's `network` list, which is `*`, so code in that container can `CONNECT` to any public host on 443. Its fetches are meant to go only through the engine's `fetch_page` on the host, so the container itself needs only the gateway. | Give the web reader container a grant with an empty CONNECT allow list (gateway only), and keep `*` for the engine's own fetcher. |
| L2 | S1.4 (SR-11, SR-12) | Low | No | `src/engine.ts:893` (`git.out(worktree, ["rev-parse","HEAD"])`); `src/agent/sandbox.ts:232` (rw worktree mount) | The worktree's `.git` link file is in the agent's rw mount and isn't read-denied, so it shows host paths. `engine.ts:893` runs `rev-parse` in the worktree without `--git-dir`, so it follows a `.git` the agent rewrote. With SR-11's overrides this can't run code, but it can return a wrong HEAD. | Pass `--git-dir` and `--work-tree` explicitly, and add `.git` to the read denies. |
| L3 | S3.2 (SR-13) | Low | No | `.github/workflows/` (no check) | SR-13's CI checks (fail if the paths file is ever tracked; fail if templates or fixtures hold non-placeholder values) don't exist. A manual grep today found placeholders only. | Add both checks to the docs or engine workflow. (Owner decision 2.) |
| L4 | S5.1 (SR-17, TR-11) | Low | No | `src/engine.ts:449` (`changedPaths(local, remote)`) | The tamper check diffs local and remote both ways. After a failed push, the engine's own unpushed commit shows as a remote change, so it raises a false Security item and fails readiness. False alarms train the owner to dismiss real ones. | Diff `merge-base(local, remote)..remote`. |
| L5 | S9.4 (SR-18) | Low | No | `src/agent/sandbox.ts:232`; `src/agent/worktree-commit.ts:91` (`touched.push` keeps every path past the cap) | The worktree is a rw bind mount with no size cap, so an agent can fill the host disk. The end-of-session walk stops counting at its cap but still keeps every path in memory. | Stop the walk (fail the session) at the cap, and check free space or the worktree's size before committing. |
| L6 | S8.1 (SR-8) | Low | No | `src/proxy/rules.ts:63-64` (`BLOCKED_V4`, `BLOCKED_V6`) | Missing special-purpose ranges: `192.0.0.0/24`, `198.18.0.0/15`, the TEST-NET ranges, `2002::/16` (6to4, which can embed a private v4), Teredo `2001::/32` and `100::/64`. The 6to4 and Teredo forms are the ones that matter. | Add them, or use an allow rule: only addresses IANA lists as globally reachable. |
| L7 | S8.4 (SR-11) | Low | No | `src/git.ts` (override list) | The engine's git overrides don't neutralise repo-local `url.*.insteadOf`, `http.proxy` or `include.path` in the clone's `.git/config`. Only a same-user process can set those, so this is the accepted SR-20 threat, but it could redirect a push and its token. | Run fetch and push with `-c include.path=` cleared and an explicit URL and `http.proxy=`, or with `GIT_CONFIG_NOSYSTEM=1` and a per-command config. |

## Info

- **Transcript chain and duplicate keys.** Two transcript lines that differ only by a duplicated JSON key hash the same once parsed, because the chain hashes the parsed entry. No change that alters meaning gets through, but hashing the raw line would be stricter.
- **gitleaks.** The binary's SHA-256 is checked once, then it runs by path. A same-user process could swap it between runs (SR-20 threat). Checking the hash before each run is cheap.
- **Image reuse.** A local image is reused if its labels match. SR-14's post-start inspect checks the digest, so a relabelled image fails there.
- **Hidden text.** `fetch_page` strips hidden elements, but text hidden only by a stylesheet class isn't detected. The dev report notes this as a residual (owner decision 6).
- **Proxy image.** The proxy sidecar runs the unstripped base image, which still has npm. It holds no agent code, but a stripped image would be smaller and match SR-19's intent.
- **Limits parsing.** `factory_check.py` accepts `1e400` (infinity) as a limit value. The engine's own check refuses non-finite numbers, so it fails closed later. Refuse it in the checker too.
- **`legacy-peer-deps`.** `engine/.npmrc` sets it, which makes some SDK option types `any`, so a typo in a security option isn't a type error. The real-CLI test from H1 would cover the important ones.
- **Windows stale parent pids.** Ancestry walks can meet a reused pid. It fails closed (the session is refused).
- **`.gitattributes`.** `**/.gitattributes` isn't in the write denies. SR-11 turns filters off, so this is defence in depth only.
- **F-006 Info (Skill widening tools):** met. The session passes the role's tool list as the hard `tools` list, so a skill's `allowed-tools` can't add a tool.

## Checked and fine

- **Container spawn (SR-10, AC-17).** `containerSpawn` requires `--setting-sources=` and `--strict-mcp-config` and refuses bypass modes. Reproduced: with a custom spawn the SDK never runs the host binary; it only passes its path. With `settingSources: []`, neither `CLAUDE.md` nor `.claude/settings.json` hooks loaded; the control run loaded both.
- **Credential gateway (SR-9).** The container env has the gateway base URL, a dummy key and a session proxy credential only (`sandbox.ts:256-258`). The proxy drops client `x-api-key` and `authorization` and adds the real credential. Body filtering is M1.
- **Worktree commit (SR-12).** `lstat` walk, `O_NOFOLLOW` reads, a check of the `.git` link, refusal of new or changed symlinks, secrets scan before any write, and compare-and-swap on the ref. Sound apart from L5.
- **State repo.** Scans before writing, compares blob ids, builds the index with `update-index --index-info` (plumbing only, no checkout), and builds the push URL from origin's owner and repo only.
- **gitleaks (SR-19, OQ-11).** Version and SHA constants match Gate 1; run in directory mode over blobs extracted from git.
- **git (SR-11), GitHub device flow (SR-23), session tokens, pins and confirm (SR-5).** Match the spec; the owner is matched by numeric id.
- **Paths file (SR-13 file checks).** Symlink, owner and mode checks are present on Unix.
- **Image.** The Dockerfile has no npm or npx in the final stage, runs as uid 1000 and checks the Claude Code binary's SHA. The base image is pinned by digest (`image.ts`).
- **Environment.** `proc.ts:86` passes only a whitelisted base environment to child processes.

## Spec security requirements (S7.1)

| SR | Status | Evidence | Notes |
|---|---|---|---|
| SR-1 No secrets in logs, Git, items, argv, prompts | Met | Proxy credential via stdin; token via `GIT_ASKPASS`; gitleaks runs with `--redact` | M1 is about what the gateway carries, not a leak. |
| SR-2 Fail closed | Met, except M2 | Checks throw and stop the run | M2 is a fail-open parser. |
| SR-3 Tool arguments are data | Met | Interview tools validate against limits before use | |
| SR-4 External actions logged | Met | GitHub calls and pushes logged with approval id | |
| SR-5 Manifest from `main`; pins | Met | `pins.json`, confirm command, device sign-in as pinned id | Scope question: owner decision 3. |
| SR-6 `--internal` network, proxy sidecar | Met | One internal network per run; AC-14 to AC-16 on Windows | |
| SR-7 Per-session proxy credential | Met | Random credential per container, dropped at session end | L1: the web reader's grant is wider than needed. |
| SR-8 Address rules | Met, with gaps | `rules.ts:63-64` | L6. |
| SR-9 Credential only at the gateway | Met | `sandbox.ts:256-258`; real gateway turn | M1 for body content. |
| SR-10 Fixed session options | Met | AC-17 and spawn probes | H1 is about the tool gate (FR-9), not these options. |
| SR-11 Git hardening; nothing runs on the host | Met for git; see H2 | `git.ts` overrides | H2 is a host file write from the worktree; L2, L7. |
| SR-12 Real-path rule; end-of-session check | Partly | `worktree-commit.ts` sound; `runtime.ts:78-87` | H2, and H1 (read denies not enforced). |
| SR-13 Paths file; CI checks | Partly | File checks met | M2 (Windows ACL parse), L3 (CI checks missing). |
| SR-14 Docker invocation and post-start inspect | Partly | Absolute path, arg array, inspect | M3 (pipe identity). `DOCKER_CONFIG` is engine-owned rather than cleared (owner decision 7). |
| SR-15 FFI fails closed; ACL read-back; negative tests on three OSes | Partly | Fixed function list in one module | M2; no real-Windows negative tests in CI. |
| SR-16 Per-project state | Met | | |
| SR-17 Transcript hash chain | Met | | L4 (false alarms), Info (duplicate keys). |
| SR-18 Caps | Met | Limits from `limits.yaml` at the `factory.version` tag | L5 (disk). |
| SR-19 OSV, no npm in image, CI permissions, gitleaks pinned | Partly | No npm; `contents: read`; gitleaks pinned | M4. |
| SR-20 OS credential store | Met (accepted risk) | | |
| SR-21 Web only through `fetch_page` | Met | `WebFetch` not in the tool list | M1 and L1 are other routes out. |
| SR-22 Transcript as data | Met | | |
| SR-23 Device flow validation | Met | | |
| FR-9 Role policy enforced per tool call | Partly | `session.ts:68-97` | H1. |

## Gate 1 findings

| G1 # | Topic | Status | Where |
|---|---|---|---|
| 1 | Network isolation | Met | SR-6 |
| 2 | Proxy credential | Met | SR-7 (L1) |
| 3 | Address rules | Met, with gaps | SR-8 (L6) |
| 4 | Model credential | Met | SR-9 (M1) |
| 5 | Session options | Met | SR-10 (H1 is separate) |
| 6 | Git on the host | Partly | SR-11 (H2) |
| 7 | Manifest from `main` | Met | SR-5 |
| 8 | Worktree paths | Partly | SR-12 (H1, H2) |
| 9 | Paths file | Partly | SR-13 (M2, L3) |
| 10 | Limits (H-0082) | Met | Limits read from the pinned tag |
| 11 | Per-project state | Met | SR-16 |
| 12 | Transcript integrity | Met | SR-17 |
| 13 | FFI | Partly | SR-15 (M2) |
| 14 | Docker invocation | Partly | SR-14 (M3) |
| 15 | Sensitive data at rest | Partly | Unix met; Windows home ACL not checked (M3) |
| 16 | External services, token scope, data to the model API | Met | Spec section 9 lists them; implementation matches |
| 17 | Caps | Met | SR-18 |
| 18 | Supply chain | Partly | SR-19 (M4) |
| 19 | Credential store | Met (accepted) | SR-20 |
| 20 | Web reader | Met | SR-21 |
| 21 | Transcript display | Met | SR-22 |
| 22 | SDK/CLI and koffi pin conditions | Met | SDK 0.3.311 with the matching CLI binary SHA; installed with `--ignore-scripts` |
| 23 | Device flow | Met | SR-23 |

## Residual risks

- Until H1 is fixed, role read denies and read-only command limits are not enforced inside a container. Mounts still keep host files and credentials out.
- Until H2 is fixed, write access to a config repo's `main` is equivalent to code execution as the owner on the host.
- Server-side tools reachable through the gateway (M1).
- Multi-user Windows hosts (M3).
- Already accepted or proposed for acceptance: text hidden by stylesheet classes; Windows stale pids (fail closed); gitleaks maintenance status; the root-equivalent Docker daemon on Linux (rootless recommended); the OS credential store (SR-20, accepted).

## Owner decisions needed

1. **Security (M1):** what the credential gateway may carry: which server-side tools and `anthropic-beta` values, per role.
2. **Hygiene item, change-controlled (M4, L3):** edit `engine.yml` and the docs checks to add OSV-Scanner (lockfile and image), pin actions by SHA and add the SR-13 CI checks; plus the S4.1 re-review of OSV-Scanner image mode.
3. **Security (SR-5 scope):** whether to pin more security-relevant manifest keys (`policy`, agent and skill overrides, `factory.version`).
4. **Security (M3):** whether a multi-user Windows host is in the threat model now or at Alpha.
5. **Security (H2):** confirm the interim restriction (config repos where only the owner can push to `main`) until the fix lands.
6. **Security:** accept the residual risks listed above that aren't yet accepted.
7. **Security, confirm developer interpretations:** `DOCKER_CONFIG` set to an engine-owned directory rather than cleared; a host refused if any DNS answer is blocked; the worktree commit includes ignored files; one internal network per run.
