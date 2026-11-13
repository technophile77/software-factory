# Proposal: onboarding checks on standard tools

- **Raised:** 2026-11-13, by the owner's review of where the factory rebuilds
  existing tools (thread "Find parts that reinvent existing tools"), after
  F-013 replaced its own model translator with LiteLLM
- **Category:** Architecture (new external components; S4.1 notes below).
  It also changes an approved requirement, F-003 FR-12, so it is a Product
  decision for that one line.
- **Status:** Decided: option A (ADR 0020), by the owner on 2026-11-13 (decision card)
- **Scope:** the `onboard-repo` skill's checker
  (`plugins/software-factory/skills/onboard-repo/scripts/factory_check.py`)
  and the CI template it adds to onboarded repos. The engine is not changed.

## Problem

F-003 FR-12 says the checker uses only the Python standard library, so the
skill can be copied anywhere and adds no external component to review. To
keep that rule the checker rebuilt three things that well-maintained tools
already do, and two of them are weaker than the tool they stand in for.

| Our code | Lines (about) | What it does | Weakness |
|---|---|---|---|
| `parse_yaml` and helpers | 240 | Reads a YAML subset (manifests, maturity records) | Ours to maintain and test (25 tests). Any YAML the factory later writes outside the subset breaks onboarding |
| `scan_workflow`, `action_pinned`, the workflow part of `assess` | 120 | Line-by-line scan of GitHub workflows for unpinned actions, missing or `write-all` permissions, `pull_request_target` | Covers four patterns. Misses script injection, checkout of untrusted PR code, credential persistence and the other known Actions attacks |
| `SECRET_RULES` and the secret scan | 60 | Nine regexes over the working tree | Nine token kinds, current files only, not history. The engine already uses gitleaks for the same job |

Measured on 2026-11-13. A fixture workflow with `pull_request_target`, a
checkout of the PR head and `run: echo "${{ github.event.issue.title }}"`
gave one gap from our checker (`workflow-pr-target`). zizmor 1.32.0, offline,
gave three: `dangerous-triggers` (High), `template-injection` (High) and
`artipacked` (Medium). On this repo's own `.github/workflows/`, zizmor's
default setting finds one Medium that our checker passes:
`extension.yml` checks out code without `persist-credentials: false`.

## What stays ours

Everything that is about the factory rather than about YAML, workflows or
secrets: stack and test detection, the gap list with the rule and maturity
level each gap blocks, factory checks (`.factory/`, CLAUDE.md,
`factory/state`), the level recommendation, the manifest and role-policy
rules, and turning gaps into inbox items. The tools report findings; the
checker maps each finding to a factory gap with its rule (S6.1, S8.3, S1.4)
and the level it blocks, as it does today.

## Options

### A. A pinned tool environment the skill sets up itself (recommended)

On first run the skill creates a virtual environment in the plugin's data
folder and installs hash-pinned wheels with
`pip install --require-hashes --only-binary :all:`, the same way ADR 0016
installs coverage.py. The checker then:

- reads YAML with **PyYAML** `safe_load`, through a loader that refuses
  anchors, aliases and tags, so the "only what the factory writes" rule
  (SR-8) still holds;
- runs **zizmor** as
  `zizmor --offline --no-config --no-ignores --format json` on the repo's
  workflows and actions. `--offline` keeps it off the network,
  `--no-config` and `--no-ignores` stop the repo being assessed from hiding
  its own findings;
- runs **gitleaks** 8.30.1 in `git` mode with redaction, downloaded from
  its official release and checked against the same SHA-256 pins the engine
  already has (`engine/src/constants.ts`), so secrets in history are found
  too. The skill still doesn't need the engine to be installed.

The CI template the onboarding PR adds gets a zizmor job, so workflows stay
checked after onboarding, not just on the day the repo joined.

| | |
|---|---|
| Pros | About 420 lines and their tests go. Workflow checks go from four patterns to zizmor's full set, kept current by its maintainers. Secret scanning matches the engine and covers history. Same install pattern as ADR 0016, so no new installer tool |
| Cons | FR-12 changes: the skill needs Python's `venv` and `pip` and a network fetch from PyPI on first run. Two new components to review and keep patched (S4.1, S4.4). zizmor's wheel is about 9 MB (27 MB installed) |

### B. Same tools, through `uv` and PEP 723

The checker declares its dependencies inline (PEP 723) with a lock file, and
the skill runs it with `uv run --locked`.

| | |
|---|---|
| Pros | The standard way to give one script its own pinned dependencies. Faster, one command, nothing for the skill to set up |
| Cons | `uv` becomes a third new tool on the owner's machine, with its own review. Nothing it does here is out of reach for option A |

### C. Keep the checker standard-library only, add zizmor in CI only

The onboarding PR's CI template gets a zizmor job; the checker is unchanged.

