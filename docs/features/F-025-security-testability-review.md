# F-025 Security and Testability Review (requirements review)

- **Feature:** F-025 Projects add their own MCP servers, spec v1
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-21
- **Maturity level:** Rapid prototype (the factory repo's level). Only
  Critical findings block there (`security-blocking.json`).
- **Result:** 9 findings: 0 Critical, 2 High, 4 Medium, 3 Low. Nothing
  blocks at Rapid prototype, but both Highs must be closed before Beta,
  which needs no open High. The owner's decisions of 2026-11-21 (local and
  remote servers; review, pin and owner approval; whole server or named
  tools) are not re-opened. Recommendations are proposed as SR-5 to SR-13
  in the spec, for the owner to approve. Finding 2 needs an owner decision.

| # | Criterion | Severity | Blocks? | Finding | Recommendation |
|---|---|---|---|---|---|
| 1 | S4.3, S4.4 | High | No | FR-2 pins only the top-level package. `npx --yes pkg@1.2.3` and `uvx pkg==1.2.3` resolve every transitive dependency fresh at each start, so code that was never scanned can run, and the CVE scan of FR-6 covers a tree that is not the one that runs. `npx` also prompts or installs into a shared cache the owner uses. | SR-5: at approval the engine installs a `package` server into its own folder per project and server (`<engine data>/mcp/<project>/<server>/`) and records the resulting lockfile (`package-lock.json`, or `uv` export with hashes) and its SHA-256 in the record. The CVE scan runs on that lockfile. Each start runs from that folder only (`npm ci --ignore-scripts` from the recorded lockfile when the folder is missing or its lockfile hash differs; `uv` with `--require-hashes`), never `npx --yes` or `uvx` resolving anew. Install scripts are off unless the record says the review allowed them. |
| 2 | S9.1, S9.2, S9.3 | High | No | MCP tools can act outside the factory: post messages, change tickets, write to a database, spend money. Today the spec lets any allowed tool run freely, and the same session also reads the tools' untrusted output, which S9.3 forbids from steering an S9.2 action. | SR-6: the approval record classifies each tool as `reads` or `acts`. The reviewer reports facts (input schema, the server's docs, MCP annotations as hints only); the owner confirms the list on the approval item; a tool not in the record counts as `acts`. Owner decision OQ-1: what happens when an agent calls an `acts` tool. Recommended: each call is held for the owner as a Security item with the exact tool, server and arguments, using the existing held-command path (Role policy v2.7: waits, timeout denies); the owner may instead mark a tool "runs without asking" for one role in the approval, which is recorded and stated as an accepted risk. |
| 3 | S9.5, S6.1 | Medium | No | A remote server cannot be pinned by version, and a local one can change what it reports at run time. A server could change a tool's description or schema after approval (a "rug pull"), steering the agent or turning a read tool into an acting one. A whole-server entry would pick up new tools with no review. | SR-7: the record holds the SHA-256 of each approved tool's name, description and input schema. At session start the engine lists the server's tools and offers the agent only approved tools whose hash matches. A changed or new tool is left out and the engine files a Security item asking for a re-review; the session continues without it. "Whole server" means every tool in the record, not every tool the server reports. |
| 4 | S8.1, S8.4, S8.5 | Medium | No | A local server runs as the owner on the owner's PC. It can read any of the owner's files, use the owner's signed-in tools, and reach the network directly. A-1 states only the network part. This widens what runs on the PC beyond the agents themselves. | SR-8: A-1 states the whole risk (files, credentials, network) and the owner accepts it on the approval of each local server until Beta, as for full-shell roles (ADR 0026). FR-8 stays: the server gets a home and temp folder of its own (as agent sessions do, so it doesn't read the owner's tool config by default) and only its declared env. Back at Beta with containers. |
| 5 | S9.4, S3.2 | Medium | No | An agent can pass repo content, spec text or anything it read into a remote tool's arguments, which then leaves the PC. The spec doesn't state what data each server may receive. | SR-9: each server's record states, from the review, what it receives and where it sends it (for a remote server, its host; for a local one, the hosts it contacts per its docs). The approval item shows this to the owner. A server on a public SaaS service is flagged as "project data leaves the PC". |
| 6 | S3.1, S3.3, S9.4 | Medium | No | FR-4 sends a remote server's `headers` secrets to the URL. If the URL redirects, or a header secret is reused for a different server, the secret could reach another host. Secret values could also show up in the live transcript if a server echoes them or in `mcp check` output. | SR-10: a secret is bound to one server entry and sent only to that entry's exact origin; the engine refuses a redirect to another origin. Secret values are masked in logs, transcripts, items and `mcp check` output (the engine replaces any exact match before writing). Only static header or env secrets are supported in v1; OAuth sign-in for remote servers is out of scope. |
| 7 | S4.1, S6.2 | Low | No | `mcp check` on a pending server runs unreviewed code on the PC, which is how the review learns its tools. | SR-11: `mcp check` on a server with no approved record asks the owner in the console first ("not reviewed yet; it runs as you"), and runs only after the CVE scan of SR-5 found nothing Critical or High. Its output is untrusted text, printed escaped. |
| 8 | S5.1, S2.2 | Low | No | FR-10's "run without that server once" lets a session start without a tool its role expects, which could make an agent take another path (for example a shell command) to do the same thing. | SR-12: "run without" is an owner option on the item only, never chosen by the engine or an agent; the agent is told in its prompt which servers are missing. |
| 9 | S1.1, S1.4 | Low | No | `command` servers name an absolute path; `args` and `env` are strings from the manifest. The hash is checked before start, but the file could change between the check and the start. | SR-13: the engine copies a `command` executable into the server's own folder at approval and starts that copy after checking its hash; `args` are passed as an argument list with no shell. |

