# Feature: Projects add their own MCP servers

- **Id:** F-025
- **Status:** v1 Approved (owner sign-off 2026-11-21 23:19Z, decision card); v2 Approved (owner, decision card, 2026-11-27 05:17Z)
- **Requested by / date:** Alex, 2026-11-21 ("I want to allow users to add
  their own MCP servers into their project and agents.")
- **Spec version:** 2
- **Depends on:** F-007 (engine, manifest pinning SR-5), F-015 (agents on the
  host, ADR 0026), F-020 (JSON Schemas for hand-edited YAML), F-021 (console
  items)

## 1. Objective and business purpose

Today every agent session gets exactly one MCP server, the engine's own
in-process `factory` server, and nothing else (`strictMcpConfig`, no setting
sources). A project that wants its agents to use another tool, such as a
database, an issue tracker, a design tool or documentation search, has no
way to give it to them. This feature lets a project declare its own MCP
servers once and choose, per agent role, which of them (or which of their
tools) each agent gets. The core and project-added roles use the same
mechanism.

## 2. Expected behavior

The owner adds a server to the project's `factory-project.yaml` in the
private config repo, either as a local server the engine starts on the
owner's PC, or as a remote https server. Any key or token it needs is
stored in the OS credential store with `factory-engine secret set`, never in
the YAML. Before agents may use it, the server goes through the approval in
FR-6. The owner then lists the server, or some of its tools, under a role's
policy. `factory-engine mcp check <server>` starts the server once and
prints its tools, so the owner can pick them.

v2 (owner, 2026-11-27, D-0020: "each allowed method must be reviewed"):
the review gives a verdict on each tool a role is allowed, not one verdict
on the whole server. The owner approves all of those tools or only the
lower-risk ones, and "Request changes" sends the owner's note back to the
reviewer for a new review instead of only recording it.

When the engine starts a session for that role, it adds the allowed
servers to the session next to `factory`. The agent sees only the tools its
role allows; a call to any other tool is refused by the engine's tool gate.

## 3. Functional requirements

| Id | Requirement |
|---|---|
| FR-1 | Project manifest v1.12 adds optional top-level `mcp_servers`: a list of servers, each with a unique `name` (`^[a-z][a-z0-9-]{0,31}$`, never `factory`) and exactly one of `local` or `remote`. Hand-edited, so it stays YAML, checked by `factory-project-1.schema.json` (F-020). |
| FR-2 | A `local` server (owner, 2026-11-21: local and remote) is started by the engine on the owner's PC with no shell. It is one of: `package: { ecosystem: npm \| pypi, name, version }`, which the engine runs as `npx --yes <name>@<version>` or `uvx <name>==<version>`, with optional `args`; or `command: [<absolute path>, args...]` with `sha256` of that executable, checked before every start. A version range, tag or `latest` is refused. |
| FR-3 | A `remote` server has `url` (https only, no user info) and optional `headers`. |
| FR-4 | `env` (local) and `headers` (remote) values are either a literal string or `{ secret: <key> }`. A secret is read from the OS credential store item `mcp-secret/<project>/<server>/<key>` (`<key>` matches `^[a-z0-9_-]{1,32}$`), set with `factory-engine secret set mcp-secret/<project>/<server>/<key>`. A literal value that looks like a credential (the existing gitleaks rules) is refused with a message to use a secret. |
| FR-5 | Role policy v2.13 adds `mcp.allow` to a role: a list of `<server>` (all its tools) or `<server>/<tool>` (one tool). Default empty. A name not in `mcp_servers` is refused when the manifest is read. A repo override may narrow `mcp.allow`, never add to it. Owner, 2026-11-21 23:07Z (whole server or named tools). |
| FR-6 | A server is usable only when its manifest entry matches an approved MCP server record (`.factory/mcp/<server>.json`, schema `mcp-server-record/1.0`) on the same name, kind, and version or `sha256` or `url`. The record is made by the approval: for `package`, the engine runs its CVE scan (osv-scanner, as for libraries); the security reviewer reviews the server against `security-standards.md` S4.1 and S9.7 and reports facts in JSON; the owner approves on a Security item. A changed version, hash or URL needs a new record. Owner, 2026-11-21 23:06Z (review, pin, owner approves). |
| FR-7 | At session start the engine passes the allowed servers as SDK `mcpServers` entries, keeps `strictMcpConfig: true` and `settingSources: []`, and puts only the allowed tools (`mcp__<server>__<tool>`, or every tool of a whole-server entry) in `allowedTools`. `toolGate` allows such a call only if the role's `mcp.allow` covers it, and denies every other `mcp__` name. |
| FR-8 | A local server's environment is the platform base variables, `PATH`, and its own `env`, nothing else of the engine's or the session's: no gateway credential, no factory token, no other server's secrets. Its working folder is the session's worktree. Its process tree ends with the session. |
| FR-9 | For a role that goes through the egress proxy, a remote server's host is added to that session's proxy grant for the session only. A local server gets the session's `HTTPS_PROXY` when the role has one, but the proxy cannot enforce it (A-1). |
| FR-10 | If an allowed server fails to start or to list its tools, the session does not start: the engine files a Testing item naming the server and the error (no secret values), with options to retry or to run without that server once. No dead end (F-019 FR-21). |
| FR-11 | Every MCP tool result is marked untrusted in the session, capped at the existing tool result byte limit, and never read by the engine as a report, command or path (as SR-7 of F-020). |
| FR-12 | `factory-engine mcp list` shows each server, its approval state, and which roles get which tools. `factory-engine mcp check <server>` starts an approved or pending server once, outside any agent session, and prints its tool names and descriptions. |
| FR-13 | `mcp_servers` and every role's `mcp.allow` are pinned with `owner.*` and `enabled` (F-007 SR-5): a change on the config repo's `main` is not used until the owner confirms it in the console. |
| FR-14 | A project `AGENT.md` with `mcpServers` in its frontmatter, or a `.mcp.json` in a worktree, is never read for a session. The engine says so in the log when it sees one, once per start. |
| FR-15 | The master factory repo ships no servers. `templates/` gets a commented example with placeholders only. |
| FR-16 | v2. The review covers the server's **allowed tools**: every tool named by some role's `mcp.allow`, plus every listed tool for a whole-server entry. The reviewer sees the full tool list for context and reports, for each allowed tool: `class` (`reads` or `acts`), `risk` (`none`, `low`, `medium`, `high`, `critical`, on the `security-standards.md` severity scale), and why, with any finding tied to the tool it is about. Tools no role allows are neither reviewed nor put in the record. |
| FR-17 | v2. The approval item lists each allowed tool on its own line with its class, risk and one-line reason, then the server-level facts (pin, CVE check, data, findings). Options: **A** approve all the listed tools; **B** don't approve; **C**, only when some but not all tools are rated `high` or `critical`, approve only the tools rated `medium` or lower. Code picks the recommendation: B when the CVE check has a Critical or High, a server-level finding is Critical or High, or every tool is rated `high` or above; C when some are; otherwise A. |
| FR-18 | v2. The record holds only the tools the owner approved, each with its class, risk and description hash. At session start a role gets the tools that are both in its `mcp.allow` and in the record; a tool it allows that isn't in the record is left out, the session still starts, the agent is told which tools are missing, and the log says why. |
| FR-19 | v2. "Request changes" or "Ask for more research" with a note on the approval item runs the review again with the owner's note given to the reviewer as the owner's words, and files a new item that replaces the old one. No dead end (F-019 FR-21): an answer that isn't A, B or C never only records. |
| FR-20 | v2. When `mcp.allow` later names a tool the record lacks, the engine reviews only the new tools and files an item for them; the tools already approved keep working meanwhile. After B, the server is not reviewed again until its manifest entry or the roles' `mcp.allow` for it changes; a session that needs it says it was declined and names the item. |

## 4. Acceptance criteria

| Id | Given / When / Then | Covers |
|---|---|---|
| AC-1 | Given a manifest with a `local` npm server pinned to an exact version and an approved record, and a role allowing it, when a session for that role starts, then the SDK options carry that server and `factory`, `strictMcpConfig` is true, and its tools are in `allowedTools`. | FR-1, FR-2, FR-7 |
| AC-2 | Given `version: ^1.2.0`, `latest`, or a missing `sha256` on a `command` server, when the manifest is read, then the project stops with the file and key path. | FR-2 |
| AC-3 | Given a `remote` server with an `http://` URL or user info in the URL, when the manifest is read, then it is refused. | FR-3 |
| AC-4 | Given an `env` value `{ secret: api_key }` and that item in the credential store, when the server starts, then its env holds the value, and the value appears in no log, transcript, item or record. Given a literal value matching a gitleaks rule, the manifest is refused. | FR-4 |
| AC-5 | Given a role allowing `db/query` only, when the agent calls `mcp__db__query` it runs, and when it calls `mcp__db__drop` it is denied by the gate. A role without `mcp.allow` gets no server added. | FR-5, FR-7 |
| AC-6 | Given a repo override that adds a server to `mcp.allow`, when the manifest is read, then it is refused. | FR-5 |
| AC-7 | Given a manifest version that differs from the approved record's, when a session would start, then the server is not added and the session does not start; the engine files the approval request instead. | FR-6 |
| AC-8 | Given a local server, when it starts, then its env holds none of: the gateway credential, `ANTHROPIC_*`, the factory token, another server's secret. | FR-8 |
| AC-9 | Given a proxied role and a remote server on `mcp.example.test`, when the session runs, then that host is in its grant, and is gone when the session ends. | FR-9 |
| AC-10 | Given a server whose command exits at once, when a session starts, then a Testing item names the server and offers retry and run-without, and nothing hangs. | FR-10 |
| AC-11 | Given a changed `mcp_servers` on `main`, when the engine reads it, then the pinned version stays in use until the owner confirms. | FR-13 |
| AC-12 | Given a worktree `.mcp.json` and an `AGENT.md` with `mcpServers`, when a session starts, then neither server is started. | FR-14 |
| AC-13 | `mcp list` and `mcp check` print what FR-12 says, for an approved server and a fake stdio server in the tests. | FR-12 |
| AC-14 | Given a server with 30 tools and roles allowing 6 of them, when the review runs, then the reviewer's turn asks for a verdict on those 6 only, and the record and item list only those 6. | FR-16, FR-18 |
| AC-15 | Given a review rating one of six allowed tools `high` and a clean CVE check, then the item offers A, B and C, recommends C, and answering C writes a record with the other five; a role allowing all six then gets five, and its session starts. | FR-17, FR-18 |
| AC-16 | Given "Request changes" with a note on the approval item, then a new review runs whose turn holds the note as the owner's words, and a new item replaces the old one. | FR-19 |
| AC-17 | Given an approved record and a role newly allowing one more tool, then only that tool is reviewed, and the approved tools keep working until the owner answers. Given B, then no new review starts until the entry or the allow list changes. | FR-20 |

## 5. Constraints

- No new runtime dependency in the engine: the Agent SDK (pinned) already
  takes stdio and http `mcpServers`; osv-scanner is already used.
- `npx` and `uvx` must be on the owner's PATH for `package` servers; the
  engine says which is missing.
- Windows and Linux both, as the rest of the engine.
- Agent data and records are JSON with a schema (H-0240); the manifest
  stays YAML (F-020).

## 6. Edge cases

- Two servers expose a tool with the same name: names are per server
  (`mcp__<server>__<tool>`), so no clash.
- A server adds a tool after approval: a whole-server entry gets it only
  after it is reviewed and approved (FR-20, SR-7); a named-tool entry does
  not. A new tool shows in `mcp list` as new.
- The owner wants a different subset from A or C: they narrow the roles'
  `mcp.allow` in the manifest (a pinned key, confirmed in the console), and
  only the remaining tools are reviewed (FR-16).
- A server's tool descriptions or results try to steer the agent (prompt
  injection): FR-11; the gate still limits what the agent can call.
