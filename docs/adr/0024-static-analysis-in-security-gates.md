# 0024. CodeQL and Semgrep in the security gates

- **Status:** Accepted; amended 2026-11-14 (engine Code Review runs Semgrep from a hash-pinned PyPI venv, see the end)
- **Date:** 2026-11-13
- **Decided by:** owner (decision card, option A)
- **Decision item:** `docs/proposals/0028-static-analysis-in-security-gates.md`

## Problem
Code-pattern weaknesses (injection, path traversal, unsafe
deserialization) were found only by an agent reading code in Code Review: not
repeatable, and paid in tokens on every run.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. CodeQL on the master repo, Semgrep CE on project repos and in Code Review** | Repeatable; free on the public master repo and on private project repos | Two tools to review; Semgrep rules fetched at run time |
| B. Semgrep everywhere | One tool | No CodeQL depth on the master repo |
| C. CodeQL everywhere | Strongest analysis | Paid (GitHub Code Security) on private repos |
| D. Opengrep | No rules licence limits | Younger; rules licence unchecked |
| E. No change | Nothing to review | Keeps the gap |

## Implications
- **Licence:** Semgrep's maintained rules are under the Semgrep Rules
  License v1.0 (internal business use, no redistribution). They are
  fetched from Semgrep's registry at run time and never copied into the
  master repo. The Semgrep CE engine is LGPL-2.1.
- **Security:** Semgrep runs from its official image pinned by digest,
  with `--metrics=off`; CodeQL actions pinned by hash. Full S4.1 reviews
  before build.

## Decision
1. The master repo runs CodeQL (JavaScript/TypeScript, Python, Actions) in
   a pinned workflow.
2. The onboarding CI template gets a Semgrep CE job, and the engine runs
   the same pinned image as a deterministic step before the Code Review agent,
   which receives the findings as evidence.

## Consequences
- `security-standards.md` gets a criterion: Code Review runs the approved
  static analysis, and every finding at the tool's highest severity is
  fixed or accepted by the owner.
- Hygiene items for the CodeQL workflow, the template job, the onboarding
  gap for a missing job, and the Code Review step when Code Review is automated.

## S4.1 reviews (H-0173, 2026-11-13)

### CodeQL Action

| Item | Finding |
|---|---|
| Source and maintainers | `github/codeql-action`, MIT, maintained by GitHub. Pinned to v4.39.0, commit `6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee` (15 October 2026, so past a 14-day wait). |
| Known CVEs | CVE-2025-24362 (GHSA-vqf5-2xx6-9wfm, High): before 3.28.3, a failed run in debug mode could upload the job's token in debug artifacts. Fixed long before v4.39.0; the workflow never turns on debug mode. |
| Install scripts | None of ours; the action downloads the CodeQL bundle from GitHub's own releases. |
| Permissions needed | `contents: read` and `security-events: write` (results upload) on the one job. Checkout keeps no token. |
| What it pulls in | The CodeQL CLI and query packs, from GitHub. |
| Runs repo code? | No: `build-mode: none` for all three languages, so nothing in the repo is built or run. |

**Residual risk.** The action is GitHub's own and runs with a write scope
limited to code-scanning results. A compromised release would reach that
scope only; the pin by commit stops a moved tag.

### Semgrep Community Edition

| Item | Finding |
|---|---|
| Source and maintainers | `semgrep/semgrep` (Semgrep Inc.). Engine LGPL-2.1; maintained rules under the Semgrep Rules License v1.0 (internal business use, no redistribution). Image `semgrep/semgrep:1.183.0`, digest `sha256:2e45517a85e13a9cca14a2a00df6bb48affd66b8ebfae1b0991cd57578362fb0` (29 October 2026, past a 14-day wait). |
| Known CVEs | CVE-2023-32758 (ReDoS in bundled git-url-parse), fixed in 1.25.0. Distributor advisories on Chainguard and Wolfi rebuilds (for example GHSA-p423-j2cm-9vmq, fixed by 1.160.0) are below the pinned version. GitHub's advisory lookup was blocked from this session, so the weekly S4.4 scan rechecks. |
| Install scripts | None: an official container image pinned by digest. |
| Permissions needed | Read the checkout. Network to `semgrep.dev` to fetch the `p/default` rules. No token; the job keeps `contents: read`. `--metrics=off` sends no usage data. |
| What it pulls in | Everything is inside the image; rules at run time from the registry. |
| Runs repo code? | No. It parses source files. `--disable-nosem` stops the scanned repo from silencing its own findings. |

