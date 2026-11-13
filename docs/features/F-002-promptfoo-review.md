# F-002 External component review: promptfoo (S4.1, SR-11)

- **Component:** promptfoo (npm `promptfoo`), MIT, version reviewed 0.125.1
  (published 2026-10-25, so past the 14-day quarantine)
- **Purpose in the factory:** runs F-002 calibration trials and transcript
  replays (ADR 0023, F-002 FR-22 to FR-25). Not used in normal feature runs.
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-13
- **Result:** **Conditional.** Usable with the SR-11 conditions below, run as
  OQ-1 decides, with the owner accepting the residual risk (Security
  decision, F-002 OQ-2). Agents don't accept it for the owner (S4.6).
- **Owner decision:** pending (F-002 OQ-2).

How this was checked: the npm registry record and the 0.125.1 tarball itself,
`npm install --package-lock-only --omit=optional` then `npm audit` on the
result (2026-11-13), and the project's GitHub security advisory page.

## Source and maintainers (S4.1)
- Repository github.com/promptfoo/promptfoo; five npm maintainers listed.
- 0.125.1 is published with npm provenance (SLSA v1 attestation), so the
  tarball can be traced to the project's own CI build.
- OpenAI agreed to acquire promptfoo in March 2026 and said it stays open
  source under MIT. That is a statement of intent, not a guarantee; the pin
  means a licence change only matters when the factory upgrades.
- Release pace: about two releases a month since June 2026.

## Known vulnerabilities (S4.2, S4.4)
- promptfoo itself: no published advisories
  ([advisories page](https://github.com/promptfoo/promptfoo/security/advisories), checked 2026-11-13).
- Transitive packages in 0.125.1 with advisories (`npm audit`, optional
  packages left out):

| Package (version pulled in) | Advisories | Reached by the factory's use? | Fix |
|---|---|---|---|
| `@hono/node-server` 2.1.5 (pinned exactly by promptfoo) | [GHSA-qv5m-9pm6-hqp3](https://github.com/advisories/GHSA-qv5m-9pm6-hqp3), [GHSA-jpvv-r467-5p4w](https://github.com/advisories/GHSA-jpvv-r467-5p4w), Moderate | Only by the web viewer (OQ-3) | override to ≥ 2.1.6 |
| `basic-ftp` 5.3.1 (via `proxy-agent` → `pac-proxy-agent` → `get-uri`) | [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r) High, [GHSA-5pm8-86m8-9m6r](https://github.com/advisories/GHSA-5pm8-86m8-9m6r), [GHSA-r4jh-29pc-gfqr](https://github.com/advisories/GHSA-r4jh-29pc-gfqr) Moderate | No: only for a PAC proxy file fetched over FTP | override to ≥ 6.2.4 (major bump; test that the unused path still loads) |
| `glob` 13.0.7 | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), Moderate | Only with config globs, which the engine doesn't use | override to a fixed release |
| `minimatch` 10.2.6 | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), Moderate | As above | override to ≥ 11.0.1 |

CI fails on fixable CVEs, so these overrides are part of H-0166, not optional.

## Install scripts (S4.1)
Of the 396 packages installed without optional ones, two have install
scripts: `esbuild` (already an engine dev dependency) and `fsevents` (macOS
only). promptfoo's own `prepare` script runs only in its own repository.
The engine installs with `npm ci`; running with `--ignore-scripts` is
possible if esbuild's binary is fetched the way the engine already does.

## What it pulls in (S4.1)
- 76 direct dependencies, 24 optional, 13 peer; 396 packages in all without
  optional ones (684 with). The engine has four runtime dependencies today,
  so this is most of its install size.
- It includes clients for many model APIs, an Express and Socket.IO server
  (the viewer), an OpenTelemetry exporter, PostHog analytics, and a libSQL
  database for results.

## What it can do, and what it needs (S8)
- Network: telemetry (PostHog), update checks, result sharing and "remote
  generation" all call promptfoo's servers by default. Each has an off
  switch found in 0.125.1: `PROMPTFOO_DISABLE_TELEMETRY`,
  `PROMPTFOO_DISABLE_UPDATE`, `PROMPTFOO_DISABLE_SHARING`,
  `PROMPTFOO_DISABLE_REMOTE_GENERATION`. With every model call going
  through the engine adapter (FR-23), promptfoo needs no network at all.
- Files: its database and cache go to `PROMPTFOO_CONFIG_DIR`, set to an
  engine-owned folder (FR-25).
- Credentials: none. Its model providers read API keys from the
  environment; the factory uses none of them, so it is given none.
- Node 22.22 or newer.

## Conditions (SR-11)
1. Exact pin with a lockfile; adopt a new release no sooner than 14 days
   after publication unless it fixes a CVE in a path the factory uses.
2. `overrides` for the four packages above; OSV-Scanner in CI as for every
   engine dependency.
3. The four `PROMPTFOO_DISABLE_*` switches set by the engine at every start;
   config folder engine-owned; response cache off.
4. Red-team, cloud and share features never used; only `evaluate()` with the
   engine's custom provider.
5. Run as OQ-1 decides, never with the factory token, Claude credential or
   endpoint keys in reach (SR-12).

## Residual risk for the owner
A malicious promptfoo release, or one of its ~400 packages, that gets past
the pin and quarantine runs code on your PC whenever calibration runs. With
OQ-1 (a) it has no factory credentials to steal and sees only calibration
prompts and outputs, but it can still read and write whatever your user
account can and can reach the network. With OQ-1 (b) it would also have the
engine's credentials. npm supply-chain attacks that steal credentials from
the environment have happened at scale, for example the September 2025
"Shai-Hulud" worm
([CISA alert, 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)).

## Alternatives, if the owner declines
- Inspect AI (ADR 0023 option B): Python, about 40 direct dependencies.
- Build the runner in the engine (option C): no new dependency, more of our
  own code.