- A secret item is missing: the server does not start; FR-10 item names the
  missing key, not a value.
- The same server name in two projects: secrets and records are per project.

## 7. Dependencies

F-007, F-015, F-019, F-020, F-021 (all merged).

## 8. Assumptions

| Id | Assumption | Decision link | Status |
|---|---|---|---|
| A-1 | A local server runs as the owner on the owner's PC: it can read the owner's files, use the owner's signed-in tools, and reach the network as the owner would; the engine can't limit it (SR-8). Accepted until Beta like full-shell roles (ADR 0026). | Owner card 2026-11-21 23:06Z (local and remote) | Approved (owner, 2026-11-21 23:19Z); accepted again on each local server's approval (SR-8) |
| A-3 | An allowed `acts` tool runs without the owner's approval per call. Content an agent read (a web page, issue text, another tool's output) could steer it into posting, changing or deleting something outside the factory. Accepted by the owner; review finding 2 (High) stays open until Beta, which needs no open High. | Owner card 2026-11-21 23:16Z | Accepted |
| A-2 | Exact-version npm and PyPI packages, plus a hashed executable, cover the local servers projects need now. | Owner sign-off 2026-11-21 23:19Z | Approved |

## 9. Security considerations

| Id | Requirement | Source | Status |
|---|---|---|---|
| SR-1 | Secrets for servers only in the OS credential store under `mcp-secret/<project>/<server>/<key>`; never in YAML, logs, transcripts, items, records or another server's env. | Analyst | Approved (owner, 2026-11-21 23:19Z) |
| SR-2 | Deny by default: a role gets no server and no tool it does not list; the gate, not the model, enforces it. | Analyst | Approved (owner, 2026-11-21 23:19Z) |
| SR-3 | Local servers pinned by exact version or SHA-256; remote by exact URL; any change needs a new approval. | Analyst | Approved (owner, 2026-11-21 23:19Z) |
| SR-4 | MCP tool descriptions and results are untrusted input. | Analyst | Approved (owner, 2026-11-21 23:19Z) |

