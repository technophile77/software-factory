# F-002 Security and Testability Review (requirements review)

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

## Re-review for spec v13 (promptfoo, ADR 0023), 2026-11-13

| # | Criterion | Severity if missed | Finding | Resolution |
|---|---|---|---|---|
| 1 | S4.1, S4.3, S4.4 | Medium | A new external component with about 400 packages, four with advisories, and default calls home (telemetry, update check, sharing, remote generation). | SR-11 conditions; review in [F-002-promptfoo-review.md](F-002-promptfoo-review.md); owner accepted, 2026-11-13 (OQ-2) |
| 2 | S8.1, S3 | High | If promptfoo ran inside the engine process, every package in its tree could read the factory token and Claude credential from the engine's environment. | SR-12; where it runs is an owner decision (OQ-1), owner chose (a), a credential-free child process, 2026-11-13 (OQ-1) |
| 3 | S3, SR-4 | Low | promptfoo stores prompts and outputs in its own database, by default in the user's home folder. | SR-13 and FR-25: engine-owned folder, outside Git |

**Unchanged:** SR-1 and SR-2 hold because every trial still runs through the
engine's session runner (FR-23). SR-9's cap is enforced by the adapter (FR-24).
