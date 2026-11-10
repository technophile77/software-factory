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

Interview answers (owner):
- Q1 (2026-11-10): two callers. The analyst during an interview's "more
  information" step, and the orchestrator when it prepares options and a
  recommendation for a hard inbox decision. No other agent calls it.
- Q2 (2026-11-10): always the strongest model at high effort (the top rung
  of the F-002 ladder). Not calibrated or tuned by F-002.
- Q3 (2026-11-10): the caller (analyst or orchestrator) may escalate when
  it judges a question is beyond it, stating its reason; the owner may also
  ask for the advisor on any interview question. This adds an "ask the
  advisor" choice to the F-005 interview skill. The owner always sees that
  the advisor was used and why.
- Q4 (2026-11-10): the analyst's research sources, read only (project code
  and docs; factory docs, ADRs and past decisions; shared skills; the web
  only through the web reader), plus a shell inside a sandbox so it can
  test code. No file writes outside the sandbox and no inbox access. Its
  output goes back only to the caller.
- Q5 (2026-11-10): the shell runs only in the shared OS sandbox proposed in
  F-003 Gate 2 item R2-1 (throwaway copy of the code, no network, no
  secrets, no access to the real repo). The advisor ships without a shell
  and gains it once that sandbox is decided and built.
- Q6 (2026-11-10): every advisor call needs the owner's OK. Agents can only
  propose a call (with their reason, per Q3); it runs when the owner
  approves it. The owner's own requests need no further approval. In an
  interview the analyst proposes the call as an interview item.
- Q7 (2026-11-10): the orchestrator files the hard decision as a normal
  inbox item in its own category, with its options and recommendation, plus
  an "Ask the advisor first" action carrying its reason. If the owner picks
  it, the advisor runs and its advice is added to the same item. No new
  category or second item.

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
- Web reader role (F-005), for the advisor's web research.
- F-003 Gate 2 R2-1 OS sandbox (owner decision pending), for the shell only.

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
| Q1 | Who can call the advisor? | Product | Answered: analyst and orchestrator (owner, 2026-11-10) |
| Q2 | Which model does the advisor run on? | Product | Answered: always strongest, high effort (owner, 2026-11-10) |
| Q3 | Who decides a question goes to the advisor? | Product | Answered: caller with reason, or the owner (owner, 2026-11-10) |
| Q4 | What can the advisor read and use? | Security | Answered: analyst's sources read only, plus shell in a sandbox (owner, 2026-11-10) |
| Q5 | What sandbox does the advisor's shell run in? | Security | Answered: the R2-1 sandbox; shell added once it exists (owner, 2026-11-10) |
| Q6 | What limits the advisor's spend? | Product | Answered: owner's OK for every call (owner, 2026-11-10) |
| Q7 | How does the orchestrator's request for an advisor call reach the owner? | Product | Answered: extra action on the decision item (owner, 2026-11-10) |
| Q8 | What does the advisor return, and how is it shown? | Product | Open |

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
