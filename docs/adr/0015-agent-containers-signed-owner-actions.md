# 0015. A container per agent session, one path-matching rule, and signed owner actions

- **Status:** Accepted; decision 3 amended for phone actions by ADR 0018; decision 1 suspended until Beta by [ADR 0026](0026-agents-on-host-until-beta.md)
- **Date:** 2026-11-10
- **Decided by:** owner
- **Decision item:** proposal 0017 (F-003 Gate 2 R2-1, R2-2, R2-4; H-0045, H-0046, H-0047, H-0052), decision cards 2026-11-10

## Problem
ADR 0004 enforces the role policy in the engine, not at the OS. Any program
an agent runs can read or write any file in reach, so the policy's `read`
and `write` lists bound only the file tools. Agents run as the owner's OS
user (ADR 0014), so that reach includes the owner's keys, logins and the
engine's socket. Policy globs had no defined matching rule, so case,
symlinks and glob dialects could get past a deny. An owner action in an
inbox item was a plain `by: owner` line that an agent could write.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Container per agent session (chosen) | The agent and everything it starts, hooks included, see only what is mounted; nothing of the owner's is there | Needs Docker Desktop (WSL2 back end on Windows); slower start; per-file write rules checked when the session ends rather than per write |
| Claude Code's sandbox per agent session | OS-enforced per command; same rules as the file tools | Reads open by default; covers commands only; the owner judged it not a real jail |
| No sandbox; rules bind file tools only | No work | Agents can read secrets and edit protected files through commands |
| Path matching: fixed rule, case-insensitive denies (chosen) | Same answer on every OS; a deny only widens | Rules using `?` or `[...]` must be rewritten |
| Path matching: fold case only on case-insensitive filesystems | Exact on Linux | Same repo behaves differently across machines |
| Owner actions as SSH-signed commits (chosen) | Standard git; works offline; self-checking record | Owner adds a signing key to GitHub once |
| Owner actions through the GitHub API | No key setup | Network per approval; larger extension change |
| Keep plain `by: owner` until Alpha | No work | Approvals can be forged |

The owner first chose Claude Code's sandbox, then, on seeing that it leaves
reads open by default, chose a container per agent session instead.

## Implications
- **Security:** an agent sees only its worktree, cache volumes and a temp
  folder; the owner's home, keys, logins, signing key and the engine's
  socket are never in its container, so it can't forge a signed approval
  or reach the engine. Its network is limited to the model API and its
  role's hosts.
- **Known limits:** a secret already committed can be read through git
  objects, so committed-secret scanning stays; the egress proxy trusts host
  names, so allowed hosts stay narrow; build and test tools still run repo
  code, inside the container; the session's model token is inside the
  container; write rules inside the worktree are enforced when the session
  ends, so a bad write is rejected rather than prevented.
- **Maintenance:** a per-project image with a pinned base and the approved
  toolchain; the inbox extension (F-001) needs a change to sign owner
  actions.
- **Performance:** container start adds seconds per session.

## Decision
1. The engine runs every agent session, the agent process included, in its
   own container, as set out in the Role policy contract: worktree and
   cache volumes only, no owner credentials, pinned image, non-root,
   read-only root, no capabilities, egress proxy to the model API and the
   role's hosts, write rules checked against the branch when the session
   ends, and no session if the container can't start.
2. Paths are matched by real path, inside the worktree, after NFC
   normalization; deny globs ignore case, allow globs don't; globs use only
   literal segments, `*` and `**`.
3. An owner action counts only if its commit is signed with one of the
   owner's SSH signing keys listed on GitHub; the engine files a Security
   alert for one that isn't.

## Consequences
- Amends ADR 0004, which named containers as a later step: agent isolation
  is now worktree + engine policy + a container per session. The worktree
  and role model are unchanged.
- Docker Desktop (or another OCI runtime) becomes a requirement on every
  machine that runs the engine.
- F-001 gets a follow-up feature to sign owner actions; the engine design
  must include the containers, the egress proxy, the end-of-session write
  check and the signature check.