| SR-5 | Package servers are installed at approval into their own folder per project and server; the lockfile (with hashes) and its SHA-256 go in the record; the CVE scan runs on it; every start uses that install only (`npm ci --ignore-scripts`, `uv --require-hashes`), never a fresh `npx`/`uvx` resolve. Install scripts off unless the review allowed them. | Security and Testability Review #1 | Approved (owner, 2026-11-21 23:19Z) |
| SR-6 | Each approved tool is classified `reads` or `acts` in the record; the reviewer reports facts, the owner confirms; an unlisted tool counts as `acts`. The approval item lists the `acts` tools, so the owner sees what a role can do outside the factory before allowing it. An allowed `acts` tool runs without asking (OQ-1, owner, 2026-11-21 23:16Z); ADR 0036 grants this as an S9.2 exemption, like ADR 0017, and the engine logs each `acts` call with role, server, tool, time and the approval id (S9.6). | Security and Testability Review #2 | Approved (owner, 2026-11-21 23:19Z) |
| SR-7 | The record holds a SHA-256 of each approved tool's name, description and input schema. At start, only approved tools whose hash matches are offered; a changed or new tool is left out and a Security item asks for re-review. "Whole server" means every tool in the record. | Security and Testability Review #3 | Approved (owner, 2026-11-21 23:19Z) |
| SR-8 | A local server runs as the owner and can reach the owner's files, signed-in tools and network. The owner accepts this per local server on its approval, until Beta (ADR 0026). It gets its own home and temp folder and only its declared env. | Security and Testability Review #4 | Approved (owner, 2026-11-21 23:19Z) |
| SR-9 | Each record states what data the server receives and where it sends it; the approval item shows it, and flags servers that send project data off the PC. | Security and Testability Review #5 | Approved (owner, 2026-11-21 23:19Z) |
| SR-10 | A secret is sent only to its own server entry's exact origin; a redirect to another origin is refused. Secret values are masked in logs, transcripts, items and `mcp check` output. Static header or env secrets only; OAuth sign-in for remote servers is out of scope for v1. | Security and Testability Review #6 | Approved (owner, 2026-11-21 23:19Z) |
| SR-11 | `mcp check` on a server with no approved record asks the owner first and runs only after the CVE scan found nothing Critical or High; its output is printed escaped. | Security and Testability Review #7 | Approved (owner, 2026-11-21 23:19Z) |
| SR-12 | "Run without that server" (FR-10) is an owner option only; the agent is told which servers are missing. | Security and Testability Review #8 | Approved (owner, 2026-11-21 23:19Z) |
| SR-13 | A `command` executable is copied into the server's folder at approval and the copy is started after its hash check, with no shell. | Security and Testability Review #9 | Approved (owner, 2026-11-21 23:19Z) |

