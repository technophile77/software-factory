# 0020. The onboarding checker uses PyYAML, zizmor and gitleaks

- **Status:** Accepted
- **Date:** 2026-11-13
- **Decided by:** owner (decision card, 2026-11-13)
- **Decision item:** [proposal 0024](../proposals/0024-onboarding-checks-on-standard-tools.md)

## Problem
F-003 FR-12 kept the `onboard-repo` checker standard-library only, so it
carried its own YAML reader, a line-by-line GitHub workflow scan and nine
secret regexes. The workflow scan misses known Actions attacks such as
script injection, and the secret scan reads current files only, while the
engine already uses gitleaks for the same job.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A. Hash-pinned venv the skill sets up with pip | Removes about 420 lines; full zizmor audit set; secrets in history; same install pattern as ADR 0016 | Standard-library-only rule ends; first run needs PyPI and GitHub; two new components to patch |
| B. Same tools through `uv` and PEP 723 | One command, standard script metadata | Adds `uv` as a third new tool |
| C. zizmor in onboarded repos' CI only | Checker unchanged | Assessment still misses High workflow findings |
| D. No change | Nothing to review | Keeps the gaps |

## Implications
Preliminary S4.1 notes are in the proposal; the full reviews are recorded
with H-0145 before the tools are used. zizmor and PyYAML have no Python
dependencies. Both read untrusted repo content, so SR-9 in F-003 stops the
repo from configuring or silencing them.

## Decision
Option A. The checker reads YAML with PyYAML's safe loader (refusing
anchors, aliases and tags), audits workflows and actions with zizmor
(`--offline --no-config --no-ignores --format json`), and scans for secrets
with gitleaks in `git` mode, redacted, with the skill's own rules. PyYAML and
zizmor are installed by the skill with
`pip install --require-hashes --only-binary :all:` into a virtual environment
in the plugin's data folder. gitleaks is downloaded from its official release
and checked against SHA-256 pins equal to the engine's. The CI template the
onboarding PR adds gets a zizmor job.

## Consequences
The checker no longer runs on the standard library alone, and its first run
needs network access. Version bumps of the three tools are hygiene items
with new hashes and a CVE check (S4.4). The factory and onboarded repos get
zizmor's findings in CI from then on. A JSON Schema for the manifest and
OpenSSF Scorecard were left out and need their own decisions.
