# Proposal: security severity definitions (open decision 7)

- **Category:** Security
- **Blocks:** the pass/fail rule for both security gates; the maturity gate bar
- **Status:** Awaiting owner

## Options

### A. Four qualitative levels (recommended)
| Severity | Meaning | Examples |
|---|---|---|
| Critical | Exploitable now, by an outside attacker, leading to data breach, account takeover, code execution, or secret exposure | SQL injection on a public endpoint; committed live credential; auth bypass |
| High | Serious impact but needs a precondition (an account, an unusual setup) or a likely-exploitable weakness | Privilege escalation for logged-in users; stored XSS; dependency CVE in a used code path |
| Medium | Weakens defenses or leaks limited information; hard to exploit alone | Verbose errors showing internals; missing rate limit; weak input validation without a known exploit |
| Low | Best-practice gap with little direct risk | Unpinned dev dependency; missing security header on a non-sensitive page |

Dependency CVEs use their CVSS score as a starting point (9.0+ Critical,
7.0–8.9 High, 4.0–6.9 Medium, below Low), adjusted for whether the
vulnerable code is actually reachable.

Blocking scales with maturity (spec section 16):
| Level | Blocks the PR |
|---|---|
| Prototype | Critical |
| Alpha | Critical, High |
| Beta | Critical, High |
| Release / Production ready | Critical, High, Medium |

Non-blocking findings are tracked as known issues and count against promotion.

| | |
|---|---|
| Pros | Familiar; easy to apply consistently; maps cleanly to the maturity bar |
| Cons | Some judgment at the boundaries |

### B. CVSS score for everything
| | |
|---|---|
| Pros | Standard numeric scale |
| Cons | Awkward for design flaws and spec gaps; slow to score; false precision |

### C. Three levels (blocking / should-fix / note)
| | |
|---|---|
| Pros | Simplest |
| Cons | Too coarse for the maturity bar to scale smoothly |

## Recommendation
**A.** Once approved, the table goes into `docs/security-standards.md` and
the security gate rows of `docs/maturity-levels.md` are updated to match.
