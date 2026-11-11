# Feature: Run spec interviews on the real engine

- **Id:** F-007
- **Status:** Draft (requirements interview in progress)
- **Requested by / date:** Alex, 2026-11-11
- **Spec version:** 5

This is the first increment of the factory engine (ADR 0001). The engine as a
whole is too large for one feature, so it is built in increments, each a
feature of its own with its own gates. The owner chose this increment first
(OQ-1, decision card, 2026-11-11); the order of the rest is in section 13.

## 1. Objective and business purpose
The interview skill (F-005) and the advisor client (F-006) are built and
tested, but only against a fake engine. Nothing yet runs the requirements
analyst, so the owner can't hold a real interview, and every later stage
depends on a real spec coming out of one.

This increment builds the engine far enough for the owner to request a
feature, approve the session on their phone, and be interviewed by the real
requirements analyst, running in its own container, until the spec passes the
interview checks of the readiness gate. It also lays the parts every later
increment reuses: the engine process, the control channel, the `factory/state`
worktree, the master config, agent sessions in containers, and the egress
proxy.

## 2. Expected behavior
1. The owner starts the engine (a command for now; the VS Code extension
   starts it in a later increment). It reads the master config and the
   enabled projects' manifests, checks its credentials against each project's
   billing mode, checks out `factory/state` at `.factory/` where missing,
   opens the control channel and writes `.factory/engine.json`.
2. In Claude Code the owner runs `/software-factory:spec-interview` and
   requests a feature, or picks one waiting for an interview. Nothing changes
   in the skill.
3. The engine starts GitHub's device sign-in. The owner enters the code on
   their phone. The engine accepts the session only for the recorded owner.
4. The engine starts the requirements analyst as an Agent SDK session in its
   own container. The analyst asks questions and proposes assumptions through
   tools the engine provides; the engine turns them into interview items. The
   owner's replies go back to the analyst word for word.
5. "More information" runs the analyst's research (and the web reader, inside
   its own container) and the question comes back with findings and sources.
6. The engine writes the transcript under `.factory/interviews/<feature>/`
   and the spec under `docs/features/` on the feature branch, committing after
   each edit (ADR 0012), with the secrets scan before each commit.
7. When the analyst says the spec is ready, the engine runs the interview
   checks of the readiness gate (F-005 FR-8, FR-9, SR-11) and reports the
   result through `engine.status` and the agent report. Stages 3 and 4 in full
   come in a later increment.
8. `engine.status`, `engine.pause`, `engine.resume` and `engine.shutdown`
   work as the channel contract says.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | The engine is a TypeScript Node process in `engine/` (ADR 0001, 0003), started by a command. One engine serves all enabled projects on the machine. |
| FR-2 | At start it loads each enabled project's manifest from its config repo, which holds the owner's GitHub id, the OAuth client id and the allow list (OQ-2, H-0080). The engine finds the config repos from a git-ignored file in the user's clone of the master repo that lists their paths and holds no settings (owner, 2026-11-11; the `.gitignore` entry is hygiene item H-0081). It refuses to run a project whose manifest fails validation, whose repo isn't reachable with the factory token, or whose owner isn't on the allow list (ADR 0012). A refusal files a Security item and stops only that project. |
| FR-3 | It refuses to start when its model credentials don't match a project's billing mode (ADR 0012). |
| FR-4 | It serves Engine control channel v1.3 on a Unix socket or Windows named pipe with every access rule of the contract, and writes `engine.json` as the contract says. Advisor reply kinds return `kind_not_allowed` until the advisor increment, and `engine.json` reports the channel version it serves, so the skill doesn't offer the advisor (F-006 FR-11). |
| FR-5 | `feature.start` assigns the next feature id, creates `feature/F-nnn-name` from `main` (ADR 0005) and queues the interview. New features enter only this way (ADR 0012). |
| FR-6 | `interview.*` follow channel v1.3 and the interview rules: session lock by token, takeover, revisions, reply ids, deferred items once per session, `wait_s`, error codes. |
| FR-7 | Every interview session needs the owner's GitHub device approval before any reply is accepted, exactly as ADR 0014 sets out: no scopes, no client secret, owner id check, token discarded, fail closed, 30-minute idle and 2-hour limits. |
| FR-8 | The analyst and the web reader run as Agent SDK sessions, each in its own container as the Role policy contract sets out (ADR 0015): worktree and caches only, pinned image, non-root, read-only root, no capabilities, no owner credentials, no engine socket, egress only through the engine's proxy to the model API and the role's hosts. No container, no session. |
| FR-9 | Each role gets exactly its policy's tools; the engine checks every file tool call against the role's `read` and `write` rules with the ADR 0015 path rule, and when the session ends compares the branch with the write rules and rejects the session's commits on a breach. |
| FR-10 | The analyst reaches the owner only through engine tools (OQ-8): ask a question, propose an assumption, request research, report the spec ready. The engine never answers for the owner and never turns analyst text into a reply. |
| FR-11 | After each agent edit the engine commits the worktree change to the agent's branch (ADR 0012). The engine alone writes the transcript, append-only, on `factory/state`, and runs the secrets scan before each commit, blocking it on a hit. |
| FR-12 | When the analyst reports the spec ready, the engine runs readiness checks 5 and 6 for interviews: no question `open` or `deferred`, no pending assumption, and every assumption the spec marks approved matches an `approve_assumption` transcript entry. |
| FR-13 | Each agent run writes an Agent report v1.1 under `.factory/runs/` on `factory/state`, with the engine-filled fields (model, effort, usage, transcript reference). |
| FR-14 | An interrupted run is marked `interrupted`, uses no retry, and resumes from its session or from the last commit with a transcript summary (ADR 0012). |