**Residual risk.** The rules come from Semgrep's registry at run time, so a
change there changes results between runs. That is accepted because the
licence forbids pinning a copy in the master repo. A rules change can add
findings; it can't run code.

## Amendment, 2026-11-14: the engine's Code Review step runs Semgrep from PyPI

- **Decided by:** owner (decision card, 2026-11-14, F-015)
- **Why:** agents no longer run in containers until Beta (ADR 0026), and the
  owner chose not to keep Docker on the PC for Semgrep alone.
- **Decision:** the engine runs Semgrep CE before the Code Review agent from a
  factory-owned virtual environment on the owner's PC, installed with
  `pip install --require-hashes --only-binary :all:` from a change-controlled
  requirements file with hashes for every wheel on each supported platform
  (the pattern of ADR 0016 and ADR 0020). Same version, flags and rules as
  above: `--metrics=off`, `--disable-nosem`, `p/default` from the registry at
  run time. The onboarding CI template job keeps the digest-pinned image,
  since CI runners have Docker.

### S4.1 recheck: Semgrep CE 1.183.0 from PyPI (2026-11-14)

| Item | Finding |
|---|---|
| Source and maintainers | PyPI project `semgrep`, Semgrep Inc., the same release as the reviewed image (uploaded 2026-10-29, past a 14-day wait). Requires Python 3.10 or later. |
| Platforms | Wheels for Windows x64, macOS arm64, Linux x86_64 and aarch64 (glibc and musl). No wheel for Intel macOS: there `--only-binary` refuses the sdist, so the Code Review Semgrep step fails closed. Semgrep's docs still label native Windows support "beta" ([quickstart](https://semgrep.dev/docs/getting-started/quickstart-ce)). |
| What it pulls in | 66 wheels in all (resolved for Windows x64, Python 3.12), all binary, so no install scripts run. Notable: `mcp` 1.29.0 (pinned exactly by Semgrep), the OpenTelemetry SDK 1.37 family, `cryptography`, `pydantic`, `requests`, `ruamel.yaml`, `pywin32` on Windows. |
| Known CVEs (PyPI advisory data, which mirrors OSV; api.osv.dev was blocked from this session, CI rechecks) | `mcp` 1.29.0: GHSA-84m7-p3x7-pcfv, GHSA-5h93-6whr-6q8j, GHSA-w4fh-qvv9-3v23, GHSA-rwrf-2pqf-9j8j, fixed in 1.30.0. They affect an MCP HTTP server, HTTP client redirects, server bearer auth and client tool-schema `$ref` fetching. `opentelemetry-api` 1.37.0: GHSA-xcq7-p3pf-p88h, GHSA-mf5v-w3w3-f6cg (ReDoS parsing inbound `tracestate` / `traceparent` headers), fixed in 1.45.x. Semgrep 1.185.0 (latest) still pins both, so no release avoids them. |
| Reachability | Not reachable from `semgrep scan`: the MCP code runs only under `semgrep mcp`, which the engine never starts, and the OpenTelemetry parsers handle inbound HTTP headers, which a command-line scan never receives (tracing exports only with `--trace`, which the engine never passes). Each gets an `osv-scanner.toml` ignore entry with this reason and an expiry of at most 90 days (H-0196), so the weekly scan flags them again. |
| Permissions needed | Read the feature worktree. Network to `semgrep.dev` for the rules. No token. Runs as the owner (ADR 0026). |
| Runs repo code? | No; it parses source files. |

**Residual risk.** As for the image, plus: 66 Python packages on the owner's
PC instead of inside an image, each a supply-chain path; hash pinning stops a
replaced file, not a malicious release we choose to pin, so every bump is a
new S4.1 check. The two unfixed advisories above are accepted as unreachable
until Semgrep moves off those pins.
