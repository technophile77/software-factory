# Proposal 0028: Static analysis tools in the security gates

- **Raised:** 2026-11-13, by the owner ("Do #4", review "Where the factory
  rebuilds existing tools", item 4)
- **Category:** Security (what the gates check, `docs/security-standards.md`)
  and Architecture (new external components, S4.1 notes below)
- **Status:** Decided: option A (ADR 0024), by the owner on 2026-11-13 (decision card)
- **Scope:** Security Gate 2 (code review after build), the CI the
  onboarding skill adds to project repos, and the master repo's own CI

## Problem

Gate 1 and Gate 2 are agent reviews against `security-standards.md`.
Tools are used only for secrets (gitleaks) and known CVEs (OSV-Scanner,
npm audit). Injection, path traversal, unsafe deserialization and similar
code patterns are found by an agent reading the code. That costs tokens
on every run and isn't repeatable: two runs can find different things.
Static analysis tools find these patterns the same way every time
(your rule: tools, not tokens).

## What stays ours

Mapping each finding to our criteria and severities, which findings block
which maturity level, filing them to the inbox, and the agent review of
design-level issues (authorization logic, trust boundaries) that no
scanner sees. The agent gets the tool findings as evidence, so it spends
its time on what tools can't do.

## Options

### A. CodeQL on the master repo, Semgrep on project repos (recommended)

- **Master repo** (public): a CodeQL workflow for JavaScript/TypeScript,
  Python and Actions. Free on public repos, results in GitHub's Security
  tab, actions pinned by hash.
- **Project repos and Gate 2**: Semgrep Community Edition (engine LGPL-2.1)
  from its official container image pinned by digest, with `--metrics=off`.
  The onboarding CI template gets a Semgrep job, and the engine runs the
  same image as a deterministic step before the Gate 2 agent, passing the
  findings to it.

| | |
|---|---|
| Pros | Repeatable findings, fewer Gate 2 tokens, works on private repos at no cost. CodeQL's deeper data-flow analysis on the repo that ships the factory |
| Cons | Two tools to review and keep current. Semgrep's maintained rules are under the Semgrep Rules License v1.0: internal business use only, no redistribution. So the rules are fetched from Semgrep's registry at run time and never copied into the master repo, which needs network to semgrep.dev |

### B. Semgrep everywhere

| | |
|---|---|
| Pros | One tool |
| Cons | Loses CodeQL's free, deeper analysis on the master repo |

### C. CodeQL everywhere

| | |
|---|---|
| Pros | One tool, strongest analysis |
| Cons | Private repos need GitHub Code Security, listed at $30 per active committer per month, and project repos are often private |

### D. Opengrep in place of Semgrep

Opengrep is an LGPL fork of Semgrep CE, started after the rules licence
change. Its rules' licence still needs checking before it could be chosen.

| | |
|---|---|
| Pros | Engine free of Semgrep Inc.'s control; rules might be pinnable in the repo |
| Cons | Younger project with fewer maintained rules; needs its own review |

### E. No change

## What changes if A is approved

1. `security-standards.md` gets a criterion that Gate 2 runs the approved
   static analysis and every finding at the tool's highest severity is
   either fixed or accepted by the owner; ADR records the tools.
2. Hygiene items (H-0169 to H-0173): the CodeQL workflow, the Semgrep job in
   `templates/ci-workflow.yml` with an onboarding gap when it is missing,
   the S4.1 reviews, and a note in F-008 for the engine's Gate 2 step
   when Gate 2 is automated.

## Recommendation

Option A. CodeQL costs nothing on the public master repo, and Semgrep CE
covers the private project repos where CodeQL is paid.

## Cost of delay

Low to medium. Each Gate 2 meanwhile relies on an agent finding code
patterns by reading.

## Outcome (2026-11-13)

The owner chose option A. Recorded as ADR 0024. Hygiene items H-0169 to H-0173 cover the CodeQL workflow, the Semgrep job in the onboarding CI template with an onboarding gap when it is missing, the `security-standards.md` criterion, the S4.1 reviews, and the Gate 2 step when Gate 2 is automated. Spec changes go through the requirements interview before anything is built.
