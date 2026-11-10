# F-002 Security Gate 1 (requirements review)

- **Feature:** F-002 Model and effort tuning per agent, spec v10
- **Reviewer role:** security-reviewer, against `docs/security-standards.md`
- **Date:** 2026-11-10
- **Result:** 5 findings; each resolved by a new or tightened requirement in
  spec v11 (SR-2, SR-7 to SR-10). No owner decision needed.

| # | Criterion | Severity if missed | Finding | Resolution |
|---|---|---|---|---|
| 1 | S6.1 | High | The evaluator reads specs, which are untrusted text. Injected wording could make it predict cheap rungs, and per-task advice (FR-21) would then weaken the security reviewer or judge. | SR-7: advice never goes below a floor or below the approved rung for gate agents |
| 2 | S8.2, S8.1 | High | Replays run a real agent loop at an old commit; with the factory token present, a replayed developer could push or open a PR. | SR-2 tightened: no factory token or extra credentials in replay worktrees |
| 3 | S8.1, S6.2 | Medium | Agents are graded by `.factory/tuning/**` and run reviews; an agent able to write there could hide its failures or inflate the evaluator's accuracy. | SR-8: only the engine writes them; all roles denied |
| 4 | S5.1 | Medium | A bad transcript list or repeated triggers could run calibration up to unbounded cost. | SR-9: cost cap at 1.5 × estimate, then stop and file a Testing item |
| 5 | S8.1, S8.5 | Medium | The new `project-evaluator` role (A-11) had no stated permissions. | SR-10: read specs and reviews, write only its report, no commands or network |

**Already covered by the analyst's requirements:** answers hidden from the
agent under test (SR-1), secrets scan before a transcript is selected (SR-5),
transcript lists validated as untrusted input (SR-6), gate-agent floors (SR-3).

**Abuse cases now in edge cases:** injected instructions in specs or
transcripts, an agent editing its own metrics, a runaway calibration batch.

**Permissions this feature adds (S8.5):** the `project-evaluator` role
(SR-10), and engine-only write access to `.factory/tuning/**`. The role
policy entry and the spec section 2 amendment go through hygiene items.

**Not applicable:** S2 (no new auth surface), S4 (no new libraries at this
stage; any chosen at implementation get the S4.1 review).