## 4. Acceptance criteria
Drafted from the requirements above; each is refined in the interview.

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a valid master config and one enabled project, when the engine starts, then `engine.json` exists with mode 0600 and the served channel version, and `engine.status` answers. | FR-1, FR-4 |
| AC-2 | Given a project whose repo owner isn't on the allow list, when the engine starts, then that project doesn't run, a Security item is filed, and other projects run. | FR-2 |
| AC-3 | Given an `ANTHROPIC_API_KEY` in the environment and a project in subscription mode, when the engine starts, then it refuses with a clear message. | FR-3 |
| AC-4 | Given a peer that isn't the owner, or a process the engine started, when it connects, then it is refused. | FR-4 |
| AC-5 | Given `feature.start`, then a feature id and branch exist and `interview.list` shows the feature. | FR-5 |
| AC-6 | Given an open session not yet approved, when the client calls `interview.next`, then it gets `approval_pending`; given approval by a GitHub account other than the owner, then `approval_failed`. | FR-7 |
| AC-7 | Given an approved session, when the analyst asks a question through its tool, then `interview.next` returns it word for word, and the owner's answer reaches the analyst word for word. | FR-6, FR-10 |
| AC-8 | Given the analyst's container, then it can't read the owner's home, the engine socket or `engine.json`, can't reach a host outside its policy, and runs as non-root with a read-only root. | FR-8 |
| AC-9 | Given a session that writes outside its write rules, when it ends, then its commits are rejected and a Security item is filed. | FR-9 |
| AC-10 | Given a spec reported ready with a question still `deferred`, then readiness check 6 fails; with an approved assumption that has no `approve_assumption` entry, check 5 fails. (These are F-005 AC-7 and AC-8, carried here.) | FR-12 |
| AC-11 | Given a secret in a transcript entry, then the commit is blocked and nothing is pushed. | FR-11 |
| AC-12 | Given the engine killed mid-session, when it restarts, then the run is `interrupted`, resumes, and no retry is counted. | FR-14 |
| AC-13 | Given the Docker runtime is stopped, when a session would start, then no session starts and the owner is told why. | FR-8 |

## 5. Constraints
- TypeScript on Node (ADR 0001). Windows, macOS and Linux; Windows needs
  Docker Desktop with the WSL2 back end (ADR 0015).
- Every new library, tool and image gets a security review and an
  Architecture decision before use (S4.1), is pinned (S4.3) and checked for
  CVEs in CI (S4.4).
- The engine's own repo maturity is Rapid prototype until promoted, so the
  bar in `maturity-levels.md` applies.
- No change to the skill or the channel contract is needed for this
  increment, except as OQ-8 and OQ-2 decide.
- Change-controlled files (contracts, agent files, CI) change only through
  hygiene items H-0080 to H-0089, in their own PRs.

## 6. Edge cases
- Two clients open the same feature; a takeover during a pending approval.
- The owner approves on the phone after the device code expired.
- GitHub unreachable during approval (fail closed, no fallback).
- The analyst asks the same question twice, or asks while research runs.
- The container dies mid-turn; the engine restarts while a session is open.
- A feature started while its project is paused or disabled.
- `factory/state` has commits the engine didn't make (another machine, the
  extension).
- Disk full while committing the transcript.

## 7. Dependencies
- F-005 skill and client; F-006 client (advisor kinds stay refused here).
- ADRs 0001, 0003, 0004, 0005, 0009, 0010, 0012, 0014, 0015.
- Contracts: Engine control channel v1.3, Role policy v2.4, Project manifest
  v1.1 (v1.2 and `enabled` are drafts), Agent report v1.1, Inbox item v1.1.
- The owner registers the GitHub OAuth app with device flow (ADR 0014).
- Docker Desktop on the owner's machine.
- External components, each pending its S4.1 review: the Claude Agent SDK
  and Claude Code inside the image, a base image, and whatever OQ-3 and OQ-5
  choose.

## 8. Assumptions
None yet. Any the analyst proposes are approved or rejected by the owner in
the interview, never recorded otherwise.

