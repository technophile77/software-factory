# F-005 External component review: MCP TypeScript SDK (S4.1, SR-19)

- **Component:** `@modelcontextprotocol/sdk` (npm), MIT, version reviewed
  1.32.2 (published 2026-10-23, so past the 14-day quarantine used for
  other engine components)
- **Purpose in the factory:** the stdio MCP server of the engine's `mcp`
  subcommand, which serves the spec interview's tools to Claude Code
  (ADR 0025, F-005 v10 FR-1, FR-15). Hygiene item H-0174.
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Result:** **Pass, with the conditions below.** Approval is an
  Architecture decision for the owner (S4.1).
- **Owner decision:** approved with all three conditions, 2026-11-13.

How this was checked:
- the npm registry record for 1.32.2;
- `npm install --save-exact --ignore-scripts` in `engine/`, then
  `npm audit --omit=dev` on the result (2026-11-13);
- the project's GitHub security advisory page;
- an esbuild bundle of exactly the two modules the engine imports, with a
  metafile listing every package that ends up in it.

## Source and maintainers (S4.1)
- The repository is github.com/modelcontextprotocol/typescript-sdk, the
  protocol's official TypeScript SDK. Five npm maintainers are listed, two
  of them with anthropic.com addresses.
- 1.32.2 is published with npm provenance (SLSA v1 attestation), so the
  tarball traces back to the project's own CI build. Its integrity is
  `sha512-SWsVtH/0vULSQStoZ6xxH2K09Li8fXYTMC64ZeogCdpZ3XSi1eCPOByV1OpuJxuI3OcmHhosDWYyii07tpPsLw==`.
- Release pace: eight releases between 2026-03-25 and 2026-10-23.
- The engine already ships this exact version as a dependency of the
  pinned Agent SDK 0.3.311. Until now it was left uninstalled under
  `legacy-peer-deps`.

## Known vulnerabilities (S4.2, S4.4)
- `npm audit --omit=dev` after the install reports 0 vulnerabilities.
- The project's advisory page lists ten advisories. The oldest are
  [GHSA-w48q-cv73-mx4w](https://github.com/advisories/GHSA-w48q-cv73-mx4w)
  (DNS rebinding) and
  [GHSA-cqwc-fm46-7fff](https://github.com/advisories/GHSA-cqwc-fm46-7fff)
  (UriTemplate ReDoS). The newest are from October 2026. npm audit names
  none of them against 1.32.2. All ten concern code the engine doesn't
  use: the HTTP and SSE transports, OAuth, bearer authentication,
  experimental tasks, or one server instance shared between clients.
- OSV-Scanner in the engine CI checks the new lockfile entries on every
  change, as it does for every other engine dependency.

## Install scripts (S4.1)
None of the 95 packages the install adds has a `preinstall`, `install` or
`postinstall` script. The engine still installs with `--ignore-scripts`.

## What it pulls in (S4.1)
- The SDK has 17 direct dependencies, and the install adds 95 packages to
  the lockfile. Most of them belong to the HTTP transports and OAuth:
  express, hono, cors, jose and their dependencies.
- The bundle includes only what the engine imports
  (`server/mcp.js` and `server/stdio.js`). The esbuild metafile lists
  exactly these packages in it:
  - `@modelcontextprotocol/sdk`
  - `ajv`, `ajv-formats`, `fast-deep-equal`, `fast-uri` and
    `json-schema-traverse` (JSON Schema validation)
  - `zod-to-json-schema`
  - `zod`, already an engine dependency, which deduplicates to 4.6.7

  No HTTP server or OAuth code is in `dist/engine.js`.

## What it can do, and what it needs (S8)
- The stdio transport reads JSON-RPC from the process's stdin and writes to
  its stdout. It opens no port and makes no network calls.
- Files and credentials: none.
- The MCP mode's own reach is the client the Python script had: it reads
  `engine.json` and the owner's document, and connects to the engine
  channel. F-005 SR-1, SR-7 and SR-9 still apply.
- Node 18 or newer. The engine targets Node 22.

## Conditions (SR-19)
1. Exact pin in `engine/package.json` and the committed lockfile. A new
   release is adopted no sooner than 14 days after publication, unless it
   fixes a CVE in a path the engine uses.
2. Only `@modelcontextprotocol/sdk/server/mcp.js` and
   `@modelcontextprotocol/sdk/server/stdio.js` are imported. A unit test
   checks the bundle's metafile for express, hono, cors and jose and fails
   if any of them appears.
3. One server instance per process with one stdio transport, never shared,
   which keeps the engine out of the shared-instance advisories.