Review: `F-025-security-testability-review.md` (0 Critical, 2 High, 4
Medium, 3 Low; threat model included).

## Open questions

| Id | Question | Status |
|---|---|---|
| OQ-1 | When an agent calls a tool classified `acts` (SR-6), what happens? | Answered: allowed tools run freely (owner, decision card, 2026-11-21 23:16Z) |

## 10. Interface requirements

Applied as drafted, owner approval 2026-11-21 23:22Z (decision card).

- Project manifest v1.11 → v1.12: `mcp_servers` (H-0270, Interfaces).
- Role policy v2.12 → v2.13: `mcp.allow` (H-0271, Interfaces).
- New: MCP server record `mcp-server-record/1.0` with JSON Schema (H-0272).
- `factory-project-1.schema.json` and the role policy schema gain the new
  keys (H-0272).
- `security-standards.md`: what an MCP server review checks (H-0273,
  Security).
- v2: MCP server record v1.0 → v1.1: `tools[]` holds only the approved
  tools and gains `risk`; `approved` gains `choice` (`A` | `C`) (H-0278,
  Interfaces).
- v2: `security-standards.md` S9.8: the review gives a class and risk for
  each allowed tool, and the owner may approve a subset (H-0279, Security).
- ADR 0036: project MCP servers run on the host, declared in the manifest,
  pinned and reviewed (H-0274, Architecture).

## 11. Readiness gate

- [x] Clear objective
- [x] Expected behavior defined
- [x] Acceptance criteria testable
- [x] Constraints documented
- [x] Assumptions explicit
- [x] Blocking decisions resolved (approved, not deferred)

## 12. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-21 | First draft, with the owner's four answers and SR-5 to SR-13 | Owner, decision card, 2026-11-21 23:19Z |
| 2 | 2026-11-27 | FR-16 to FR-20, AC-14 to AC-17: per-tool review of the allowed tools, approve all or only the lower-risk ones, "Request changes" goes back to the reviewer, incremental review of newly allowed tools. From the owner's D-0020 answer and decision card 2026-11-27 05:12Z | Owner, decision card, 2026-11-27 05:17Z (with H-0278, H-0279) |
