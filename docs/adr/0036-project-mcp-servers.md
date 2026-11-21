# 0036. Projects add their own MCP servers, declared in the manifest

- **Status:** Accepted
- **Date:** 2026-11-21
- **Decided by:** owner
- **Decision item:** F-025 decision cards, 2026-11-21 (23:06Z, 23:06Z, 23:07Z, 23:16Z), spec v1 sign-off (23:19Z), H-0274 (23:22Z)

## Problem

Agent sessions get only the engine's own `factory` MCP server. A project
that wants its agents to use another tool (a database, an issue tracker,
documentation search) has no way to give it to them.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Local and remote servers | Covers servers that ship only as a command and hosted ones | A local server runs as the owner and the proxy can't limit it |
| Remote (https) only | Every call goes through the egress proxy | Most servers ship as local commands |
| Local only | No remote sign-in or headers | No hosted servers |

For tools that act outside the factory: hold each call for the owner;
ask unless pre-approved per role; run freely when the role allows the
tool; read-only tools only.

## Implications

A local server runs on the owner's PC as the owner and can reach the
owner's files, signed-in tools and network until Beta (F-025 A-1, SR-8),
as full-shell roles do (ADR 0026). An allowed acting tool runs without
per-call approval, so content an agent read could steer it (F-025 A-3);
review finding 2 (High) stays open and must be closed before Beta.

## Decision

Projects declare MCP servers in `factory-project.yaml` (`mcp_servers`,
manifest v1.12), local or remote. A server is usable only after a CVE scan
of its locked dependency tree, a security review and the owner's approval,
recorded in an MCP server record pinned to its exact version, hash or URL
and to each tool's description hash (S9.8). Each role lists the servers or
single tools it may call (`mcp.allow`, role policy v2.13); the engine's
gate denies everything else. An allowed tool classed `acts` runs without
asking: this ADR grants that as an exemption from S9.2, like ADR 0017, and
the engine logs each such call (S9.6).

## Consequences

Projects can extend agents without changing the master factory, which
ships no servers. Server secrets live only in the OS credential store.
Before Beta: local servers move into containers with the agents, and the
acting-tool exemption is revisited.
