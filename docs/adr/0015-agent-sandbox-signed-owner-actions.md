# 0015. OS sandbox for agent commands, one path-matching rule, and signed owner actions

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decided by:** owner
- **Decision item:** proposal 0017 (F-003 Gate 2 R2-1, R2-2, R2-4; H-0045, H-0046, H-0047), decision cards 2026-11-10

## Problem
ADR 0004 enforces the role policy in the engine, not in an OS sandbox. Any
program an agent runs through `Bash` can read or write any file in reach,
so the policy's `read` and `write` lists bound only the file tools. Policy
globs had no defined matching rule, so case, symlinks and glob dialects
could get past a deny. An owner action in an inbox item was a plain
`by: owner` line that an agent could write.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Claude Code's sandbox per agent session, built from the role policy (chosen) | OS-enforced for every child process; same rules as the file tools | Needs WSL2 on Windows; covers commands only, so hooks and MCP servers stay out of agent sessions |
| Container per agent session | Whole-process boundary | Needs Docker Desktop; slower; coarse per-file rules |
| No sandbox; rules bind file tools only | No work | Agents can read secrets and edit protected files through commands |
| Path matching: fixed rule, case-insensitive denies (chosen) | Same answer on every OS; a deny only widens | Rules using `?` or `[...]` must be rewritten |
| Path matching: fold case only on case-insensitive filesystems | Exact on Linux | Same repo behaves differently across machines |
| Owner actions as SSH-signed commits (chosen) | Standard git; works offline; self-checking record | Owner adds a signing key to GitHub once |
| Owner actions through the GitHub API | No key setup | Network per approval; larger extension change |
| Keep plain `by: owner` until Alpha | No work | Approvals can be forged |

## Implications
- **Security:** commands an agent runs are confined to its role's file and
  network rules by the OS. Approvals can't be forged by an agent that can't
  use the owner's signing key. Both hold only while agents can't act as the
  owner's OS user (proposal 0016, F-005 SR-5).
- **Known limits:** a secret already committed can be read through git
  objects, so committed-secret scanning stays; the sandbox's network filter
  trusts host names, so allowed hosts stay narrow; build and test tools
  still run repo code, inside the sandbox.
- **Maintenance:** the engine generates sandbox settings from the policy;
  the inbox extension (F-001) needs a change to sign owner actions.
- **Long term:** containers remain possible later without changing the
  role model.

## Decision
1. The engine runs every session of a role with `Bash` in Claude Code's OS
   sandbox, built from the role's `read`, `write` and `network` lists (deny
   wins), with `failIfUnavailable: true`, `allowUnsandboxedCommands: false`,
   no `excludedCommands`, and only the settings the engine generates. On
   Windows, agent sessions run inside WSL2.
2. Paths are matched by real path, inside the worktree, after NFC
   normalization; deny globs ignore case, allow globs don't; globs use only
   literal segments, `*` and `**`.
3. An owner action counts only if its commit is signed with one of the
   owner's SSH signing keys listed on GitHub; the engine files a Security
   alert for one that isn't.

## Consequences
- Amends ADR 0004: agent isolation is now worktree + engine policy + OS
  sandbox. The worktree and role model are unchanged.
- Rules out running agent commands on native Windows outside WSL2.
- F-001 gets a follow-up feature to sign owner actions; the engine design
  must include the sandbox and the signature check.
