# F-025 development report

- **Feature:** F-025 Projects add their own MCP servers, spec v1 (approved 2026-11-21 23:19Z)
- **Contracts:** Project manifest v1.12, Role policy v2.13, MCP server record v1.0 (H-0270 to H-0274, approved 23:22Z)
- **Branch / PR:** `claude/project-thread-wfhcke`, PR #157

## What was built

| Part | Where | Covers |
|---|---|---|
| `mcp_servers` parsing: exact npm/PyPI versions, hashed absolute-path commands, https-only remote URLs, `{ secret: <key> }` values | `engine/src/config/mcp-servers.ts`, `config/manifest.ts`, `schemas/config.ts` | FR-1 to FR-4, AC-2, AC-3 |
| `mcp.allow` per role; repo overrides narrow only; names must be declared | `engine/src/policy/role-policy.ts` | FR-5, AC-6 |
| `mcp-secret/<project>/<server>/<key>` store items and `secret set` | `engine/src/secrets.ts`, `cli.ts` | FR-4, SR-1 |
| Servers and every role's `mcp.allow` pinned with the owner keys; `confirm` shows the change | `engine/src/config/pins.ts`, `config/confirm.ts` | FR-13, AC-11 |
| MCP server record schema | `engine/src/schemas/mcp-server-record.ts`, `docs/schemas/mcp-server-record-1.schema.json` | FR-6 |
| Minimal MCP client (stdio and streamable HTTP, `initialize` + `tools/list`, no redirects, 4 MiB cap) | `engine/src/mcp-client/client.ts` | SR-7, SR-10 |
| Per-session resolution: record match, installed-file hash, secrets, tool hashes, acting tools, remote hosts | `engine/src/agent/project-mcp.ts` | FR-6 to FR-9, SR-5, SR-7, SR-13, AC-7 |
| Session options and the tool gate: project servers beside `factory`, strict MCP config kept, acting calls logged | `engine/src/agent/session.ts`, `sdk.ts` | FR-7, SR-2, SR-6, AC-1, AC-5 |
| `mcp-launch`: Claude Code starts a local server through the engine, which passes on only the chosen env | `engine/src/cli.ts`, `agent/project-mcp.ts` (`launchSpec`) | FR-8, AC-8 |
| Remote server host granted to a proxied session for its life | `engine/src/agent/host.ts` | FR-9 |
| Start failure: build step stops with an item; option C runs it once without the server, and the agent is told | `engine/src/engine.ts` (`buildStopped`, `onAnswer`), `session.ts` | FR-10, SR-12, AC-10 |
| Approval: install into the server's own folder (npm with scripts off, uv with hashes, or a copied executable), OSV CVE check, tool listing, a read-only security reviewer session, the owner's Security item, the record written from the answer | `engine/src/mcp-approval/*.ts`, `engine.ts` (`startMcpApproval`, `runMcpReview`) | FR-6, SR-5, SR-6, SR-8, SR-9, S9.8 |
| Remote `factory/state` changes under `mcp/` refused, as for inbox records | `engine/src/engine.ts` (`checkRemote`) | FR-6 |
| `.mcp.json` in a worktree and `mcpServers` in an AGENT.md are logged as ignored | `engine/src/agent/host.ts`, `engine.ts` | FR-14, AC-12 |
| Secret values masked in the live transcript | `engine/src/engine.ts` (`maskMcp`) | SR-10 |
| `factory-engine mcp list` and `mcp check <server>` | `engine/src/mcp-approval/cli.ts`, `cli.ts` | FR-12, AC-13 |
| Commented example in the onboarding manifest template; nothing in the master repo | `plugins/software-factory/skills/onboard-repo/templates/factory-project.yaml` | FR-15 |

## Deviations and limits

1. **`mcp check` is stricter than SR-11.** It never starts an unapproved server. The engine's approval itself installs, scans and lists the tools, so a check before approval isn't needed.
2. **CVE check uses the OSV API** (`api.osv.dev`), the database osv-scanner reads, not the osv-scanner binary, which the engine doesn't ship. Only package names and versions are sent. An advisory with no stated severity counts as high.
3. **Install scripts are always off** (`install_scripts: false`). A package that needs its install script won't work. Allowing scripts per review would need its own decision.
4. **A missing install folder needs a new approval.** SR-5's reinstall from the recorded lockfile without asking again isn't built: the lockfile stays in the server's folder, not on `factory/state`.
5. **SR-10 redirect refusal covers the engine's own client.** Agent calls go through Claude Code's HTTP client. For a proxied role the egress proxy only allows the server's host, so a redirect to another host fails. A full-shell role isn't proxied (ADR 0026), and Claude Code's client follows the Fetch standard, which drops `Authorization` on a cross-origin redirect but not custom headers.
6. **FR-10's retry and run-without options are on build-stage sessions** (developer and test engineer). An analyst, reviewer or web-reader session whose server can't start fails through that stage's existing failure path.
7. **Container sessions get no project servers.** Only endpoint runs use containers until Beta (ADR 0026).
8. **Not run against a real package.** Installing and starting a real npm or PyPI MCP server from the registry was blocked in the cloud build environment. The npm and uv install paths are covered by unit tests of their parts only. The first real use on the owner's PC is the live check.

## Tests run locally

`engine`: `npm run typecheck`, and vitest on `test/f025-mcp-config`, `f025-project-mcp`, `f025-approval`, `f020-schemas`, `agent`, `host`, `engine`, `f016-acceptance`, `f021-inbox`, `build-lifecycle`, `f015-build`, `build-review`, `f016-run`, `run-tests-tool`, `commands`, `units`, `policy`, `acceptance/pinning`, `acceptance/secrets`, `f023-lease`, `f023-project-files`. All pass. The repository's docs checks (`check_docs.py`, `check_placeholders.py`, `scripts/tests`) pass. The onboarding plugin's `test_factory_check` shows the same 2 failures and 59 errors with and without this change. Its tools come from `setup_tools.py`, which this environment didn't run.