## Threat model (S9.7)

STRIDE over the parts this feature adds: the manifest entry, the engine
starting a server, the server, the agent session that calls it, and the
remote service.

| Threat | Where | Covered by |
|---|---|---|
| Spoofing | A changed manifest names a different package or URL under an approved name | FR-6 record match, FR-13 pinning, SR-3 |
| Spoofing | Remote host impersonated | https only (FR-3), redirect refusal (SR-10) |
| Tampering | Transitive dependency or executable changes after approval | SR-5, SR-13 |
| Tampering | Tool description or schema changes (rug pull) | SR-7 |
| Repudiation | Who approved a server, a tool's class, an `acts` call | Record and Security items carry the owner's approval id; held calls logged (S9.6) |
| Information disclosure | Secrets in env, headers, logs, transcripts | SR-1, SR-10, FR-8 |
| Information disclosure | Project data sent to a remote service | SR-9 |
| Denial of service | Server hangs or floods output | FR-10, FR-11 caps, engine hang watchdog |
| Elevation of privilege | Agent calls a tool its role lacks | SR-2, FR-7 gate |
| Elevation of privilege | Injected content steers an acting tool | SR-4, SR-6 (OQ-1) |
| Elevation of privilege | Local server reads owner's files and credentials | SR-8 (accepted until Beta) |

OWASP Top 10 for Agentic Applications: tool misuse (SR-2, SR-6), prompt
injection via tool output and descriptions (SR-4, SR-7), data leaks (SR-9,
SR-10), identity abuse (agents get no credential, FR-8, S9.6), supply chain
(SR-5, SR-13).

## Testability

Every AC can be tested in engine CI with no network: a fake stdio MCP
server (a small Node script in `engine/test/fixtures/`) and a local http
server stand in for real ones, and the SDK binding is already faked in the
session tests. SR-5 needs an npm install test against a local tarball
(`npm pack` of the fixture), not the registry. SR-7 is tested by changing
the fixture's description between two starts. SR-6 reuses the held-command
tests. Windows runs the stdio fixture in the existing `test:platform`
subset.

**Already covered by the spec or decisions:** deny by default per role
(FR-5, FR-7, SR-2); secrets only in the OS store (FR-4, SR-1); local servers
get none of the session's credentials (FR-8); exact pins and re-approval on
change (FR-2, FR-6, SR-3); worktree `.mcp.json` and AGENT.md `mcpServers`
ignored (FR-14); config changes pinned until the owner confirms (FR-13);
nothing owner-specific in the master repo (FR-15).
