# Feature: Local model provider

- **Id:** F-013
- **Status:** Draft (open questions OQ-1 to OQ-5 with the owner)
- **Requested by / date:** Alex, 2026-11-13 ("I want to also incorporate a
  local llm api"; "this model would be a good candidate for the security
  agent, judge, or any low end agent")
- **Spec version:** 1

## 1. Objective and business purpose
The owner runs an LLM server on their own LAN. Running some agent work on it
instead of the Claude API costs nothing per token and keeps that work off
third-party services. The owner wants the factory to use it alongside Claude
for agents whose work it can do well, and named the security reviewer, the
validation judge and the low-end roles as candidates.

The factory already decides each role's model by evidence (F-002): the
cheapest rung of the ladder that passes calibration, approved by the owner.
This feature makes the local model a rung like any other, so the same
evidence and the same approvals decide where it is used. It does not
switch any role on its own.

The endpoint is the owner's own machine on their LAN. Its address is
owner-specific and never goes into the public master repo.

## 2. Expected behavior
1. **Setup, once per PC.** The owner names the local server in a
   machine-local file next to `factory-projects.local.yaml` (git-ignored,
   writable only by the owner, like H-0081's paths file): its base URL and,
   if the server has one, the name of its API key in the OS credential
   store. The engine checks it at start: the address must be on a private
   network (FR-4), the server must answer, and the model it serves must be
   the one the ladder names. Problems are shown as a plain message in the
   engine status, never a stack trace.
2. **The local model is a rung.** The master ladder gets rungs whose
   provider is `local`, with a model name and no address, for example
   `local/qwen3.8-27b`. A PC without a local server just has those rungs
   unavailable; calibration skips them and says so.
3. **Agents don't change.** An agent on a local rung still runs Claude Code
   in its container. Its model requests go to the engine's credential
   gateway as today, and the gateway sends them to the local server instead
   of `api.anthropic.com` (OQ-2). The agent never learns the address.
4. **Choosing roles.** Which roles run locally is decided as F-002 decides
   every rung: calibration on the master tasks, then the role's own
   transcripts, then a hygiene item the owner approves. Before F-002's
   calibration is built, the owner can set a role to a local rung directly
   in `engine/config/models.yaml` through a hygiene item. Gate roles follow
   OQ-1.
5. **When the server is busy or down.** The server is shared with other
   work (on 2026-11-13 two of its four slots were busy with 57k and 94k
   token prompts and a 30-token test waited over 3 minutes). The engine
   sends at most a set number of sessions to it at once, and handles a
   timeout or refusal as OQ-5 decides.
6. **Reports.** Each agent report records the provider with the model, so
   run reviews, metrics and costs tell local work apart. A local rung's
   cost is $0 in `tokens` mode and 0% of plan in `subscription` mode; its
   tokens and time are still recorded.

## 3. Functional requirements
| Id | Requirement |
|---|---|
| FR-1 | A ladder rung (and, before F-002, a `models.yaml` entry) can name provider `local` with a model id. The master repo holds no host, address, port or key for it. |
| FR-2 | A machine-local file, `factory-providers.local.yaml` in the master clone, git-ignored, holds the local server's base URL, optional API key reference, the model id it serves, and a concurrency cap (default 1). It is refused unless only the owner can write it (as H-0081). |
| FR-3 | The engine reads the API key, if any, from the OS credential store, never from the file, an argument or an environment variable; it reaches the gateway on stdin as the Claude credential does today. |
| FR-4 | At start, and again before each local session, the engine resolves the host on the PC (so `.local` mDNS names work), requires every address to be in a private range (RFC 1918, RFC 4193 or link-local), and pins the address it checked for the session. Loopback is allowed only if the owner sets it explicitly. A public address is refused. |
| FR-5 | The gateway forwards a local-rung session's `/v1/messages` and `/v1/messages/count_tokens` requests, with the same body checks it applies today, to the pinned address only. The grant names the upstream; an agent cannot choose it. |
| FR-6 | The engine checks at start that the server lists the configured model (`GET /v1/models`) and that it answers an Anthropic Messages request with a tool call. A failing check marks the local rungs unavailable, with the reason. |
| FR-7 | No more than the configured number of local sessions run at once; others wait their turn, then follow OQ-5. |
| FR-8 | The agent report's `model` field carries the provider prefix (`local/...`); metrics, run reviews and the calibration result group by it. |
| FR-9 | A role on a local rung that fails its run is attributed and stepped up exactly as F-002 says; nothing here bypasses F-002's approvals. |
| FR-10 | Gate roles (security reviewer, validation judge) use the local model only as OQ-1 decides. |

## 4. Acceptance criteria
| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given the master repo, when it is searched, then no local host name, IP address, port or key appears in it (a CI check). | FR-1 |
| AC-2 | Given `factory-providers.local.yaml` writable by another user, when the engine starts, then local rungs are unavailable and the status says why. | FR-2 |
| AC-3 | Given a base URL whose name resolves to a public address, when the engine starts, then local rungs are unavailable. | FR-4 |
| AC-4 | Given a local-rung session, when the agent sends a model request, then it reaches the pinned address and not `api.anthropic.com`, and the Claude credential is not sent to it. | FR-3, FR-5 |
| AC-5 | Given a local-rung session, when the agent tries to reach the local server directly (not through the gateway), then the proxy refuses it (SR-8 unchanged). | FR-5 |
| AC-6 | Given a server that doesn't list the configured model, when the engine starts, then local rungs are unavailable with that reason. | FR-6 |
| AC-7 | Given a cap of 1 and two local-rung sessions starting, then the second waits until the first ends. | FR-7 |
| AC-8 | Given a local-rung run, when its report is written, then `model` starts with `local/` and its cost is 0. | FR-8 |
| AC-9 | Given the server times out, then the session follows the OQ-5 decision and the event is logged with the role and reason. | FR-7, OQ-5 |

## 5. Constraints
- Measured 2026-11-13 from the owner's PC: one model, `Qwen3.8-27B-Uncensored`
  (GGUF, Q4_K_M, 27.3B parameters, 262,144-token context, text and image
  input), served by llama.cpp's `llama-server` with 4 parallel slots, no API
  key, over plain HTTP. Speed and tool-call support are still being measured
  (§ 13 note).
- Claude Code needs the Anthropic Messages API, tool use and a large context
  (its system prompt and tools are tens of thousands of tokens). `llama-server`
  serves `/v1/messages`; whether this model's tool calls are reliable enough
  is what calibration measures.
- The server is shared with the owner's other work, so its speed varies.
- Change-controlled files touched: `engine/config/models.yaml`,
  `docs/interface-contracts.md`, the proxy, role policies if any.

## 6. Edge cases
- The `.local` name resolves to a different address later (DHCP, or someone
  answering mDNS for it): the check runs again before each session, and a
  non-private answer refuses it.
- The server's model is swapped for a different one: FR-6 catches it at the
  next check; a changed model means its calibration results no longer apply.
- A long agent session outlives a server restart: the request fails, and the
  run follows OQ-5.
- The model returns malformed tool calls: Claude Code reports an error; the
  run fails and F-002 attributes it to the role's rung.
- Prompt injection: this model is an "uncensored" fine-tune, with refusal
  training removed, so it may follow instructions planted in content it reads
  more readily than Claude (SR-6).

## 7. Dependencies
- F-002 (ladder, calibration, run reviews). Until it is built, FR-1's
  `models.yaml` path is the only way a role is put on the local model.
- Engine credential gateway and egress proxy (F-007, SR-6 to SR-9).
- The owner's LAN server (outside the factory).

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | `llama-server`'s Anthropic Messages endpoint works with Claude Code, including streaming and tool use. To be checked in a spike before build; a failure sends the spec back. | OQ-2 | Pending |
| A-2 | The local model's results count as F-002 calibration evidence the same way a Claude model's do: same tasks, same pass bar (F-002 A-2). | OQ-1 | Pending |

## 9. Security considerations
| Id | Requirement | Source (analyst / Gate 1) | Status |
|---|---|---|---|
| SR-1 | External service (S9.1): the owner's local LLM server only, read-and-generate (`GET /v1/models`, `POST /v1/messages`, `POST /v1/messages/count_tokens`). No other path. | Analyst (S9.1, S2.2) | Proposed |
| SR-2 | The address and key never appear in Git, logs, agent environment or reports (S3.1, S3.3); logs name the provider, not the host. | Analyst (S3.1) | Proposed |
| SR-3 | Only private addresses, checked and pinned per session (FR-4), so a misconfigured or hijacked name can't send project content to the internet (S9.4; CWE-918 server-side request forgery). | Analyst | Proposed |
| SR-4 | Agents still cannot reach private addresses (SR-8 of F-007 is unchanged); only the gateway reaches the local server, and only for a session the engine granted a local rung (S8.1). | Analyst (S8.1) | Proposed |
| SR-5 | Transport and authentication of the local server, per OQ-3. Risk to state: as found, the server takes requests from anyone on the LAN with no key, and traffic is plain HTTP, so prompts holding repo content cross the LAN unencrypted (CWE-319) and an `.local` name can be answered by any device on the LAN (mDNS is unauthenticated). | Analyst (S8.2; OWASP ASVS 5.0 V12, secure communication; NIST SP 800-53 SC-8) | Open (OQ-3) |
| SR-6 | Responses from the local model are untrusted input like any model output (S4.5, S6.1). The model's removed refusal training makes prompt injection likelier (OWASP Top 10 for LLM Applications 2025, LLM01), so it isn't used for a role that reads external content (the web reader) unless calibration includes injection tasks and the owner approves. | Analyst | Proposed |
| SR-7 | The model weights come from an outside fine-tune (S4.1): which file the server runs is recorded with each calibration result (name and size from `/v1/models`), so results tie to the weights tested (OWASP LLM03, supply chain). | Analyst (S4.1) | Proposed |

## 10. Interface requirements
Drafts, for the owner's approval once the open questions are decided:

- **H-0135 (Interfaces):** new contract *Local providers file v1.0*
  (`factory-providers.local.yaml`): `providers.local.base_url`,
  `providers.local.model`, `providers.local.api_key_ref` (optional, a
  credential store name), `providers.local.max_sessions` (default 1),
  `providers.local.allow_loopback` (default false).
- **H-0136 (Interfaces):** Agent report minor bump: `model` may carry a
  provider prefix (`local/<id>`); Tuning metrics and Calibration result
  group rungs by it. Additive.
- **H-0137 (Hygiene):** `.gitignore` adds `/factory-providers.local.yaml`;
  CI check for AC-1.
- **H-0138 (Architecture, if OQ-2 is (a)):** ADR 0019, a second model
  upstream through the credential gateway.
- **H-0139:** reserved for the OQ-1 outcome (amending F-002 A-3 if the owner
  picks that).

## 11. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 12. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-13 | Draft with OQ-1 to OQ-5, from the owner's request and a probe of the server | — |

## 13. Open questions
| Id | Question | Category | Status |
|---|---|---|---|
| OQ-1 | The owner named the security reviewer and judge as candidates, but F-002 A-3 (approved 2026-11-10) says those two never run below Sonnet/medium. (a) Keep A-3; the local model may run a gate role only as an extra, advisory first pass whose findings go to the Claude reviewer, which still decides. (b) Amend A-3: a gate role may move to the local rung once it passes F-002 calibration with A-2's strict bar (no missed Critical or High in any trial) and the owner approves. (c) Keep the local model to non-gate roles. **Recommended: (a) now, and (b) later only if the advisory runs show it matches the Claude reviewer.** | Security | Open |
| OQ-2 | How agents reach the local model. (a) The credential gateway gets a second upstream, chosen per session by the engine; agents and their containers don't change (ADR 0019). (b) Give local-rung containers network access to the LAN server. **Recommended: (a)**; (b) breaks SR-8 for every local agent. | Architecture | Open |
| OQ-3 | Securing the link to the server. (a) Require an API key (`llama-server --api-key`), stored in the OS credential store, plus the private-address pin; accept plain HTTP on the home LAN. (b) As (a), and also require TLS. (c) Use it as is: no key, plain HTTP. **Recommended: (a)**: one flag on the server and one credential entry; TLS needs a certificate to manage for little gain on a home LAN. | Security | Open |
| OQ-4 | Which roles to calibrate on the local model first. (a) The owner's picks: security reviewer and judge (per OQ-1), plus the low-end roles (web reader, project evaluator, context hygiene). (b) All roles, let calibration sort it out. **Recommended: (a)**; calibrating every role spends a lot of slow local time on roles it is unlikely to pass. | Product | Open |
| OQ-5 | When the local server is busy or down. (a) After a wait (default 10 minutes), the session falls back to the role's Claude rung and the run review notes it. (b) Wait, then stop the run with a Testing inbox item. **Recommended: (a)**: the server is shared, so waits will happen and the feature should keep moving; fallback costs Claude tokens. | Product | Open |

Probe note (2026-11-13): no project data was sent; the probe used a
generic `is_prime` prompt and a made-up weather tool. Measured speed and
tool-call results are added here when the server has a free slot.
