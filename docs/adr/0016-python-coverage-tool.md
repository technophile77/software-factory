# 0016. coverage.py measures coverage for the factory's Python code

- **Status:** Accepted
- **Date:** 2026-11-10
- **Decided by:** owner (decision card, 2026-11-10)
- **Decision item:** [proposal 0018](../proposals/0018-python-coverage-tool.md)

## Problem
`testing-strategy.md` asks for line and branch coverage at every maturity
level. The stdlib `trace` module used for F-003 and F-005 measures lines only,
so neither feature has a branch figure (F-003 m27, F-005 m3), and the factory
repo can't show the Alpha bar.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| coverage.py 7.17.2, test only, hash-pinned | Standard tool, measures branches, no runtime dependencies on 3.11+, works with `unittest` | One more tool to patch; measures on Python 3.11+ only |
| coverage.py 7.16.2 | Also runs on Python 3.10 | Older line with no more fixes |
| stdlib `trace` | No external tool | No branch figure |
| pytest-cov | Common with pytest | Adds pytest and its dependencies; our tests use `unittest` |

## Implications
Security review (S4.1) is in the proposal: no known CVEs, upstream
trusted-publishing attestations, no dependencies on 3.11+. The wheel installs
a `.pth` startup hook, and the source package runs a C build, so it is
installed from wheels only, into a dedicated test virtual environment.

## Decision
coverage.py 7.17.2 for the factory repo's Python code (the plugin skills and
their tests). It is a test-only tool: never imported by the skills and never
shipped in the plugin, which stay standard-library only. It is installed with
`pip install --require-hashes --only-binary :all:` from a hash-pinned
`requirements-test.txt` (H-0065), and coverage is measured with `--branch`.

## Consequences
Raising the version within coverage.py is routine (new hashes, CVE check).
Adding another test tool needs a new Architecture decision. Python 3.10
compatibility tests still run, without coverage. This does not choose a
coverage tool for other projects. Running Python tests and coverage in the
factory repo's CI is a separate hygiene item.
