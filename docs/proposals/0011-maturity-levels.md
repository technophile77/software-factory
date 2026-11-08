# Proposal: software maturity levels (new requirement)

- **Requested by:** owner, 2026-11-08
- **Category:** Product (new requirement), with Architecture follow-ons
- **Type:** Change to the specification (configuration hygiene item)
- **Status:** Awaiting owner. Nothing here is applied until approved.

## 1. File being changed
`docs/spec/software-factory-spec-v0.1.md` (adds section 16; spec becomes v0.2)
and `docs/open-decisions.md` (adds item 11).

## 2. Reason
The owner wants every repo and every project to carry a maturity level, and
wants the move from one level to the next to be defined by the tests and level
of testing required.

## 3. Current content
The spec has no concept of maturity. Every feature goes through the same nine
stages and the same definition of done.

## 4. Proposed content (new spec section 16)

> ## 16. Software Maturity Levels
>
> Every repository and every project has a maturity level:
>
> 1. **Rapid prototype** — exploring an idea; may be thrown away.
> 2. **Alpha** — core functionality works; used by the owner and close testers.
> 3. **Beta** — feature-complete for its scope; used by real testers.
> 4. **Release** — a release candidate that has passed full regression and non-functional testing.
> 5. **Production ready** — fit to run in production and be supported.
>
> Each level has defined **promotion criteria**: the tests, the level of
> testing, and other evidence required to move to the next level. Promotion
> criteria are recorded in `docs/maturity-levels.md` and changed only through
> the configuration hygiene process.
>
> The orchestrator checks the promotion criteria and prepares the evidence.
> Promotion always requires the owner's approval. Demotion (for example after
> a serious regression) is proposed by the orchestrator and also approved by
> the owner.
>
> A repository's level is tracked per repository. A project's level is tracked
> per project. How the two relate, and how maturity affects the per-feature
> lifecycle, are defined in `docs/maturity-levels.md`.

## 5. Diff
See `0011-maturity-levels.diff` next to this file.

## 6. Expected benefits
- Prototypes can move fast without pretending to be production code.
- "Is this ready?" gets an evidence-based answer instead of a feeling.
- Testing effort grows as the stakes grow.

## 7. Risks and side effects
- If levels are allowed to relax the lifecycle gates, prototype code can carry
  weak tests and unreviewed security issues into later levels. Promotion
  criteria must catch this.
- Adds a new artifact (the maturity record) that needs storage (decision 3).
- Project-vs-repo levels can disagree; needs a clear rule.

## 8. Recommendation
Approve the section 16 text, then settle the open questions below one at a
time. The draft promotion criteria are a starting point for the owner to edit,
not a decision.

---

## Draft promotion criteria (for discussion, not decided)

| Move | Testing required | Other evidence |
|---|---|---|
| → Prototype | Builds and a smoke test runs | Purpose written down |
| Prototype → Alpha | Every acceptance criterion of core features has a passing test; unit tests on core logic; failure paths for core features | Gate 2 security on the whole codebase; known issues listed |
| Alpha → Beta | All acceptance criteria tested, including edge cases; contract tests for every interface; integration tests; coverage target (TBD) | No open security findings above an agreed severity; user-facing docs; tester feedback channel |
| Beta → Release | Full regression suite green on a clean environment; performance/load tests against stated targets; upgrade and rollback tested | Dependency audit; no open blocking bugs; release notes |
| Release → Production ready | Tests pass in a production-like environment; backup/restore tested; failure/recovery tested | Monitoring and alerting; runbook; full security review; owner sign-off |

## Open questions (to ask one at a time)

1. **Does maturity change the per-feature lifecycle?** (asked first)
2. How does a project's level relate to its repos' levels? (e.g. the lowest of them, or set independently)
3. Can a repo skip a level?
4. What triggers a demotion?
5. Where the level is stored (follows decision 3).
6. The exact promotion criteria per level (edit the table above).