| | |
|---|---|
| Pros | FR-12 untouched. One new component, and it runs on GitHub's runner, not the owner's machine |
| Cons | The YAML parser and secret regexes stay. The onboarding assessment itself still misses the workflow attacks above, so the starting level can be recommended on a repo with a High finding |

### D. No change

| | |
|---|---|
| Pros | Nothing to review |
| Cons | Keeps the gaps shown above |

### Considered and left out

- **OpenSSF Scorecard.** Its overlap with the checker is branch protection
  (we already read it through `gh api`) and pinned actions (zizmor covers
  these offline). It needs a GitHub token and network, and its other checks
  (maintenance, contributors) don't map to factory rules.
- **JSON Schema for the manifest.** It would also give autocomplete in
  `factory-project.yaml` in VS Code, but it touches the Project manifest
  contract and the engine's zod schema, so it is an Interfaces decision of
  its own. Left for a later proposal.

## Security notes (S4.1, preliminary)

Checked 2026-11-13. A full review is recorded before build if A or B is
approved; OSV and GitHub advisory lookups were blocked from this session, so
CI re-checks with OSV-Scanner (already approved for Python) per S4.4.

| | zizmor 1.32.0 | PyYAML 6.0.3 |
|---|---|---|
| Source | `github.com/zizmorcore/zizmor`, MIT, Rust | `github.com/yaml/pyyaml`, MIT |
| What it pulls in | Nothing: one static binary in a wheel, no Python dependencies | Nothing. Wheels bundle libyaml; pure-Python fallback |
| Wheels | Windows (x64, x86, arm64), macOS, Linux glibc and musl | Every supported CPython on Windows, macOS, Linux |
| Install scripts | None for wheels; `--only-binary :all:` stops the source build | Same |
| Network | None with `--offline` | None |
| Known issues | None found on PyPI | Past CVEs (2017-18342, 2020-1747, 2020-14343) are in `load`/`full_load`, fixed in 5.4; `safe_load` was not affected |
| Untrusted input | Reads the assessed repo's workflows; run with a timeout, no config or ignore comments honoured | Reads factory files only; aliases refused so a crafted file can't expand |
| Publishing | No PyPI attestation found for 1.32.0 | No PyPI attestation found for 6.0.3 |

gitleaks 8.30.1 is already approved (F-007 OQ-4) and needs no new review.

## Recommendation

Option A. It removes the most home-made code, closes real detection gaps,
and reuses the install pattern and the gitleaks pin the owner has already
approved.

If approved:

1. ADR 0020 records the decision; F-003 FR-12, AC-15 and its constraint line
   change from "standard library only" to "standard library plus the
   hash-pinned tools in ADR 0020" (spec v7).
2. Hygiene items (H-0145 onward) add the pinned requirements file for the
   skill, the zizmor job in `templates/ci-workflow.yml`, and the checker
   changes, with the full S4.1 reviews.
3. The factory repo's own `extension.yml` gets `persist-credentials: false`,
   the finding zizmor reported above.

## Cost of delay

Low to medium. Each repo onboarded meanwhile gets an assessment that can miss
High workflow findings and secrets in history, and the YAML parser and
regexes keep costing maintenance.

## Outcome (2026-11-13)

The owner chose option A. Recorded as ADR 0020 and F-003 spec v7.

One fact found after the decision: zizmor's wheels declare
`requires_python >=3.11`, and F-003 FR-12 said Python 3.10+. Python 3.10
reached end of life in October 2026 (PEP 619), so spec v7 raises the
skill's minimum to 3.11, pending the owner's confirmation. The alternative
is to download zizmor's release binary with SHA-256 pins, as for gitleaks.

### Hygiene items

| Id | Change | Files |
|---|---|---|
| H-0145 | Pinned tool environment and checker changes: `requirements-tools.txt` in the skill with PyYAML 6.0.3 and zizmor 1.32.0 and every wheel's hash; a gitleaks pin file equal to the engine's; setup on first run; PyYAML safe loader refusing anchors, aliases and tags in place of `parse_yaml`; zizmor and gitleaks findings mapped to gaps in place of `scan_workflow`, `action_pinned` and `SECRET_RULES`; tests for AC-15 and AC-22 to AC-24; the full S4.1 reviews of zizmor and PyYAML | `plugins/software-factory/skills/onboard-repo/` |
| H-0146 | zizmor job in the CI template onboarded repos get, pinned by hash | `plugins/software-factory/skills/onboard-repo/templates/ci-workflow.yml` |
| H-0147 | The factory repo's own workflows: `persist-credentials: false` on the checkout in `extension.yml` (zizmor `artipacked`), a zizmor job, and a CI check that the skill's gitleaks pins equal the engine's (AC-24) | `.github/workflows/`, `scripts/` |

H-0148 and H-0149 are reserved for follow-ups.