| Id | Assumption | Decision link | Status |
|---|---|---|---|

## 9. Security considerations
To be completed at Gate 1. Known from the ADRs and S9.7 (this feature has
external interactions, so it gets a STRIDE threat model at Gate 1):

| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | The device-flow token and the model credential never reach a log, a file in Git, an inbox item or an agent's prompt. | Analyst (ADR 0014, S3) | Draft |
| SR-2 | Fail closed on every check: config, authorization, approval, container start, proxy start, secrets scan. | Analyst (S5.1, ADR 0015) | Draft |
| SR-3 | Analyst tool output and owner text are data to the engine; the engine never executes or interprets them as commands. | Analyst (S6.1) | Draft |
| SR-4 | Each external action (GitHub calls, pushes) is logged with agent, action, target, time and approval id, without secrets. | Analyst (S9.6) | Draft |
| SR-5 | The allow list sits in the manifest it guards, so widening it is a manifest change: it needs an approved hygiene item, and the engine refuses an unsigned owner change to it (ADR 0015). For Gate 1 to review. | Analyst (OQ-2) | Draft |

## 10. Interface requirements
- Engine control channel v1.3: implemented as approved; no change expected.
- New: analyst-to-engine interview tools (OQ-8). An Interfaces decision.
- Project manifest: owner GitHub id, OAuth client id and allow list (OQ-2), drafted as H-0080. An Interfaces decision.
- The master repo ships only templates and placeholders; no owner's real values are ever committed to it (owner, 2026-11-11).
- Project manifest: `enabled` (ADR 0012) is not yet in the contract; needs
  its hygiene item before FR-2 can read it.

## 11. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Open questions for the owner
Asked one at a time in the interview. None is assumed.

| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | Is this the right first increment? | Product | Decided: real interviews end to end (owner, decision card, 2026-11-11) |
| OQ-2 | Where does the owner's factory config live (owner GitHub id, OAuth client id, allow list)? | Architecture, Interfaces | Decided: per project, in the project's config repo manifest (ADR 0010); nothing owner-specific in the master repo (owner, thread, 2026-11-11). Contract change drafted as H-0080. Project paths in a git-ignored file in the master repo clone (owner, thread, 2026-11-11; H-0081) |
| OQ-3 | Node can't read a socket peer's uid or pid, set a named pipe's ACL, or read a pipe client's SID, all of which the channel contract requires. How do we get them: a small FFI library, a native addon, or a separate helper program? | Architecture, Security | Decided: the koffi FFI library, subject to its S4.1 security review before it is approved for use (owner, decision card, 2026-11-11) |
| OQ-4 | Approve the Claude Agent SDK, and Claude Code inside the agent image, after their S4.1 review. | Architecture, Security | Open |
| OQ-5 | How the engine drives containers: the `docker` command line (no new library) or a Docker API library. And the egress proxy: written in the engine with Node's own modules, or an existing proxy image. | Architecture, Security | Open |
| OQ-6 | Which base image, pinned by digest. | Architecture, Security | Open |
| OQ-7 | How the model credential reaches a container and where the engine keeps it (subscription token from `claude setup-token`, or an API key), and where the factory token is stored. | Security | Open |
| OQ-8 | The analyst-to-engine tools: names, parameters and results. | Interfaces | Open |
| OQ-9 | Test tools for the engine: Vitest, as the extension uses, or Node's built-in runner. | Architecture | Open |

## 13. Increments (first one chosen by the owner, OQ-1; later order open)
1. **This feature:** engine core, channel, phone approval, analyst and web
   reader in containers, transcript, interview readiness checks.
2. **Advisor:** the engine half of F-006 (its dev report's deferred list).
3. **Requirements to ready:** Security Gate 1 runs, the engine reads the
   inbox, owner actions count only when SSH-signed (ADR 0015), with the F-001
   follow-up that signs them; full readiness gate.
4. **Build to PR:** stages 5 to 9, CI gate, PR through the factory token.
5. **Budgets and control:** ADR 0012 budgets, `project.*` methods, the
   Factory view.
6. **Merge conflicts:** ADR 0013.

## 14. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-11 | Draft from the specs, ADRs and the F-005 and F-006 deferred lists, before the owner interview | — |
| 2 | 2026-11-11 | OQ-1: first increment is real interviews end to end | Owner, 2026-11-11 (decision card) |
| 3 | 2026-11-11 | OQ-2: owner config goes per project in the config repo manifest; master repo holds templates only | Owner, 2026-11-11 (thread) |
| 4 | 2026-11-11 | OQ-2: the list of project paths is a git-ignored file in the master repo clone | Owner, 2026-11-11 (thread) |
| 5 | 2026-11-11 | OQ-3: OS checks through the koffi FFI library, pending its S4.1 review | Owner, 2026-11-11 (decision card) |
