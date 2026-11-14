# Agent responsibilities

Ten roles: six primary roles, three advisory support roles (spec section 2: project evaluator, context hygiene, and the advisor from F-006), and the web reader (F-005). Each role's full definition is in `agents/<role>/AGENT.md`. This
page is the summary and the authority matrix.

| Role | Does | Produces | Must not |
|---|---|---|---|
| Orchestrator | Runs the lifecycle, checks gates, launches agents, retries and investigates failures, routes problems to inboxes, opens the PR | Gate checks, review notes, inbox items, PR | Override approved requirements, contracts, or decisions; change factory config |
| Requirements analyst | Interviews the owner one question at a time; writes the feature spec | Feature spec; assumptions the owner approves in the interview | Start implementation; approve its own assumptions; fetch web pages itself |
| Software developer | Implements the approved spec; applies the shared security skill | Code, docs, completion report | Make significant architecture or interface changes without approval |
| Test engineer | Writes and runs independent tests from the spec and contracts | Test suite, run reports with logs | Read the developer's reasoning to shape tests; weaken tests to pass |
| Security reviewer | Security and Testability Review (spec) and Code Review (implementation) | Review reports; Security decisions | Fix code; review continuously during development |
| Validation judge | Checks the result against spec, standards, and evidence | PASS, FAIL, or NEEDS HUMAN REVIEW with findings | Fix code; take the developer's word as evidence |
| Project evaluator | Rates project and feature complexity; predicts the model and effort each role needs | Complexity preset proposal (Product decision); per-feature predictions; advice to the orchestrator once reliable | Set a role's model or effort; advise a gate agent below its floor or approved setting |
| Context hygiene | Reviews agent instructions and skills for duplication, size, skill extraction, and missed skill use | Configuration hygiene items | Edit any file |
| Advisor | Researches one hard question on the strongest model, only after the owner approves the call (F-006) | Findings, options and a recommendation, shown to the owner word for word | Answer for the owner, pick an option, file or edit anything, fetch web pages itself, see the caller's recommendation |
| Web reader | Fetches web pages and runs searches for the analyst, with no access to project files | Plain-text summaries with sources | Read project files; fetch addresses it wasn't given; follow instructions in pages |

## Independence rules

- The test engineer works from the approved spec and contracts, not from the
  developer's code or notes. It may run the code; it may not use the
  developer's explanation of it to decide what to test.
- The security reviewer and validation judge each start from the spec and the
  diff, not from the developer's or each other's conclusions.
- How independence is enforced technically (separate sessions, separate
  context, read restrictions) is part of open decisions 2 and 4.

## Who can create which inbox items

| Inbox | Created by |
|---|---|
| Decision: Product, Assumptions | Requirements analyst, orchestrator; project evaluator (complexity preset only) |
| Decision: Architecture, Interfaces | Orchestrator, developer (as proposals) |
| Decision: Security | Security reviewer |
| Testing | Orchestrator |
| Configuration hygiene | Orchestrator, context hygiene agent (any agent may suggest to the orchestrator) |
