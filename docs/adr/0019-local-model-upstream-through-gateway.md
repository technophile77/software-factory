# 0019. A local model is a second upstream of the credential gateway

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner (thread "Add local LLM as model provider", decision card)
- **Decision item:** F-013 OQ-2, H-0138

## Problem
F-013 lets agent roles run on the owner's LAN LLM server as well as Claude.
Agents run Claude Code in containers that can reach only the engine's egress
proxy, and the proxy refuses private addresses (F-007 SR-8). Their model
requests go to the proxy's credential gateway, which forwards them to
`api.anthropic.com` with the real credential. A LAN server is a private
address, so agents can't reach it as things stand.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. The gateway gets a second upstream, chosen per session by the engine** | Agents, containers and SR-8 don't change; the agent never sees the address; the engine picks the upstream when it grants the session | The gateway now speaks to two upstreams, one over plain HTTP (F-013 SR-5) |
| B. Local-rung containers get network access to the LAN server | No gateway change | Breaks SR-8 for every local agent; the agent learns the address and could reach other LAN hosts through a misconfiguration |

## Implications
- **Security:** the engine resolves the server's name on the PC, requires a
  private address and pins it per session (F-013 SR-3); the gateway connects
  only to the pinned address and never re-resolves. The Claude credential is
  never sent to the local upstream. The server has no key and uses plain HTTP,
  a risk the owner accepted (F-013 SR-5); SR-9 limits local rungs to
  read-only roles because of it.
- **Maintenance:** the gateway's body checks apply to both upstreams; the
  local upstream's paths are the same `/v1/messages` and
  `/v1/messages/count_tokens`.
- **Performance:** local requests get deadlines that scale with prompt size
  (F-013 FR-12) and fall back to Claude when the server is busy (FR-7).

## Decision
Option A. The session grant names its upstream (`anthropic` or `local`);
the gateway forwards to that upstream only.

## Consequences
- Agents and their containers are unchanged by which provider a rung uses.
- Another provider later would be another upstream in the same place, with
  its own spec and Security review.
- Rules out giving agent containers direct access to LAN hosts.
