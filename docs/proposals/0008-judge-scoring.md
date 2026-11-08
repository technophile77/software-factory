# Proposal: validation judge scoring and evidence (open decision 8)

- **Category:** Product
- **Blocks:** stage 8 pass rule
- **Status:** Decided: option A, applied to `agents/validation-judge/AGENT.md`

## Options

### A. Evidence checklist with graded findings, no numeric score (recommended)
The judge fills a fixed checklist. Each line is **Met**, **Not met**, or
**Needs owner**, with evidence attached.

| Area | Evidence required |
|---|---|
| Each functional requirement | Code location + passing test id |
| Each acceptance criterion | Passing test id from the test engineer's run on the final commit |
| Architecture | No conflict with any ADR, or a cited approved exception |
| Interface contracts | Contract tests pass; no unapproved contract diff |
| Code quality, readability, maintainability | Specific findings with file and line |
| Comments | Redundant, outdated, excessive, or crutch comments listed |
| Documentation | Each doc the spec requires is updated |
| Security | Both gate reports present, no blocking findings |

Findings are **Blocking**, **Major**, or **Minor**.

Verdict:
- **PASS:** every line Met, no Blocking findings, Major findings within the
  maturity allowance (below).
- **FAIL:** any line Not met, or any Blocking finding.
- **NEEDS HUMAN REVIEW:** any line Needs owner (for example, the spec is
  ambiguous or a trade-off is the owner's call).

Major findings allowed for PASS, by maturity: Prototype any (logged),
Alpha 3, Beta 1, Release and Production ready 0. Minor findings never block;
they are logged.

| | |
|---|---|
| Pros | Every verdict traceable to evidence; hard to game; maps to maturity |
| Cons | Longer reports |

### B. Numeric score (0–100) with a pass threshold
| | |
|---|---|
| Pros | One number to track |
| Cons | A high score can hide a failed acceptance criterion; false precision |

### C. Narrative judgment with a verdict
| | |
|---|---|
| Pros | Flexible, short |
| Cons | Inconsistent between runs; hard to audit |

## Recommendation
**A.** The spec says a feature is done on evidence, not on reports; a
checklist makes that literal.
