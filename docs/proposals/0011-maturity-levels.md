# Proposal: software maturity levels (new requirement)

- **Requested by:** owner, 2026-11-08
- **Category:** Product (new requirement), with Architecture follow-ons
- **Type:** Change to the specification (configuration hygiene item)
- **Status:** Section 16 wording approved and applied 2026-11-08 (spec v0.2). Criteria tables moved to `docs/maturity-levels.md` as drafts.

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
> **Same gates at every level.** Every feature, at every level, goes through
> all nine lifecycle stages, all six agents, and both security gates. What
> scales with maturity is the bar inside each gate: the depth of testing
> required, which security findings block, and how strict the validation
> judge is. The bar for each level is defined in `docs/maturity-levels.md`.
>
> **Promotion.** Each level has promotion criteria: the tests, level of
> testing, and other evidence needed to reach it. Criteria are cumulative. A
> repository may skip a level only if it meets the criteria of every level in
> between. The orchestrator checks the criteria and prepares the evidence;
> every promotion needs the owner's approval.
>
> **Demotion.** When a criterion for the current level stops holding, such as
> a regression or a serious security finding, the orchestrator proposes a
> demotion and the owner approves it. A single flaky failure is not a trigger.
>
> **Repositories and projects.** Each repository has its own level. Each
> project has its own level, set by the owner, which can never be higher than
> the least mature repository in the project. It may be lower, for example
> while cross-repository integration is untested.
>
> Promotion criteria and per-level gate bars are change-controlled and change
> only through the configuration hygiene process.

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
Approve the section 16 text, which now reflects the owner's answers to
questions 1 to 4. The draft promotion criteria are a starting point for the owner to edit,
not a decision.

---

## Draft promotion criteria (for discussion, not decided)

| Move | Testing required | Other evidence |
|---|---|---|
| → Prototype | Builds and a smoke test runs | Purpose written down |
| Prototype → Alpha | Every acceptance criterion of core features has a passing test; unit tests on core logic; failure paths for core features | Code Review security on the whole codebase; known issues listed |
| Alpha → Beta | All acceptance criteria tested, including edge cases; contract tests for every interface; integration tests; coverage target (TBD) | No open security findings above an agreed severity; user-facing docs; tester feedback channel |
| Beta → Release | Full regression suite green on a clean environment; performance/load tests against stated targets; upgrade and rollback tested | Dependency audit; no open blocking bugs; release notes |
| Release → Production ready | Tests pass in a production-like environment; backup/restore tested; failure/recovery tested | Monitoring and alerting; runbook; full security review; owner sign-off |

## Draft gate bar per level (for discussion, not decided)

| Gate | Prototype | Alpha | Beta | Release / Production ready |
|---|---|---|---|---|
| Requirements interview | Short; assumptions allowed if approved | Full | Full | Full |
| Test engineer | Happy path for each acceptance criterion | All acceptance criteria + core failure paths | Plus edge cases and contract tests | Plus regression and non-functional tests |
| Security and Testability Review and Code Review | Only the most severe findings block | Severe and high block | High and above block | Anything above low blocks |
| Validation judge | Spec compliance; style findings advisory | Spec + architecture; style advisory | All criteria enforced | All criteria enforced, no waivers |

Severity names wait on open decision 7.

## Questions

1. **Does maturity change the per-feature lifecycle?** Decided 2026-11-08: **same gates, bar scales by level.** Every feature at every level still goes through all six agents and both security gates. What scales is the bar inside each gate (test depth required, which security severities block, how strict the judge is). The per-level bar goes in `docs/maturity-levels.md`.
2. How does a project's level relate to its repos' levels? Decided 2026-11-08: **capped by its least mature repo.** The owner sets the project's level, but it can never be higher than the lowest level among its repos. It can be lower, for example while cross-repo integration is untested.
3. Can a repo skip a level? Decided 2026-11-08: **only by meeting every level in between.** Criteria are cumulative; a jump (e.g. prototype to beta) needs evidence for every intermediate level's criteria, and the owner's approval.
4. What triggers a demotion? Decided 2026-11-08: **the orchestrator proposes, the owner approves.** When a criterion for the current level stops holding (for example a regression or a serious security finding), the orchestrator files a demotion for approval. A single flaky failure is not a trigger.
5. Where the level is stored: follows ADR 0002. Proposed: `.factory/maturity.yaml` in each repo, and in the project's manifest for the project level, each with the evidence links for the last promotion.
6. The exact promotion criteria per level (edit the table above).
