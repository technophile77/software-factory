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
