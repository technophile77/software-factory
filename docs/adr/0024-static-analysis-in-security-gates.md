# 0024. CodeQL and Semgrep in the security gates

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner (decision card, option A)
- **Decision item:** `docs/proposals/0028-static-analysis-in-security-gates.md`

## Problem
Code-pattern weaknesses (injection, path traversal, unsafe
deserialization) were found only by an agent reading code in Gate 2: not
repeatable, and paid in tokens on every run.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| **A. CodeQL on the master repo, Semgrep CE on project repos and in Gate 2** | Repeatable; free on the public master repo and on private project repos | Two tools to review; Semgrep rules fetched at run time |
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
   the same pinned image as a deterministic step before the Gate 2 agent,
   which receives the findings as evidence.

## Consequences
- `security-standards.md` gets a criterion: Gate 2 runs the approved
  static analysis, and every finding at the tool's highest severity is
  fixed or accepted by the owner.
- Hygiene items for the CodeQL workflow, the template job, the onboarding
  gap for a missing job, and the Gate 2 step when Gate 2 is automated.

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
