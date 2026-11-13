# 0019. Configured model endpoints are upstreams of the credential gateway

- **Status:** Proposed (the one-server version was approved 2026-11-13; this generalized version needs re-approval)
- **Date:** 2026-11-13
- **Decided by:** owner (thread "Add local LLM as model provider", decision card)
- **Decision item:** F-013 OQ-2, H-0138

## Problem
F-013 lets agent roles run on model APIs other than Claude: the owner's LAN
LLM server first, and any endpoint the owner configures later. Agents run
Claude Code in containers that can reach only the engine's egress proxy,
and the proxy refuses private addresses (F-007 SR-8). Their model requests
go to the proxy's credential gateway, which forwards them to
`api.anthropic.com` with the real credential.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. The gateway forwards to configured endpoints, chosen per session by the engine** | Agents, containers and SR-8 don't change; the agent never sees an address or key; the engine picks the endpoint when it grants the session | The gateway now holds several upstreams and keys, and one class (private endpoints) may be plain HTTP (F-013 SR-5) |
| B. Endpoint-rung containers get network access to their endpoint | No gateway change | Breaks SR-8 for every such agent; the agent learns the address and holds the key |

## Implications
- **Security:** the engine resolves each endpoint on the PC, classes it
  private or public, and pins the address per session (F-013 SR-3). Public
  endpoints need HTTPS and a key (SR-12); private ones may be plain HTTP
  with no key, a risk the owner accepted (SR-5). Each key goes only to its
  own endpoint, and the gateway follows no redirects (SR-13). Endpoint rungs
  are limited to read-only roles (SR-9).
- **Maintenance:** the gateway's body checks apply to every upstream; each
  endpoint uses the same `/v1/messages` and `/v1/messages/count_tokens`
  paths (Anthropic format, F-013 OQ-6).
- **Cost:** metered endpoints count against project budgets; `local`
  endpoints don't (F-013 FR-13).

## Decision
Option A. A session grant names its upstream: `anthropic` or a configured
endpoint name. The gateway forwards to that upstream only, with that
upstream's credential only.

## Consequences
- Agents and their containers are unchanged by which endpoint a rung uses.
- A new API format (for example OpenAI chat-completions) would be a
  translator inside the gateway, with its own spec and Security review.
- Rules out giving agent containers direct access to model endpoints.
