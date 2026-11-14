# 0014. Owner approval of interview sessions through GitHub on the owner's phone

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decided by:** owner (decision card)
- **Amended:** 2026-11-14, F-018 FR-13: at Rapid prototype one approval per engine run covers later sessions; accepted risk F-018 SR-8.
- **Decision item:** F-005 SR-5; write-up in `docs/proposals/0016-stop-agents-acting-as-owner.md`

## Problem
At Rapid prototype every agent runs as the owner's OS user, so an agent could
connect to the engine channel and answer interview questions or approve
assumptions in the owner's place (F-005 SR-5). This must be closed before
Alpha.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A. Agents run as a separate OS account | Agents can't reach the channel or the owner's credentials at all | Engine launcher and file permissions more complex; one admin prompt at setup |
| **B. GitHub device approval on the phone, per session** | Uses the owner's GitHub account and phone; nothing on the machine can produce the approval | Once per session: an agent running as the owner could reuse an approved session |
| C. Windows Hello / Touch ID per reply | Binds each reply; works even while agents run as the owner | A prompt per answer; native helper per OS |
| D. Authenticator code | Familiar | The shared secret sits on the machine, readable by agents |
| E. Proof by a write to the repo | Uses GitHub | Plain push is forgeable with the owner's saved Git login; a key-signed push is slower than C |

## Decision
Every interview session must be approved by the owner through GitHub's
device sign-in before the engine accepts any reply in it.

1. **One-time setup (owner):** the owner registers a GitHub OAuth app for the
   factory under their own account, with device flow enabled and no scopes.
   Its client id is public and goes in the factory's config. It has no client
   secret on the machine. The owner's numeric GitHub user id is recorded at
   the same time.
2. **Each session:** `interview.open` makes the engine request a device code
   from GitHub. The skill shows the owner the eight-character code and
   `github.com/login/device`. The owner enters the code **on their phone**,
   signed in to GitHub, checks that the code matches the one in the skill,
   and approves.
3. **Engine check:** the engine polls GitHub for the token, calls `GET /user`
   with it, and accepts the session only if the id equals the recorded owner
   id. It then discards the token; the token never leaves the engine. Until
   then the session is pending and every interview call on it is refused.
4. **Fail closed:** a denied, expired or wrong-account approval, or GitHub
   staying unreachable until the code expires, means no session. There is no
   fallback. A poll that gets no answer (network error, timeout, 5xx) is
   retried at the next interval, with its cause logged, because the code is
   still valid (owner decision, 2026-11-13).
5. **Lifetime:** an approved session ends on `interview.close`, after 30
   minutes without a call, or 2 hours after approval, whichever comes first.
   A takeover is a new session and needs a new approval.

## Implications
- **Security, residual risk (recorded at the owner's choice):** the check
  happens once per session. After approval, a process that can read the
  session token (from the client or the owner's Claude Code history) or
  connect to the socket could send replies in that session. Narrowed by: the
  engine refusing processes it started (SR-14); the 2-hour cap; and, once
  approved, ADR 0015 (proposal 0017), which runs every agent session in its
  own container with only its worktree and caches mounted: no owner home, no
  engine socket or `engine.json`, no owner credentials. With that in place
  the remaining exposure is a container escape, or a non-factory program the
  owner runs themselves. A per-reply presence check (option C) would close
  it and can be added later without changing this flow.
- **Code confusion:** an agent could start its own device sign-in and hope
  the owner approves the wrong code. The one-session-per-feature lock and the
  owner comparing the code shown in the skill guard against this.
- **Availability:** interviews need GitHub to be reachable.
- **Scope:** only interview sessions need approval. The owner chose not to
  gate `feature.start` (decision card, 2026-11-10).

## Consequences
- Engine control channel v1.2 (H-0051): pending sessions, the approval
  details in `interview.open`, `interview.awaitApproval`, two error codes.
- F-005 spec SR-5 changes from accepted risk to this design plus the recorded
  residual risk (H-0053).
- The engine needs outbound HTTPS to `github.com` and `api.github.com`.
- Where the client id and owner id are stored depends on the master factory
  config, which is not yet defined. Until it is, the engine refuses to open
  interview sessions.
