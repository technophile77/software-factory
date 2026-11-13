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
| **A. The gateway forwards to configured endpoints, chosen per session by the engine** | Agents, containers and SR-8 don't change; the agent never sees an address or key; the engine picks the endpoint when it grants the session | The gateway gains one more upstream (LiteLLM), which holds the endpoint keys; one endpoint class (private) may be plain HTTP (F-013 SR-5) |
| B. Endpoint-rung containers get network access to their endpoint | No gateway change | Breaks SR-8 for every such agent; the agent learns the address and holds the key |

## Implications
- **Security:** LiteLLM holds the endpoint keys and is an external
  component under S4.1 (F-013 SR-16). The engine resolves each endpoint on the PC, classes it
  private or public, and pins the address per session (F-013 SR-3). Public
  endpoints need HTTPS and a key (SR-12); private ones may be plain HTTP
  with no key, a risk the owner accepted (SR-5). Each key goes only to its
  own endpoint, with no redirects followed (SR-13). Endpoint rungs
  are limited to read-only roles (SR-9).
- **Maintenance:** format translation, per-endpoint keys, budgets and
  rate limits come from LiteLLM, an existing open-source proxy, rather than
  factory code (owner: include it "instead of building another thing").
  The factory keeps one pinned LiteLLM image, upgraded by hygiene item
  after a conformance run (F-013 FR-15) and CVE checks (SR-16).
- **Cost:** `per_token` endpoints count against project budgets, `subscription`
  endpoints stop at their plan limits, and `local`
  endpoints don't (F-013 FR-13).

## Decision
Option A. A session grant names its upstream: `anthropic` or a configured
endpoint name. `anthropic` goes to `api.anthropic.com` as today. A
configured endpoint goes to the factory's LiteLLM container (F-013 OQ-8,
H-0139), which adds that endpoint's key, translates the format if needed,
and calls the endpoint through the egress proxy under a grant that allows
only the configured endpoints at their pinned addresses.

## Consequences
- Agents and their containers are unchanged by which endpoint a rung uses.
- Any API format LiteLLM supports can be added by configuration; the
  factory writes no translator. LiteLLM becomes a security-relevant
  dependency: it holds the endpoint keys, so it runs locked down (F-013
  SR-16) and its upgrades are change-controlled.
- Rules out giving agent containers direct access to model endpoints.
