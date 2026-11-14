# 0026. Agents run on the owner's PC without containers until Beta

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner
- **Decision item:** decision card, 2026-11-13 ("Drop containers until
  Beta"); write-up in [proposal 0031](../proposals/0031-agents-on-host-until-beta.md);
  hygiene H-0200

## Problem
ADR 0015 runs every agent session in its own container. That needs Docker
Desktop on every machine that runs the engine, adds seconds to each session,
and leaves open where each project's build toolchain comes from (F-015
OQ-6). The owner judged a worktree per agent sufficient to start with, with
containers as a later improvement.

Claude Code's isolated worktree (the subagent `isolation: worktree` field)
is not what provides that worktree here. The engine runs each role as its
own Agent SDK session, never as a Claude Code subagent (ADR 0001), and
already gives each session its own git worktree on its own branch
(ADR 0004). Claude Code's worktree checks only stop edits and git from
reaching the main checkout. They do not track what shell commands write,
and they do not limit reads or network
([Claude Code docs, worktrees](https://code.claude.com/docs/en/worktrees.md#how-claude-code-enforces-isolation)).

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Keep a container per session (ADR 0015) | Built and tested; every approved guarantee holds | Docker Desktop required; slower start; toolchain images per project |
| **No containers until Beta (chosen)** | No Docker for agents; faster start; agents use the toolchain on the PC; F-015 OQ-6 goes away for now | Agent-run code has the owner's OS permissions, credentials and network; rework across the engine and five specs |
| No containers, agents under a separate Windows account | Owner's home and tokens out of reach | Network and resource limits still lost; admin prompt at setup |
| Claude Code subagents with `isolation: worktree` | No engine session code | Gates depend on prompt-following (rejected in ADR 0001); worktrees branch from main, not the feature branch; no read, network or shell-write limits |

## Implications
- **Kept:** a worktree and branch per session (ADR 0004); the engine's
  tool gate on every file-tool read and write, including the secret-file and
  change-controlled denies; the end-of-session check of the branch diff
  against the role's write rules; the command allowlist for every role
  except the software developer and test engineer; per-session turn,
  token and time caps; the credential proxy, now a host process, so the
  model credential is still never handed to an agent; path matching and
  signed owner actions (ADR 0015 decisions 2 and 3).
- **Lost until Beta:** the container's read, network, resource and
  privilege boundary. Any command an agent may run, and any test or build
  command the engine runs, runs as the owner on the owner's PC. The software developer
  and test engineer have a full shell until Beta (F-015, owner,
  2026-11-14), so for them nothing limits commands but the end-of-session
  write check.
- **Accepted risks (stated to the owner, accepted 2026-11-13, expire at
  Beta):**
  1. Code an agent runs (package install scripts, tests, a command planted
     by prompt injection) can read the owner's GitHub token and act as the
     owner: merge a PR, approve an inbox item, push. GitHub can't tell this
     from the owner. ADR 0017's residual risk assumed agents had no token.
     Prompt injection is [OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/);
     broad permissions make it [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).
  2. That code can read SSH keys, cloud logins, the owner's Claude login and
     other repos, and send them to any host. This is what the 2025
     "Shai-Hulud" npm worm did on developer machines
     ([CISA, 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)).
  3. An SSH signing key without a passphrase can sign a forged owner action
     (ADR 0015 decision 3).
  4. No CPU, memory or process limits: a runaway session or test can slow
     or hang the PC.
  5. The engine's socket and `engine.json` are protected from file tools
     only, not from commands.
- Roles with no shell (analyst, web reader, advisor, security reviewer,
  readiness, triager, evaluator, context hygiene) are limited by the tool
  gate. Their exposure is lower but no longer OS-enforced.
- Claude Code's own sandbox can't replace the container here, because on
  native Windows it runs commands unsandboxed
  ([Claude Code docs, sandboxing](https://code.claude.com/docs/en/sandboxing.md)).
- **Maintenance:** the container code (`engine/src/docker/`,
  `engine/src/agent/sandbox.ts`) stays for the return at Beta, but is unused
  for agent sessions until then.

## Decision
1. Until Beta, the engine runs each agent session as an Agent SDK session on
   the owner's PC, with the session's own worktree as its working folder.
   It does not use Claude Code subagents or their `isolation: worktree`
   field.
2. ADR 0015 decision 1 (container per session) is suspended until Beta. Its
   decisions 2 (path matching) and 3 (signed owner actions) stay in force.
3. Risks 1 to 5 above are accepted by the owner until Beta. Containers must
   be back, under a new Security decision, before the factory or any project
   it runs is promoted to Beta. The orchestrator blocks that promotion until
   they are.
4. Approved requirements that rely on containers reopen, and each owning
   feature records the change with the owner:

   | Spec | Requirements | What they assumed |
   |---|---|---|
   | Role policy contract v2.6 | Container per agent session (mounts, credentials, image, network, write rules, fail closed) | Container boundary (H-0201 drafts the change) |
   | F-007 | FR-8, AC-16, SR-6, SR-9, SR-18 (container limits) | Analyst and web reader in containers on an internal network |
   | F-008 | FR-2, AC-3, SR-6, SR-8 | Security and Testability Review reviewer in a container; report read after the container is gone |
   | F-010 | FR-4, AC-5, SR-2, SR-25; A-2 | Triager and confirmation with no network and no writable mount; reproduction in the agent container |
   | F-016 (draft) | SR-11, AC-14 | Readiness session under the reviewer's container rules |
   | F-015 (draft) | FR-3, FR-6, OQ-6 | Developer, test engineer and the engine's test run in containers |
   | F-006 | FR-7, SR-9 | A future advisor shell checked against an OS sandbox |

## Consequences
- Docker Desktop is no longer needed for agent sessions until Beta.
- The F-013 LiteLLM router stays in its own container, started only when a
  project configures a model endpoint (owner, 2026-11-14, decision card).
  Docker is needed only for those projects. F-013's container requirements
  and its accepted LiteLLM CVEs stand unchanged. An endpoint rung still
  goes only to a role with no shell and no network tool (F-013 SR-9), and
  that rule now rests on the role's tool list.
- Amends ADR 0004 (back to worktree plus engine policy, its own original
  position) and suspends ADR 0015 decision 1 until Beta. ADR 0017's residual
  risk widens to include agent-run code until Beta.
- Until Beta the engine asks the owner, through the inbox, before any agent
  runs a command naming a credentialed program such as `gh`, `aws` or
  `railway` (Role policy v2.7, owner, 2026-11-14). It doesn't cover
  programs started by code an agent runs.
- Security standard S8 (least privilege) has a recorded, time-limited
  exception for agent-run code.
- Rules out running the factory's roles as Claude Code subagents.
