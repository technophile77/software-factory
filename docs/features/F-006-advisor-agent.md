# Feature: Advisor agent for hard questions

- **Id:** F-006
- **Status:** Draft (requirements interview in progress)
- **Requested by / date:** Alex, 2026-11-10 (split out of F-005)
- **Spec version:** 1

## 1. Objective and business purpose
Some questions the factory puts to the owner are hard and cross-cutting, and
the agent asking them may be running on a cheaper model than the question
needs. The advisor is a support role that researches such a question on a
stronger model and returns findings and options with a recommendation. It
advises only. It never answers for the owner, decides, or changes code,
specs, or configuration.

Already decided (F-005 interview, owner, 2026-11-10):
- The advisor is its own feature (F-006), and F-005's analyst must be able
  to call it from an interview's "more information" step.
- The analyst does not consult other agents for more information; it uses
  shared skills and docs itself, and escalates to the advisor only when the
  question needs a stronger model.
- Until F-006 is built, no escalation is offered (F-005 OQ-3).
- Analyst escalation to the advisor is an approved permission widening
  (F-005 OQ-4).

## 2. Expected behavior
_To be written from the interview._

## 3. Functional requirements
_To be written from the interview._

## 4. Acceptance criteria
_To be written from the interview._

## 5. Constraints
- Advisory only, like the other support roles (spec section 2): it never
  changes code, specs, or configuration.
- Never answers an interview question or approves an assumption for the
  owner (owner rule, 2026-11-10).

## 6. Edge cases
_To be written from the interview and Gate 1._

## 7. Dependencies
- F-005 spec interview (merged): the escalation entry point.
- F-002 model/effort tuning: model choice builds on its rungs and floors.
- ADR 0012: spend counts against project budgets.
- Web reader role (F-005), if the advisor needs the web.

## 8. Assumptions
| Id | Assumption | Decision link | Status |
|---|---|---|---|
| | None yet. Assumptions are proposed in the interview for the owner to approve. | | |

## 9. Security considerations
_Gate 1 runs after the interview._

## 10. Interface requirements
_To be written from the interview. Adding a role needs an AGENT.md, a role
policy entry and shared agent-list edits, each through a hygiene item
(ids H-0060 to H-0064 reserved for this feature)._

## 11. Open interview questions
| Id | Question | Category | Status |
|---|---|---|---|
| Q1 | Who can call the advisor? | Product | Open |

## 12. Readiness gate
- [ ] Clear objective
- [ ] Expected behavior defined
- [ ] Acceptance criteria testable
- [ ] Constraints documented
- [ ] Assumptions explicit
- [ ] Blocking decisions resolved (approved, not deferred)

## 13. Change log
| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-11-10 | Skeleton with what the F-005 interview already decided | — |
